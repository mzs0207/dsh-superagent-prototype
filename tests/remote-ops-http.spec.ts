import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { registerRemoteHttp } from '../src/remote-ops/http.ts'
import { ManagedRemoteOps } from '../src/remote-ops/managed.ts'
import { apply, Config } from '../src/remote-ops/index.ts'
import type { ProcessResult } from '../src/remote-ops/runner.ts'
import type { ManagedView, HostKeyProbe } from '../src/remote-ops/managed-types.ts'

const dirs: string[] = [], services: ManagedRemoteOps[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(services.splice(0).map(service => service.stop())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const fingerprint = `SHA256:${'A'.repeat(43)}`
const secret = ' fixture password $;&\' '
const processResult = (extra: Partial<ProcessResult> = {}): ProcessResult => ({ ok: true, exitCode: 0, signal: null,
  stdout: 'fixture output', stderr: '', truncated: false, timedOut: false, cancelled: false, durationMs: 5, ...extra })
async function host() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-managed-http-')); dirs.push(dir)
  const probe = vi.fn(async (_address: import('../src/remote-ops/password-ssh.ts').ProbeAddress, _signal: AbortSignal,
    _limits: import('../src/remote-ops/runner.ts').ProcessLimits) => fingerprint)
  const run = vi.fn(async (_connection: import('../src/remote-ops/password-ssh.ts').PasswordConnection, _command: string | undefined,
    _signal: AbortSignal, _limits: import('../src/remote-ops/runner.ts').ProcessLimits) => processResult())
  const remote = new ManagedRemoteOps(join(dir, 'remote-ops'), { probe, run })
  services.push(remote)
  type Handler = (req: unknown, res: unknown) => Promise<void>
  let handler: Handler = async () => {}
  const web = { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } }
  registerRemoteHttp(web as never, remote, new AbortController().signal)
  const call = async (method: string, path = '', body?: unknown, headers: Record<string, string | undefined> = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    await handler({ method, url: `/environment-resources/api/remote${path ? `/${path}` : ''}`, headers: {
      host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }, async *[Symbol.asyncIterator]() { yield* chunks } },
    { writeHead: (value: number, responseHeaders: Record<string, string>) => { status = value; expect(responseHeaders['cache-control']).toBe('no-store') },
      end: (value: string) => { text = value } })
    return { status, body: JSON.parse(text) as ManagedView & HostKeyProbe & { ok?: boolean; error?: string; message?: string } }
  }
  const create = async () => {
    let view = (await call('POST', 'environments', { revision: 0, name: '开发环境V2', aliases: ['dev2'], production: false })).body
    const environment = view.environments[0]!.id
    view = (await call('POST', `environments/${environment}/hosts`, { revision: view.revision, name: '应用机', host: 'host.example.invalid',
      port: 22, username: 'diagnostics', password: secret, projects: [{ id: 'community', directory: '/srv/community' }] })).body
    const id = view.environments[0]!.hosts[0]!.id
    return { view, environment, id, path: `environments/${environment}/hosts/${id}` }
  }
  return { remote, call, create, probe, run, dir, dispatch: handler }
}

