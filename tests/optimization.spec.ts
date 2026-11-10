import { afterEach, beforeEach, expect, it } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Effects, Later } from '../src/app/effects.ts'
import { OptimizationLedger } from '../src/app/optimization.ts'
import { HealthBoard } from '../src/infra/health.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

it('keeps failure, manual recovery and completion evidence without copying task content', async () => {
  const { ticket } = await h.acceptedTicket(feishu('optimization1', 'private task body password=never-copy-this'))
  h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'private report om_secret ou_person' })
  h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.idle()
  h.runtime.engine.report(ticket.id, { state: 'ready', summary: 'private completion' })
  const response = await h.api('GET', 'optimization/records?limit=100')
  expect(response.status).toBe(200)
  const items = response.body.items as { kind: string; status: string; ticket?: string; durationMs?: number }[]
  expect(items).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'report', status: 'blocked' }),
    expect.objectContaining({ kind: 'explicit-retry', status: 'requested' }),
    expect.objectContaining({ kind: 'ticket-ended', status: 'completed', durationMs: expect.any(Number) }),
  ]))
  expect(JSON.stringify(response.body)).not.toMatch(/never-copy-this|private report|private completion|om_secret|ou_person|ou_alice|oc_team/)
  expect(items.filter(row => row.kind === 'ticket-ended')).toHaveLength(1)
})

it('deduplicates assignment starts and discards evidence from rolled-back commands', async () => {
  const { ticket } = await h.acceptedTicket(feishu('optimization2', 'Fix a regression'))
  const assignment = ticket.assignments[0]!
  h.runtime.engine.assignmentStarted(ticket.id, assignment.id)
  h.runtime.engine.assignmentStarted(ticket.id, assignment.id)
  expect(() => h.runtime.store.atomic(() => {
    h.runtime.engine.report(ticket.id, { state: 'failed', summary: 'must roll back' })
    throw new Error('rollback')
  })).toThrow('rollback')
  const response = await h.api('GET', 'optimization/records?limit=100')
  expect(response.status).toBe(200)
  const items = response.body.items as { kind: string; status: string }[]
  expect(items.filter(row => row.kind === 'assignment-started')).toHaveLength(1)
  expect(items.some(row => row.kind === 'report' && row.status === 'failed')).toBe(false)
})

it('requires evidence for verified lessons and keeps hypotheses separate', async () => {
  const draft = { status: 'verified', problem: 'Repeated launches fail', change: 'Correct the launch boundary', validation: '', effect: 'Fewer failures', evidence: [] }
  expect(await h.api('POST', 'optimization/lessons', draft)).toMatchObject({ status: 400 })
  const hypothesis = { ...draft, status: 'hypothesis' }
  expect(await h.api('POST', 'optimization/lessons', hypothesis)).toMatchObject({ status: 200, body: { status: 'hypothesis' } })
  expect(await h.api('POST', 'optimization/lessons', { ...hypothesis, problem: 'password=do-not-store' })).toMatchObject({ status: 400 })
})

it('does not let observation storage failure change a worker report or retry behavior', async () => {
  const { ticket } = await h.acceptedTicket(feishu('optimization3', 'Fix a regression'))
  h.runtime.store.db.exec("CREATE TRIGGER reject_observation BEFORE INSERT ON optimization_record BEGIN SELECT RAISE(ABORT, 'fixture disk error'); END")
  const updated = h.runtime.engine.report(ticket.id, { state: 'failed', summary: 'worker failed' })
  expect(updated.assignments.at(-1)?.report?.state).toBe('failed')
  expect(h.runtime.health.optimization?.state).toBe('error')
  expect((await h.api('GET', 'optimization/records')).body.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'failed' })]))
  h.runtime.store.db.exec('DROP TRIGGER reject_observation')
  h.runtime.engine.retryTicket(ticket.id)
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
})

it('separates scheduled provider retries from explicit human retries', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('optimization4', 'Fix a regression'))
  h.ctx.emit('agent/error', { agent: h.agents.get(sessionId), error: Object.assign(new Error('private provider response'), { status: 429 }) } as never)
  const response = await h.api('GET', 'optimization/records')
  expect(response.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'worker-retry', status: 'scheduled', reason: 'rate-limited' })]))
  expect((response.body.items as { kind: string }[]).some(row => row.kind === 'explicit-retry')).toBe(false)
  expect(JSON.stringify(response.body)).not.toContain('private provider response')
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
})

