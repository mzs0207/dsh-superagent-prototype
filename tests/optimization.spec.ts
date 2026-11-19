import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Effects, Later } from '../src/app/effects.ts'
import { OptimizationLedger } from '../src/app/optimization.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Commands } from '../src/infra/commands.ts'

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

it('replaces an edited lesson under a stable id instead of leaving the stale version beside it', async () => {
  const lesson = { id: 'a'.repeat(8), status: 'hypothesis', problem: 'Launch times out', change: 'Raise the limit',
    validation: '', effect: '', evidence: [] }
  const created = await h.api('POST', 'optimization/lessons', lesson)
  expect(created).toMatchObject({ status: 200, body: { id: lesson.id } })
  const edited = await h.api('POST', 'optimization/lessons', { ...lesson, change: 'Raise the limit and retry once' })
  expect(edited).toMatchObject({ status: 200, body: { change: 'Raise the limit and retry once' } })
  // The edit keeps the lesson's original timestamp and leaves exactly one row: no stale duplicate is readable.
  expect(edited.body).toMatchObject({ at: (created.body as { at: string }).at })
  const lessons = await h.api('GET', 'optimization/lessons')
  expect((lessons.body as { items: { change: string }[] }).items).toEqual([expect.objectContaining({ change: 'Raise the limit and retry once' })])
})

it('states both retention lifetimes so no consumer mistakes one for the other', async () => {
  const summary = await h.api('GET', 'optimization')
  expect(summary.body).toMatchObject({ retentionDays: 90, lessonRetention: 'indefinite' })
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

it('does not clear a failed report observation on a no-op wait update', async () => {
  const { ticket } = await h.acceptedTicket(feishu('health-no-op', 'Fix a regression'))
  const report = { state: 'blocked' as const, summary: 'Waiting for a decision' }
  h.runtime.engine.report(ticket.id, report)
  h.runtime.store.db.exec(`CREATE TRIGGER reject_report BEFORE INSERT ON optimization_record
    WHEN json_extract(NEW.value, '$.kind') = 'report'
    BEGIN SELECT RAISE(ABORT, 'fixture disk error'); END`)
  h.runtime.engine.report(ticket.id, report)
  expect(h.runtime.health.optimization?.state).toBe('error')
  h.runtime.store.db.exec('DROP TRIGGER reject_report')
  h.runtime.engine.report(ticket.id, report)
  expect(h.runtime.health.optimization?.state).toBe('ready')
})

it('keeps health in error when a report fails but its wait is committed in the same transaction', async () => {
  const { ticket } = await h.acceptedTicket(feishu('health-mixed', 'Fix a regression'))
  h.runtime.store.db.exec(`CREATE TRIGGER reject_report BEFORE INSERT ON optimization_record
    WHEN json_extract(NEW.value, '$.kind') = 'report'
    BEGIN SELECT RAISE(ABORT, 'fixture disk error'); END`)
  h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Waiting for a decision' })
  expect(h.runtime.health.optimization?.state).toBe('error')
  const { items } = (await h.api('GET', 'optimization/records')).body
  expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'blocker-wait', status: 'started' })]))
  h.runtime.store.db.exec('DROP TRIGGER reject_report')
  h.runtime.engine.report(ticket.id, { state: 'progress', summary: 'Resumed' })
  expect(h.runtime.health.optimization?.state).toBe('ready')
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

it('records renewed-login errors as terminal even through a transient-looking wrapper', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('renew-login', 'Repair the parser'))
  const error = Object.assign(new Error('HTTP 503 with private diagnostic', {
    cause: { code: 'AUTH', message: 'ChatGPT sign-in needs to be renewed' },
  }), { status: 503 })
  h.ctx.emit('agent/error', { agent: h.agents.get(sessionId), error } as never)
  await h.runtime.idle()
  const { items } = (await h.api('GET', 'optimization/records')).body
  expect(items).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'worker-failure', component: 'execution', reason: 'auth-required' }),
  ]))
  expect(items).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'worker-retry' })]))
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toMatchObject({
    state: 'failed', summary: expect.stringContaining('Sign in again'),
  })
  expect(JSON.stringify(items)).not.toContain('private diagnostic')
})

