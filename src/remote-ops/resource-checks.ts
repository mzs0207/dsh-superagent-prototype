import pg from 'pg'
import { chromium, type Browser } from 'playwright-core'
import type { WebsiteSystem } from './api.ts'
import type { ConnectionTest, ManagedResource, ResourceAction, WebsiteMode } from './managed-types.ts'

const routes = {
  oms: { apiLogin: '/api/oms/auth/login', identity: '/api/oms/me', webPage: '/login', webSubmit: '/api/oms/auth/login' },
  community: { apiLogin: '/api/auth/login', identity: '/api/users/user-profiles', webPage: '/login', webSubmit: '/api/auth/login' },
  zentao: { apiLogin: '/api.php/v1/tokens', identity: '/api.php/v1/products?limit=1', webPage: '/user-login.html', webSubmit: '/user-login.html' },
} as const
const maxJson = 256 * 1024
const maxReadChars = 16_000
type WebsiteResource = Extract<ManagedResource, { type: 'website-account' }>
export type WebsiteReadResult = { ok: boolean; path: string; data?: unknown; text?: string; truncated?: boolean }
export interface WebsiteConnection {
  read(path: string, signal: AbortSignal): Promise<WebsiteReadResult>
  close(): Promise<void>
}
interface AuthenticatedApi extends WebsiteConnection { secrets: string[] }

/** ZenTao also uses GET for some legacy actions; only named view routes are considered reads. */
export function isWebsiteReadPath(system: WebsiteSystem, mode: WebsiteMode, path: string): boolean {
  const pathname = path.split('?', 1)[0]!
  if (mode === 'api') {
    if (system === 'oms') return pathname.startsWith('/api/oms/') && !/^\/api\/oms\/auth(?:\/|$)/i.test(pathname)
    if (system === 'community') return pathname === routes.community.identity || pathname === '/api/resources/work/list'
    return /^\/api\.php\/v1\/(?:products(?:\/\d+(?:\/bugs)?)?|bugs\/\d+)$/.test(pathname)
  }
  if (system === 'zentao') {
    return !path.includes('?') && /^\/(?:|index\.html|my\/?|my(?:-index)?\.html|(?:product-browse|bug-(?:browse|view))-\d+(?:-\d+)*\.html)$/.test(pathname)
  }
  return !/^\/(?:api|auth|login|change-password|logout|register|signup)(?:\/|$)/i.test(pathname)
}

function payload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (fields.code !== undefined && fields.code !== 0 && fields.code !== '0') return undefined
  return fields.data && typeof fields.data === 'object' && !Array.isArray(fields.data) ? fields.data as Record<string, unknown> : fields
}

async function apiJson(origin: string, path: string, options: RequestInit): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(origin + path, { ...options, redirect: 'error' })
  if (!response.ok || !response.body) { await response.body?.cancel(); return undefined }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxJson) throw new Error('Oversized website response')
      chunks.push(next.value)
    }
    return payload(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } finally { await reader.cancel().catch(() => undefined) }
}

async function postgres(resource: Extract<ManagedResource, { type: 'postgresql' }>, password: string, signal: AbortSignal) {
  const { host, port, database, username, tls, ca } = resource
  signal.throwIfAborted()
  const client = new pg.Client({ host, port, database, user: username, password, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000, options: '-c default_transaction_read_only=on',
    ssl: tls ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false })
  const stop = () => { void client.end().catch(() => undefined) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    await client.connect()
    signal.throwIfAborted()
    const { rows } = await client.query<{ connected: number }>('SELECT 1 AS connected')
    return rows[0]?.connected === 1
  } finally { signal.removeEventListener('abort', stop); await client.end().catch(() => undefined) }
}

function redactText(value: string, secrets: readonly string[]): string {
  for (const secret of secrets) value = value.split(secret).join('[redacted]')
  return value.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
}

function redactJson(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (depth >= 20) return '[nested data omitted]'
  if (Array.isArray(value)) return value.map(item => redactJson(item, secrets, depth + 1))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|token|secret|authorization|cookie|credential/i.test(key))
    .map(([key, item]) => [redactText(key, secrets), redactJson(item, secrets, depth + 1)]))
}

