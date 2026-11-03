/** Read-only GitLab conversations, threaded notes and pipeline metadata. */
import { z } from 'zod'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { GitlabDiscussionSchema, GitlabItemSchema, GitlabMergeRequestSchema, GitlabNoteSchema, PipelineSchema,
  gitlabPage, type GitlabDiscussion, type GitlabItem, type GitlabNote, type GitlabRef, type Pipeline } from './gitlab-trigger.ts'
import type { GitlabConfig } from './gitlab.ts'

export const JobSchema = z.looseObject({ id: z.number(), name: z.string(), status: z.string(), stage: z.string().optional(),
  allowed_failure: z.boolean().optional(), web_url: z.string().optional() })
export interface PipelineSnapshot { pipeline: Pipeline; jobs: z.infer<typeof JobSchema>[] }
export async function pipelineSnapshot(commands: Commands, pipeline: Pipeline, tally?: Tally): Promise<PipelineSnapshot> {
  return { pipeline, jobs: await commands.pages(JobSchema, `pipelines/${pipeline.id}/jobs`, tally) }
}
export function pipelineFailures(snapshot: PipelineSnapshot): string[] {
  if (snapshot.pipeline.status !== 'failed') return []
  const failed = snapshot.jobs.filter(job => job.status === 'failed' && !job.allowed_failure).map(job => job.name).sort()
  return failed.length ? failed : ['Pipeline failed']
}
export function pipelineSummary(snapshot: PipelineSnapshot, where: string): string {
  const failed = pipelineFailures(snapshot)
  return failed.length ? `CI failed on ${where}:\n${failed.map(name => `- ${name}`).join('\n')}`
    : `CI on ${where}: ${snapshot.pipeline.status}`
}
export const resourcePath = (ref: Pick<GitlabRef, 'number' | 'isPr'>): string => `${ref.isPr ? 'merge_requests' : 'issues'}/${ref.number}`
export function referenceOf(commands: Commands, number: number, isPr: boolean): GitlabRef {
  const deployment = commands.deployment
  if (deployment.provider !== 'gitlab' || !Number.isSafeInteger(number) || number < 1) throw new Error('A configured GitLab Issue or MR is required')
  return { namespace: deployment.namespace, number, isPr, url: gitlabPage(deployment, number, isPr) }
}
export async function readItem(commands: Commands, ref: GitlabRef): Promise<GitlabItem> {
  return ref.isPr ? commands.api(GitlabMergeRequestSchema, resourcePath(ref)) : commands.api(GitlabItemSchema, resourcePath(ref))
}
function message(note: GitlabNote, ref: GitlabRef, agent: string): ContextMessage {
  const position = note.position
  const path = position?.new_path ?? position?.old_path
  const line = position?.new_line ?? position?.old_line
  return { id: `${ref.url}#note_${note.id}`, from: note.author.username, at: note.created_at, text: note.body,
    url: `${ref.url}#note_${note.id}`, ...note.system || note.author.bot || sameName(note.author.username, agent) ? { bot: true as const } : {},
    ...note.internal !== undefined || note.confidential !== undefined ? { internal: note.internal === true || note.confidential === true } : {},
    ...path ? { path, ...line ? { line } : {} } : {} }
}
export async function discussionForNote(commands: Commands, ref: GitlabRef, noteId: number): Promise<GitlabDiscussion | undefined> {
  return (await commands.pages(GitlabDiscussionSchema, `${resourcePath(ref)}/discussions`))
    .find(thread => !thread.individual_note && thread.notes.some(note => note.id === noteId))
}
function discussionMessages(discussion: GitlabDiscussion, ref: GitlabRef, agent: string): ContextMessage[] {
  const messages = discussion.notes.map(note => message(note, ref, agent))
  return messages.map((item, index) => index > 0 ? { ...item, reply_to: messages[0]!.id } : item)
}
async function rootMessage(commands: Commands, ref: GitlabRef, supplied?: GitlabItem): Promise<ContextMessage> {
  const item = supplied ?? await readItem(commands, ref)
  return { id: ref.url, from: item.author.username, at: item.created_at, text: `${item.title}\n\n${item.description ?? ''}`, url: ref.url,
    ...item.author.bot || sameName(item.author.username, commands.deployment.account.login) ? { bot: true as const } : {} }
}
async function conversationPage(commands: Commands, ref: GitlabRef, page: number, size: number, root: boolean) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid GitLab comment page')
  const messages: ContextMessage[] = root && page === 1 ? [await rootMessage(commands, ref)] : []
  const listed = await commands.api(z.array(z.unknown()), `${resourcePath(ref)}/notes?sort=asc&order_by=created_at&per_page=${size}&page=${page}`)
  const tally = { skipped: 0 }
  messages.push(...validItems(GitlabNoteSchema, listed, tally).map(note => message(note, ref, commands.deployment.account.login)))
  return { messages, next: listed.length === size ? String(page + 1) : undefined, ...tally.skipped ? { skipped: tally.skipped } : {} }
}

