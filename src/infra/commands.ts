/** Subprocess wrapper for running gh, lark-cli, and git commands under the deployment's configured accounts. */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'
import { gitlabEnvironment } from './environment.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}
/**
 * Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string { return this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  async run(program: string, args: string[], cwd?: string, environment?: Record<string, string>): Promise<string> {
    try {
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...this.environment, ...environment, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      return stdout
    } catch (error) { throw commandError(error, program) }
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> {
    if (this.deployment.provider !== 'github') throw new Error('GitHub is not the selected repository host')
    return JSON.parse(await this.run(this.deployment.account.cli, args)) as T
  }
  /**
   * Calls the selected host's API within the configured repository/project, validating JSON output when a schema is provided.
   * Without a schema it returns raw CLI output.
   * @throws CliError with the host's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (this.deployment.provider === 'github') {
      if (typeof schema === 'string') return this.run(this.deployment.account.cli, ['api', this.path(schema), ...rest])
      const [path = '', ...flags] = rest
      return schema.parse(await this.gh(['api', this.path(path), ...flags]))
    }
    const path = typeof schema === 'string' ? schema : rest[0] ?? ''
    const flags = typeof schema === 'string' ? rest : rest.slice(1)
    const { account, origin, caFile } = this.deployment
    const raw = await this.run(account.cli, ['api', this.path(path), ...flags, '--repo', this.deployment.webUrl],
      undefined, gitlabEnvironment(origin, caFile))
    return typeof schema === 'string' ? raw : schema.parse(JSON.parse(raw))
  }
  /** Fetches a repository-scoped list, with bounded and advancing GitLab pages; invalid items count toward the caller's tally. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    if (this.deployment.provider === 'github') {
      const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
      return validItems(item, pages.flat(), tally)
    }
    this.path(path)
    const separator = path.indexOf('?')
    const resource = separator < 0 ? path : path.slice(0, separator)
    const query = new URLSearchParams(separator < 0 ? '' : path.slice(separator + 1))
    query.set('per_page', '100')
    const result: T[] = []
    let previous: string | undefined
    let bytes = 0
    for (let page = 1; page <= 1000; page++) {
      this.signal.throwIfAborted()
      query.set('page', String(page))
      const raw = await this.api(`${resource}?${query}`)
      const rows = z.array(z.unknown()).parse(JSON.parse(raw))
      bytes += Buffer.byteLength(raw)
      if ((previous === raw && rows.length > 0) || bytes > 16 * 1024 * 1024) throw new CliError('GitLab pagination did not advance or exceeded its output limit')
      result.push(...validItems(item, rows, tally))
      if (rows.length < 100) return result
      previous = raw
    }
    throw new CliError('GitLab pagination exceeded 1000 pages')
  }
  private path(path: string): string {
    let decoded: string
    try { decoded = decodeURIComponent(path.split('?')[0] ?? '') } catch { decoded = '/' }
    const file = /^repository\/files\/[^/?]+\/raw(?:\?|$)/.test(path)
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path) || path.includes('\\')
      || (this.deployment.provider === 'gitlab' && (/^\/|(^|\/)\.\.?(\/|$)/.test(decoded) || /%5c/i.test(path.split('?')[0] ?? '')
        || (!file && /%2f/i.test(path.split('?')[0] ?? ''))))
    if (outside) throw new Error('API calls are restricted to the configured repository')
    if (this.deployment.provider === 'github') return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
    const project = this.deployment.projectId
    if (!project) throw new Error('GitLab project is not resolved')
    return path ? `projects/${project}/${path}` : `projects/${project}`
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}
