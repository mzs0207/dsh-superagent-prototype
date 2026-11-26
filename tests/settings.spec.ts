/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Deployment } from '../src/deployment.ts'
import { UserError } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }

it('applies a saved compaction route to the next summary of an existing worker, without changing other calls', async () => {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const original = { provider: 'old-provider', model: 'old-model', maxTokens: 65_536 }
  const summary = { provider: 'summary-provider', model: 'summary-model' }
  const limit = 32_768
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, defaultMaxTokens: provider === summary.provider ? limit : original.maxTokens }
    }
    async *stream({ provider, model, maxTokens }: GenerateOptions): AsyncGenerator<StreamChunk> {
      if (provider === summary.provider && (maxTokens ?? 0) > limit) throw new Error('Summary exceeds provider output limit')
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ provider, model, maxTokens }) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  onTestFinished(llm.registerAdapter([original.provider, summary.provider], new Adapter()))
  const host = h = await startRuntime(undefined, ctx)
  const { sessionId } = await host.acceptedTicket(feishu('compaction-route', 'Fix a regression'))
  const { settings, store, masterId } = host.runtime
  const executor = store.settings().executor
  const request = async (id: string, purpose?: 'compaction', maxTokens = original.maxTokens) => {
    let text: string | undefined
    for await (const chunk of llm.stream({ ...original, maxTokens, messages: [], sessionId: SessionId(id), ...(purpose ? { purpose } : {}) })) {
      if (chunk.type === 'finish') expect(chunk.reason).toEqual({ kind: 'stop' })
      if (chunk.type === 'block-end' && chunk.block.type === 'text') text = chunk.block.text
    }
    return JSON.parse(text!)
  }
  const save = (compactionModel: typeof summary | null) => host.api('PUT', 'settings/executor', {
    value: { ...executor, compactionModel }, revision: store.blockRevision('executor'),
  })
  expect(await request(sessionId, 'compaction')).toEqual(original)
  expect(await save(summary)).toMatchObject({ status: 200, body: { restarting: false } })
  expect(settings.block('executor').value).toMatchObject({ compactionModel: summary, model: executor.model })
  expect(await request(sessionId, 'compaction')).toEqual({ ...summary, maxTokens: limit })
  expect(await request(sessionId, 'compaction', 4096)).toEqual({ ...summary, maxTokens: 4096 })
  expect(await request(sessionId)).toEqual(original)
  expect(await request(masterId, 'compaction')).toEqual(original)
  expect(await request('worker-missing-ticket', 'compaction')).toEqual(original)
  expect(await save(null)).toMatchObject({ status: 200 })
  expect(await request(sessionId, 'compaction')).toEqual(original)
})

it('refuses an unavailable compaction model and prevents tool saves from rerouting worker history', async () => {
  const host = h = await startRuntime()
  const { settings, store } = host.runtime
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const compactionModel = { provider: 'missing', model: 'unknown' }
  const value = { ...executor, compactionModel }
  const resolve = vi.mocked(host.ctx.llm.resolveCallConfig)
  resolve.mockClear()
  await expect(settings.save('executor', value, revision, 'tool')).rejects.toMatchObject({ code: 'panelOnlyCompactionModel' })
  expect(resolve).not.toHaveBeenCalled()
  resolve.mockRejectedValueOnce(new Error('unknown provider missing'))
  expect(await host.api('PUT', 'settings/executor', { value, revision }))
    .toMatchObject({ status: 400, body: { code: 'compactionModelUnavailable' } })
  expect(store.blockRevision('executor')).toBe(revision)
  expect(store.settings().executor).toMatchObject({ compactionModel: null })
})

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<Deployment | undefined>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve(undefined)
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})

it('refuses a project switch that would reuse an unchanged custom prepare command without running it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, prepare: 'echo old-project-guard' } })
  const github = settings.block('source:github'), value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const spawnCount = h.subprocess.spawn.mock.calls.length
  expect(await h.api('PUT', 'settings/source:github', {
    value: { ...value, config: { ...value.config, repository: 'acme/other' } }, revision: github.revision,
  })).toMatchObject({ status: 400, body: { setup: { code: 'prepareProjectChanged' } } })
  expect(store.settings().sources.github!.config.repository).toBe('acme/widgets')
  expect(h.subprocess.spawn.mock.calls.length).toBe(spawnCount)
})

