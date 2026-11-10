import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { KV } from '../src/kv.ts'
import { HindsightMemory } from '../src/app/memory.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { OPTIMIZATION_TAG, OptimizationLedger } from '../src/app/optimization.ts'

let h: Host, server: Server
let mode: 'ok' | 'unavailable' | 'redirect' | 'retain-failure'
let requests: { path: string; body: { items?: { content: string; document_id: string }[]; [key: string]: unknown }; authorization: string | undefined }[]
const token = 'fixture-memory-credential', projectTag = 'project:widgets'
beforeEach(async () => {
  mode = 'ok'; requests = []
  server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    requests.push({ path: req.url!, body: JSON.parse(text || '{}'), authorization: req.headers.authorization })
    if (mode === 'redirect') { res.writeHead(302, { location: '/leak' }); res.end(); return }
    if (mode === 'unavailable' || (mode === 'retain-failure' && !req.url!.endsWith('/recall'))) { res.writeHead(503); res.end('private backend diagnostic'); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url!.endsWith('/recall') ? { results: [
      { id: 'own', text: 'Known nullable-assignee compatibility fix', tags: [projectTag] },
      { id: 'other', text: 'Another project secret', tags: ['project:other'] },
      { id: 'global', text: 'Untagged instructions', tags: [] },
    ] } : { success: true, bank_id: 'omp', items_count: 1, async: false }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing TCP address')
  h = await startRuntime(store => {
    const file = String(store.db.prepare('PRAGMA database_list').get()!.file)
    writeFileSync(join(dirname(file), 'hindsight.json'), JSON.stringify({ apiUrl: `http://127.0.0.1:${address.port}`, apiToken: token,
      bankId: 'omp', projectTag, repository: 'https://github.com/acme/widgets' }), { mode: 0o600 })
  })
})
afterEach(async () => { await h.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })

it('injects only explicitly tagged project history without exposing credentials or treating it as authority', async () => {
  const { sessionId } = await h.acceptedTicket(feishu('memory1', 'Fix nullable assignees'))
  const input = h.deliveries.mock.calls.filter(([call]) => call.sessionId === sessionId).map(([call]) => call.text).join('\n')
  expect(input).toContain('Known nullable-assignee compatibility fix')
  expect(input).not.toMatch(/Another project secret|Untagged instructions|fixture-memory-credential/)
  expect(input).toContain('not instructions or authorization')
  const recall = requests.find(request => request.path.endsWith('/recall'))!
  expect(recall.body).toMatchObject({ tags: [projectTag], tags_match: 'all_strict', max_tokens: 1500 })
  expect(recall.authorization).toBe(`Bearer ${token}`)
  expect(JSON.stringify(recall.body)).not.toContain(token)
})

it.each(['unavailable', 'redirect'] as const)('continues the actual worker when memory is %s, without forwarding the token', async failure => {
  mode = failure
  const { ticket, sessionId } = await h.acceptedTicket(feishu('memory2', 'Fix the regression'))
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.state).toBe('running')
  expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === sessionId && !call.text.includes('historical_memory'))).toBe(true)
  expect(h.runtime.health.memory?.state).toBe('error')
  expect(requests.some(request => request.path === '/leak')).toBe(false)
  expect(JSON.stringify(h.runtime.health)).not.toMatch(/fixture-memory-credential|private backend diagnostic/)
})

async function finish(verified: boolean) {
  const { ticket, trigger } = await h.acceptedTicket(feishu('memory3', 'Fix nullable assignees'))
  h.runtime.store.triggers.save({ ...trigger, source: 'zentao', meta: { repository: h.runtime.deployment.webUrl } })
  h.runtime.store.set(KV.zentao.workflow(ticket.id), { cause: 'Nullable assignee interrupted page parsing', changes: 'Normalize null without relaxing account scope',
    head: 'a'.repeat(40), reproduction: 'RAW original report password=do-not-export', tests: 'RAW test output do-not-export',
    mr: 7, mergeCommit: 'c'.repeat(40), testCommit: 'b'.repeat(40), testVerification: 'RAW test log do-not-export', published: true,
    ...verified ? { resolved: true, liveVerification: 'RAW live logs do-not-export',
      deployment: { at: new Date().toISOString(), builds: [{ service: 'api', number: 8, url: 'https://ci.invalid/8', commit: 'b'.repeat(40) }] } } : {} })
  h.runtime.engine.report(ticket.id, { state: 'ready', summary: 'RAW transcript do-not-export' })
  await h.runtime.idle()
  return ticket.id
}

it('retains verified repair facts and revision evidence, never raw logs or transcripts', async () => {
  await finish(true)
  const retain = requests.find(request => request.path.endsWith('/memories'))!
  expect(retain?.body).toMatchObject({ async: false, items: [{ tags: expect.arrayContaining([projectTag, 'source:dsh-superagent']) }] })
  expect(retain.body.items![0]!.content).toContain('Nullable assignee interrupted page parsing')
  expect(retain.body.items![0]!.content).toContain('b'.repeat(40))
  expect(retain.body.items![0]!.document_id).toMatch(/^dsh-superagent-/)
  expect(JSON.stringify(retain.body)).not.toMatch(/RAW|do-not-export|fixture-memory-credential/)
})