it('retains real effect failures after recovery and reopening SQLite, but not Later holds', async () => {
  const path = join(h.directory, 'attempts.sqlite'), store = new Store(path), board = new HealthBoard()
  let clock = Date.now(), outcome = 'hold'
  const ledger = new OptimizationLedger(store, board.claim('optimization'), () => {}, () => clock)
  const effects = new Effects(store, board, () => clock, attempt => ledger.effect(attempt))
  effects.handle('notice', async () => {
    if (outcome === 'hold') throw new Later('paused')
    if (outcome === 'fail') throw Object.assign(new Error('password=do-not-copy'), { code: 'ETIMEDOUT' })
  }, { retry: [10, 100] })
  try {
    effects.enqueue('notice', 'fixed', { value: { private: 'payload' }, summary: 'private summary' })
    effects.start(); await effects.idle()
    expect(ledger.records().items).toEqual([])
    clock += 10; outcome = 'fail'; await effects.idle()
    clock += 10; outcome = 'ok'; await effects.idle()
    expect(effects.pending('notice')).toBe(false)
    expect(ledger.summary().groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'effect-attempt', status: 'failed', reason: 'timeout', count: 1 }),
      expect.objectContaining({ kind: 'effect-attempt', status: 'succeeded', count: 1 }),
    ]))
    expect(JSON.stringify(ledger.records())).not.toMatch(/do-not-copy|private summary|payload/)
  } finally { await effects.drain(); store.close() }
  const reopened = new Store(path), second = new OptimizationLedger(reopened, new HealthBoard().claim('optimization'), () => {}, () => clock)
  try { expect(second.records().items.map(row => row.status).sort()).toEqual(['failed', 'succeeded']) } finally { reopened.close() }
})

it('keeps pagination stable within a fixed time window and rejects invalid bounds', async () => {
  const { ticket } = await h.acceptedTicket(feishu('optimization5', 'Fix a regression'))
  h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'blocked' })
  const first = await h.api('GET', 'optimization/records?limit=1')
  const until = String(first.body.until)
  const second = await h.api('GET', `optimization/records?limit=1&offset=1&until=${encodeURIComponent(until)}`)
  const a = first.body.items as { id: string }[], b = second.body.items as { id: string }[]
  expect(first.body.next_offset).toBe(1)
  expect(a[0]!.id).not.toBe(b[0]!.id)
  expect(await h.api('GET', 'optimization/records?limit=101')).toMatchObject({ status: 400 })
  expect(await h.api('GET', 'optimization?since=2027-01-01T00:00:00Z&until=2026-01-01T00:00:00Z')).toMatchObject({ status: 400 })
  const empty = await h.api('GET', 'optimization/records?since=2020-01-01T00:00:00Z&until=2020-01-02T00:00:00Z')
  expect(empty.body.items).toEqual([])
})

it('expires runtime evidence after ninety days without expiring recorded lessons', () => {
  const store = new Store(join(h.directory, 'retention.sqlite')), board = new HealthBoard()
  let clock = Date.now()
  const ledger = new OptimizationLedger(store, board.claim('optimization'), () => {}, () => clock)
  try {
    ledger.effect({ id: 'old', kind: 'notice', at: new Date(clock).toISOString(), durationMs: 2, status: 'failed' })
    ledger.saveLesson({ status: 'hypothesis', problem: 'Observation', change: 'Candidate', validation: '', effect: '', evidence: [] })
    clock += 91 * 86_400_000
    ledger.effect({ id: 'new', kind: 'notice', at: new Date(clock).toISOString(), durationMs: 1, status: 'succeeded' })
    expect(ledger.records().items.map(row => row.id)).toEqual(['new'])
    expect(store.db.prepare('SELECT id FROM optimization_record').all()).toEqual([{ id: 'new' }])
    expect(ledger.lessons().items[0]?.status).toBe('hypothesis')
  } finally { store.close() }
})

it('records terminal provider failures at the execution boundary rather than inventing a root cause', async () => {
  const { sessionId } = await h.acceptedTicket(feishu('optimization6', 'Fix a regression'))
  h.ctx.emit('agent/error', { agent: h.agents.get(sessionId), error: new Error('private nonretryable provider diagnostic') } as never)
  await h.runtime.idle()
  const response = await h.api('GET', 'optimization/records')
  expect(response.body.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'worker-failure', component: 'execution', status: 'failed', reason: 'unknown' }),
  ]))
})

it('does not merge distinct report transitions that share a millisecond', async () => {
  const { ticket } = await h.acceptedTicket(feishu('optimization7', 'Fix a regression'))
  const at = new Date().toISOString()
  for (const state of ['blocked', 'progress', 'blocked'] as const) h.runtime.optimization.domain({
    type: 'assignment.reported', at, data: { ticketId: ticket.id, assignmentId: ticket.assignments[0]!.id, state },
  })
  const response = await h.api('GET', 'optimization/records')
  expect((response.body.items as { kind: string; status: string }[]).filter(row => row.kind === 'report' && row.status === 'blocked')).toHaveLength(2)
})

it('keeps initialization failure visible until a new recorder can actually persist evidence', () => {
  const store = new Store(join(h.directory, 'initialization.sqlite')), board = new HealthBoard()
  try {
    store.db.exec('PRAGMA query_only = ON')
    const ledger = new OptimizationLedger(store, board.claim('optimization'), () => {})
    expect(board.all.optimization?.state).toBe('error')
    store.db.exec('PRAGMA query_only = OFF')
    ledger.effect({ id: 'not-recorded', kind: 'notice', at: new Date().toISOString(), durationMs: 1, status: 'succeeded' })
    expect(board.all.optimization?.state).toBe('error')
    const restarted = new HealthBoard(), recovered = new OptimizationLedger(store, restarted.claim('optimization'), () => {})
    recovered.effect({ id: 'recorded', kind: 'notice', at: new Date().toISOString(), durationMs: 1, status: 'succeeded' })
    expect(restarted.all.optimization?.state).toBe('ready')
    expect(recovered.records().items.map(row => row.id)).toEqual(['recorded'])
  } finally { store.close() }
})