it.each(['repository', 'permissions'] as const)('refuses a project switch with an invalid memory %s binding before saving or restarting', async boundary => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const target = { ...h.runtime.deployment, repository: 'acme/other', webUrl: 'https://github.com/acme/other' }
  vi.spyOn(Setup.prototype, 'checkAccounts').mockResolvedValue(target)
  const restart = vi.spyOn(Setup.prototype, 'restart').mockImplementation(() => {})
  const memoryFile = join(h.directory, 'hindsight.json')
  writeFileSync(memoryFile, JSON.stringify({
    apiUrl: 'https://memory.invalid', apiToken: 'test-token', bankId: 'test-bank', projectTag: 'project:widgets',
    repository: boundary === 'repository' ? h.runtime.deployment.webUrl : target.webUrl,
  }), { mode: 0o600 })
  if (boundary === 'permissions') chmodSync(memoryFile, 0o644)
  const github = settings.block('source:github'), value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const saved = JSON.stringify(store.settings())
  expect(await h.api('PUT', 'settings/source:github', {
    value: { ...value, config: { ...value.config, repository: target.repository } }, revision: github.revision,
  })).toMatchObject({ status: 400, body: { setup: { code: boundary === 'repository' ? 'memoryRepositoryMismatch' : 'memoryConfigurationInvalid' } } })
  expect(JSON.stringify(store.settings())).toBe(saved)
  expect(restart).not.toHaveBeenCalled()
})

it('allows a reviewed project switch without retargeting tickets or migrating queued memory exports', async () => {
  h = await startRuntime()
  const { settings, store, effects } = h.runtime
  const { ticket } = await h.acceptedTicket(feishu('switch1', 'Repair existing project'))
  const before = store.tickets.get(ticket.id)!
  const pending = { scope: 'original-scope', documentId: 'original-document', content: 'Verified repair', at: new Date().toISOString(), fingerprint: 'original' }
  effects.enqueue('memory-retain', 'original-export', pending)
  const target = { ...h.runtime.deployment, repository: 'acme/other', webUrl: 'https://github.com/acme/other' }
  vi.spyOn(Setup.prototype, 'checkAccounts').mockResolvedValue(target)
  vi.spyOn(Setup.prototype, 'restart').mockImplementation(() => {})
  writeFileSync(join(h.directory, 'hindsight.json'), JSON.stringify({
    apiUrl: 'https://memory.invalid', apiToken: 'test-token', bankId: 'test-bank', projectTag: 'project:other', repository: target.webUrl,
  }), { mode: 0o600 })
  const github = settings.block('source:github'), value = github.value as { enabled: boolean; config: Record<string, unknown> }
  expect(await settings.save('source:github', { ...value, config: { ...value.config, repository: target.repository } },
    github.revision, 'panel')).toMatchObject({ saved: true, restarting: true })
  const after = store.tickets.get(ticket.id)!
  expect(after.execution).toEqual(before.execution)
  expect(after.assignments.map(row => row.id)).toEqual(before.assignments.map(row => row.id))
  expect(effects.payload('memory-retain', 'original-export')).toEqual(pending)
})

it('refuses a project switch when the prepare command changes while its account check is pending', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const target = { ...h.runtime.deployment, repository: 'acme/other', webUrl: 'https://github.com/acme/other' }
  const accounts = Promise.withResolvers<Deployment | undefined>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github'), value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const saving = settings.save('source:github', { ...value, config: { ...value.config, repository: target.repository } }, github.revision, 'panel')
  await settings.save('executor', { ...store.settings().executor, prepare: 'echo old-project-guard' }, store.blockRevision('executor'), 'panel')
  accounts.resolve(target)
  await expect(saving).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config.repository).toBe('acme/widgets')
  expect(store.settings().executor.prepare).toBe('echo old-project-guard')
})
