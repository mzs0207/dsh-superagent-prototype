/** GitLab notes/discussion delivery, with project binding and retry-safe markers. */
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { OutboundMessage } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { GitlabDiscussionSchema, GitlabNoteSchema, gitlabPage } from './gitlab-trigger.ts'
import { discussionForNote, referenceOf } from './gitlab-read.ts'

export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const address = message.channel.address
  const { deployment } = commands
  if (deployment.provider !== 'gitlab' || address.namespace !== deployment.namespace) throw new Error('GitLab reply belongs to another configured project')
  const number = Number(address.number)
  if (!Number.isSafeInteger(number) || number < 1 || !['true', 'false'].includes(address.isPr ?? '')) throw new Error('Missing GitLab reply target')
  const base = `${address.isPr === 'true' ? 'merge_requests' : 'issues'}/${number}`
  try {
    const ref = referenceOf(commands, number, address.isPr === 'true')
    const discussion = address.discussion
      ? await commands.api(GitlabDiscussionSchema, `${base}/discussions/${encodeURIComponent(address.discussion)}`)
      : address.note ? await discussionForNote(commands, ref, Number(address.note)) : undefined
    const target = discussion ? `${base}/discussions/${encodeURIComponent(discussion.id)}/notes` : `${base}/notes`
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const notes = discussion?.notes ?? await commands.pages(GitlabNoteSchema, `${base}/notes`)
    const original = address.note ? notes.find(note => note.id === Number(address.note)) : undefined
    const internal = address.internal === 'true' || original?.internal === true || original?.confidential === true
    if (address.note && !original && address.internal === undefined) throw new Error('Original GitLab note is not readable; refusing to widen reply audience')
    if (notes.some(note => sameName(note.author.username, deployment.account.login) && note.body.includes(marker)
      && (!internal || note.internal === true || note.confidential === true))) return 'sent'
    await commands.api(target, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`, ...internal ? ['-F', 'internal=true'] : [])
    return 'sent'
  } catch (error) {
    // A 404 can mean revoked access to a private project; never silently discard it.
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = Number(address.number)
  const isPr = address.isPr === 'true'
  const url = address.url ?? (links.webUrl && links.namespace === address.namespace && number > 0
    ? gitlabPage({ webUrl: links.webUrl }, number, isPr) : '')
  return { url, label: { zh: `GitLab ${isPr ? 'MR !' : 'Issue #'}${address.number ?? ''}`,
    en: `GitLab ${isPr ? 'MR !' : 'Issue #'}${address.number ?? ''}` } }
}