it('manages empty environments and password hosts through same-origin API without ever returning secrets', async () => {
  const h = await host()
  expect(await h.call('GET')).toMatchObject({ status: 200, body: { revision: 0, environments: [] } })
  const created = await h.create()
  expect(created.view).toMatchObject({ revision: 2, environments: [{ name: '开发环境V2', hosts: [{ auth: 'password', hasPassword: true, hostKeyFingerprint: null }] }] })
  expect(JSON.stringify(created.view)).not.toContain(secret)
  expect(JSON.stringify((await h.call('GET')).body)).not.toMatch(/ciphertext|"password"\s*:|master\.key/)
  expect(h.probe).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled()
  const edited = await h.call('PUT', created.path, { revision: 2, name: '应用机-改名', host: 'host.example.invalid', port: 22,
    username: 'diagnostics', password: '', projects: [] })
  expect(edited).toMatchObject({ status: 200, body: { revision: 3 } })
  expect((await h.remote.store.credentials(created.environment, created.id, 3)).password).toBe(secret)
  const removed = await h.call('DELETE', `environments/${created.environment}`, { revision: 3 })
  expect(removed).toMatchObject({ status: 200, body: { revision: 4, environments: [] } })
})
it('rejects CSRF, foreign host/origin and oversized or invalid credential bodies before persisting', async () => {
  const h = await host()
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { origin: 'https://evil.example' }]) {
    expect((await h.call('POST', 'environments', { revision: 0, name: 'prod' }, headers)).status).toBe(403)
  }
  expect((await h.call('POST', 'environments', '{')).status).toBe(400)
  expect((await h.call('POST', 'environments', { revision: 0, name: 'x'.repeat(128 * 1024) })).status).toBe(400)
  expect((await h.call('GET')).body).toEqual({ revision: 0, environments: [] })
  const created = await h.create()
  const invalid = await h.call('PUT', created.path, { revision: 2, name: 'bad', host: '--options', username: 'diagnostics', password: secret })
  expect(invalid.status).toBe(400); expect(JSON.stringify(invalid)).not.toContain(secret)
})
it('requires endpoint-bound fingerprint confirmation before sending a password; trusts a token once', async () => {
  const h = await host(), created = await h.create()
  expect((await h.call('POST', `${created.path}/test`, { revision: 2 })).status).toBe(400)
  expect(h.run).not.toHaveBeenCalled()
  const probe = await h.call('POST', `${created.path}/probe`, { revision: 2 })
  expect(probe).toMatchObject({ status: 200, body: { fingerprint } })
  expect(h.probe.mock.calls[0]![0]).toEqual({ host: 'host.example.invalid', port: 22 })
  expect(JSON.stringify(h.probe.mock.calls)).not.toContain(secret)
  expect((await h.call('POST', `${created.path}/trust`, { revision: 2, token: 'not-a-token' })).status).toBe(400)
  const trusted = await h.call('POST', `${created.path}/trust`, { revision: 2, token: probe.body.token })
  expect(trusted).toMatchObject({ status: 200, body: { revision: 3, environments: [{ hosts: [{ hostKeyFingerprint: fingerprint }] }] } })
  expect((await h.call('POST', `${created.path}/trust`, { revision: 2, token: probe.body.token })).status).toBe(400)
  expect(await h.call('POST', `${created.path}/test`, { revision: 3 })).toMatchObject({ status: 200, body: { ok: true } })
  const sent = h.run.mock.calls[0] as unknown as [Record<string, unknown>, string | undefined]
  expect(sent[0]).toMatchObject({ password: secret, fingerprint, username: 'diagnostics' }); expect(sent[1]).toBeUndefined()
})
it('rejects expired/revision-stale challenges, arbitrary trust fingerprints and stale writes', async () => {
  const h = await host(), created = await h.create()
  const probe = await h.call('POST', `${created.path}/probe`, { revision: 2 })
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 6 * 60 * 1000)
  expect((await h.call('POST', `${created.path}/trust`, { revision: 2, token: probe.body.token })).status).toBe(400)
  vi.useRealTimers()
  expect((await h.call('POST', `${created.path}/trust`, { revision: 2, token: probe.body.token, fingerprint })).status).toBe(400)
  const fresh = await h.call('POST', `${created.path}/probe`, { revision: 2 })
  expect((await h.call('PUT', `environments/${created.environment}`, { revision: 2, name: 'renamed' })).status).toBe(200)
  expect((await h.call('POST', `${created.path}/trust`, { revision: 2, token: fresh.body.token })).status).toBe(409)
  expect((await h.call('DELETE', created.path, { revision: 2 })).status).toBe(409)
  expect(h.run).not.toHaveBeenCalled()
})
it('uses UI-managed inventory and pinned password transport for the original read-only tools without leaking credentials', async () => {
  const h = await host(), created = await h.create()
  let value = await h.remote.inventory()
  expect(value.environments[0]).toMatchObject({ label: '开发环境V2', servers: [{ trusted: false }] })
  expect(JSON.stringify(value)).not.toContain(secret)
  await expect(h.remote.inspect({ environment: 'dev2', action: 'status' }, new AbortController().signal)).rejects.toThrow('verified')
  expect(h.run).not.toHaveBeenCalled()
  const probe = await h.remote.probe(created.environment, created.id, { revision: 2 }, new AbortController().signal)
  await h.remote.trust(created.environment, created.id, { revision: 2, token: probe.token })
  const result = await h.remote.inspect({ environment: 'dev2', project: 'community', action: 'status' }, new AbortController().signal)
  expect(result).toMatchObject({ ok: true, results: [{ server: created.id, project: 'community', stdout: 'fixture output' }] })
  expect(JSON.stringify(result)).not.toContain(secret)
  const run = h.run.mock.calls[0] as unknown as [unknown, string]
  expect(run[1]).toBe("cd '/srv/community' && 'docker' 'compose' 'ps' '--all' '--format' 'json'")
})

