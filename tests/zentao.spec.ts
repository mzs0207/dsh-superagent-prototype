import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZentaoClient } from '../src/sources/zentao-client.ts'
import { pollZentao, zentaoKind, ZentaoConfigSchema } from '../src/sources/zentao.ts'
import { Store } from '../src/app/store.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { Engine, type Ticket } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { KV } from '../src/kv.ts'
import { guardZentaoReport, zentaoTools, type ZentaoToolsHost } from '../src/app/tools/zentao.ts'

interface FixtureBug extends Record<string, unknown> {
  id: string; assignedTo: { account: string }; actions: { id: number; comment: string; actor: string }[]
}
const bug = (id: number, overrides: Record<string, unknown> = {}): FixtureBug => ({ id: String(id), product: '4', title: `Bug ${id}`, status: 'active', deleted: false,
  assignedTo: { account: 'alice' }, activatedCount: '0', openedDate: '2026-11-01T08:00:00+08:00', steps: '<p>expected result</p>',
  openedBuild: [{ id: '82', title: 'Test' }], actions: [], files: [], ...overrides })
let directory: string, server: Server, baseUrl: string, credentialsFile: string
let rows: FixtureBug[], requests: string[], comments: string[], refuseComment: boolean, wrongPage: boolean
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'zentao-'))
  credentialsFile = join(directory, 'credentials.json')
  writeFileSync(credentialsFile, JSON.stringify({ account: 'alice', password: 'fixture-password' }))
  rows = [bug(1)]; requests = []; comments = []; refuseComment = false; wrongPage = false
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost'); requests.push(`${req.method} ${url.pathname}${url.search}`)
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    res.setHeader('Content-Type', 'application/json')
    const send = (value: unknown) => res.end(JSON.stringify(value))
    if (url.pathname.endsWith('/tokens')) return send({ token: 'token' })
    if (url.pathname.endsWith('/api-getsessionid.json')) return send({ status: 'success', data: JSON.stringify({ sessionName: 'zentaosid', sessionID: 'session' }) })
    if (url.pathname.endsWith('/user-login.json')) return send({ status: 'success', user: { account: 'alice' } })
    if (url.pathname.includes('/action-comment-bug-')) {
      if (refuseComment) { res.statusCode = 403; return send({ result: 'fail', message: 'no comment permission' }) }
      const form = new URLSearchParams(body)
      comments.push(form.get('comment')!)
      const id = /bug-(\d+)/.exec(url.pathname)![1]
      const item = rows.find(row => row.id === id)!
      item.actions.push({ id: comments.length, comment: comments.at(-1)!, actor: 'alice' })
      return send({ result: 'success' })
    }
    if (req.headers.token !== 'token') { res.statusCode = 401; return send({ error: 'Unauthorized' }) }
    if (url.pathname.endsWith('/products/4/bugs')) {
      const page = Number(url.searchParams.get('page') ?? 1)
      return send({ page: wrongPage ? 1 : page, total: rows.length, limit: 2, bugs: rows.slice((page - 1) * 2, page * 2) })
    }
    const resolving = /\/bugs\/(\d+)\/resolve$/.exec(url.pathname)
    if (resolving) {
      const fields = JSON.parse(body)
      const item = rows.find(row => row.id === resolving[1])!
      item.status = 'resolved'; item.resolution = 'fixed'; item.assignedTo = { account: 'reporter' }
      item.actions.push({ id: item.actions.length + 1, comment: fields.comment, actor: 'alice' })
      return send(item)
    }
    const match = /\/bugs\/(\d+)$/.exec(url.pathname)
    if (match) return send(rows.find(row => row.id === match[1]))
    res.statusCode = 404; send({ error: 'not found' })
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  baseUrl = `http://127.0.0.1:${address.port}/zentao`
})
afterEach(async () => {
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise
  rmSync(directory, { recursive: true, force: true })
})
const config = () => ZentaoConfigSchema.parse({ baseUrl, product: 4, account: 'alice', credentialsFile, repository: testDeployment().webUrl })
function context() {
  const store = new Store(join(directory, 'store.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { zentao: { enabled: true, config: config() } } }))
  const sources = new SourceRegistry(() => store.settings()); sources.register(zentaoKind)
  const deployment = testDeployment()
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const engine = new Engine({ repo: store, scope: sources, assessor: { request: async () => {} }, executor: { start: async () => {}, deliver: async () => {}, stop: async () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} }, policy: () => ({ version: 'test', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: false, reason: 'test' }), revalidate: () => true, admitsInferred: () => false }) })
  const ctx = sourceContextOf({ store, sources, commands, deployment, engine, ready: Promise.resolve(), configured: () => true,
    receive: trigger => engine.receive(trigger), outbox: { send: message => { store.receipts.add(message) } } }, zentaoKind)
  return { store, ctx, engine }
}
describe('Zentao intake', () => {
  it('paginates unclosed and admits only this product’s active assigned bugs, including the initial backlog', async () => {
    rows = [bug(1), bug(2, { assignedTo: { account: 'bob' } }), bug(3, { status: 'resolved' }), bug(4, { product: '5' }), bug(5)]
    const { store, ctx } = context()
    try {
      await pollZentao(ctx)
      const triggers = store.read.triggers({}, 0, 20)
      expect(triggers.items.map(item => item.meta.bugId).sort()).toEqual([1, 5])
      expect(requests.filter(path => path.includes('/products/'))).toEqual(expect.arrayContaining([expect.stringContaining('status=unclosed')]))
      expect(triggers.items.every(item => !item.human)).toBe(true)
    } finally { store.close() }
  })
  it('does not create new work for its own comments, edits or a process restart', async () => {
    const first = context()
    await pollZentao(first.ctx)
    rows[0]!.lastEditedDate = '2026-11-06T09:00:00+08:00'
    await pollZentao(first.ctx)
    first.store.close()
    const second = context()
    try { await pollZentao(second.ctx); expect(second.store.read.triggers({}, 0, 20).items).toHaveLength(1) }
    finally { second.store.close() }
  })
  it('rejects non-advancing pagination instead of treating an incomplete list as complete', async () => {
    rows = [bug(1), bug(2), bug(3)]; wrongPage = true
    await expect(new ZentaoClient(config()).bugs()).rejects.toThrow()
  })
})
describe('Zentao comment-only writes', () => {
  it('posts a native comment once, reads it back, and leaves status and assignee unchanged on retry', async () => {
    const client = new ZentaoClient(config())
    await client.comment(1, 'operation-1', '无法复现；已检查测试环境，请补充账号和步骤。')
    await new ZentaoClient(config()).comment(1, 'operation-1', '无法复现；已检查测试环境，请补充账号和步骤。')
    expect(comments).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'active', assignedTo: { account: 'alice' } })
    expect(requests.some(path => /\/assign|\/resolve|PUT /.test(path))).toBe(false)
  })
  it('refuses writes after reassignment and reports comment permission failure', async () => {
    rows[0]!.assignedTo = { account: 'bob' }
    await expect(new ZentaoClient(config()).comment(1, 'op', 'blocked')).rejects.toThrow(/assigned|scope/i)
    rows[0]!.assignedTo = { account: 'alice' }; refuseComment = true
    await expect(new ZentaoClient(config()).comment(1, 'op', 'blocked')).rejects.toThrow(/403/)
    expect(comments).toEqual([])
  })
  it('reconciles a successful resolution after the server reassigns the bug back to its reporter', async () => {
    await new ZentaoClient(config()).resolve(1, '82', 'resolved-ticket', 'Verified in test')
    await new ZentaoClient(config()).resolve(1, '82', 'resolved-ticket', 'Verified in test')
    expect(requests.filter(path => path === 'POST /zentao/api.php/v1/bugs/1/resolve')).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'resolved', resolution: 'fixed', assignedTo: { account: 'reporter' } })
  })
  it('reconciles an already-written note after reassignment without posting a second note', async () => {
    await new ZentaoClient(config()).comment(1, 'note-before-reassign', 'Evidence saved')
    rows[0]!.assignedTo = { account: 'bob' }
    await new ZentaoClient(config()).comment(1, 'note-before-reassign', 'Evidence saved')
    expect(comments).toHaveLength(1)
  })
})

