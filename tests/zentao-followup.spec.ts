import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { key, ticketStage, type Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { ZentaoConfigSchema, zentaoKind, zentaoNamespace } from '../src/sources/zentao.ts'
import { startRuntime, feishu, MEMBER, type Host } from './fixtures/host.ts'

let h: Host, ticket: Ticket
const root = 'om_notification'
const reply = (id: string, text: string, overrides: Record<string, unknown> = {}) => feishu(id, text,
  { chat_type: 'p2p', root_id: root, mentions: [], create_time: String(Date.now()), ...overrides })
beforeEach(async () => {
  h = await startRuntime()
  const { runtime: r } = h, settings = r.store.settings()
  r.sources.register(zentaoKind)
  const config = ZentaoConfigSchema.parse({ baseUrl: 'https://bugs.invalid', product: 1, account: 'alice',
    credentialsFile: '/unused/credentials.json', repository: r.deployment.webUrl })
  r.store.saveSettings({ ...settings, sources: { ...settings.sources,
    zentao: { enabled: true, config }, feishu: { ...settings.sources.feishu!, config: { ...settings.sources.feishu!.config, notificationOpenId: MEMBER } } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources,
      zentao: { allowed: [], admission: { bugs: { unlistedUnaddressed: 'inferred' } } } } } })
  const namespace = zentaoNamespace(config), thread = `${namespace}:bug:1`, at = new Date(Date.now() - 1000).toISOString()
  const origin = { id: 'bug-trigger', source: 'zentao', actor: { source: 'zentao', id: '' }, human: false, at,
    threads: [{ source: 'zentao', id: thread }], text: 'Fix bug', meta: { namespace, repository: config.repository },
    channel: { source: 'zentao', thread, address: { namespace, bugId: '1', url: 'https://bugs.invalid/bug-view-1.html' } } }
  r.store.triggers.save(origin)
  ticket = { id: 'bug-ticket', title: 'Fix bug', decisionId: 'bug-decision', createdAt: at, updatedAt: at,
    mandate: { strength: 'inferred', policyVersion: 'test', actor: origin.actor, scope: 'Fix bug',
      basis: { via: 'admission', source: 'zentao', scope: origin.meta, cell: 'unlistedUnaddressed' } },
    completion: 'report', resume: 'manual', origin: { triggerId: origin.id, triggerIds: [origin.id] }, channels: [origin.channel],
    execution: { name: 'fix-bug', directory: join(h.directory, 'work'), assignment: 'Fix bug' }, inputs: [], undelivered: [],
    assignments: [{ id: 'first', state: 'running', createdAt: at, report: { state: 'blocked', summary: 'Need reproduction details', at } }] }
  r.store.tickets.save(ticket)
  r.store.set(KV.zentao.feishuTopic(key(thread, 'cli_bot', MEMBER)), root)
})
afterEach(async () => { await h.stop() })

it.each([true, false])('records context without waking the worker, including manual flag=%s', async manual => {
  if (!manual) { delete ticket.resume; h.runtime.store.tickets.save(ticket) }
  const trigger = reply('context1', '复现步骤补充：选择第二项；不是继续指令')
  expect(h.runtime.receive(trigger)).toBe('stored')
  await h.runtime.idle()
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(stored.inputs).toEqual([expect.objectContaining({ kind: 'trigger', triggerId: trigger.id, context: true })])
  expect(ticketStage(stored)).toEqual({ stage: 'person', action: 'blocked' })
  expect(h.candidates()).toEqual([])
  expect(h.deliveries.mock.calls.filter(([call]) => call.sessionId === `worker-${ticket.id}`)).toEqual([])
  const detail = await h.api('GET', `tickets/${ticket.id}`)
  expect(detail.body.inputs).toEqual([expect.objectContaining({ held: true, delivered: false })])
})

it('explicit continue resumes the original ticket once and delivers previously held context', async () => {
  const context = reply('context2', '已补充复现步骤'), command = reply('continue3', ' 继续 ')
  h.runtime.receive(context); h.runtime.receive(command)
  await h.runtime.idle()
  expect(h.runtime.receive(command)).toBe('duplicate')
  await h.runtime.idle()
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(stored.assignments.map(item => item.state)).toEqual(['ended', 'running'])
  expect(stored.execution).toEqual(ticket.execution)
  expect(stored.inputs.filter(input => input.kind === 'trigger').map(input => input.triggerId)).toEqual([context.id, command.id])
  expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === `worker-${ticket.id}` && call.text.includes('已补充复现步骤'))).toBe(true)
  expect(h.candidates()).toEqual([])
})

it.each(['unlisted', 'recipient', 'bot', 'group', 'source-off', 'scope', 'mandate', 'ended', 'ambiguous'] as const)(
  'never resumes or opens new work for a notification reply outside %s boundaries', async boundary => {
    const r = h.runtime, settings = r.store.settings(), overrides: Record<string, unknown> = {}
    if (boundary === 'unlisted') settings.policy.sources.feishu!.allowed = []
    if (boundary === 'recipient') overrides.sender_id = 'ou_other'
    if (boundary === 'bot') overrides.sender_type = 'bot'
    if (boundary === 'group') overrides.chat_type = 'group'
    if (boundary === 'source-off') settings.sources.zentao!.enabled = false
    if (boundary === 'scope') settings.sources.zentao!.config.product = 2
    if (boundary === 'mandate') settings.policy.sources.zentao!.admission = {}
    if (boundary === 'ended') r.store.tickets.save({ ...ticket, ended: { by: 'executor', outcome: 'completed', at: ticket.updatedAt } })
    if (boundary === 'ambiguous') r.store.tickets.save({ ...ticket, id: 'another-live-ticket' })
    r.store.saveSettings(settings)
    r.receive(reply('reject4', '继续', overrides)); await r.idle()
    expect(r.store.tickets.get(ticket.id)!.assignments).toEqual(ticket.assignments)
    expect(r.store.tickets.get(ticket.id)!.inputs).toEqual([])
    expect(h.candidates()).toEqual([])
  })

it('keeps unrelated Feishu topics on the ordinary intake path', async () => {
  const trigger = reply('normal5', 'Please fix another issue', { root_id: 'om_unrelated' })
  h.runtime.receive(trigger); await h.runtime.idle()
  expect(h.candidates()).toContain(trigger.id)
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs).toEqual([])
})

it('panel retry also delivers the supplementary context without treating it as a new request', async () => {
  const trigger = reply('panel6', '复现账号已准备好')
  h.runtime.receive(trigger); await h.runtime.idle()
  expect((await h.api('POST', `tickets/${ticket.id}/retry`, {})).status).toBe(200)
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === `worker-${ticket.id}` && call.text.includes('复现账号已准备好'))).toBe(true)
})

it('does not replay an old continue command against a later pause', async () => {
  const old = reply('old7', '继续', { create_time: String(Date.parse(ticket.createdAt) - 1000) })
  h.runtime.receive(old); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toEqual(ticket.assignments)
  expect(h.candidates()).toEqual([])
})
