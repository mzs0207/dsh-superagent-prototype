/** Native GitLab Issues, MRs, notes and pipeline transitions mapped to stable domain events. */
import { z } from 'zod'
import { key, type ChannelRef, type ThreadRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import type { Deployment } from '../deployment.ts'

export const SOURCE = 'gitlab'
export const GitlabUserSchema = z.looseObject({ id: z.number().optional(), username: z.string(), bot: z.boolean().optional() })
  .nullable().transform(user => user ?? { username: 'ghost', bot: true })
export const GitlabItemSchema = z.looseObject({ id: z.number().int().positive(), iid: z.number().int().positive(), title: z.string(),
  description: z.string().nullish(), state: z.string(), author: GitlabUserSchema, created_at: z.string(), updated_at: z.string().nullish(),
  web_url: z.string().optional(), closed_at: z.string().nullish() })
export type GitlabItem = z.infer<typeof GitlabItemSchema>
export const GitlabMergeRequestSchema = GitlabItemSchema.extend({ source_project_id: z.number().nullish(), target_project_id: z.number(),
  source_branch: z.string(), target_branch: z.string(), sha: z.string().nullish(), merged_at: z.string().nullish(),
  merge_when_pipeline_succeeds: z.boolean().optional(), auto_merge_enabled: z.boolean().optional() })
export type GitlabMergeRequest = z.infer<typeof GitlabMergeRequestSchema>
export const GitlabNoteSchema = z.looseObject({ id: z.number().int().positive(), body: z.string(), author: GitlabUserSchema,
  system: z.boolean().default(false), created_at: z.string(), updated_at: z.string().nullish(), type: z.string().nullish(),
  internal: z.boolean().optional(), confidential: z.boolean().optional(),
  position: z.looseObject({ new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().nullish(), old_line: z.number().nullish() }).nullish() })
export type GitlabNote = z.infer<typeof GitlabNoteSchema>
export const GitlabDiscussionSchema = z.looseObject({ id: z.string().min(1), individual_note: z.boolean().optional(), notes: z.array(GitlabNoteSchema) })
export type GitlabDiscussion = z.infer<typeof GitlabDiscussionSchema>
export const PipelineSchema = z.looseObject({ id: z.number().int().positive(), status: z.string(), sha: z.string(), ref: z.string(),
  web_url: z.string().optional(), updated_at: z.string().nullish(), created_at: z.string().nullish() })
export type Pipeline = z.infer<typeof PipelineSchema>
export interface GitlabRef { namespace: string; number: number; isPr: boolean; url: string; prAuthor?: string | undefined; discussionId?: string | undefined }
export const gitlabThread = (ref: Pick<GitlabRef, 'namespace' | 'number' | 'isPr'>): ThreadRef =>
  ({ source: SOURCE, id: `${ref.namespace}:${ref.isPr ? 'merge_request' : 'issue'}:${ref.number}` })
export const gitlabPage = (deployment: Pick<Deployment, 'webUrl'>, number: number, isPr = false): string =>
  `${deployment.webUrl}/-/${isPr ? 'merge_requests' : 'issues'}/${number}`
export function gitlabChannel(ref: GitlabRef, noteId?: number, discussionId = ref.discussionId): ChannelRef {
  const url = noteId ? `${ref.url}#note_${noteId}` : ref.url
  return { source: SOURCE, thread: `${SOURCE}:${gitlabThread(ref).id}`, address: { namespace: ref.namespace,
    number: String(ref.number), isPr: String(ref.isPr), url, ...noteId ? { note: String(noteId) } : {},
    ...discussionId ? { discussion: discussionId } : {} } }
}
export function parseGitlabThread(id: string, deployment: Pick<Deployment, 'namespace' | 'webUrl'>): GitlabRef | undefined {
  const match = /^([^:]+):(issue|merge_request):([1-9]\d*)$/.exec(id)
  if (!match || match[1] !== deployment.namespace) return undefined
  const number = Number(match[3]); const isPr = match[2] === 'merge_request'
  return { namespace: deployment.namespace, number, isPr, url: gitlabPage(deployment, number, isPr) }
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-]|\\.[a-zA-Z0-9_-])`, 'i').test(text)
function person(user: z.infer<typeof GitlabUserSchema>, agent: string, system = false) {
  return { actor: { source: SOURCE, id: user.username }, human: !system && !user.bot && !sameName(user.username, agent) }
}
export function openedTrigger(item: Pick<z.infer<typeof GitlabItemSchema>, 'iid' | 'title' | 'description' | 'author' | 'created_at'>,
  ref: GitlabRef, agent: string): Trigger {
  const body = item.description ?? ''
  return { id: key('gitlab-opened', ref.namespace, ref.isPr ? 'merge_request' : 'issue', String(item.iid)), source: SOURCE,
    threads: [gitlabThread(ref)], ...person(item.author, agent), at: item.created_at, text: `${item.title}\n\n${body}`,
    ...mentions(body, agent) ? { addressed: 'mention' as const } : {}, channel: gitlabChannel(ref), url: ref.url,
    meta: { namespace: ref.namespace, number: item.iid, isPr: ref.isPr, kind: ref.isPr ? 'merge_request' : 'issue',
      ...ref.isPr ? { prAuthor: item.author.username } : {} } }
}
export function noteTrigger(note: GitlabNote, ref: GitlabRef, agent: string): Trigger {
  const position = note.position
  const path = position?.new_path ?? position?.old_path
  const line = position?.new_line ?? position?.old_line
  const text = path ? `${path}${line ? `:${line}` : ''}\n\n${note.body}` : note.body
  const url = `${ref.url}#note_${note.id}`
  const channel = gitlabChannel(ref, note.id)
  if (note.internal !== undefined || note.confidential !== undefined) channel.address.internal = String(note.internal === true || note.confidential === true)
  return { id: key('gitlab-note', ref.namespace, String(note.id), note.updated_at ?? note.created_at), source: SOURCE,
    threads: [gitlabThread(ref)], ...person(note.author, agent, note.system), at: note.updated_at ?? note.created_at, text,
    ...mentions(note.body, agent) ? { addressed: 'mention' as const } : {}, channel, url,
    meta: { namespace: ref.namespace, number: ref.number, isPr: ref.isPr, commentId: note.id,
      ...channel.address.internal !== undefined ? { internal: channel.address.internal === 'true' } : {},
      kind: position ? 'inline' : 'conversation', ...ref.prAuthor ? { prAuthor: ref.prAuthor } : {},
      ...ref.discussionId ? { discussionId: ref.discussionId } : {}, ...path ? { path, line: line ?? null } : {} } }
}
export function pipelineTrigger(deployment: Pick<Deployment, 'namespace' | 'webUrl'>, target: GitlabRef | { branch: string },
  pipeline: Pipeline, revision: number, summary: string): Trigger {
  const ref = 'number' in target ? target : undefined
  const branch = 'branch' in target ? target.branch : undefined
  const id = ref ? gitlabThread(ref).id : `${deployment.namespace}:ci:${encodeURIComponent(branch!)}`
  const url = pipeline.web_url ?? `${deployment.webUrl}/-/pipelines/${pipeline.id}`
  return { id: key('gitlab-ci', deployment.namespace, id, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id }], actor: { source: SOURCE, id: '' }, human: false,
    at: pipeline.updated_at ?? pipeline.created_at ?? new Date().toISOString(), text: summary, url,
    ...ref ? { channel: gitlabChannel(ref) } : {},
    meta: { namespace: deployment.namespace, ci: true, pipelineId: pipeline.id, sha: pipeline.sha, status: pipeline.status, revision,
      ...ref ? { number: ref.number, isPr: true, ...ref.prAuthor ? { prAuthor: ref.prAuthor } : {} } : { branch } } }
}
