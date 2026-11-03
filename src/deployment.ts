/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { gitlabEnvironment, runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const GitlabAccountsSchema = z.object({
  host: z.string().trim().default(''),
  repository: z.string().trim().regex(/^((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)?$/, 'namespace/project').default(''),
  cli: z.string().trim().default(''),
  caFile: z.string().trim().refine(value => value === '' || isAbsolute(value), 'An absolute CA file path').default(''),
})
export type RepositoryProvider = 'github' | 'gitlab'

/** Canonical self-managed origin; URL credentials and path-based API redirects are not accepted. */
export function gitlabOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('Not an origin')
    return url.origin
  } catch { throw new SetupError('gitlabHostInvalid') }
}
/** Stable namespace for one configured hosting instance/project, including self-managed hosts. */
export const repositoryScope = (provider: RepositoryProvider, origin: string, repository: string): string =>
  createHash('sha256').update(`${provider}\n${origin}\n${repository.toLowerCase()}`).digest('hex')
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape),
  gitlab: Object.keys(GitlabAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  provider: RepositoryProvider
  repository: string
  origin: string
  namespace: string
  cloneUrl: string
  webUrl: string
  projectId?: number
  defaultBranch?: string
  caFile?: string
  account: { cli: string; login: string; email: string }
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the selected repository host, agent CLI identity and repository write role. */
export async function resolveDeployment(machine: Machine, config: unknown, probe: Probe, path = process.env.PATH ?? '',
  provider: RepositoryProvider = 'github'): Promise<Deployment> {
  if (provider === 'gitlab') return resolveGitlab(machine, config, probe, path)
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(config ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  const origin = 'https://github.com'
  return { ...machine, provider, repository, origin, namespace: repositoryScope(provider, origin, remote),
    cloneUrl: `${origin}/${repository}.git`, webUrl: `${origin}/${repository}`,
    account: { cli, login: agent.login, email: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const GitlabUser = z.looseObject({ id: z.number().int().positive(), username: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  email: z.email(), commit_email: z.string().nullish() })
const GitlabAccess = z.looseObject({ id: z.number().int().positive(),
  path_with_namespace: z.string().regex(/^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/),
  http_url_to_repo: z.string(), web_url: z.string(), default_branch: z.string().nullish(), archived: z.boolean(),
  permissions: z.object({ project_access: z.object({ access_level: z.number() }).nullish(),
    group_access: z.object({ access_level: z.number() }).nullish() }).nullish() })

async function resolveGitlab(machine: Machine, config: unknown, probe: Probe, path: string): Promise<Deployment> {
  const accounts = GitlabAccountsSchema.parse(config ?? {})
  if (!accounts.host) throw new SetupError('gitlabHostUnset')
  const origin = gitlabOrigin(accounts.host)
  if (!accounts.repository) throw new SetupError('gitlabRepositoryUnset')
  if (!accounts.cli) throw new SetupError('gitlabCliUnset')
  if (accounts.caFile) {
    try {
      if (!statSync(accounts.caFile).isFile()) throw new Error('Not a file')
      accessSync(accounts.caFile, constants.R_OK)
    } catch { throw new SetupError('gitlabCaMissing') }
  }
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(machine.stateDir)) }
  catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }) }
  const environment = Object.entries(gitlabEnvironment(origin, accounts.caFile)).map(([name, value]) => `${name}=${value}`)
  // glab 1.82 rejects ports in api --hostname; the native repository override preserves host:port.
  const api = (endpoint: string) => probe(['env', ...environment, cli, 'api', endpoint, '--repo', `${origin}/${accounts.repository}`])
  const agent = parsed(GitlabUser, await api('user').catch((error: unknown) => {
    throw new SetupError('gitlabCliSignedOut', { output: reason(error) })
  }))
  if (!agent) throw new SetupError('gitlabCliNoAccount')
  const project = parsed(GitlabAccess, await api(`projects/${encodeURIComponent(accounts.repository)}`).catch((error: unknown) => {
    throw new SetupError('gitlabRepositoryUnreadable', { account: agent.username, repository: accounts.repository, output: reason(error) })
  }))
  const invalid = () => new SetupError('gitlabRepositoryUnreported', { repository: accounts.repository })
  if (!project) throw invalid()
  for (const [raw, suffix] of [[project.http_url_to_repo, '.git'], [project.web_url, '']] as const) {
    let url: URL
    try { url = new URL(raw) } catch { throw invalid() }
    if (url.origin !== origin || url.username || url.password || url.search || url.hash
      || decodeURIComponent(url.pathname) !== `/${project.path_with_namespace}${suffix}`) throw invalid()
  }
  const access = Math.max(project.permissions?.project_access?.access_level ?? 0, project.permissions?.group_access?.access_level ?? 0)
  if (project.archived || access < 30) throw new SetupError('gitlabRepositoryReadOnly', { account: agent.username, repository: project.path_with_namespace })
  const email = z.email().safeParse(agent.commit_email)
  return { ...machine, provider: 'gitlab', origin, repository: project.path_with_namespace, projectId: project.id,
    cloneUrl: project.http_url_to_repo, webUrl: project.web_url, defaultBranch: project.default_branch ?? '',
    namespace: repositoryScope('gitlab', origin, accounts.repository), caFile: accounts.caFile,
    account: { cli, login: agent.username, email: email.success ? email.data : agent.email } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
