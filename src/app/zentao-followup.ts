/** Correlates private ZenTao notification replies without granting new work or weakening manual pauses. */
import { canRetry, key, latestReport, said, type Engine, type ReceiveResult, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import type { FeishuConfig } from '../sources/feishu.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

interface FollowupHost {
  store: Store
  sources: SourceRegistry
  engine: Pick<Engine, 'receiveContext' | 'retryTicket'>
  outbox: Pick<Outbox, 'send'>
  appId: string | undefined
}

/** Undefined leaves ordinary Feishu traffic untouched; every known notification root is consumed, including refusals. */
export function receiveZentaoFollowup(host: FollowupHost, trigger: Trigger): ReceiveResult | undefined {
  if (trigger.source !== 'feishu') return
  const root = trigger.meta.rootId ?? trigger.meta.parentId
  if (typeof root !== 'string') return
  const { store, sources, engine, outbox } = host
  const topicKeys = store.keys(KV.zentao.feishuTopic).filter(name => store.get(name) === root)
  if (!topicKeys.length) return
  return store.atomic(() => {
    if (store.triggers.get(trigger.id)) return 'duplicate'
    const settings = store.settings(), feishu = sources.instance<FeishuConfig>('feishu')
    const allowed = feishu?.enabled && feishu.config.directMessages && trigger.meta.direct === true && trigger.human
      && trigger.actor.source === 'feishu' && trigger.actor.id === feishu.config.notificationOpenId
      && allowedSender(settings, trigger.actor) && sources.scope(trigger).listened && host.appId
    const refuse = (message: string): ReceiveResult => {
      store.triggers.save(trigger)
      store.triggers.saveDisposition(trigger.id, { fanout: [], at: new Date().toISOString(), filtered: said(message) })
      // Never answer an untrusted sender or a source that no longer receives private messages.
      if (allowed && trigger.channel) outbox.send({ id: key('zentao-followup', trigger.id), channel: trigger.channel,
        kind: 'notice', text: message })
      return 'filtered'
    }
    if (!allowed) return refuse('本通知话题只接受当前已授权收件人的私聊回复；未恢复任务。')
    const matches = store.tickets.open().filter(ticket => ticket.channels.some(channel => channel.source === 'zentao'
      && topicKeys.includes(KV.zentao.feishuTopic(key(channel.thread, host.appId!, feishu.config.notificationOpenId)))))
    if (matches.length !== 1) return refuse('未找到唯一的未结束任务；请在工单面板确认，本回复不会新建或恢复任务。')
    const ticket = matches[0]!, origin = store.triggers.get(ticket.origin.triggerId)
    if (!origin || origin.source !== 'zentao' || !sources.scope(origin).listened
      || !settingsPolicy(settings, sources).revalidate(ticket.mandate)) return refuse('来源或任务授权已变化；未恢复任务，请在工单面板检查。')
    const resume = trigger.text.trim() === '继续'
    // A global pause is not overridden, nor is the command retained as a delayed authorization.
    if (resume && settings.paused) return refuse('系统处理已暂停；请先在面板恢复处理，再回复“继续”。')
    if (resume && !canRetry(ticket)) return refuse('任务当前不需要重试；未重复启动。')
    const pausedAt = ticket.delivery?.at ?? latestReport(ticket)?.at ?? ticket.createdAt
    if (resume && !(Date.parse(trigger.at) > Date.parse(pausedAt))) return refuse('该“继续”消息早于当前暂停，已忽略；请针对本次阻塞重新确认。')
    const result = engine.receiveContext(ticket.id, trigger)
    if (result !== 'stored') return result
    if (resume) engine.retryTicket(ticket.id)
    if (trigger.channel) outbox.send({ id: key('zentao-followup', trigger.id), channel: trigger.channel, ticketId: ticket.id,
      kind: 'notice', text: resume ? '已恢复原任务，将先读取补充信息并核对已有提交、发布状态，避免重复执行。'
        : '补充信息已保存到原任务，不会自动恢复已暂停的工作。需要恢复时请单独回复“继续”，或在工单面板手动重试。' })
    return result
  })
}