describe('Zentao workflow boundaries', () => {
  async function worker() {
    const value = context()
    await pollZentao(value.ctx)
    const trigger = value.store.read.triggers({}).items[0]!
    const ticket: Ticket = { id: 'ticket', title: 'Fix bug', decisionId: 'decision',
      mandate: { strength: 'inferred', policyVersion: 'test', actor: trigger.actor, basis: { via: 'admission', source: 'zentao', scope: trigger.meta, cell: 'unlistedUnaddressed' }, scope: 'Fix assigned bug' },
      channels: [trigger.channel!], inputs: [], undelivered: [], createdAt: trigger.at, updatedAt: trigger.at, completion: 'report',
      assignments: [{ id: 'assignment-1', state: 'running', createdAt: trigger.at }], origin: { triggerId: trigger.id, triggerIds: [trigger.id] } }
    value.store.tickets.save(ticket)
    const thread = value.store.threads.get(`zentao:${trigger.threads[0]!.id}`)!
    value.store.threads.save({ ...thread, subscriptions: [ticket.id] })
    const host: ZentaoToolsHost = { store: value.store, repository: value.ctx, resources: { store: value.store } }
    return { ...value, host, ticket }
  }
  it('rejects ready and dropped before verified deployment rather than silently ending the bug', async () => {
    const h = await worker()
    try {
      expect(() => guardZentaoReport(h.host, h.ticket, { state: 'ready', summary: 'merged' })).toThrow()
      expect(() => guardZentaoReport(h.host, h.ticket, { state: 'dropped', summary: 'not a bug' })).toThrow()
      expect(h.store.tickets.get(h.ticket.id)?.ended).toBeUndefined()
    } finally { h.store.close() }
  })
  it('queues one evidence note and keeps a blocked bug paused across poll cycles and reactivation', async () => {
    const h = await worker()
    try {
      const report = { state: 'blocked' as const, summary: '测试账号缺失，无法复现；请补充账号。' }
      const first = guardZentaoReport(h.host, h.ticket, report)
      h.engine.report(h.ticket.id, report)
      const second = guardZentaoReport(h.host, h.store.tickets.get(h.ticket.id)!, report)
      expect(second).toBe(first)
      expect(h.store.replyStatus(first!)).toBe('pending')
      rows[0]!.activatedCount = '1'
      await pollZentao(h.ctx)
      expect(h.store.read.triggers({}).items).toHaveLength(1)
      expect(h.store.tickets.get(h.ticket.id)!.assignments[0]!.report?.state).toBe('blocked')
      expect(() => guardZentaoReport(h.host, h.store.tickets.get(h.ticket.id)!, { state: 'progress', summary: 'retry by myself' })).toThrow()
    } finally { h.store.close() }
  })
  it('automatically blocks a failed release receipt without waiting for a model report', async () => {
    const h = await worker()
    try {
      const receipt = join(directory, 'release.json')
      writeFileSync(receipt, JSON.stringify({ failure: 'Jenkins checked out another SHA', builds: { service: { number: 7 } } }))
      h.store.set(KV.zentao.workflow(h.ticket.id), { receipt, published: true })
      await pollZentao(h.ctx)
      expect(h.store.tickets.get(h.ticket.id)!.assignments[0]!.report).toMatchObject({ state: 'blocked' })
      expect(h.store.tickets.get(h.ticket.id)!.ended).toBeUndefined()
    } finally { h.store.close() }
  })
  it('does not consume a release failure when its durable pause transaction fails', async () => {
    const h = await worker()
    try {
      const receipt = join(directory, 'release.json')
      writeFileSync(receipt, JSON.stringify({ failure: 'Deployment failed', failureAt: 'attempt-1' }))
      h.store.set(KV.zentao.workflow(h.ticket.id), { receipt, published: true })
      const block = h.ctx.tickets.block
      h.ctx.tickets.block = () => { throw new Error('Injected persistence failure') }
      await expect(pollZentao(h.ctx)).rejects.toThrow()
      expect(h.store.get(KV.zentao.workflow(h.ticket.id))?.failureSeen).toBeUndefined()
      h.ctx.tickets.block = block
      await pollZentao(h.ctx)
      expect(h.store.tickets.get(h.ticket.id)!.assignments[0]!.report?.state).toBe('blocked')
    } finally { h.store.close() }
  })
  it('does not allow merging without reproduction and fix verification', async () => {
    const h = await worker()
    try {
      const operation = zentaoTools(h.host, h.ticket)[0]!
      await expect(operation.execute({ action: 'merge', mr: 7 }, new AbortController().signal)).rejects.toThrow()
      expect(requests.some(path => path.includes('/resolve'))).toBe(false)
      expect(h.store.tickets.get(h.ticket.id)!.assignments[0]!.report?.state).toBe('blocked')
    } finally { h.store.close() }
  })
})
