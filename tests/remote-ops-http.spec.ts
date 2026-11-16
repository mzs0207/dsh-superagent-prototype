import { Context } from '@deepseek-ai/cordis'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
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
  const remote = new ManagedRemoteOps(new Context(), join(dir, 'remote-ops'), new AbortController().signal, { probe, run })
  services.push(remote)
  type Handler = (req: unknown, res: unknown) => Promise<void>
  let handler: Handler = async () => {}
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), remote } as HttpHost)
  const call = async (method: string, path = '', body?: unknown, headers: Record<string, string | undefined> = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    await handler({ method, url: `/orchestrator/api/remote${path ? `/${path}` : ''}`, headers: {
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
  const tools = new Map<string, { execute(args: unknown, execution: { signal: AbortSignal }): Promise<unknown> }>()
  let dispose!: () => Promise<void>
  apply({ get: () => h.remote, tools: { register: (tool: { name: string; execute: never }) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    effect: (effect: () => () => Promise<void>) => { dispose = effect() } } as never, Config({}))
  expect(await tools.get('remote_ops_inventory')!.execute({}, { signal: new AbortController().signal })).toMatchObject({ source: 'managed' })
  expect([...tools.keys()]).toEqual(['remote_ops_inventory', 'remote_ops_inspect'])
  await dispose()
})
it('cancels a fingerprint connection when its HTTP client disconnects, without writing a late response', async () => {
  const h = await host(), created = await h.create(), started = Promise.withResolvers<void>()
  let observed: AbortSignal | undefined
  h.probe.mockImplementationOnce(async (_address, signal) => {
    observed = signal; started.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return fingerprint
  })
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: `/orchestrator/api/remote/${created.path}/probe`,
    headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"revision":2}') } })
  const res = Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn() })
  const work = h.dispatch(req, res)
  await started.promise; res.emit('close'); await work
  expect(observed?.aborted).toBe(true); expect(res.end).not.toHaveBeenCalled()
  expect(req.listenerCount('aborted')).toBe(0); expect(res.listenerCount('close')).toBe(0)
})

it('drains accepted vault writes and refuses new work before shutdown releases the enclosing lock', async () => {
  const h = await host()
  const accepted = h.remote.store.createEnvironment({ revision: 0, name: 'accepted before stop' })
  await h.remote.stop()
  expect(await accepted).toMatchObject({ revision: 1 })
  await expect(h.remote.store.view()).rejects.toThrow('stopping')
  await expect(h.remote.store.createEnvironment({ revision: 1, name: 'must not write' })).rejects.toThrow('stopping')
  const { ManagedStore } = await import('../src/remote-ops/managed-store.ts')
  expect(await new ManagedStore(join(h.dir, 'remote-ops')).view()).toMatchObject({ revision: 1, environments: [{ name: 'accepted before stop' }] })
})

it('cancels and awaits delegated managed diagnostics when the tool plugin is disposed', async () => {
  const tools = new Map<string, { execute(args: unknown, execution: { signal: AbortSignal }): Promise<unknown> }>()
  const started = Promise.withResolvers<void>()
  let dispose!: () => Promise<void>
  const managed = { inspect: async (_args: unknown, signal: AbortSignal) => {
    started.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    return { cancelled: true }
  } }
  apply({ get: () => managed, tools: { register: (tool: { name: string; execute: never }) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    effect: (effect: () => () => Promise<void>) => { dispose = effect() } } as never, Config({}))
  const work = tools.get('remote_ops_inspect')!.execute({ environment: 'dev', action: 'containers' }, { signal: new AbortController().signal })
  await started.promise; await dispose()
  expect(await work).toEqual({ cancelled: true }); expect(tools.size).toBe(0)
})

it('reports an actual failed connection result rather than asserting success', async () => {
  const h = await host(), created = await h.create()
  const probe = await h.remote.probe(created.environment, created.id, { revision: 2 }, new AbortController().signal)
  await h.remote.trust(created.environment, created.id, { revision: 2, token: probe.token })
  h.run.mockResolvedValueOnce(processResult({ ok: false, error: 'SSH password authentication failed' }))
  expect(await h.call('POST', `${created.path}/test`, { revision: 3 })).toMatchObject({ status: 200, body: { ok: false, message: 'SSH password authentication failed' } })
})