export const gitlabThreadContext: ThreadContext<GitlabConfig> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    if (trigger.meta.namespace !== commands.deployment.namespace) throw new Error('GitLab context belongs to another configured project')
    if (typeof trigger.meta.branch === 'string') {
      const item: ContextMessage = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true }
      return { messages: [item], body: { status: 'branch_ci', messages: [item] }, status: 'branch_ci' }
    }
    const ref = referenceOf(commands, Number(trigger.meta.number), trigger.meta.isPr === true)
    if (typeof trigger.meta.discussionId === 'string') {
      const discussion = await commands.api(GitlabDiscussionSchema, `${resourcePath(ref)}/discussions/${encodeURIComponent(trigger.meta.discussionId)}`)
      const messages = discussionMessages(discussion, ref, commands.deployment.account.login)
      const offset = (Number(cursor ?? '1') - 1) * 100
      const read = part === 'thread' ? messages.slice(offset, offset + 100) : messages.slice(0, 1)
      return { messages: read, ...part === 'thread' && offset + 100 < messages.length ? { next: String(offset / 100 + 2) } : {},
        body: { status: 'discussion', messages: read }, status: 'discussion' }
    }
    if (part !== 'thread') {
      const root = await rootMessage(commands, ref)
      return { messages: [root], body: { messages: [root] }, status: 'root' }
    }
    const body = await conversationPage(commands, ref, Number(cursor ?? '1'), 100, true)
    return { messages: body.messages, next: body.next, body }
  },
}

/** Same resource grammar as GitHub, with native MR names and discussion-note IDs. */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  if (commands.deployment.provider !== 'gitlab') throw new Error('GitLab is not the selected repository provider')
  const pipeline = /^gitlab\/pipelines\/([1-9]\d*)\/jobs$/.exec(resource)
  if (pipeline) return pipelineSnapshot(commands, await commands.api(PipelineSchema, `pipelines/${pipeline[1]}`))
  const match = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/(comments|thread|checks)(?:\/([a-zA-Z0-9_-]+))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/issues/<iid> or gitlab/merge_requests/<iid>; append /comments/<page>, /thread/<note-id> or /checks; or gitlab/pipelines/<id>/jobs')
  const [, kind, number, section, suffix] = match
  const ref = referenceOf(commands, Number(number), kind === 'merge_requests')
  if (section === 'checks') {
    if (!ref.isPr || suffix) throw new Error('Checks require an MR and take no page')
    const listed = await commands.api(z.array(PipelineSchema), `${resourcePath(ref)}/pipelines?per_page=1`)
    return listed[0] ? pipelineSnapshot(commands, listed[0]) : { pipeline: null, jobs: [] }
  }
  if (section === 'thread') {
    const noteId = Number(suffix)
    if (!Number.isSafeInteger(noteId) || noteId < 1) throw new Error('Name the GitLab discussion by a note ID')
    const discussion = await discussionForNote(commands, ref, noteId)
    if (!discussion) throw new Error('No discussion on this Issue or MR has that note')
    return { discussion: discussion.id, messages: discussionMessages(discussion, ref, commands.deployment.account.login) }
  }
  if (section === 'comments') {
    const page = Number(suffix ?? '1')
    const body = await conversationPage(commands, ref, page, 20, false)
    return { messages: body.messages, ...body.skipped ? { skipped: body.skipped } : {},
      ...body.next ? { next_resource: `gitlab/${kind}/${number}/comments/${body.next}` } : {} }
  }
  const item = await readItem(commands, ref)
  return { number: item.iid, title: item.title, state: item.state, ...await rootMessage(commands, ref, item),
    ...ref.isPr ? { merged: item.state === 'merged', draft: item.draft === true || item.work_in_progress === true,
      head: item.source_branch, base: item.target_branch } : {} }
}
