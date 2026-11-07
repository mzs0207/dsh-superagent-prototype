import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZentaoClient } from '../src/sources/zentao-client.ts'
import { pollZentao, zentaoKind, zentaoTrigger, ZentaoConfigSchema } from '../src/sources/zentao.ts'
import { Store } from '../src/app/store.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { Engine, type Ticket } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { KV } from '../src/kv.ts'
import { guardZentaoReport, zentaoTools, type ZentaoToolsHost } from '../src/app/tools/zentao.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { Outbox } from '../src/app/outbox.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'

interface FixtureBug extends Record<string, unknown> {
  id: string; assignedTo: string | { account: string } | null; actions: { id: number; comment: string; actor: string }[]
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
const config = (repository = testDeployment().webUrl) => ZentaoConfigSchema.parse({ baseUrl, product: 4, account: 'alice', credentialsFile, repository })
function context(deployment = testDeployment()) {
  const store = new Store(join(directory, 'store.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { zentao: { enabled: true, config: config(deployment.webUrl) } } }))
  const sources = new SourceRegistry(() => store.settings()); sources.register(zentaoKind); sources.register(feishuKind)
  const gitConfig = join(directory, 'gitconfig')
  writeFileSync(gitConfig, '[user]\nuseConfigOnly = true\n')
  const commands = new Commands(() => deployment, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined,
    DSH_SUPERAGENT_ACCOUNT: undefined, DSH_SUPERAGENT_COMMIT_EMAIL: undefined }, new AbortController().signal)
  let now = Date.now()
  const effects = new Effects(store, new HealthBoard(), () => now)
  const outbox = new Outbox({ store, effects, sources, commands, paused: () => false })
  const engine = new Engine({ repo: store, scope: sources, assessor: { request: async () => {} }, executor: { start: async () => {}, deliver: async () => {}, stop: async () => {} },
    outbox, policy: () => ({ version: 'test', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: false, reason: 'test' }), revalidate: () => true, admitsInferred: () => false }) })
  const ctx = sourceContextOf({ store, sources, commands, deployment, engine, ready: Promise.resolve(), configured: () => true,
    receive: trigger => engine.receive(trigger), outbox }, zentaoKind)
  return { store, ctx, engine, outbox, effects, advance: (ms: number) => { now += ms } }
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
  it('skips null assignees without losing assigned active bugs on later pages', async () => {
    rows = [bug(1, { status: 'resolved', assignedTo: null }), bug(2, { assignedTo: null }),
      bug(3, { assignedTo: 'alice' }), bug(4)]
    const { store, ctx } = context()
    try {
      await pollZentao(ctx)
      expect(store.read.triggers({}).items.map(item => item.meta.bugId).sort()).toEqual([3, 4])
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
  it('refuses reading or writing a bug after its assignee becomes null', async () => {
    rows[0]!.assignedTo = null
    const client = new ZentaoClient(config())
    await expect(client.bug(1)).rejects.toThrow('no longer assigned')
    await expect(client.comment(1, 'unassigned-note', 'blocked')).rejects.toThrow('no longer assigned')
    await expect(client.resolve(1, '82', 'unassigned-resolution', 'Verified')).rejects.toThrow('no longer active and assigned')
    expect(requests.filter(path => path.startsWith('POST ') && !path.endsWith('/tokens'))).toEqual([])
    expect(rows[0]).toMatchObject({ status: 'active', assignedTo: null, actions: [] })
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
  async function worker(deployment = testDeployment()) {
    const value = context(deployment)
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
  function notifications(h: { store: Store }, enabled = true, notificationOpenId = 'ou_operator') {
    const settings = h.store.settings()
    h.store.saveSettings({ ...settings,
      sources: { ...settings.sources, feishu: { enabled, config: { notificationOpenId } } },
      policy: { ...settings.policy, sources: { ...settings.policy.sources,
        feishu: { allowed: [{ id: 'ou_operator' }, { id: 'ou_another' }], admission: {} } } } })
  }
  it.each(['blocked', 'failed'] as const)('delivers %s evidence privately to the fixed operator, never as a bug comment', async state => {
    const h = await worker()
    const sent = vi.spyOn(h.ctx.commands, 'lark').mockResolvedValue({ message_id: 'om_first' })
    try {
      notifications(h)
      const report = { state, summary: `无法复现，请补充测试账号。\n${'已检查相关日志和接口。'.repeat(60)}` }
      const id = guardZentaoReport(h.host, h.ticket, report)!
      h.engine.report(h.ticket.id, report)
      h.effects.start(); await h.outbox.sent()
      expect(h.store.replyStatus(id)).toBe('sent')
      expect(sent).toHaveBeenCalledExactlyOnceWith(['im', '+messages-send', '--user-id', 'ou_operator', '--text',
        expect.stringContaining(report.summary), '--idempotency-key', id])
      const text = sent.mock.calls[0]![0][5]!
      expect(text).toContain('禅道 Bug #1')
      expect(text).toContain(`${baseUrl}/bug-view-1.html`)
      expect(text).toContain('手动重试')
      expect(comments).toEqual([])
      await pollZentao(h.ctx); await h.outbox.sent()
      expect(sent).toHaveBeenCalledTimes(1)
      expect(h.store.tickets.get(h.ticket.id)!.assignments[0]!.report?.state).toBe(state)
    } finally { await h.effects.drain(); sent.mockRestore(); h.store.close() }
  })
  it.each([{ enabled: false, recipient: 'ou_operator' }, { enabled: true, recipient: '' }])('keeps comment delivery when Feishu notifications are not enabled: %j', async ({ enabled, recipient }) => {
    const h = await worker()
    const sent = vi.spyOn(h.ctx.commands, 'lark').mockResolvedValue({})
    try {
      notifications(h, enabled, recipient)
      const id = guardZentaoReport(h.host, h.ticket, { state: 'blocked', summary: '缺少复现账号。' })!
      h.effects.start(); await h.outbox.sent()
      expect(h.store.replyStatus(id)).toBe('sent')
      expect(comments).toHaveLength(1)
      expect(comments[0]).toContain('缺少复现账号。')
      expect(sent).not.toHaveBeenCalled()
      expect(rows[0]).toMatchObject({ status: 'active', assignedTo: { account: 'alice' } })
    } finally { await h.effects.drain(); sent.mockRestore(); h.store.close() }
  })
  it('retries a failed Feishu delivery without falling back to a comment or restarting the ticket', async () => {
    const h = await worker()
    const sent = vi.spyOn(h.ctx.commands, 'lark').mockRejectedValueOnce(new Error('Feishu unavailable')).mockResolvedValue({ message_id: 'om_first' })
    try {
      notifications(h)
      const report = { state: 'blocked' as const, summary: '合并冲突，需要人工处理。' }
      const id = guardZentaoReport(h.host, h.ticket, report)!
      h.engine.report(h.ticket.id, report)
      h.effects.start(); await h.outbox.sent()
      expect(h.store.replyStatus(id)).toBe('pending')
      expect(comments).toEqual([])
      h.advance(5000); await h.outbox.sent()
      expect(h.store.replyStatus(id)).toBe('sent')
      expect(sent).toHaveBeenCalledTimes(2)
      expect(sent.mock.calls[0]![0]).toEqual(sent.mock.calls[1]![0])
      expect(comments).toEqual([])
      expect(h.store.tickets.get(h.ticket.id)!.assignments.map(item => item.report?.state)).toEqual(['blocked'])
    } finally { await h.effects.drain(); sent.mockRestore(); h.store.close() }
  })
  it('routes an already queued human-action reply through Feishu when notifications are enabled before delivery', async () => {
    const h = await worker()
    const sent = vi.spyOn(h.ctx.commands, 'lark').mockResolvedValue({ message_id: 'om_first' })
    try {
      h.engine.report(h.ticket.id, { state: 'blocked', summary: '缺少账号', question: '请提供测试账号。' })
      const reply = h.engine.reply({ purpose: 'attention', ticketId: h.ticket.id, question: '请提供测试账号。', text: '请提供测试账号。' })
      notifications(h)
      h.effects.start(); await h.outbox.sent()
      expect(h.store.replyStatus(reply.id)).toBe('sent')
      expect(sent).toHaveBeenCalledExactlyOnceWith(['im', '+messages-send', '--user-id', 'ou_operator', '--text',
        expect.stringContaining('请提供测试账号。'), '--idempotency-key', reply.id])
      expect(comments).toEqual([])
    } finally { await h.effects.drain(); sent.mockRestore(); h.store.close() }
  })
  it('keeps the same bug topic across a process restart and a new ticket', async () => {
    const h = await worker()
    let active: ReturnType<typeof context> = h
    const sent = vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ message_id: 'om_root' })
    try {
      notifications(active)
      guardZentaoReport(h.host, h.ticket, { state: 'blocked', summary: 'Needs investigation' })
      active.effects.start(); await active.outbox.sent()
      await active.effects.drain(); active.store.close()
      active = context()
      notifications(active)
      active.outbox.send({ id: 'retry-update', channel: h.ticket.channels[0]!, ticketId: 'new-ticket', kind: 'notice', text: 'New evidence' })
      active.effects.start(); await active.outbox.sent()
      expect(active.store.replyStatus('retry-update')).toBe('sent')
      expect(sent).toHaveBeenCalledTimes(2)
      expect(sent.mock.calls[0]![0][1]).toBe('+messages-send')
      expect(sent.mock.calls[1]![0]).toEqual(['im', '+messages-reply', '--message-id', 'om_root', '--text',
        expect.stringContaining('New evidence'), '--reply-in-thread', '--idempotency-key', 'retry-update'])
      expect(comments).toEqual([])
    } finally { await active.effects.drain(); sent.mockRestore(); active.store.close() }
  })
  it.each(['bug', 'namespace', 'recipient', 'bot'] as const)('starts a separate topic when the %s changes', async boundary => {
    const h = await worker()
    const sent = vi.spyOn(h.ctx.commands, 'lark').mockResolvedValueOnce({ message_id: 'om_old' }).mockResolvedValue({ message_id: 'om_new' })
    try {
      notifications(h)
      guardZentaoReport(h.host, h.ticket, { state: 'blocked', summary: 'First notice' })
      h.effects.start(); await h.outbox.sent()
      let channel = h.ticket.channels[0]!
      if (boundary === 'recipient') notifications(h, true, 'ou_different')
      if (boundary === 'bot') h.ctx.commands.deployment.feishu!.appId = 'cli_different'
      if (boundary === 'bug' || boundary === 'namespace') {
        const next = config()
        const data = await new ZentaoClient(next).bug(1)
        if (boundary === 'bug') data.id = 2
        else {
          next.baseUrl += '/other'
          const settings = h.store.settings()
          h.store.saveSettings({ ...settings, sources: { ...settings.sources, zentao: { enabled: true, config: next } } })
        }
        channel = zentaoTrigger(next, data).channel!
      }
      h.outbox.send({ id: 'different-destination', channel, kind: 'notice', text: 'Different audience or bug' })
      await h.outbox.sent()
      expect(h.store.replyStatus('different-destination')).toBe('sent')
      expect(sent).toHaveBeenCalledTimes(2)
      expect(sent.mock.calls[1]![0]).toEqual(['im', '+messages-send', '--user-id',
        boundary === 'recipient' ? 'ou_different' : 'ou_operator', '--text',
        expect.stringContaining('Different audience or bug'), '--idempotency-key', 'different-destination'])
    } finally { await h.effects.drain(); sent.mockRestore(); h.store.close() }
  })
  it('does not settle the first notification without a confirmed root message ID', async () => {
    const h = await worker()
    const sent = vi.spyOn(h.ctx.commands, 'lark').mockResolvedValueOnce({}).mockResolvedValue({ message_id: 'om_confirmed' })
    try {
      notifications(h)
      const id = guardZentaoReport(h.host, h.ticket, { state: 'blocked', summary: 'First notice' })!
      h.effects.start(); await h.outbox.sent()
      expect(h.store.replyStatus(id)).toBe('pending')
      h.advance(5000); await h.outbox.sent()
      expect(h.store.replyStatus(id)).toBe('sent')
      expect(sent.mock.calls[1]![0]).toEqual(sent.mock.calls[0]![0])
      h.outbox.send({ id: 'after-confirmation', channel: h.ticket.channels[0]!, kind: 'notice', text: 'Follow-up' })
      await h.outbox.sent()
      expect(sent.mock.calls[2]![0]).toContain('om_confirmed')
      expect(sent.mock.calls[2]![0]).toContain('--reply-in-thread')
      expect(comments).toEqual([])
    } finally { await h.effects.drain(); sent.mockRestore(); h.store.close() }
  })
  it('retries a failed topic reply in the same topic without starting another root', async () => {
    const h = await worker()
    const sent = vi.spyOn(h.ctx.commands, 'lark').mockResolvedValueOnce({ message_id: 'om_root' })
      .mockRejectedValueOnce(new Error('Feishu unavailable')).mockResolvedValue({ message_id: 'om_reply' })
    try {
      notifications(h)
      guardZentaoReport(h.host, h.ticket, { state: 'blocked', summary: 'First notice' })
      h.effects.start(); await h.outbox.sent()
      h.outbox.send({ id: 'followup', channel: h.ticket.channels[0]!, kind: 'notice', text: 'More evidence' })
      await h.outbox.sent()
      expect(h.store.replyStatus('followup')).toBe('pending')
      h.advance(5000); await h.outbox.sent()
      expect(h.store.replyStatus('followup')).toBe('sent')
      expect(sent).toHaveBeenCalledTimes(3)
      expect(sent.mock.calls[1]![0]).toEqual(['im', '+messages-reply', '--message-id', 'om_root', '--text',
        expect.stringContaining('More evidence'), '--reply-in-thread', '--idempotency-key', 'followup'])
      expect(sent.mock.calls[2]![0]).toEqual(sent.mock.calls[1]![0])
      expect(comments).toEqual([])
    } finally { await h.effects.drain(); sent.mockRestore(); h.store.close() }
  })
  it.each(['retry-limit', 'withdrawn'] as const)('reconciles an uncertain root before later notifications after %s', async mode => {
    const h = await worker()
    const roots = new Map<string, { id: string; text: string }>()
    const replies: { root: string; id: string }[] = []
    let lostResponses = mode === 'retry-limit' ? 3 : 1
    const sent = vi.spyOn(h.ctx.commands, 'lark').mockImplementation(async args => {
      const id = args.at(-1)!
      if (args[1] === '+messages-send') {
        if (!roots.has(id)) roots.set(id, { id: `om_root${roots.size + 1}`, text: args[5]! })
        if (lostResponses-- > 0) throw new Error('Response lost after Feishu accepted the message')
        return { message_id: roots.get(id)!.id }
      }
      replies.push({ root: args[3]!, id })
      return { message_id: 'om_reply' }
    })
    try {
      notifications(h)
      const firstId = guardZentaoReport(h.host, h.ticket, { state: 'blocked', summary: 'Original evidence' })!
      h.effects.start(); await h.outbox.sent()
      expect(h.store.replyStatus(firstId)).toBe('pending')
      if (mode === 'withdrawn') h.outbox.withdraw(firstId)
      h.outbox.send({ id: 'later-notice', channel: h.ticket.channels[0]!, ticketId: h.ticket.id, kind: 'notice', text: 'Later evidence' })
      await h.outbox.sent()
      if (mode === 'retry-limit') {
        h.advance(5000); await h.outbox.sent()
        h.advance(10_000); await h.outbox.sent()
        h.advance(20_000); await h.outbox.sent()
        expect(h.store.replyStatus(firstId)).toBe('sent')
      } else expect(h.store.replyStatus(firstId)).toBeUndefined()
      expect([...roots.keys()]).toEqual([firstId])
      expect(roots.get(firstId)!.text).toContain('Original evidence')
      expect(replies).toEqual([{ root: 'om_root1', id: 'later-notice' }])
      expect(h.store.replyStatus('later-notice')).toBe('sent')
      expect(comments).toEqual([])
    } finally { await h.effects.drain(); sent.mockRestore(); h.store.close() }
  })
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
  it('cherry-picks with the configured agent identity when the host has no Git user configured', async () => {
    const deployment = testDeployment({ provider: 'gitlab', origin: 'http://gitlab.invalid', projectId: 1 })
    const h = await worker(deployment)
    try {
      const repository = join(directory, 'repository'), remote = join(directory, 'remote.git')
      const env = { ...process.env, GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined }
      const git = (args: string[], cwd = repository) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim()
      git(['init', '--bare', remote], directory); git(['clone', remote, repository], directory)
      writeFileSync(join(repository, 'bug.txt'), 'broken\n'); git(['add', '.'])
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'])
      git(['branch', '-M', 'develop']); git(['branch', 'test'])
      writeFileSync(join(repository, 'bug.txt'), 'fixed\n')
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'fix'])
      const head = git(['rev-parse', 'HEAD']); git(['push', 'origin', 'develop', 'test'])
      h.store.tickets.save({ ...h.ticket, execution: { name: 'identity-smoke', directory: repository, assignment: 'fix' } })
      h.store.set(KV.zentao.workflow(h.ticket.id), { head, reproduction: 'failed before', tests: 'passed after', mr: 7, mergeCommit: head })
      await zentaoTools(h.host, h.ticket)[0]!.execute({ action: 'sync_test' }, new AbortController().signal)
      const copied = h.store.get(KV.zentao.workflow(h.ticket.id))!.testDirectory!
      expect(readFileSync(join(copied, 'bug.txt'), 'utf8')).toBe('fixed\n')
      expect(git(['log', '-1', '--format=%cn <%ce>'], copied)).toBe(`${deployment.account.login} <${deployment.account.email}>`)
    } finally { h.store.close() }
  })
})
