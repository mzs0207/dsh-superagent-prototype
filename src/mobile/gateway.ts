/** Private mobile gateway: password login, projected task reads and allowlisted conversation operations. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import { once } from 'node:events'
import type { ApiResponse } from '../app/api.ts'
import { TICKET_FILTERS } from '../app/api.ts'
import { publicDelivery } from '../app/views/delivery.ts'
import html from './view.html?raw'
import script from './view.js?raw'
import style from './view.css?raw'
import loginHtml from './login.html?raw'
import loginScript from './login.js?raw'

export interface GatewayOptions {
  host: string; port: number; upstream: string; password: { salt: string; hash: string }
}
const cookieName = 'superagent-view'
const derive = promisify(scrypt)
export async function hashPassword(value: string) {
  if (value.length < 8 || value.length > 256) throw new Error('Use an access password between 8 and 256 characters')
  const salt = randomBytes(16).toString('hex')
  return { salt, hash: ((await derive(value, salt, 32)) as Buffer).toString('hex') }
}
const resources: Record<string, [string, string]> = {
  '/': ['text/html', html], '/view.js': ['text/javascript', script], '/view.css': ['text/css', style],
}
export function privateAddress(host: string): boolean {
  if (isIP(host) !== 4) return false
  const [a, b] = host.split('.').map(Number)
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b! >= 16 && b! <= 31)
}
export function loopbackOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Upstream must be a loopback http://127.0.0.1:<port> origin')
  }
  return url.origin
}
function row(ticket: ApiResponse<'GET tickets'>['items'][number] | ApiResponse<'GET tickets/:id'>) {
  return { id: ticket.id, title: ticket.title, stage: ticket.stage, action: 'action' in ticket ? ticket.action : undefined,
    summary: ticket.summary, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
    sources: [...new Set(ticket.threads.map(thread => thread.source))],
    ended: ticket.ended ? { at: ticket.ended.at, outcome: ticket.ended.outcome, reason: ticket.ended.reason } : undefined }
}
function detail(ticket: ApiResponse<'GET tickets/:id'>) {
  return { ...row(ticket), description: ticket.mandate.scope, attention: ticket.attention?.question,
    delivery: publicDelivery(ticket.delivery),
    reports: ticket.assignments.flatMap(assignment => assignment.report
      ? [{ state: assignment.report.state, summary: assignment.report.summary, at: assignment.report.at }] : []).reverse() }
}
function listQuery(query: URLSearchParams): string | undefined {
  for (const name of query.keys()) if (!['state', 'offset', 'limit'].includes(name) || query.getAll(name).length !== 1) return
  const state = query.get('state') ?? 'open', offset = query.get('offset') ?? '0', limit = query.get('limit') ?? '20'
  if (!(TICKET_FILTERS as readonly string[]).includes(state) || !/^\d+$/.test(offset) || !/^\d+$/.test(limit)
    || !Number.isSafeInteger(Number(offset)) || Number(limit) < 1 || Number(limit) > 100) return
  return new URLSearchParams({ state, offset, limit }).toString()
}
function conversationQuery(path: string, query: URLSearchParams): string | undefined {
  const names = path === '/api/conversations' ? ['offset'] : path.endsWith('/history') ? ['before', 'through'] : []
  for (const name of query.keys()) {
    const value = query.get(name)!
    if (!names.includes(name) || query.getAll(name).length !== 1 || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return
  }
  if (path.endsWith('/history') && (!query.has('before') || !query.has('through') || Number(query.get('before')) > Number(query.get('through')))) return
  return query.toString()
}
async function conversationProxy(req: IncomingMessage, res: ServerResponse, url: URL, upstream: string, lifetime: AbortSignal) {
  const query = conversationQuery(url.pathname, url.searchParams)
  if (query === undefined || (req.method === 'POST' && url.search)) return send(res, 400, { error: '无效的会话参数' })
  let body: string | undefined
  if (req.method === 'POST') {
    if (req.headers['x-superagent-request'] !== '1') return send(res, 403, { error: '缺少会话操作标识' })
    if (req.headers['content-type'] !== 'application/json') return send(res, 415, { error: '会话操作必须使用 JSON' })
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length
      if (bytes > 128 * 1024) { req.resume(); return send(res, 413, { error: '消息过长' }) }
      chunks.push(Buffer.from(chunk))
    }
    body = Buffer.concat(chunks).toString('utf8')
  }
  const disconnected = new AbortController(), deadline = new AbortController()
  res.on('close', () => disconnected.abort())
  const signal = AbortSignal.any([lifetime, disconnected.signal, deadline.signal])
  const timer = setTimeout(() => deadline.abort(), 15_000)
  try {
    const response = await fetch(`${upstream}/orchestrator${url.pathname}${query ? `?${query}` : ''}`, {
      method: req.method, headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      body, redirect: 'error', signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      const status = [400, 404, 409].includes(response.status) ? response.status : 502
      return send(res, status, { error: status === 404 ? '会话不存在，或电脑端尚未升级'
        : status === 409 ? '会话状态已变化，请刷新后重试' : status === 400 ? '会话请求无效，请检查输入' : '电脑端会话服务暂不可用' })
    }
    if (url.pathname.endsWith('/events')) {
      clearTimeout(timer)
      if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('Invalid event stream')
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' })
      res.flushHeaders()
      for await (const chunk of response.body) if (!res.write(chunk)) await once(res, 'drain', { signal })
      res.end()
    } else send(res, 200, await response.json())
  } catch {
    if (!res.destroyed) {
      if (res.headersSent) res.destroy()
      else send(res, 502, { error: '无法连接电脑端会话服务，请检查连接后重试' })
    }
  } finally { clearTimeout(timer) }
}
function authorized(req: IncomingMessage, token: Buffer): boolean {
  const credential = req.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  if (!credential) return false
  const supplied = Buffer.from(credential)
  return supplied.length === token.length && timingSafeEqual(supplied, token)
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value))
}
/** Start only on explicit invocation; shutdown closes in-flight reads and the dedicated listener. */
export async function startGateway(options: GatewayOptions) {
  const upstream = loopbackOrigin(options.upstream)
  if (!privateAddress(options.host)) throw new Error('Listen address must be a private or loopback IPv4 address')
  if (!/^[a-f0-9]{32}$/.test(options.password.salt) || !/^[a-f0-9]{64}$/.test(options.password.hash)) throw new Error('Invalid password configuration')
  const token = Buffer.from(randomBytes(32).toString('base64url')), stopped = new AbortController()
  const expectedPassword = Buffer.from(options.password.hash, 'hex')
  // The public fingerprint survives restarts, but changing the password invalidates saved credentials.
  const identity = { service: 'superagent-viewer', version: 1,
    id: createHash('sha256').update(options.password.salt).digest('hex'), name: hostname().slice(0, 80) }
  let origin = '', activeLogins = 0
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    if (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: '拒绝跨来源访问' })
    let url: URL
    try { url = new URL(req.url ?? '/', origin) }
    catch { return send(res, 400, { error: '无效的请求地址' }) }
    if (url.origin !== origin) return send(res, 400, { error: '无效的请求地址' })
    if (req.method === 'POST' && url.pathname === '/login' && !url.search) {
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return send(res, 415, { error: '无效的登录请求' })
      if (activeLogins >= 4) return send(res, 429, { error: '正在处理登录，请稍后重试' })
      activeLogins++
      try {
        let body = '', bytes = 0
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length
          if (bytes > 4096) { req.resume(); return send(res, 413, { error: '登录请求过大' }) }
          body += chunk.toString()
        }
        const password = new URLSearchParams(body).get('password') ?? ''
        if (password.length > 256) return send(res, 401, { error: '密码错误' })
        const actual = await derive(password, options.password.salt, 32) as Buffer
        if (!timingSafeEqual(actual, expectedPassword)) return send(res, 401, { error: '密码错误' })
        res.setHeader('set-cookie', `${cookieName}=${token.toString()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`)
        return send(res, 200, { authenticated: true })
      } catch { if (!res.destroyed) send(res, 400, { error: '登录失败，请重试' }) }
      finally { activeLogins-- }
      return
    }
    const conversation = url.pathname === '/api/conversations'
      || /^\/api\/conversations\/[A-Za-z0-9_-]{1,160}\/(?:history|events|messages|stop)$/.test(url.pathname)
    const conversationWrite = conversation && req.method === 'POST'
      && (url.pathname === '/api/conversations' || /\/(?:messages|stop)$/.test(url.pathname))
    if (req.method !== 'GET' && !conversationWrite) return send(res, 405, { error: '不允许此操作' })
    if (url.pathname === '/.well-known/superagent') {
      if (url.search) return send(res, 400, { error: '无效参数' })
      return send(res, 200, identity)
    }
    const loggedIn = authorized(req, token)
    const asset = url.pathname === '/' && !loggedIn ? ['text/html', loginHtml]
      : url.pathname === '/login.js' ? ['text/javascript', loginScript]
      : (loggedIn || url.pathname === '/view.css') && Object.hasOwn(resources, url.pathname) ? resources[url.pathname] : undefined
    if (asset) {
      if (url.search) return send(res, 400, { error: '无效参数' })
      res.writeHead(200, { 'content-type': `${asset[0]}; charset=utf-8` }); res.end(asset[1]); return
    }
    if (!loggedIn) return send(res, 401, { error: '请重新输入访问密码' })
    if (conversation) {
      if (req.method === 'GET' && /\/(?:messages|stop)$/.test(url.pathname)) return send(res, 405, { error: '不允许此操作' })
      try { await conversationProxy(req, res, url, upstream, stopped.signal) }
      catch { if (!res.destroyed) send(res, 400, { error: '会话请求中断' }) }
      return
    }
    const list = url.pathname === '/api/tickets'
    const match = /^\/api\/tickets\/([A-Za-z0-9_-]{1,160})$/.exec(url.pathname)
    if (!list && !match) return send(res, 404, { error: '没有此接口' })
    const query = list ? listQuery(url.searchParams) : ''
    if (query === undefined || (!list && url.search)) return send(res, 400, { error: '无效的筛选或分页参数' })
    const disconnected = new AbortController()
    res.on('close', () => disconnected.abort())
    try {
      const response = await fetch(`${upstream}/orchestrator/api/tickets${list ? `?${query}` : `/${match![1]}`}`, {
        headers: { 'x-orchestrator-request': '1' }, redirect: 'error',
        signal: AbortSignal.any([stopped.signal, disconnected.signal, AbortSignal.timeout(10_000)]),
      })
      if (response.status === 404 && !list) {
        const body = await response.text()
        return send(res, body ? 404 : 502, { error: body ? '任务不存在或已被移除' : '电脑端任务服务暂不可用' })
      }
      if (!response.ok) { await response.body?.cancel(); return send(res, 502, { error: '电脑端任务服务暂不可用' }) }
      if (list) {
        const value = await response.json() as ApiResponse<'GET tickets'>
        send(res, 200, { items: value.items.map(row), total: value.total, next_offset: value.next_offset })
      } else send(res, 200, detail(await response.json() as ApiResponse<'GET tickets/:id'>))
    } catch { if (!res.destroyed) send(res, 502, { error: '无法读取电脑端任务，请检查服务是否运行' }) }
  })
  server.requestTimeout = 15_000; server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(options.port, options.host, () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  origin = `http://${options.host}:${address.port}`
  return { origin, close: async () => {
    stopped.abort(); server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}
