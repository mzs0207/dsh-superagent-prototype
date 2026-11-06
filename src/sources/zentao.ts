/** Assigned ZenTao bugs become durable, non-human workflow candidates; comments never retrigger them. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { KV } from '../kv.ts'
import { z } from 'zod'
import { key, latestAssignment, latestReport, type OutboundMessage, type Ticket, type Trigger } from '../core/index.ts'
import { ZentaoClient, ZentaoConnectionSchema, ZentaoScopeError, type ZentaoBug } from './zentao-client.ts'
import type { SourceKind } from './kind.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'

export const ZentaoConfigSchema = ZentaoConnectionSchema.extend({
  repository: z.string().trim().default(''),
  testApi: z.string().trim().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
}).strict()
export type ZentaoConfig = z.infer<typeof ZentaoConfigSchema>
export const zentaoNamespace = (config: ZentaoConfig) => key('zentao', config.baseUrl, String(config.product), config.account, config.repository)
export function zentaoTrigger(config: ZentaoConfig, bug: ZentaoBug): Trigger {
  const namespace = zentaoNamespace(config)
  const thread = `${namespace}:bug:${bug.id}`
  const url = `${config.baseUrl}/bug-view-${bug.id}.html`
  return { id: key('zentao', namespace, String(bug.id), String(bug.activatedCount)), source: 'zentao',
    actor: { source: 'zentao', id: '' }, human: false, at: new Date().toISOString(), threads: [{ source: 'zentao', id: thread }], url,
    text: `禅道 Bug #${bug.id}: ${bug.title}\n指派给 ${config.account}；状态 active。\n${bug.steps}\n\n按已授权的禅道流程复现并修复；只同步本次修复到 test。不存在或无法解决时通知并暂停。`,
    channel: { source: 'zentao', thread, address: { namespace, bugId: String(bug.id), url } },
    meta: { namespace, bugId: bug.id, product: config.product, account: config.account, activatedCount: bug.activatedCount, workflow: 'zentao-bug', repository: config.repository } }
}
export function zentaoBlockedNotice(ticket: Ticket, trigger: Trigger, summary: string): OutboundMessage {
  if (!trigger.channel || trigger.source !== 'zentao') throw new Error('A ZenTao bug channel is required')
  return { id: key('zentao-blocked', ticket.id, latestAssignment(ticket)?.id ?? '', summary), channel: trigger.channel,
    ticketId: ticket.id, kind: 'notice', text: `自动处理已暂停，本单不会因轮询、评论或服务重启自动重试。\n\n${summary}\n\n补充信息或排除阻塞后，请在 Superagent 工单面板手动重试。` }
}
export const zentaoKind: SourceKind<ZentaoConfig> = {
  kind: 'zentao', defaultEnabled: false,
  title: { zh: '禅道', en: 'ZenTao' },
  description: { zh: '轮询本人名下的活跃 Bug：复现、修复、develop 合并、仅本次修复同步到 test、部署复验。不存在或无法解决时通知并暂停该单。',
    en: 'Poll assigned active bugs: reproduce, fix, merge to develop, cherry-pick only this fix to test, deploy and verify. Notify and pause when blocked.' },
  schema: ZentaoConfigSchema,
  fields: [
    { key: 'baseUrl', type: 'text', label: { zh: '禅道地址', en: 'ZenTao URL' }, hint: { zh: '填写安装根路径，例如 http://host:8080/zentao；可粘贴 admin.html 地址。', en: 'Installation root including /zentao; an admin.html URL is also accepted.' } },
    { key: 'product', type: 'number', min: 1, max: 2147483647, label: { zh: '对应仓库的产品 ID', en: 'Product ID for this repository' } },
    { key: 'account', type: 'text', label: { zh: '登录及 Bug 指派账号', en: 'Login and assigned account' } },
    { key: 'credentialsFile', type: 'text', label: { zh: '本机账号密码 JSON 文件', en: 'Local credentials JSON file' }, hint: { zh: '绝对路径；内容为 account 和 password。不进入工单或提示词。', en: 'Absolute path containing account and password; never included in tickets or prompts.' } },
    { key: 'repository', type: 'text', label: { zh: '绑定代码仓库网页 URL', en: 'Bound repository web URL' }, hint: { zh: '必须等于执行器当前仓库，避免跨产品修复。', en: 'Must match the Executor repository; prevents cross-product fixes.' } },
    { key: 'testApi', type: 'text', label: { zh: '测试环境 API 地址', en: 'Test environment API URL' } },
    { key: 'pollSeconds', type: 'number', min: 60, max: 3600, advanced: true, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / seconds' } },
  ],
  health: ['zentao'],
  scope: ({ meta }, config) => meta.namespace === zentaoNamespace(config)
    ? { listened: true, observed: true, row: 'bugs' } : { listened: false, reason: 'ZenTao product, assignee or repository does not match this Source' },
  channel: {
    allowed: (address, config) => address.namespace === zentaoNamespace(config),
    link: address => ({ url: address.url ?? '', label: { zh: '禅道 Bug', en: 'ZenTao Bug' } }),
    send: async (_host, message, config) => {
      if (message.channel.address.namespace !== zentaoNamespace(config)) return 'gone'
      try {
        await new ZentaoClient(config).comment(Number(message.channel.address.bugId), message.id, message.text)
        return 'sent'
      } catch (error) { if (error instanceof ZentaoScopeError) return 'gone'; throw error }
    },
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.bugId),
    read: async (_commands, trigger, _part, _cursor, config) => {
      if (trigger.meta.namespace !== zentaoNamespace(config)) throw new Error('ZenTao Source scope changed')
      const bug = await new ZentaoClient(config).bug(Number(trigger.meta.bugId))
      return { messages: [{ id: String(bug.id), from: config.account, bot: true, at: trigger.at, text: `${bug.title}\n${bug.steps}`, url: trigger.url }],
        body: { ...bug, workflow: 'Load dsh-superagent-zentao; every eligible assigned bug requires investigation, including incomplete reports.' }, status: bug.status }
    },
  },
  find: (query, config) => {
    const match = /^(?:zentao:|bug[- #]?)?([1-9]\d*)$/i.exec(query.trim())
    return { threads: match && config ? [`zentao:${zentaoNamespace(config)}:bug:${match[1]}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '授权账号', en: 'Authorized accounts' }, columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] },
      { key: 'mode', type: 'select', label: { zh: '禅道执行模式', en: 'ZenTao execution mode' }, options: [
        { value: 'inherit', label: { zh: '跟随全局', en: 'Inherit global mode' } }, { value: 'auto', label: { zh: '自动执行', en: 'Automatic' } },
        { value: 'observe', label: { zh: '只观察', en: 'Observe only' } }, { value: 'off', label: { zh: '关闭候选评估', en: 'Off' } },
      ] }],
    explicit: { zh: '指派事件是系统事件，使用自动模式及禅道 Bug 规则，不伪造用户消息。', en: 'Assignments are system events; enable Auto mode and a ZenTao bug rule. They are not human messages.' },
    rows: () => [{ id: 'bugs', label: { zh: '本人名下活跃 Bug', en: 'Assigned active bugs' }, note: { zh: '含首次积压', en: 'Includes existing bugs' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } }],
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_ZENTAO_BUG_ID', description: { zh: '当前禅道 Bug 编号；其他来源为空', en: 'Current ZenTao bug ID; empty for other sources' } },
      { key: 'DSH_SUPERAGENT_ZENTAO_TEST_API', description: { zh: 'Bug 复现及发布后复验的测试环境 API', en: 'Test API for reproduction and post-deployment verification' } },
    ],
    values: ({ trigger, config }) => ({ DSH_SUPERAGENT_ZENTAO_BUG_ID: trigger?.source === 'zentao' ? String(trigger.meta.bugId) : '', DSH_SUPERAGENT_ZENTAO_TEST_API: config.testApi }),
  },
}
export async function pollZentao(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const config = ctx.config<ZentaoConfig>('zentao')
  if (!config) return 60
  if (!config.repository || config.repository !== ctx.deployment.webUrl) throw new Error('Bind ZenTao to the Executor repository web URL before enabling it')
  for (const ticket of ctx.tickets.open()) {
    const trigger = ctx.triggers.get(ticket.origin.triggerId)
    if (trigger?.source !== 'zentao' || trigger.meta.namespace !== zentaoNamespace(config)) continue
    let report = latestReport(ticket)
    const workflow = ctx.state.get(KV.zentao.workflow(ticket.id))
    if (workflow?.receipt && !workflow.resolved) {
      let failure: string | undefined, failureAt = ''
      try {
        const receipt = z.object({ failure: z.string().optional(), failureAt: z.string().optional() }).parse(JSON.parse(await readFile(workflow.receipt, 'utf8')))
        failure = receipt.failure; failureAt = receipt.failureAt ?? ''
      } catch (error) { failure = `Release checkpoint cannot be read: ${error instanceof Error ? error.message : String(error)}` }
      const signature = failure && key(failure, failureAt)
      if (failure && signature !== workflow.failureSeen) {
        ctx.atomic(() => {
          if (report?.state !== 'blocked' && report?.state !== 'failed') {
            ctx.tickets.block(ticket.id, `测试部署已暂停：${failure}`)
            report = latestReport(ctx.tickets.get(ticket.id)!)
          }
          if (report) ctx.notify(zentaoBlockedNotice(ticket, trigger, report.summary))
          ctx.state.set(KV.zentao.workflow(ticket.id), { ...workflow, failureSeen: signature! })
        })
      }
    }
    if (report && (report.state === 'blocked' || report.state === 'failed')) ctx.notify(zentaoBlockedNotice(ticket, trigger, report.summary))
  }
  const client = new ZentaoClient(config, signal)
  const bugs = await client.bugs(); let accepted = 0
  for (const bug of bugs) {
    if (signal?.aborted || !ctx.config('zentao')) break
    if (bug.product !== config.product || bug.assignedTo !== config.account || bug.status !== 'active' || bug.deleted) continue
    const trigger = zentaoTrigger(config, bug)
    if (ctx.triggers.get(trigger.id)) continue
    const existing = ctx.threads.get(`zentao:${trigger.threads[0]!.id}`)
    // A new activation cannot wake work that explicitly waits for manual retry.
    if (existing?.subscriptions.some(id => {
      const ticket = ctx.tickets.get(id), report = ticket && latestReport(ticket)
      return ticket && !ticket.ended && (report?.state === 'blocked' || report?.state === 'failed')
    })) continue
    const fresh = await client.bug(bug.id)
    if (fresh.status !== 'active' || fresh.activatedCount !== bug.activatedCount) continue
    await ctx.receive(zentaoTrigger(config, fresh)); accepted++
    ctx.threads.describe(`zentao:${trigger.threads[0]!.id}`, { label: `禅道 #${bug.id} ${bug.title}`, url: trigger.url })
  }
  ctx.report('zentao', { state: 'ready', detail: `ZenTao: ${accepted} new assigned bugs; next poll ${config.pollSeconds}s`, at: new Date().toISOString() })
  return config.pollSeconds
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('zentao', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<ZentaoConfig>('zentao')
    try {
      if (config) await pollZentao(ctx, signal)
      else ctx.report('zentao', health('paused', 'sourceOff'))
    } catch (error) { if (!signal.aborted) ctx.report('zentao', { state: 'error', detail: String(error) }) }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
export const name = 'dsh-superagent-zentao'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(zentaoKind), 'zentao: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, zentaoKind), controller = new AbortController()
    const running = watch(source, controller.signal).catch(error => { source.report('zentao', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
