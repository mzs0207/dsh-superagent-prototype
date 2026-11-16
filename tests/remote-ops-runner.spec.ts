import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { RemoteOps, runSsh, type ProcessResult, type Transport } from '../src/remote-ops/runner.ts'
import { apply, Config } from '../src/remote-ops/index.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const limits = { timeoutMs: 3000, maxOutputBytes: 4096 }
const result = (extra: Partial<ProcessResult> = {}): ProcessResult => ({ ok: true, exitCode: 0, signal: null, stdout: 'ok', stderr: '',
  truncated: false, timedOut: false, cancelled: false, durationMs: 1, ...extra })
const local = (code: string) => ({ executable: process.execPath, args: ['-e', code] })
const inventory = () => ({ version: 1, environments: [{ id: 'dev-v2', label: '开发环境V2', aliases: ['开发V2'], servers: [
  { id: 'web-1', host: 'one.example.invalid', projects: [{ id: 'community', directory: '/opt/community' }] },
  { id: 'web-2', host: 'two.example.invalid', projects: [{ id: 'community', directory: '/opt/community' }] },
] }] })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-ops-')); dirs.push(dir)
  const path = join(dir, 'inventory.json'); await writeFile(path, JSON.stringify(inventory()))
  return path
}
const service = (inventoryFile: string, transport: Transport, maxConcurrent = 2) =>
  new RemoteOps({ inventoryFile, maxConcurrent, ...limits }, transport)