async function confirmApi(resource: WebsiteResource, login: Record<string, unknown>, password: string, signal: AbortSignal): Promise<AuthenticatedApi | undefined> {
  const { origin, system } = resource
  const token = system === 'zentao' ? login.token : login.access_token
  const refresh = login.refresh_token
  if (system === 'oms' && login.state !== 'AUTHENTICATED') return undefined
  if (typeof token !== 'string' || !token || token.length > 8192) return undefined
  const secrets = [password, token, ...(typeof refresh === 'string' && refresh ? [refresh] : [])].filter(Boolean)
  const headers = new Headers({ accept: 'application/json' })
  if (system === 'zentao') headers.set('Token', token)
  else headers.set('Authorization', `Bearer ${token}`)
  let closed = false, confirmed = false
  const close = async () => {
    if (closed) return
    closed = true
    // Only OMS exposes logout for the refresh record issued to this login.
    if (system !== 'oms' || typeof refresh !== 'string' || !refresh || refresh.length > 8192) return
    const response = await fetch(origin + '/api/oms/auth/logout', { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refresh }),
      signal: AbortSignal.timeout(1500) }).catch(() => undefined)
    await response?.body?.cancel().catch(() => undefined)
  }
  try {
    const me = await apiJson(origin, routes[system].identity, { headers, signal })
    if (system === 'zentao') {
      if (!Array.isArray(me?.products)) return undefined
    } else {
      const id = system === 'oms' ? me?.operator_id ?? me?.id : me?.id
      if (typeof id !== 'string' || !id || id !== (system === 'oms' ? login.operator_id : login.user_id)) return undefined
    }
    confirmed = true
    return { secrets, close, read: async (path, active) => {
      if (closed) return { ok: false, path }
      const data = await apiJson(origin, path, { headers, signal: active })
      if (data === undefined) return { ok: false, path }
      const safe = redactJson(data, secrets)
      return JSON.stringify(safe).length > maxReadChars ? { ok: true, path, truncated: true } : { ok: true, path, data: safe }
    } }
  } finally { if (!confirmed) await close() }
}