it('opens the previous encrypted inventory and serves its management view without Superagent', async () => {
  const legacy = await host(), { environment, id, path } = await legacy.create()
  const probe = await legacy.call('POST', `${path}/probe`, { revision: 2 })
  await legacy.call('POST', `${path}/trust`, { revision: 2, token: probe.body.token })
  const previous = (await legacy.call('GET')).body
  await legacy.remote.stop()

  type Tool = { name: string; execute(args: unknown, execution: { signal: AbortSignal }): Promise<unknown> }
  type Handler = (req: unknown, res: unknown) => Promise<void>
  const tools = new Map<string, Tool>()
  const handlers = new Map<string, Handler>()
  const webServer = { host: '127.0.0.1', port: 3082, register: ({ path, handler }: { path: string; handler: Handler }) => {
    handlers.set(path, handler); return () => handlers.delete(path)
  } }
  let dispose!: () => Promise<void>
  apply({ get: (key: string) => key === 'webServer' ? webServer : undefined,
    on: () => () => {},
    tools: { register: (tool: Tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    effect: (effect: () => () => Promise<void>) => { dispose = effect() } } as never,
    Config({ stateDir: join(legacy.dir, 'remote-ops') }))
  try {
    const inventory = await tools.get('remote_ops_inventory')!.execute({}, { signal: AbortSignal.timeout(1500) })
    expect(inventory).toMatchObject({ source: 'managed', environments: [{
      id: environment, aliases: ['dev2'], servers: [{ id, trusted: true, projects: [{ id: 'community' }] }],
    }] })
    const dispatch = handlers.get('/environment-resources')!
    const writeHead = vi.fn(), end = vi.fn()
    await dispatch({ method: 'GET', url: '/environment-resources/api/remote',
      headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' } }, { writeHead, end })
    expect(writeHead.mock.calls[0]?.[0]).toBe(200)
    expect(JSON.parse(end.mock.calls[0]![0])).toEqual(previous)
    expect(end.mock.calls[0]![0]).not.toContain(secret)
  } finally { await dispose() }
  expect(handlers.size).toBe(0)
  expect(tools.size).toBe(0)
})
it('cancels a fingerprint connection when its HTTP client disconnects, without writing a late response', async () => {
  const h = await host(), created = await h.create(), started = Promise.withResolvers<void>()
  let observed: AbortSignal | undefined
  h.probe.mockImplementationOnce(async (_address, signal) => {
    observed = signal; started.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return fingerprint
  })
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: `/environment-resources/api/remote/${created.path}/probe`,
    headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"revision":2}') } })
  const res = Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn() })
  const work = h.dispatch(req, res)
  await started.promise; res.emit('close'); await work
  expect(observed?.aborted).toBe(true); expect(res.end).not.toHaveBeenCalled()
  expect(req.listenerCount('aborted')).toBe(0); expect(res.listenerCount('close')).toBe(0)
})

it('drains accepted vault writes and refuses new work on shutdown', async () => {
  const h = await host()
  const accepted = h.remote.store.createEnvironment({ revision: 0, name: 'accepted before stop' })
  await h.remote.stop()
  expect(await accepted).toMatchObject({ revision: 1 })
  await expect(h.remote.store.view()).rejects.toThrow('stopping')
  await expect(h.remote.store.createEnvironment({ revision: 1, name: 'must not write' })).rejects.toThrow('stopping')
  const { ManagedStore } = await import('../src/remote-ops/managed-store.ts')
  expect(await new ManagedStore(join(h.dir, 'remote-ops')).view()).toMatchObject({ revision: 1, environments: [{ name: 'accepted before stop' }] })
})

it('reports an actual failed connection result rather than asserting success', async () => {
  const h = await host(), created = await h.create()
  const probe = await h.remote.probe(created.environment, created.id, { revision: 2 }, new AbortController().signal)
  await h.remote.trust(created.environment, created.id, { revision: 2, token: probe.token })
  h.run.mockResolvedValueOnce(processResult({ ok: false, error: 'SSH password authentication failed' }))
  expect(await h.call('POST', `${created.path}/test`, { revision: 3 })).toMatchObject({ status: 200, body: { ok: false, message: 'SSH password authentication failed' } })
})

it('stores typed resources and searchable notes without exposing stored passwords or changing existing host identity', async () => {
  const h = await host(), existing = await h.create()
  const root = `environments/${existing.environment}/resources`
  const db = await h.call('POST', root, { revision: 2, type: 'postgresql', name: 'OMS data', notes: 'refund verification',
    host: 'db.example.invalid', port: 5432, database: 'oms', username: 'readonly', password: secret, allowWorker: false })
  expect(db.status).toBe(200)
  const account = await h.call('POST', root, { revision: 3, type: 'website-account', name: 'OMS operator', notes: 'Refund verification only',
    origin: 'https://oms.example.invalid', username: 'test@example.invalid', password: secret, allowWorker: true })
  expect(account).toMatchObject({ status: 200, body: { revision: 4, environments: [{
    hosts: [{ id: existing.id, type: 'linux-host', hasPassword: true }],
    resources: [{ type: 'postgresql', name: 'OMS data' }, { type: 'website-account', name: 'OMS operator', notes: 'Refund verification only' }],
  }] } })
  expect(JSON.stringify(await h.call('GET'))).not.toContain(secret)
  const found = await h.remote.findResources({ environment: 'dev2', type: 'website-account', keyword: 'refund' })
  expect(found).toMatchObject({ resources: [{ name: 'OMS operator', notes: 'Refund verification only', type: 'website-account' }] })
  expect(JSON.stringify(found)).not.toMatch(/ciphertext|fixture password/)
})

it('defaults new databases to plaintext and preserves TLS on records created before the option existed', async () => {
  const h = await host(), { environment } = await h.create()
  const root = `environments/${environment}/resources`
  const fields = { type: 'postgresql', name: 'Database', host: 'db.example.invalid', database: 'app', username: 'reader', ca: 'fixture CA' }
  const created = await h.call('POST', root, { ...fields, revision: 2, password: secret })
  expect(created).toMatchObject({ status: 200, body: { environments: [{ resources: [{ tls: false }] }] } })
  const id = created.body.environments[0]!.resources![0]!.id
  const path = join(h.dir, 'remote-ops', 'state.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  delete state.environments[0].resources[0].tls
  const legacy = JSON.stringify(state)
  await writeFile(path, legacy)
  expect(await h.call('GET')).toMatchObject({ status: 200, body: { environments: [{ resources: [{ id, tls: true }] }] } })
  expect(await readFile(path, 'utf8')).toBe(legacy)
  const route = `${root}/${id}`
  expect(await h.call('PUT', route, { ...fields, revision: 3 })).toMatchObject({
    status: 200, body: { environments: [{ resources: [{ id, tls: true }] }] },
  })
  expect(await h.call('PUT', route, { ...fields, revision: 4, tls: false })).toMatchObject({
    status: 200, body: { environments: [{ resources: [{ id, tls: false, ca: 'fixture CA', hasPassword: true }] }] },
  })
  expect((await h.remote.store.resourceCredentials(environment, id, 5, false)).password).toBe(secret)
})

it('authorizes official OMS login only after the Worker is enabled and never returns the test tokens', async () => {
  const h = await host(), { environment } = await h.create()
  const origin = 'https://oms.example.invalid', username = 'test@example.invalid'
  const root = `environments/${environment}/resources`
  const fields = { type: 'website-account', origin, username, name: 'OMS', notes: 'read-only' }
  const created = await h.call('POST', root, { ...fields, revision: 2, password: secret })
  expect(created.status).toBe(200)
  const id = created.body.environments[0]!.resources![0]!.id
  const request = { environment, resource: id, action: 'api' }
  const signal = new AbortController().signal, attempts: string[] = []
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    expect(options.redirect).toBe('error')
    attempts.push(new URL(url).pathname)
    if (url === `${origin}/api/oms/auth/login`) {
      expect(options.method).toBe('POST')
      expect(JSON.parse(String(options.body))).toEqual({ email: username, password: secret })
      return Response.json({ state: 'AUTHENTICATED', operator_id: 'test', access_token: 'not-model-access', refresh_token: 'not-model-refresh' })
    }
    if (url === `${origin}/api/oms/me`) {
      expect(new Headers(options.headers).get('authorization')).toBe('Bearer not-model-access')
      return Response.json({ operator_id: 'test' })
    }
    if (url === `${origin}/api/oms/auth/logout`) {
      expect(JSON.parse(String(options.body))).toEqual({ refresh_token: 'not-model-refresh' })
      return new Response(null, { status: 204 })
    }
    throw new Error('Unexpected target')
  })
  vi.stubGlobal('fetch', fetch)
  try {
    await expect(h.remote.check(request, signal, true)).rejects.toThrow('not enabled')
    expect(attempts).toEqual([])
    const edited = await h.call('PUT', `${root}/${id}`, { ...fields, revision: 3, allowWorker: true })
    expect(edited.status).toBe(200)
    const verified = await h.remote.check(request, signal, true)
    expect(verified).toMatchObject({ ok: true })
    expect(JSON.stringify(verified)).not.toContain('not-model')
    expect(attempts).toEqual(['/api/oms/auth/login', '/api/oms/me', '/api/oms/auth/logout'])
    expect((await h.call('PUT', `${root}/${id}`, { ...fields, revision: 4, origin: 'https://other.example.invalid' })).status).toBe(400)
    expect((await h.call('DELETE', `${root}/${id}`, { revision: 4 })).status).toBe(200)
  } finally { vi.unstubAllGlobals() }
})