it('classifies generic 401 responses without telling the operator to sign in again', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('provider-credentials', 'Repair the parser'))
  h.runtime.optimization.effect({ id: 'unauthenticated-reply', kind: 'reply', at: new Date().toISOString(),
    durationMs: 1, status: 'failed', error: { status: 401, message: 'Reply credential was rejected' } })
  h.ctx.emit('agent/error', { agent: h.agents.get(sessionId), error: Object.assign(new Error('Upstream HTTP 503', {
    cause: { status: 401, message: 'API key rejected' },
  }), { status: 503 }) } as never)
  await h.runtime.idle()
  const { items } = (await h.api('GET', 'optimization/records')).body
  expect(items).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'effect-attempt', component: 'reply', reason: 'authentication-failed' }),
    expect.objectContaining({ kind: 'worker-failure', component: 'execution', reason: 'authentication-failed' }),
    expect.objectContaining({ kind: 'blocker-wait', status: 'started', reason: 'authentication-failed' }),
  ]))
  expect(items).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'worker-retry' })]))
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toMatchObject({
    state: 'failed', summary: expect.stringContaining('Check the model provider credentials'),
  })
  expect(JSON.stringify(items)).not.toContain('API key rejected')
})

it('reports a launch 401 without implying the model provider rejected its credentials', async () => {
  vi.spyOn(h.runtime.sessions, 'ensure').mockRejectedValueOnce(Object.assign(new Error('Workspace credentials rejected'), { status: 401 }))
  const { ticket } = await h.acceptedTicket(feishu('launch-credentials', 'Repair the parser'))
  const { items } = (await h.api('GET', 'optimization/records')).body
  expect(items).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'worker-failure', component: 'launch', reason: 'authentication-failed' }),
  ]))
  expect(ticket.assignments.at(-1)?.report).toMatchObject({
    state: 'failed', summary: expect.stringContaining('Check the credentials used during worker startup'),
  })
})

it.each(['startup', 'execution'] as const)('notifies the requester of %s failure without copying raw host diagnostics', async phase => {
  const sent = vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({})
  const diagnostic = 'Private diagnostic: token=synthetic-private-value'
  if (phase === 'startup') {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
      prepare: `printf '%s\\n' '${diagnostic}' >&2; exit 23` } })
    const fallback = h.subprocess.spawn.getMockImplementation()!
    h.subprocess.spawn.mockImplementation(spec => {
      const handle = fallback(spec)
      if (spec.argv[0] !== 'sh') return handle
      const result = spawnSync(spec.argv[0], spec.argv.slice(1), { encoding: 'utf8' })
      return { done: Promise.resolve({ exitCode: result.status ?? 1, signal: null }),
        collected: { ...handle.collected, stderr: { readFrom: () => ({
          text: result.stderr, nextOffset: result.stderr.length, lossy: false,
        }) } } }
    })
  }
  const { sessionId, ticket } = await h.acceptedTicket(feishu('private-failure', 'Repair the parser'))
  if (phase === 'execution') {
    h.ctx.emit('agent/error', { agent: h.agents.get(sessionId), error: new Error(diagnostic) } as never)
    await h.runtime.idle()
  }
  const notices = sent.mock.calls.filter(([args]) => args[1] === '+messages-reply')
  expect(JSON.stringify(notices)).toContain(`Worker ${phase} failed`)
  expect(JSON.stringify(notices)).not.toContain('synthetic-private-value')
  if (phase === 'startup') {
    expect(h.agents.has(sessionId)).toBe(false)
    const path = join(h.runtime.machine.stateDir, 'prepare-failure.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ ticketId: ticket.id, detail: expect.stringContaining(diagnostic) })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const records = (await h.api('GET', 'optimization/records')).body.items
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ component: 'prepare', reason: 'prepare-failed' })]))
    expect(JSON.stringify(records)).not.toContain(diagnostic)
  }
})

