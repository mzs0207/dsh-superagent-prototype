/** Native GitHub pull reads and ownership adapter for the shared change-request lifecycle. */
import { z } from 'zod'
import type { Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { SOURCE, UserSchema } from './github-trigger.ts'
import { claimChange, observeChange, type ChangeRequest } from './change.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
const pullNumber = (thread: string): number | undefined => thread.startsWith(`${SOURCE}:`) ? Number(thread.slice(SOURCE.length + 1)) : undefined
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread) ?? [])
/** True when the PR was opened by the agent account from a branch in the configured repository (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: Pick<Deployment, 'account' | 'repository'>): boolean =>
  sameName(pr.user.login, deployment.account.login) && sameName(pr.head?.repo?.full_name ?? '', deployment.repository)
function change(ctx: SourceContext, pr: Pull): ChangeRequest {
  return { thread: { source: SOURCE, id: String(pr.number) }, group: `${SOURCE}:`, number: pr.number, noun: 'PR',
    url: pr.html_url, author: pr.user.login, branch: pr.head.ref, agentOwned: agentPull(pr, ctx.deployment),
    state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    closedAt: pr.merged_at ?? pr.closed_at ?? undefined, autoMerge: pr.auto_merge != null }
}
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  return claimChange(ctx, ticketId, change(ctx, pr))
}
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  return observeChange(ctx, change(ctx, pr))
}
