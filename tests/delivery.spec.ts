import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { AgentDelivery } from '../src/app/delivery.ts'
import { Later } from '../src/app/effects.ts'

function fixture(history: UserMessage[] = []) {
  const ctx = new Context()
  const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
  const steer = vi.fn((message: UserMessage) => { inbox.nextStep.push(message) })
  const followup = vi.fn((message: UserMessage) => { inbox.nextTurn.push(message) })
  const injected = vi.fn((_message: UserMessage) => {})
  const appended = vi.fn((_type: string, message: UserMessage) => { history.push(message) })
  // Only the delivery-facing Agent methods participate in this fixture.
  const agent = { id: SessionId('delivery-test'), session: { append: appended, snapshotEvents: () => [] }, inbox, steer, followup, inject: injected } as unknown as Agent
  const event = (message: UserMessage): SessionEvent => ({ type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append', data: message })
  const read = vi.fn(async (offset: number, length: number) => ({ events: history.slice(offset, offset + length).map(event) }))
  const close = vi.fn(async () => {})
  const flush = vi.fn(async () => {})
  const open = vi.fn(async () => ({ read, [Symbol.asyncDispose]: close }))
  const agents = new Map([[agent.id, agent]])
  ctx.reflect.provide('agents', agents)
  ctx.reflect.provide('sessionPersistence', { open, flush })
  const delivery = new AgentDelivery(ctx)
  const signal = new AbortController()
  const send = (id = 'request', mode: 'queue' | 'steer' = 'steer') => delivery.send(agent, id, '{"event_id":"event"}', mode, signal.signal)
  const inject = (id: string, summary: string) => delivery.send(agent, id, '{"settings_saved":"policy"}', { inject: summary }, signal.signal)
  const holds = (id: string) => delivery.holds(agent, id)
  const consume = (message: UserMessage) => {
    inbox.nextStep.splice(0); inbox.nextTurn.splice(0)
    ctx.emit('session/event', agent.session, event(message))
  }
  return { agent, agents, inbox, steer, followup, injected, appended, delivery, open, read, close, flush, send, inject, holds, consume, signal }
}

it.each(['queue', 'steer'] as const)('delivers %s as an orchestrator relay, deduplicating pending and consumed messages', async mode => {
  const f = fixture()
  await f.send('request', mode)
  const target = mode === 'queue' ? f.followup : f.steer
  expect(target).toHaveBeenCalledOnce()
  const message = target.mock.calls[0]![0]
  expect(message.role).toBe('user')
  expect(message.source).toEqual({ kind: 'dsh-superagent', form: 'relay' })
  expect(Object.isFrozen(message)).toBe(true)
  await f.send('request', mode)
  f.consume(message)
  await f.send('request', mode)
  expect(target).toHaveBeenCalledOnce()
  expect(f.open).toHaveBeenCalledOnce()
  expect(f.close).toHaveBeenCalledOnce()
  const restored = fixture([message])
  await restored.send('request', mode)
  expect(restored.steer).not.toHaveBeenCalled()
  expect(restored.followup).not.toHaveBeenCalled()
})

it.each(['pending', 'consumed', 'live'] as const)('recognizes legacy plugin identity in %s input without rewriting it', async location => {
  // Bypass TypeScript's current source union to construct the retired serialized shape.
  const old: UserMessage = JSON.parse(JSON.stringify({ id: 'dsh-superagent:request', role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-superagent', form: 'relay' } }))
  const before = JSON.stringify(old)
  const f = fixture(location === 'consumed' ? [old] : [])
  if (location === 'pending') f.inbox.nextTurn.push(old)
  if (location === 'live') f.read.mockImplementationOnce(async () => { f.consume(old); return { events: [] } })
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(JSON.stringify(old)).toBe(before)
  await f.send('different-request')
  expect(f.steer).toHaveBeenCalledOnce()
})

it.each(['another-plugin', undefined])('does not treat a legacy plugin source %s as this producer', async plugin => {
  const old: UserMessage = JSON.parse(JSON.stringify({ id: 'dsh-superagent:request', role: 'user', content: [], source: { kind: 'plugin', plugin, form: 'relay' } }))
  const f = fixture([old])
  await f.send()
  expect(f.steer).toHaveBeenCalledOnce()
})

it.each(['pending', 'consumed'] as const)('recognizes legacy user RPC identity in %s input', async location => {
  const old = createUserMessage({ content: [{ type: 'text', text: 'old relay' }], source: { kind: 'user', rpcId: 'request' } })
  const f = fixture(location === 'consumed' ? [old] : [])
  if (location === 'pending') f.inbox.nextTurn.push(old)
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(old.source.kind).toBe('user')
  await f.send('different-request')
  expect(f.steer).toHaveBeenCalledOnce()
})

it('retries a failed durability barrier without another delivery and permits concurrent retries', async () => {
  const f = fixture()
  f.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk busy'))
  await expect(f.send()).rejects.toThrow('disk busy')
  f.consume(f.steer.mock.calls[0]![0])
  await Promise.all([f.send(), f.send()])
  expect(f.steer).toHaveBeenCalledOnce()
  expect(f.flush).toHaveBeenCalledTimes(4)
})

it('retries history failures and reads past the first page', async () => {
  const old = createUserMessage({ content: [], source: { kind: 'user', rpcId: 'request' } })
  const f = fixture([...Array.from({ length: 512 }, () => createUserMessage({ content: [], source: { kind: 'user' } })), old])
  f.read.mockRejectedValueOnce(new Error('read failed'))
  await expect(f.send()).rejects.toThrow('read failed')
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledTimes(2)
})

it('keeps consumption that happens during the initial history read', async () => {
  const f = fixture()
  const old = createUserMessage({ content: [], source: { kind: 'user', rpcId: 'request' } })
  f.read.mockImplementationOnce(async () => { f.consume(old); return { events: [] } })
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
})

it('does not dispatch when cancelled or disposed during history loading', async () => {
  const cancelled = fixture()
  cancelled.read.mockImplementationOnce(async () => { cancelled.signal.abort(); return { events: [] } })
  await expect(cancelled.send()).rejects.toThrow()
  expect(cancelled.steer).not.toHaveBeenCalled()
  const disposed = fixture()
  disposed.read.mockImplementationOnce(async () => { disposed.agents.clear(); return { events: [] } })
  await expect(disposed.send()).rejects.toThrow('disposed')
  expect(disposed.steer).not.toHaveBeenCalled()
})

it('injects a notice once, as dsh-superagent\'s notice with its summary, without waking the agent', async () => {
  const f = fixture()
  await f.inject('notice:settings', 'Settings saved')
  await f.inject('notice:settings', 'Settings saved')
  expect(f.injected).toHaveBeenCalledOnce()
  expect(f.injected.mock.calls[0]![0]).toMatchObject({ role: 'user', source: { kind: 'dsh-superagent', form: 'notice', summary: 'Settings saved' } })
  expect([f.steer, f.followup].map(spy => spy.mock.calls.length)).toEqual([0, 0])
})

it('persists a visible notice immediately without leaving it in an idle worker inbox or waking a model', async () => {
  const f = fixture(), text = '需要你处理：请确认最低支持版本。'
  await f.delivery.send(f.agent, 'visible', text, { display: '需要你处理' }, f.signal.signal)
  await f.delivery.send(f.agent, 'visible', text, { display: '需要你处理' }, f.signal.signal)
  expect(f.appended).toHaveBeenCalledExactlyOnceWith('user/message', expect.objectContaining({
    content: [{ type: 'text', text }], source: { kind: 'dsh-superagent', form: 'notice', summary: '需要你处理' },
  }), { surfaceOp: 'append' })
  expect([f.steer, f.followup, f.injected].map(spy => spy.mock.calls.length)).toEqual([0, 0, 0])
  const restored = fixture([f.appended.mock.calls[0]![1]])
  await restored.delivery.send(restored.agent, 'visible', text, { display: '需要你处理' }, restored.signal.signal)
  expect(restored.appended).not.toHaveBeenCalled()
})

it('waits for all tool results in a real SDK step before adding a visible notice to model history', async () => {
  const f = fixture(), session = Session.create(f.agent.id)
  Object.assign(f.agent, { session })
  const calls = [ToolCallId('report'), ToolCallId('parallel')]
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    content: calls.map(id => ({ type: 'tool-call', id, name: 'orchestrator_report', arguments: '{}' })),
    source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
  for (const callId of calls) session.append('tool/call', { turn: 1, step: 1, callId, name: 'orchestrator_report', arguments: '{}' })
  const show = () => f.delivery.send(f.agent, 'visible', '需要你处理', { display: '需要你处理' }, f.signal.signal)
  await expect(show()).rejects.toBeInstanceOf(Later)
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
    callId: calls[0]!, content: [{ type: 'text', text: 'reported' }], isError: false,
  }) }, { surfaceOp: 'append' })
  await expect(show()).rejects.toBeInstanceOf(Later)
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
    callId: calls[1]!, content: [{ type: 'text', text: 'done' }], isError: false,
  }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  await show()
  expect(session.snapshotEvents().map(event => event.type)).toEqual([
    'turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/call', 'tool/result', 'tool/result', 'step/end', 'user/message',
  ])
})

it('tells whether the Session holds a message: one waiting in its inbox, one it took, and one in its stored history', async () => {
  const f = fixture()
  expect(await f.holds('request')).toBe(false)
  await f.send('request')
  expect(await f.holds('request')).toBe(true)
  f.consume(f.steer.mock.calls[0]![0])
  expect([f.inbox.nextStep.length, await f.holds('request')]).toEqual([0, true])
  const restored = fixture([f.steer.mock.calls[0]![0]])
  expect([await restored.holds('request'), await restored.holds('other')]).toEqual([true, false])
})
