/** Direct intranet REST reads and native comment-only writes; no proxy or browser dependency. */
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { z } from 'zod'

export const ZentaoConnectionSchema = z.object({
  baseUrl: z.string().trim().default('').transform(value => value.replace(/\/(?:admin\.html)?$/, '')).refine(value => {
    if (!value) return true
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash }
    catch { return false }
  }, 'An HTTP(S) ZenTao installation URL, including its /zentao path'),
  product: z.number().int().positive().default(4),
  account: z.string().trim().default(''),
  credentialsFile: z.string().trim().refine(value => !value || value.startsWith('/'), 'An absolute JSON credentials file path').default(''),
})
export type ZentaoConnection = z.infer<typeof ZentaoConnectionSchema>
const User = z.union([z.string(), z.looseObject({ account: z.string() })]).transform(value => typeof value === 'string' ? value : value.account)
const Action = z.looseObject({ comment: z.string().nullish(), id: z.union([z.string(), z.number()]).optional() })
export const ZentaoBugSchema = z.looseObject({
  id: z.coerce.number().int().positive(), product: z.coerce.number().int().positive(), title: z.string(), status: z.string(),
  assignedTo: User.nullable().transform(value => value ?? ''), activatedCount: z.coerce.number().int().nonnegative().default(0),
  deleted: z.union([z.boolean(), z.string(), z.number()]).optional().transform(value => value === true || value === '1' || value === 1),
  steps: z.string().default(''), openedDate: z.string().default(''),
  actions: z.union([z.array(Action), z.record(z.string(), Action)]).default([]).transform(value => Object.values(value)),
  files: z.unknown().optional(), openedBuild: z.unknown().optional(),
})
export type ZentaoBug = z.infer<typeof ZentaoBugSchema>
/** Signals that a bug left the configured product or assignee scope, so pending channel writes must stop. */
export class ZentaoScopeError extends Error {}

export async function zentaoRequest(url: URL, options: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  const { promise, resolve, reject } = Promise.withResolvers<{ bytes: Buffer; contentType: string }>()
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: options.method ?? 'GET', signal,
    headers: { ...options.headers, ...(options.body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(options.body)) }) } }, response => {
    const chunks: Buffer[] = []; let size = 0
    response.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 16 * 1024 * 1024) request.destroy(new Error('ZenTao response exceeds 16 MiB'))
      else chunks.push(chunk)
    })
    response.on('error', reject)
    response.on('end', () => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) reject(new Error(`ZenTao ${options.method ?? 'GET'} ${url.pathname}: HTTP ${response.statusCode}`))
      else resolve({ bytes: Buffer.concat(chunks), contentType: response.headers['content-type'] ?? '' })
    })
  })
  request.on('error', error => reject(new Error(`ZenTao ${options.method ?? 'GET'} ${url.pathname}: ${error.message}`)))
  request.end(options.body)
  return promise
}