it('keeps an OMS login for its owner only and revokes it at expiry', async () => {
  const h = await host(), { environment } = await h.create()
  const root = `environments/${environment}/resources`, selected = '/api/oms/test-read?page=2&limit=10'
  const saved = await h.call('POST', root, { revision: 2, type: 'website-account', name: 'Test operator',
    origin: 'https://oms.example.invalid', username: 'test@example.invalid', password: secret })
  expect(saved.status).toBe(200)
  const resource = saved.body.environments[0]!.resources![0]!.id
  const owner = {}, other = {}, signal = new AbortController().signal
  const request = { environment, resource, mode: 'api' }
  const requests: string[] = []
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    const target = new URL(url)
    const path = target.pathname + target.search
    requests.push(path)
    if (path.endsWith('/login')) return Response.json({ state: 'AUTHENTICATED', operator_id: 'operator', access_token: 'owner-access',
      refresh_token: 'owner-refresh' })
    if (path.endsWith('/logout')) return new Response(null, { status: 204 })
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer owner-access')
    if (path === '/api/oms/me') return Response.json({ operator_id: 'operator' })
    if (path === selected) return Response.json({ count: 9, accessToken: 'exported-secret', detail: `echo owner-access ${secret}` })
    throw new Error('Unexpected authenticated path')
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    expect(await h.remote.login(request, owner, signal, false)).toMatchObject({ ok: true })
    expect(requests).toEqual(['/api/oms/auth/login', '/api/oms/me'])
    await expect(h.remote.readSession({ ...request, path: selected }, other, signal, false)).rejects.toThrow('Sign in')
    await expect(h.remote.readSession({ ...request, path: '/api/oms/auth/refresh' }, owner, signal, false)).rejects.toThrow('not allowed')
    await expect(h.remote.readSession({ ...request, path: '/api/other/records' }, owner, signal, false)).rejects.toThrow('not allowed')
    await expect(h.remote.readSession({ ...request, path: 'https://other.example.invalid/api/oms/me' }, owner, signal, false)).rejects.toThrow()
    const result = await h.remote.readSession({ ...request, path: selected }, owner, signal, false)
    expect(result).toMatchObject({ ok: true, data: { count: 9 } })
    expect(JSON.stringify(result)).not.toMatch(/owner-access|exported-secret|fixture password/)
    await vi.advanceTimersByTimeAsync(300_001)
    expect(requests).toEqual(['/api/oms/auth/login', '/api/oms/me', selected, '/api/oms/auth/logout'])
    await expect(h.remote.readSession({ ...request, path: selected }, owner, signal, false)).rejects.toThrow('Sign in')
  } finally { vi.unstubAllGlobals() }
})