it('captures local fixture output and nonzero exit without attempting SSH', async () => {
  const value = await runSsh(local("process.stdout.write('开发V2'); process.stderr.write('failure'); process.exitCode=7"), new AbortController().signal, limits)
  expect(value).toMatchObject({ ok: false, exitCode: 7, stdout: '开发V2', stderr: 'failure', truncated: false, cancelled: false })
})
it('bounds combined output, keeps draining and marks truncation', async () => {
  const value = await runSsh(local("process.stdout.write('a'.repeat(200000)); process.stderr.write('b'.repeat(200000))"), new AbortController().signal, limits)
  expect(value.ok).toBe(true)
  expect(value.truncated).toBe(true)
  expect(Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr)).toBe(4096)
})
it('reports a missing executable rather than successful verification', async () => {
  const path = join(await fixture(), 'not-an-executable')
  const value = await runSsh({ executable: path, args: [] }, new AbortController().signal, limits)
  expect(value).toMatchObject({ ok: false, timedOut: false, cancelled: false })
  expect(value.error).toMatch(/ENOENT|ENOTDIR/)
})
it('terminates a timed out local fixture and waits for process close', async () => {
  const value = await runSsh(local('setInterval(() => {}, 1000)'), new AbortController().signal, { ...limits, timeoutMs: 80 })
  expect(value).toMatchObject({ ok: false, timedOut: true, cancelled: false })
  expect(value.durationMs).toBeLessThan(2500)
})
it('forwards cancellation, including an already aborted signal', async () => {
  const controller = new AbortController()
  const work = runSsh(local('setInterval(() => {}, 1000)'), controller.signal, limits)
  controller.abort()
  expect(await work).toMatchObject({ ok: false, cancelled: true, timedOut: false })
  await expect(runSsh(local("throw new Error('must not start')"), controller.signal, limits)).rejects.toThrow()
})
it('kills an uncooperative local process after the termination grace period', async () => {
  // The first output confirms the handler has been installed before cancellation.
  const path = await fixture(), marker = join(path, '..', 'started')
  const controller = new AbortController()
  const work = runSsh(local(`process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(marker)},'started'); setInterval(()=>{},1000)`), controller.signal, limits)
  await vi.waitFor(async () => { expect(await readFile(marker, 'utf8')).toBe('started') })
  controller.abort()
  expect(await work).toMatchObject({ ok: false, cancelled: true, signal: 'SIGKILL' })
})
it('validates local process limits', async () => {
  await expect(runSsh(local(''), new AbortController().signal, { timeoutMs: 0, maxOutputBytes: 1 })).rejects.toThrow('limits')
})
it('does not connect for an unconfigured inventory', async () => {
  const transport = vi.fn<Transport>()
  const ops = service('', transport)
  expect(await ops.inventory()).toMatchObject({ configured: false, environments: [] })
  await expect(ops.inspect({ environment: 'prod', action: 'status' }, new AbortController().signal)).rejects.toThrow('inventoryFile')
  expect(transport).not.toHaveBeenCalled()
  await ops.stop()
})
it('checks all servers sequentially, labels evidence, preserves a failure and rereads configuration', async () => {
  const file = await fixture(), calls: string[][] = []
  const transport: Transport = async invocation => {
    calls.push(invocation.args)
    return calls.length === 1 ? result({ ok: false, exitCode: 255, stderr: 'Host key verification failed' }) : result()
  }
  const ops = service(file, transport)
  const value = await ops.inspect({ environment: '开发环境V2', action: 'status' }, new AbortController().signal)
  expect(value).toMatchObject({ ok: false, requestedServers: 2, completedServers: 2, results: [
    { environment: 'dev-v2', server: 'web-1', project: 'community', exitCode: 255, ok: false },
    { environment: 'dev-v2', server: 'web-2', ok: true },
  ] })
  expect(calls).toHaveLength(2)
  expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value)
  expect(validateJsonSchemaValue({ type: 'object', additionalProperties: true }, value)).toEqual([])
  expect(JSON.stringify(await ops.inventory())).not.toContain('example.invalid')
  const next = inventory(); next.environments[0]!.servers.pop()
  await writeFile(file, JSON.stringify(next))
  expect(await ops.inspect({ environment: 'dev-v2', action: 'containers' }, new AbortController().signal)).toMatchObject({ requestedServers: 1 })
  await ops.stop()
})
it('validates every target before starting any process', async () => {
  const file = await fixture(), next = inventory(), transport = vi.fn<Transport>()
  next.environments[0]!.servers[1]!.projects.push({ id: 'other', directory: '/opt/other' })
  await writeFile(file, JSON.stringify(next))
  const ops = service(file, transport)
  await expect(ops.inspect({ environment: 'dev-v2', action: 'status' }, new AbortController().signal)).rejects.toThrow()
  await expect(ops.inspect({ environment: 'prod', action: 'containers' }, new AbortController().signal)).rejects.toThrow()
  await expect(ops.inspect({ environment: 'dev-v2', action: 'restart' }, new AbortController().signal)).rejects.toThrow()
  expect(transport).not.toHaveBeenCalled()
  await ops.stop()
})
it('isolates transport exceptions to one server', async () => {
  const transport = vi.fn<Transport>().mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValue(result())
  const ops = service(await fixture(), transport)
  expect(await ops.inspect({ environment: 'dev-v2', action: 'status' }, new AbortController().signal)).toMatchObject({ ok: false,
    completedServers: 2, results: [{ ok: false, error: 'spawn failed' }, { ok: true }] })
  await ops.stop()
})
it('enforces concurrency across requests and releases cancelled queued requests', async () => {
  const first = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let active = 0, peak = 0, count = 0
  const transport: Transport = async () => {
    peak = Math.max(peak, ++active); count++; entered.resolve()
    if (count === 1) await first.promise
    active--; return result()
  }
  const ops = service(await fixture(), transport, 1)
  const request = { environment: 'dev-v2', server: 'web-1', action: 'status' }
  const a = ops.inspect(request, new AbortController().signal); await entered.promise
  const cancel = new AbortController(), b = ops.inspect(request, cancel.signal)
  const rejected = expect(b).rejects.toThrow(); cancel.abort(); await rejected
  first.resolve(); await a
  await ops.inspect(request, new AbortController().signal)
  expect(peak).toBe(1); expect(count).toBe(2)
  await ops.stop()
})
it('stops active diagnostics, settles them and never fans out after cancellation', async () => {
  const entered = Promise.withResolvers<void>(), transport = vi.fn<Transport>(async (_invocation, signal) => {
    entered.resolve()
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve() })
    return result({ ok: false, cancelled: true })
  })
  const ops = service(await fixture(), transport)
  const work = ops.inspect({ environment: 'dev-v2', action: 'status' }, new AbortController().signal)
  await entered.promise; await ops.stop()
  expect(await work).toMatchObject({ ok: false, requestedServers: 2, completedServers: 1 })
  expect(transport).toHaveBeenCalledTimes(1)
  await expect(ops.inspect({ environment: 'dev-v2', action: 'status' }, new AbortController().signal)).rejects.toThrow()
})
it('registers canonical DSH tools and releases both on plugin disposal', async () => {
  type Tool = { name: string; parameters: unknown; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown>; output: { render: (args: unknown, value: never) => unknown } }
  const tools = new Map<string, Tool>(), disposals: (() => Promise<void>)[] = []
  const ctx = { tools: { register: (tool: Tool) => { assertObjectJsonSchema(tool.parameters); tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } },
    effect: (effect: () => () => Promise<void>) => { disposals.push(effect()) } }
  apply(ctx as never, Config({ inventoryFile: await fixture() }))
  expect([...tools.keys()]).toEqual(['remote_ops_inventory', 'remote_ops_inspect'])
  const list = tools.get('remote_ops_inventory')!
  const value = await list.execute({}, { signal: new AbortController().signal })
  expect(value).toMatchObject({ configured: true, readOnly: true })
  expect(validateJsonSchemaValue({ type: 'object', additionalProperties: true }, value)).toEqual([])
  expect(list.output.render({}, value as never)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
  await expect(list.execute({ password: 'not allowed' }, { signal: new AbortController().signal })).rejects.toThrow()
  await disposals[0]!(); expect(tools.size).toBe(0)
})