/** Authenticated ZenTao reads and scope-checked, idempotent comment/resolution writes with authoritative readback. */
export class ZentaoClient {
  private token?: string
  constructor(readonly config: ZentaoConnection, private readonly signal?: AbortSignal) {}
  private async credentials() {
    if (!this.config.baseUrl || !this.config.account || !this.config.credentialsFile) throw new Error('Configure the ZenTao URL, account and credentials file')
    const value = z.object({ account: z.string(), password: z.string().min(1) }).parse(JSON.parse(await readFile(this.config.credentialsFile, 'utf8')))
    if (value.account !== this.config.account) throw new Error('ZenTao credentials account does not match the Source')
    return value
  }
  private async json(url: URL, body?: string, headers?: Record<string, string>) {
    const response = await zentaoRequest(url, { ...(body === undefined ? {} : { method: 'POST', body }), ...headers ? { headers } : {}, ...this.signal ? { signal: this.signal } : {} })
    try { return JSON.parse(response.bytes.toString()) as unknown }
    catch { throw new Error(`ZenTao ${url.pathname} returned non-JSON data`) }
  }
  private async api(path: string, body?: Record<string, unknown>): Promise<unknown> {
    if (!this.token) {
      const login = await this.json(new URL(`${this.config.baseUrl}/api.php/v1/tokens`), JSON.stringify(await this.credentials()), { 'Content-Type': 'application/json' })
      this.token = z.object({ token: z.string().min(1) }).parse(login).token
    }
    return this.json(new URL(`${this.config.baseUrl}/api.php/v1/${path}`), body === undefined ? undefined : JSON.stringify(body), { Token: this.token, 'Content-Type': 'application/json' })
  }
  async bugs(): Promise<ZentaoBug[]> {
    const result: ZentaoBug[] = [], seen = new Set<number>()
    for (let page = 1; page <= 1000; page++) {
      const data = z.object({ page: z.coerce.number(), total: z.coerce.number().nonnegative(), limit: z.coerce.number().positive(), bugs: z.array(ZentaoBugSchema) })
        .parse(await this.api(`products/${this.config.product}/bugs?status=unclosed&limit=100&page=${page}`))
      if (data.page !== page || data.bugs.some(bug => seen.has(bug.id))) throw new Error('ZenTao pagination did not advance')
      for (const bug of data.bugs) { seen.add(bug.id); result.push(bug) }
      if (result.length >= data.total) return result
      if (!data.bugs.length) throw new Error('ZenTao pagination ended before total')
    }
    throw new Error('ZenTao pagination exceeded 1000 pages')
  }
  private async productBug(id: number): Promise<ZentaoBug> {
    const bug = ZentaoBugSchema.parse(await this.api(`bugs/${z.number().int().positive().parse(id)}`))
    if (bug.id !== id || bug.product !== this.config.product || bug.deleted) throw new ZentaoScopeError('Bug is outside the configured product scope; stop work')
    return bug
  }
  async bug(id: number): Promise<ZentaoBug> {
    const bug = await this.productBug(id)
    if (bug.assignedTo !== this.config.account) throw new ZentaoScopeError('Bug is no longer assigned to this account; stop work')
    return bug
  }
  async comment(id: number, operation: string, text: string): Promise<void> {
    const marker = `[dsh-superagent:${operation}]`
    const bug = await this.productBug(id)
    if (bug.actions.some(action => action.comment?.includes(marker))) return
    if (bug.assignedTo !== this.config.account) throw new ZentaoScopeError('Bug is no longer assigned to this account; do not comment')
    const credentials = await this.credentials()
    const envelope = z.object({ status: z.literal('success'), data: z.union([z.string(), z.record(z.string(), z.unknown())]) })
      .parse(await this.json(new URL(`${this.config.baseUrl}/api-getsessionid.json`)))
    const session = z.object({ sessionName: z.string().regex(/^[a-zA-Z0-9_]+$/), sessionID: z.string().min(1) })
      .parse(typeof envelope.data === 'string' ? JSON.parse(envelope.data) : envelope.data)
    const query = new URLSearchParams({ [session.sessionName]: session.sessionID })
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
    z.object({ status: z.literal('success') }).parse(await this.json(new URL(`${this.config.baseUrl}/user-login.json?${query}`), new URLSearchParams(credentials).toString(), headers))
    // Recheck assignment after authentication; never use assign/resolve as a substitute for commenting.
    await this.bug(id)
    const escaped = `${text}\n\n${marker}`.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>')
    const response = z.object({ result: z.string().optional(), status: z.string().optional() })
      .parse(await this.json(new URL(`${this.config.baseUrl}/action-comment-bug-${id}.json?${query}`), new URLSearchParams({ comment: escaped }).toString(), headers))
    if (response.result !== 'success' && response.status !== 'success') throw new Error('ZenTao refused the comment')
    const after = await this.productBug(id)
    if (!after.actions.some(action => action.comment?.includes(marker))) throw new Error('ZenTao comment was not found on readback; delivery is unconfirmed')
  }
  async resolve(id: number, build: string, operation: string, text: string): Promise<void> {
    const marker = `[dsh-superagent:${operation}]`
    const bug = await this.productBug(id)
    // A successful resolution commonly assigns back to the reporter. Reconcile it before checking the current assignee.
    if (bug.status === 'resolved' && bug.resolution === 'fixed' && bug.actions.some(action => action.comment?.includes(marker))) return
    if (bug.status !== 'active' || bug.assignedTo !== this.config.account) throw new Error('Bug is no longer active and assigned to this account; do not resolve it')
    if (!/^[1-9]\d*$/.test(build)) throw new Error('resolvedBuild must be a numeric ZenTao build ID')
    await this.api(`bugs/${id}/resolve`, { resolution: 'fixed', resolvedBuild: build, comment: `${text}\n\n${marker}` })
    // Resolve may legitimately assign back to the reporter, so read directly instead of using bug()'s assignee gate.
    const after = ZentaoBugSchema.parse(await this.api(`bugs/${id}`))
    if (after.id !== id || after.product !== this.config.product || after.status !== 'resolved' || after.resolution !== 'fixed'
      || !after.actions.some(action => action.comment?.includes(marker))) throw new Error('ZenTao fixed resolution was not confirmed on readback')
  }
  async file(id: number): Promise<{ bytes: Buffer; contentType: string }> {
    await this.credentials()
    if (!this.token) await this.bugs()
    return zentaoRequest(new URL(`${this.config.baseUrl}/api.php/v1/files/${z.number().int().positive().parse(id)}`), { headers: { Token: this.token! }, ...this.signal ? { signal: this.signal } : {} })
  }
}
