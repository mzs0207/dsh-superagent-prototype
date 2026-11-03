/** GitLab MR reads, ownership checks and the shared change-request lifecycle adapter. */
import type { Ticket } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { claimChange, observeChange, type ChangeRequest } from './change.ts'
import { GitlabMergeRequestSchema, gitlabPage, gitlabThread, type GitlabMergeRequest, type GitlabRef } from './gitlab-trigger.ts'
import type { SourceContext } from './host.ts'

export const readMergeRequest = (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<GitlabMergeRequest> =>
  ctx.commands.withSignal(signal).api(GitlabMergeRequestSchema, `merge_requests/${number}`)
export function mergeRequestsOf(ticket: Pick<Ticket, 'follows'>, namespace: string, open = false): number[] {
  const prefix = `gitlab:${namespace}:merge_request:`
  return (ticket.follows ?? []).filter(follow => (!open || !follow.closed) && follow.thread.startsWith(prefix))
    .flatMap(follow => { const id = Number(follow.thread.slice(prefix.length)); return Number.isSafeInteger(id) && id > 0 ? [id] : [] })
}
export function mergeRequestRef(ctx: Pick<SourceContext, 'deployment'>, request: GitlabMergeRequest): GitlabRef {
  return { namespace: ctx.deployment.namespace, number: request.iid, isPr: true,
    url: gitlabPage(ctx.deployment, request.iid, true), prAuthor: request.author.username }
}
function change(ctx: SourceContext, request: GitlabMergeRequest): ChangeRequest {
  const ref = mergeRequestRef(ctx, request)
  return { thread: gitlabThread(ref), group: `gitlab:${ref.namespace}:merge_request:`, number: request.iid, noun: 'MR',
    url: ref.url, author: request.author.username, branch: request.source_branch,
    agentOwned: sameName(request.author.username, ctx.deployment.account.login)
      && request.source_project_id === ctx.deployment.projectId && request.target_project_id === ctx.deployment.projectId,
    state: request.state === 'merged' ? 'merged' : request.state === 'closed' ? 'closed' : 'open',
    closedAt: request.merged_at ?? request.closed_at ?? undefined,
    autoMerge: request.merge_when_pipeline_succeeds === true || request.auto_merge_enabled === true,
    meta: { namespace: ref.namespace } }
}
export function claimMergeRequest(ctx: SourceContext, ticketId: string, request: GitlabMergeRequest): string | undefined {
  return claimChange(ctx, ticketId, change(ctx, request))
}
export async function observeMergeRequest(ctx: SourceContext, request: GitlabMergeRequest): Promise<boolean> {
  return observeChange(ctx, change(ctx, request))
}