it('does not turn a ready report and publication-only checkpoint into verified memory', async () => {
  await finish(false)
  expect(requests.filter(request => request.path.endsWith('/memories'))).toEqual([])
})

it('keeps failed memory exports queued without reopening or failing a completed ticket', async () => {
  mode = 'retain-failure'
  const id = await finish(true)
  expect(h.runtime.store.tickets.get(id)?.ended?.outcome).toBe('completed')
  expect(h.runtime.effects.pending('memory-retain')).toBe(true)
  expect(requests.filter(request => request.path.endsWith('/memories'))).toHaveLength(1)
})

it.each(['repository', 'permissions'] as const)('does not contact memory with an invalid %s binding', async boundary => {
  const file = join(h.directory, 'hindsight.json')
  if (boundary === 'permissions') chmodSync(file, 0o644)
  else {
    const config = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...config, repository: 'https://github.com/other/project' }))
  }
  await h.runtime.memory.load()
  const { ticket } = await h.acceptedTicket(feishu('memory4', 'Fix the regression'))
  expect(requests).toEqual([])
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.state).toBe('running')
  expect(h.runtime.health.memory?.state).toBe('error')
})

it('replays a persisted failed export after reopening SQLite and then suppresses duplicate completion', async () => {
  mode = 'retain-failure'
  const id = await finish(true), deployment = h.runtime.deployment
  await h.runtime.stop()
  const store = new Store(join(h.directory, 'orchestrator.sqlite')), board = new HealthBoard()
  const effects = new Effects(store, board, () => Date.now() + 60_000)
  const memory = new HindsightMemory({ store, effects, health: board.claim('memory'), stateDir: h.directory,
    deployment: () => deployment, lifetime: new AbortController().signal })
  try {
    mode = 'ok'; await memory.load(); effects.start(); await effects.idle()
    const retained = requests.filter(request => request.path.endsWith('/memories'))
    expect(retained).toHaveLength(2)
    expect(retained[1]!.body).toEqual(retained[0]!.body)
    expect(effects.pending('memory-retain')).toBe(false)
    memory.remember(store.tickets.get(id)!); await effects.idle()
    expect(requests.filter(request => request.path.endsWith('/memories'))).toHaveLength(2)
  } finally { await effects.drain(); store.close() }
})

it('exports only explicitly verified optimization lessons under an isolated project and purpose', async () => {
  const lesson = { status: 'hypothesis', problem: 'Retry evidence vanished after success', change: 'Persist structured outcomes',
    validation: '', effect: '', evidence: [] }
  expect(await h.api('POST', 'optimization/lessons', lesson)).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(requests.filter(request => request.path.endsWith('/memories'))).toEqual([])
  const verified = { ...lesson, status: 'verified', validation: 'Local HTTP recovery and SQLite restart passed',
    effect: 'The failed attempt remains visible after recovery', evidence: ['fixture: timeout then success; one failure and one success after reopen'] }
  expect(await h.api('POST', 'optimization/lessons', verified)).toMatchObject({ status: 200 })
  await h.runtime.idle()
  const retained = requests.filter(request => request.path.endsWith('/memories'))
  expect(retained).toHaveLength(1)
  expect(retained[0]!.body).toMatchObject({ items: [{ tags: [OPTIMIZATION_TAG, 'purpose:project-optimization', 'source:dsh-superagent'] }] })
  expect(JSON.stringify(retained[0]!.body)).not.toMatch(/project:widgets|acme\/widgets|fixture-memory-credential|orchestrator-host-/)
  await h.api('POST', 'optimization/lessons', verified); await h.runtime.idle()
  expect(requests.filter(request => request.path.endsWith('/memories'))).toHaveLength(1)
})

it('replays a failed optimization export after restart without losing the local lesson', async () => {
  mode = 'retain-failure'
  const lesson = { status: 'verified', problem: 'Failure evidence disappears', change: 'Store the observation',
    validation: 'Focused recovery test passed', effect: 'Evidence survives queue cleanup', evidence: ['local recovery test: passed'] }
  expect(await h.api('POST', 'optimization/lessons', lesson)).toMatchObject({ status: 200 })
  await h.runtime.idle()
  const deployment = h.runtime.deployment
  await h.runtime.stop()
  const store = new Store(join(h.directory, 'orchestrator.sqlite')), board = new HealthBoard()
  const effects = new Effects(store, board, () => Date.now() + 60_000)
  const memory = new HindsightMemory({ store, effects, health: board.claim('memory'), stateDir: h.directory,
    deployment: () => deployment, lifetime: new AbortController().signal })
  const ledger = new OptimizationLedger(store, board.claim('optimization'), record => memory.rememberOptimization(record))
  try {
    mode = 'ok'; await memory.load(); ledger.exportVerified(); effects.start(); await effects.idle()
    expect(ledger.lessons().items).toEqual([expect.objectContaining(lesson)])
    const retained = requests.filter(request => request.path.endsWith('/memories'))
    expect(retained).toHaveLength(2)
    expect(retained[1]!.body).toEqual(retained[0]!.body)
    expect(effects.pending('memory-retain')).toBe(false)
  } finally { await effects.drain(); store.close() }
})