async function webLogin(resource: WebsiteResource, password: string, executable: string, signal: AbortSignal): Promise<WebsiteConnection | undefined> {
  const { origin, system, username } = resource
  if (system === 'community' && !resource.communityTermsAccepted) return undefined
  const { webPage, webSubmit } = routes[system]
  const base = new URL(origin), prefix = base.pathname === '/' ? '' : base.pathname
  let identity: AuthenticatedApi | undefined
  let browser: Browser | undefined, retained = false
  const stop = () => { void browser?.close().catch(() => undefined) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    signal.throwIfAborted()
    browser = await chromium.launch({ ...(executable ? { executablePath: executable } : {}), headless: true, timeout: 8000 })
    signal.throwIfAborted()
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' })
    context.setDefaultTimeout(8000)
    await context.routeWebSocket('**/*', socket => { void socket.close() })
    let submitted = false
    let submitting = false
    let login: Record<string, unknown> | undefined
    await context.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url())
      if (target.origin !== base.origin || (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`))) return route.abort()
      const path = target.pathname.slice(prefix.length) || '/'
      const method = request.method()
      const reading = method === 'GET' || method === 'HEAD'
      if (reading) {
        if (/^\/api\/(?:oms\/)?auth(?:\/|$)/i.test(path)) return route.abort()
        if (system === 'community' && /^\/api\/oms(?:\/|$)/i.test(path)) return route.abort()
        if (system === 'oms' && /^\/api\//i.test(path) && !path.startsWith('/api/oms/')) return route.abort()
        if (system === 'zentao' && path !== webPage
          && !(submitting && !submitted && /^\/user-refreshrandom\.html$/i.test(path))
          && !isWebsiteReadPath(system, 'web', path + target.search) && !isWebsiteReadPath(system, 'api', path + target.search)
          && !/^\/(?:js|theme|css|images|img|static)\/[A-Za-z0-9._/-]+\.(?:js|css|svg|png|gif|jpe?g|ico|woff2?)$/i.test(path)) return route.abort()
      } else {
        if (!submitting || path !== webSubmit || target.search || method !== 'POST' || submitted) return route.abort()
        submitted = true
      }
      // Don't let Chromium follow a redirect outside the origin or forward the sign-in POST.
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: 6000 })
        try {
          if (response.status() >= 300 && response.status() < 400) return await route.abort()
          if (!reading && response.ok()) {
            const body = await response.body()
            if (body.byteLength > maxJson) return await route.abort()
            // Capture before fulfilling: SPA navigation can discard the browser's response body.
            login = payload(JSON.parse(body.toString('utf8')))
          }
          await route.fulfill({ response })
        } finally { await response.dispose().catch(() => undefined) }
      } catch { await route.abort().catch(() => undefined) }
    })
    const page = await context.newPage()
    await page.goto(origin + webPage, { waitUntil: 'domcontentloaded' })
    if (page.url() !== origin + webPage) return undefined
    const submit = system === 'zentao' ? page.locator('#loginForm button[type="submit"]')
      : page.getByRole('button', { name: system === 'community' ? /^(Join us|Log in|Login|登录|加入我们)$/i : /^(Login|登录)$/i })
    await page.locator(system === 'zentao' ? '#loginForm input[name="account"]' : 'input[autocomplete="email"]').fill(username)
    await page.locator(system === 'zentao' ? '#loginForm input[name="password"]' : 'input[autocomplete="current-password"]').fill(password)
    if (system === 'community') await page.getByRole('checkbox', { name: /terms of service|privacy policy|服务条款|隐私政策/i }).check()
    submitting = true
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + webSubmit && response.request().method() === 'POST'),
      submit.click(),
    ])
    if (!response.ok() || !login) return undefined
    if (system === 'zentao') {
      if (login.result !== 'success') return undefined
    } else {
      identity = await confirmApi(resource, login, password, signal)
      if (!identity) return undefined
    }
    await page.waitForURL(url => url.origin === base.origin && (!prefix || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
      && isWebsiteReadPath(system, 'web', (url.pathname.slice(prefix.length) || '/') + url.search), { waitUntil: 'domcontentloaded' })
    if (await page.locator('input[type="password"]').count()) return undefined
    const instance = browser
    retained = true
    return {
      close: async () => { await Promise.allSettled([instance.close(), identity?.close()]) },
      read: async (path, active) => {
        active.throwIfAborted()
        // Cancellation also invalidates this page, so no agent can keep using a late navigation result.
        const cancel = () => { void instance.close().catch(() => undefined) }
        active.addEventListener('abort', cancel, { once: true })
        try {
          const target = new URL(origin + path).href
          const loaded = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 8000 })
          if (!loaded?.ok() || page.url() !== target) return { ok: false, path }
          const visible = await page.locator('body').innerText({ timeout: 3000 })
          const cookies = (await context.cookies()).map(cookie => cookie.value).filter(value => value.length >= 8)
          const text = redactText(visible.slice(0, maxReadChars + 8192), [...(identity?.secrets ?? [password]), ...cookies])
          return { ok: true, path, text: text.slice(0, maxReadChars), truncated: visible.length > maxReadChars || text.length > maxReadChars }
        } finally { active.removeEventListener('abort', cancel) }
      },
    }
  } finally {
    signal.removeEventListener('abort', stop)
    if (!retained) await Promise.allSettled([browser?.close(), identity?.close()])
  }
}

/** Opens only the selected website's built-in authentication flow. Secrets stay in the private connection. */
export async function openWebsite(resource: WebsiteResource, password: string, mode: WebsiteMode, executable: string,
  signal: AbortSignal): Promise<WebsiteConnection | undefined> {
  if (mode === 'web') return webLogin(resource, password, executable, signal)
  const account = resource.system === 'zentao' ? { account: resource.username } : { email: resource.username }
  const login = await apiJson(resource.origin, routes[resource.system].apiLogin, { method: 'POST', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...account, password }) })
  return login && confirmApi(resource, login, password, signal)
}

/** Executes only a fixed PostgreSQL check or a supported website sign-in. */
export async function checkResource(resource: ManagedResource, password: string, action: ResourceAction, executable: string,
  caller: AbortSignal): Promise<ConnectionTest> {
  const started = Date.now(), signal = AbortSignal.any([caller, AbortSignal.timeout(25000)])
  let ok = false
  try {
    signal.throwIfAborted()
    if (resource.type === 'postgresql' && action === 'database') ok = await postgres(resource, password, signal)
    else if (resource.type === 'website-account' && action !== 'database') {
      const login = await openWebsite(resource, password, action, executable, signal)
      ok = !!login
      await login?.close()
    }
  } catch { /* Driver, page, and API errors can include authentication data. */ }
  caller.throwIfAborted()
  return { ok, durationMs: Date.now() - started, message: ok ? 'Resource connection verified' : signal.aborted ? 'Resource check timed out'
    : action === 'web' ? 'Web login could not be verified. Check the selected system, Chromium and account.'
      : action === 'api' ? 'API login could not be verified. Check the selected system and account.'
        : 'PostgreSQL authentication or read-only connection check failed. Check network, TLS and the account.' }
}
