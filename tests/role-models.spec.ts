import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const projection = modelSelectionProjectionDefinition
  const host = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
  const model = new AgentModel(() => session.snapshotEvents().reduce(projection.apply, projection.init(session.header, session.inheritedEventCount)), session, host)
  return { ctx, agent: { session, model }, host, resolve, flush }
}
it('records the role route through native Agent selection without changing host defaults', async () => {
  const { ctx, agent, host, flush } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  const selected = { provider: 'worker-provider', model: 'worker-model' }
  expect(agent.model.current()).toEqual(selected)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  expect(flush).toHaveBeenCalledOnce()
  expect(host).toEqual({ provider: 'host', model: 'default', reasoningEffort: 'high' })
  agent.session.append('request/header', { header: { config: selected }, reason: 'initial' })
  expect(agent.model.current()).toEqual(selected)
})
it('preserves a later explicit selection over the role default', async () => {
  const { ctx, agent } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  agent.model.select(manual)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  expect(agent.model.current()).toEqual(manual)
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  expect(agent.model.current()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})
