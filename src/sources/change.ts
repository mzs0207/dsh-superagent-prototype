/** Repository-neutral ownership, terminal state and IM notices for GitHub PRs and GitLab MRs. */
import { key, liveTicket, threadKey, type Follow, type OutboundMessage, type ThreadFact, type ThreadRef, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceContext } from './host.ts'

export interface ChangeRequest {
  thread: ThreadRef
  group: string
  number: number
  noun: 'PR' | 'MR'
  url: string
  author: string
  branch: string
  agentOwned: boolean
  state: 'open' | 'merged' | 'closed'
  closedAt?: string | undefined
  autoMerge: boolean
  meta?: Record<string, unknown> | undefined
}
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/** Most recently bound open PR/MR, otherwise the most recently bound closed one. */
export function changeOf(ticket: Pick<Ticket, 'follows'>): number | undefined {
  const follows = (ticket.follows ?? []).flatMap(follow => {
    const match = /^(?:github:|gitlab:[^:]+:merge_request:)([1-9]\d*)$/.exec(follow.thread)
    return match ? [{ ...follow, number: Number(match[1]) }] : []
  })
  return follows.filter(follow => !follow.closed).at(-1)?.number ?? follows.at(-1)?.number
}

export function claimChange(ctx: SourceContext, ticketId: string, change: ChangeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return `Ticket ended because its ${change.noun} was closed`
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const target = threadKey(change.thread)
  const started = source?.source === change.thread.source && source.meta.isPr === true && source.threads.some(thread => threadKey(thread) === target)
  const opened = change.agentOwned && ticketBranch(ticket, change.branch)
  if (!started && !opened) return `${change.noun} does not belong to this ticket: use the source ${change.noun} or a ${change.noun} by ${ctx.deployment.account.login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no ${change.noun} exists`
  const owner = ctx.tickets.open().find(item => item.follows?.some(follow => follow.thread === target && !follow.closed))
  if (owner && owner.id !== ticketId) return `${change.noun} already belongs to another active ticket`
  const follow = ticket.follows?.find(item => item.thread === target)
  if (change.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) {
    ctx.atomic(() => {
      ctx.tickets.bindThread(ticketId, change.thread, opened)
      ctx.threads.patch(target, { number: change.number, isPr: true, url: change.url, prAuthor: change.author, ...change.meta })
    })
  }
  return undefined
}

export function observeChange(ctx: SourceContext, change: ChangeRequest): boolean {
  const target = threadKey(change.thread)
  const ended = change.state !== 'open'
  if (ended) {
    if (ctx.tickets.open().some(ticket => ticket.follows?.some(follow => follow.thread === target && !follow.closed))) {
      ctx.tickets.threadClosed(change.thread, change.state === 'merged' ? 'merged' : 'closed', change.closedAt ?? new Date().toISOString())
    }
  } else {
    const candidates = change.agentOwned ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, change.branch)) : []
    const ticket = candidates.length === 1 ? candidates[0] : undefined
    const reopened = ticket?.follows?.some(follow => follow.thread === target && follow.closed)
    const another = ticket?.follows?.some(follow => follow.thread.startsWith(change.group) && !follow.closed && follow.thread !== target)
    if (ticket && (reopened || !another)) claimChange(ctx, ticket.id, change)
  }
  ctx.threads.describe(target, { facts: { autoMerge: !ended && change.autoMerge ? AUTO_MERGE_ON : null } })
  return ended
}

/** Preserve existing GitHub notice IDs while using host/project namespaces for GitLab notices. */
export function changeEndNotices(ticket: Ticket, request: string, deployment: Pick<Deployment, 'provider' | 'namespace' | 'webUrl'>): OutboundMessage[] {
  const numberOf = (thread: string): number | undefined => {
    const match = deployment.provider === 'github' ? /^github:([1-9]\d*)$/.exec(thread)
      : thread.startsWith(`gitlab:${deployment.namespace}:merge_request:`) ? /:([1-9]\d*)$/.exec(thread) : null
    return match ? Number(match[1]) : undefined
  }
  const follows = (ticket.follows ?? []).filter(follow => follow.closed && numberOf(follow.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  const outcome = ticket.ended?.outcome
  if (!follow || (outcome !== 'merged' && outcome !== 'closed')) return []
  const number = numberOf(follow.thread)!
  const gitlab = deployment.provider === 'gitlab'
  const label = gitlab ? `MR !${number}` : `PR #${number}`
  const url = `${deployment.webUrl}/${gitlab ? '-/merge_requests' : 'pull'}/${number}`
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese ? `[${label}](${url}) ${outcome === 'merged' ? '已合并。' : '已关闭，未合并。'}`
    : `[${label}](${url}) ${outcome === 'merged' ? 'has merged.' : 'was closed without merging.'}`
  return ticket.channels.filter(channel => channel.source !== deployment.provider).map(channel => ({
    id: gitlab ? key('mr-terminal', deployment.namespace, String(number), channel.source, JSON.stringify(channel.address), outcome)
      : key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome),
    channel, text, kind: 'notice', ticketId: ticket.id,
  }))
}
