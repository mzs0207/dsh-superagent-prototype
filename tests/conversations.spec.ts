import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

it('stops a worker through its ticket, including background work and the mandate', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('mobile-stop', 'Fix the regression'))
  const job = h.jobs.run(sessionId, 'build')
  const response = await h.api('POST', `conversations/${sessionId}/stop`, {})
  expect(response.status).toBe(200)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
  expect(h.jobs.service.list(sessionId).find(item => item.id === job)?.status).toBe('killed')
  expect(h.agents.get(sessionId)?.status).toBe('idle')
})

it('lists desktop conversations with roles without leaking paths or arbitrary projections', async () => {
  Object.assign(h.controller, { list: async () => ({ items: [
    { sessionId: h.runtime.masterId, running: true, updatedAt: 20, projections: { values: { title: '调度', secret: 'private-token' } }, cwd: '/private' },
    { sessionId: 'normal', running: false, updatedAt: 10, projections: { values: { title: '<script>unsafe</script>' } } },
    { sessionId: 'child', origin: 'subagent', updatedAt: 5 },
  ] }) })
  const response = await h.api('GET', 'conversations?offset=0')
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ items: [
    { id: h.runtime.masterId, kind: 'orchestrator', title: '调度', running: true },
    { id: 'normal', kind: 'conversation', title: '<script>unsafe</script>' },
  ], total: 2, next_offset: null })
  expect(JSON.stringify(response.body)).not.toMatch(/private|secret|cwd/)
})

it('keeps human transcript history, omitting replacement copies, credentials and reasoning', async () => {
  const event = (seq: number, type: string, data: unknown, surfaceOp: unknown = 'append') => ({ type: 'event', event: { seq, time: seq, type, data, surfaceOp } })
  Object.assign(h.controller, { page: async () => ({ hasMore: true, records: [
    event(1, 'request/start', { apiKey: 'private-token' }),
    event(2, 'user/message', { role: 'user', content: [{ type: 'text', text: '原问题' }], source: { kind: 'user', rpcId: 'request-1' } }),
    event(3, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'private-reasoning' }, { type: 'text', text: '原回复' }] } }),
    event(4, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '压缩副本' }] } }, { op: 'replace', startSeq: 2, endSeq: 3 }),
  ] }) })
  const response = await h.api('GET', 'conversations/normal/history?through=10&before=8')
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ messages: [
    { seq: 2, role: 'user', text: '原问题', requestId: 'request-1' },
    { seq: 3, role: 'assistant', text: '原回复' },
  ], before: 1, hasMore: true })
  expect(JSON.stringify(response.body)).not.toMatch(/private|压缩副本|apiKey/)
})

it('rejects empty prompts, oversized text and injected create options before activating an agent', async () => {
  const before = h.agents.size
  for (const body of [{ requestId: 'r', text: '   ' }, { requestId: 'r', text: 'x'.repeat(32001) },
    { requestId: 'r', text: 'hello', cwd: '/private' }]) {
    expect((await h.api('POST', 'conversations/normal/messages', body)).status).toBe(400)
  }
  expect((await h.api('POST', 'conversations', { requestId: 'r', agentPreset: 'dsh-superagent-worker' })).status).toBe(400)
  expect(h.agents.size).toBe(before)
  expect(h.controller.prompt).not.toHaveBeenCalled()
})

it('retains interrupted assistant text and distinguishes injected context from the human', async () => {
  Object.assign(h.controller, { page: async () => ({ hasMore: false, records: [
    { type: 'event', event: { seq: 1, time: 1, type: 'user/message', surfaceOp: 'append',
      data: { role: 'user', content: [{ type: 'text', text: 'Runtime context' }], source: { kind: 'runtime-context', form: 'snapshot' } } } },
    { type: 'event', event: { seq: 2, time: 2, type: 'assistant/attempt',
      data: { stream: [{ type: 'text-chunks', time0: 2, index: 0, dt: [0, 1], texts: ['部分', '回复'] }] } } },
  ] }) })
  const response = await h.api('GET', 'conversations/normal/history?through=3&before=3')
  expect(response.body).toMatchObject({ messages: [
    { seq: 1, role: 'context', text: 'Runtime context' },
    { seq: 2, role: 'assistant', text: '部分回复', interrupted: true },
  ] })
})

it('shows cancellation and provider failures after reopening history', async () => {
  Object.assign(h.controller, { page: async () => ({ hasMore: false, records: [
    { type: 'event', event: { seq: 1, time: 1, type: 'assistant/message', surfaceOp: 'append',
      data: { interrupted: true, message: { role: 'assistant', content: [{ type: 'text', text: '停止前的文字' }] } } } },
    { type: 'event', event: { seq: 2, time: 2, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Provider unavailable' } } } } },
  ] }) })
  const response = await h.api('GET', 'conversations/normal/history?through=3&before=3')
  expect(response.body).toMatchObject({ messages: [
    { role: 'assistant', text: '停止前的文字', interrupted: true },
    { role: 'status', text: 'Provider unavailable' },
  ] })
})

it('admits a retried message once across the claimed-before-history gap and concurrent requests', async () => {
  const id = 'mobile-deduplication'
  await h.controller.create({ sessionId: id })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const delivered: string[] = []
  Object.assign(h.controller, { prompt: async (request: { content: { text: string }[] }) => {
    delivered.push(request.content[0]!.text); entered.resolve()
    await release.promise
    return { accepted: true }
  } })
  const body = { requestId: 'stable-id', text: '只执行一次' }
  const first = h.api('POST', `conversations/${id}/messages`, body)
  await entered.promise
  const concurrent = h.api('POST', `conversations/${id}/messages`, body)
  release.resolve()
  expect((await first).status).toBe(200)
  expect((await concurrent).status).toBe(200)
  expect((await h.api('POST', `conversations/${id}/messages`, body)).status).toBe(200)
  expect(delivered).toEqual(['只执行一次'])
})