it('preserves existing OMS credentials after removing the old account metadata', async () => {
  const h = await host(), { environment } = await h.create()
  const base = `environments/${environment}/resources`
  const fields = { type: 'website-account', name: 'OMS', origin: 'https://oms.example.invalid', username: 'test@example.invalid',
    allowWorker: true, notes: 'Existing account' }
  const created = await h.call('POST', base, { ...fields, revision: 2, password: secret })
  const id = created.body.environments[0]!.resources![0]!.id
  const file = join(h.dir, 'remote-ops', 'state.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const saved = state.environments[0].resources[0]
  delete saved.system
  Object.assign(saved, { role: 'operator', webPaths: ['/old'], apiPaths: ['/api/oms/old'] })
  await writeFile(file, JSON.stringify(state))

  const view = (await h.call('GET')).body.environments[0]!.resources![0]
  expect(view).toEqual({ ...fields, id, hasPassword: true, system: 'oms' })
  expect((await h.remote.store.resourceCredentials(environment, id, 3, true)).password).toBe(secret)
  expect((await h.call('PUT', `${base}/${id}`, { ...fields, revision: 3, notes: 'Edited' })).status).toBe(200)
  const updated = JSON.parse(await readFile(file, 'utf8')).environments[0].resources[0]
  expect(updated.secret).toEqual(saved.secret)
  expect(updated).not.toHaveProperty('role')
  expect(updated).not.toHaveProperty('apiPaths')
  expect(updated).not.toHaveProperty('webPaths')
})

it('stores RFC 1918 HTTP website origins but refuses public HTTP destinations', async () => {
  const h = await host(), { environment } = await h.create()
  const route = `environments/${environment}/resources`
  const common = { type: 'website-account', name: 'Local OMS', username: 'test@example.invalid', password: secret }
  let revision = 2
  for (const origin of ['http://192.168.77.10', 'http://172.16.3.4:8080/', 'http://172.31.3.4', 'http://10.0.0.5']) {
    const saved = await h.call('POST', route, { ...common, origin, revision })
    expect(saved.status, origin).toBe(200)
    expect(saved.body.environments[0]?.resources?.at(-1)).toMatchObject({ origin: new URL(origin).origin })
    revision++
  }
  for (const origin of ['http://192.169.77.10', 'http://172.15.3.4', 'http://172.32.3.4',
    'http://10.example.invalid', 'http://169.254.169.254', 'http://127.0.0.1', 'http://192.168.77.10/login']) {
    expect((await h.call('POST', route, { ...common, origin, revision })).status, origin).toBe(400)
  }
  expect((await h.call('GET')).body.revision).toBe(revision)
})

it.each([
  { system: 'community', origin: 'http://192.168.77.10', username: 'test@example.invalid', loginPath: '/api/auth/login',
    checkPath: '/api/users/user-profiles', readPath: '/api/users/user-profiles', headers: { authorization: 'Bearer access-fixture' },
    login: { user_id: 'test-id', access_token: 'access-fixture', refresh_token: 'refresh-fixture' },
    profile: { id: 'test-id' }, body: { email: 'test@example.invalid' } },
  { system: 'zentao', origin: 'http://192.168.77.10:8080/zentao', username: 'qa_user', loginPath: '/api.php/v1/tokens',
    checkPath: '/api.php/v1/products?limit=1', readPath: '/api.php/v1/products', headers: { token: 'access-fixture' },
    login: { token: 'access-fixture' }, profile: { products: [] }, body: { account: 'qa_user' } },
])('uses the $system login contract without sharing sessions or logging out other devices', async fixture => {
  const h = await host(), { environment } = await h.create()
  const created = await h.call('POST', `environments/${environment}/resources`, { revision: 2, type: 'website-account',
    name: 'Fixture', system: fixture.system, origin: fixture.origin, username: fixture.username, password: secret })
  expect(created.status).toBe(200)
  const saved = created.body.environments[0]!.resources![0]!
  expect(saved).toMatchObject({ system: fixture.system, origin: fixture.origin })
  expect(JSON.stringify(saved)).not.toContain(secret)
  const owner = {}, signal = AbortSignal.timeout(4000), args = { environment, resource: saved.id, mode: 'api' }
  const expected = [fixture.loginPath, fixture.checkPath, fixture.readPath]
  let calls = 0
  vi.stubGlobal('fetch', async (target: string, options: RequestInit) => {
    expect(target).toBe(fixture.origin + expected[calls])
    expect(options.redirect).toBe('error')
    if (calls++ === 0) {
      expect(options.method).toBe('POST')
      expect(JSON.parse(String(options.body))).toEqual({ ...fixture.body, password: secret })
      return Response.json(fixture.login)
    }
    expect(options.method ?? 'GET').toBe('GET')
    for (const [key, value] of Object.entries(fixture.headers)) expect(new Headers(options.headers).get(key)).toBe(value)
    return Response.json(fixture.profile)
  })
  try {
    expect(await h.remote.login(args, owner, signal, false)).toMatchObject({ ok: true })
    await expect(h.remote.readSession({ ...args, path: fixture.readPath }, {}, signal, false)).rejects.toThrow('Sign in')
    await expect(h.remote.readSession({ ...args, path: '/api/oms/me' }, owner, signal, false)).rejects.toThrow('not allowed')
    const result = await h.remote.readSession({ ...args, path: fixture.readPath }, owner, signal, false)
    expect(result).toMatchObject({ ok: true, data: fixture.profile })
    expect(JSON.stringify(result)).not.toContain('access-fixture')
    await h.remote.releaseOwner(owner)
    expect(calls).toBe(3)
  } finally { vi.unstubAllGlobals() }
})

it('does not carry an OMS password over to the community on the same origin', async () => {
  const h = await host(), { environment } = await h.create()
  const route = `environments/${environment}/resources`
  const fields = { type: 'website-account', name: 'Existing OMS', origin: 'http://192.168.77.10', username: 'test@example.invalid' }
  const created = await h.call('POST', route, { ...fields, revision: 2, password: secret })
  const resource = created.body.environments[0]!.resources![0]!.id
  const replaced = await h.call('PUT', `${route}/${resource}`, { ...fields, revision: 3, system: 'community' })
  expect(replaced).toMatchObject({ status: 400, body: { code: 'password_required' } })
  expect((await h.call('GET')).body).toMatchObject({ revision: 3, environments: [{ resources: [{ id: resource, system: 'oms' }] }] })
})
