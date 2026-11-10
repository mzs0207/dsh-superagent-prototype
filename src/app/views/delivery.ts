/** Public delivery evidence; missing checkpoints stay unknown, and publication never implies deployment. */
import { latestReport, type Ticket } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import type { Store } from '../store.ts'

/** Only credential-free HTTP(S) artifact links are exposed on either user-facing surface. */
export function artifactUrl(value: string | undefined): string | undefined {
  if (!value) return
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch { /* Invalid artifact links remain plain text evidence. */ }
}

export function deliveryCard(store: Pick<Store, 'get' | 'triggers'>, ticket: Ticket) {
  const report = latestReport(ticket), origin = store.triggers.get(ticket.origin.triggerId)
  const state = origin?.source === 'zentao' ? store.get(KV.zentao.workflow(ticket.id)) ?? {} : undefined
  const repository = typeof origin?.meta.repository === 'string' ? artifactUrl(origin.meta.repository) : undefined
  const workflow = state && {
    cause: state.cause, changes: state.changes, reproduction: state.reproduction, tests: state.tests, head: state.head,
    mr: state.mr ? { number: state.mr, url: repository ? artifactUrl(`${repository.replace(/\/$/, '')}/-/merge_requests/${state.mr}`) : undefined } : undefined,
    mergeCommit: state.mergeCommit, testCommit: state.testCommit, testVerification: state.testVerification,
    published: state.published === true, resolved: state.resolved === true,
    deployment: state.deployment && { at: state.deployment.at, builds: state.deployment.builds.map(build => ({
      number: build.number, service: build.service, commit: build.commit, url: artifactUrl(build.url),
    })) },
    liveVerification: state.liveVerification,
  }
  return { scope: ticket.mandate.scope, summary: report?.summary,
    humanAction: ticket.attention?.question ?? (report?.state === 'blocked' || report?.state === 'failed' ? report.summary : undefined), workflow }
}
export type DeliveryCard = ReturnType<typeof deliveryCard>

/** Explicit allowlist for mobile responses, even if an upstream later adds private fields to its evidence object. */
export function publicDelivery(card: DeliveryCard): DeliveryCard {
  const w = card.workflow
  return { scope: card.scope, summary: card.summary, humanAction: card.humanAction,
    workflow: w && { cause: w.cause, changes: w.changes, reproduction: w.reproduction, tests: w.tests, head: w.head,
      mr: w.mr && { number: w.mr.number, url: artifactUrl(w.mr.url) }, mergeCommit: w.mergeCommit,
      testCommit: w.testCommit, testVerification: w.testVerification, published: w.published, resolved: w.resolved,
      deployment: w.deployment && { at: w.deployment.at, builds: w.deployment.builds.map(build => ({
        number: build.number, service: build.service, commit: build.commit, url: artifactUrl(build.url),
      })) }, liveVerification: w.liveVerification } }
}