it('measures a reported wait once per intervention episode and links its end to its start', async () => {
  const { ticket } = await h.acceptedTicket(feishu('wait-ledger', 'Repair the parser'))
  const report = { state: 'blocked' as const, summary: 'private blocker summary', waitReason: 'approval' as const }
  const start = Date.now() + 100
  try {
    vi.setSystemTime(start)
    h.runtime.engine.report(ticket.id, report)
    expect(h.runtime.receive(feishu('wait-followup', 'Still checking the approval', { root_id: 'om_wait-ledger' }))).toBe('stored')
    expect(h.runtime.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'trigger'
      && h.runtime.store.triggers.get(input.triggerId)?.text === 'Still checking the approval')).toBe(true)
    vi.setSystemTime(start + 1_000)
    h.runtime.engine.report(ticket.id, report)
    vi.setSystemTime(start + 3_000)
    h.runtime.engine.report(ticket.id, { state: 'progress', summary: 'Resumed' })
    vi.setSystemTime(start + 5_000)
    h.runtime.engine.report(ticket.id, report)
    const { items } = (await h.api('GET', 'optimization/records?limit=100')).body
    const waits = (items as { kind: string; episode: string; at: string }[])
      .filter(row => row.kind === 'blocker-wait').reverse()
    expect(waits).toEqual([
      expect.objectContaining({ status: 'started', reason: 'approval', at: new Date(start).toISOString() }),
      expect.objectContaining({ status: 'cleared', reason: 'approval', durationMs: 3_000, episode: waits[0]?.episode }),
      expect.objectContaining({ status: 'started', reason: 'approval', at: new Date(start + 5_000).toISOString() }),
    ])
    expect(waits[2]?.episode).not.toBe(waits[0]?.episode)
    expect(JSON.stringify(waits)).not.toContain('private blocker summary')
  } finally { vi.useRealTimers() }
})

it('separates replaced attention from a ticket that ended without resuming', async () => {
  const { ticket } = await h.acceptedTicket(feishu('wait-replaced', 'Repair the parser'))
  h.runtime.engine.report(ticket.id, { state: 'progress', summary: 'Working', question: 'First request', waitReason: 'missing-input' })
  h.runtime.engine.report(ticket.id, { state: 'progress', summary: 'Working', question: 'Second request', waitReason: 'external' })
  h.runtime.engine.stopTicket(ticket.id)
  const { items } = (await h.api('GET', 'optimization/records?limit=100')).body
  const waits = (items as { kind: string }[]).filter(row => row.kind === 'blocker-wait')
  expect(waits).toHaveLength(4)
  expect(waits).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'replaced', reason: 'missing-input', durationMs: expect.any(Number) }),
    expect.objectContaining({ status: 'ended', reason: 'external', durationMs: expect.any(Number) }),
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

it('retains nested cleanup failure codes without reopening a completed ticket or copying private diagnostics', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('cleanup1', 'Repair the parser'))
  const job = h.jobs.run(sessionId)
  h.jobs.service.kill.mockImplementationOnce(() => {
    h.jobs.end(job)
    throw Object.assign(new Error('password=never-copy-this ou_private'), { code: 'ETIMEDOUT' })
  })
  h.runtime.engine.report(ticket.id, { state: 'ready', summary: 'Completed' })
  await h.runtime.idle()
  const records = (await h.api('GET', 'optimization/records')).body.items
  expect(records).toEqual(expect.arrayContaining([expect.objectContaining({
    kind: 'worker-failure', component: 'cleanup', status: 'failed', reason: 'timeout',
    errors: expect.arrayContaining([expect.objectContaining({ name: 'Error', code: 'ETIMEDOUT' })]),
  })]))
  expect(h.runtime.health.worker).toMatchObject({ state: 'error', detail: expect.stringContaining('ETIMEDOUT') })
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  expect(JSON.stringify([records, h.runtime.health.worker])).not.toMatch(/never-copy-this|ou_private/)
})

it('bounds cyclic aggregate diagnostics and excludes arbitrary names, codes and error messages', async () => {
  const { ticket } = await h.acceptedTicket(feishu('diagnostic1', 'Repair the parser'))
  const root = new AggregateError([], 'private root diagnostic')
  const nested = Object.assign(new TypeError('private inner diagnostic'), { cause: root, code: 'secret-value' })
  root.errors.push(root, nested, ...Array.from({ length: 20 }, () => new Error('private extra diagnostic')))
  h.runtime.optimization.workerFailure(ticket.id, 'execution', root)
  const records = (await h.api('GET', 'optimization/records')).body.items as { kind: string; reason?: string; errors?: unknown[] }[]
  const failure = records.find(row => row.kind === 'worker-failure')!
  expect(failure.reason).toBe('type-error')
  expect(failure.errors).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'TypeError' })]))
  expect(failure.errors!.length).toBeLessThanOrEqual(8)
  expect(JSON.stringify(failure)).not.toMatch(/private|secret-value/)
})
