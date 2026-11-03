import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type Assessor, type Executor, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { Commands, CliError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { repositoryScope } from '../src/deployment.ts'
import { KV } from '../src/kv.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitlabKind, pollRound } from '../src/sources/gitlab.ts'
import { gitlabChannel, gitlabThread, mentions, noteTrigger, openedTrigger, type GitlabRef } from '../src/sources/gitlab-trigger.ts'
import { claimMergeRequest, observeMergeRequest } from '../src/sources/gitlab-change.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { gitlabThreadContext } from '../src/sources/gitlab-read.ts'

const origin = 'http://gitlab.internal:8080'
const repository = 'team/platform/widgets'
const namespace = repositoryScope('gitlab', origin, repository)
const config = { host: origin, repository, cli: '/bin/false', observeIssues: true, observeMergeRequests: true, observeComments: true, observeCi: true }
const at = () => new Date(Date.now() - 1000).toISOString()
const author = { id: 11, username: 'alice', bot: false }
const issue = () => ({ id: 101, iid: 7, title: 'Fix the margin', description: '@agent.bot fix this', state: 'opened', author,
  created_at: at(), updated_at: at(), web_url: `${origin}/${repository}/-/issues/7` })
const mergeRequest = () => ({ ...issue(), id: 102, source_project_id: 42, target_project_id: 42, source_branch: 'agent/job',
  target_branch: 'main', sha: 'abc', web_url: `${origin}/${repository}/-/merge_requests/7`, merge_when_pipeline_succeeds: false })
const note = (id = 201) => ({ id, body: '@agent.bot please fix this', author, system: false, created_at: at(), updated_at: at() })
const reference = (isPr = false): GitlabRef => ({ namespace, number: 7, isPr,
  url: `${origin}/${repository}/-/${isPr ? 'merge_requests' : 'issues'}/7`, prAuthor: isPr ? 'alice' : undefined })
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function fixture(overrides: Record<string, unknown> = {}, initialCursor = true) {
  const directory = mkdtempSync(join(tmpdir(), 'gitlab-source-'))
  const store = new Store(join(directory, 'state.sqlite'))
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.saveSettings(SettingsSchema.parse({ executor: { repositoryProvider: 'gitlab' }, eval: { mode: 'auto' },
    sources: { gitlab: { enabled: true, config: { ...config, ...overrides } } },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board); sources.register(gitlabKind)
  const deployment = testDeployment({ provider: 'gitlab', origin, repository, namespace, projectId: 42, defaultBranch: 'main',
    account: { cli: '/bin/false', login: 'agent.bot', email: 'bot@example.test' } })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => engine.receive(trigger))
  const ctx = sourceContextOf({ store, engine, outbox, commands, sources, deployment, ready: Promise.resolve(), configured: () => true, receive }, gitlabKind)
  const since = new Date(Date.now() - 60_000).toISOString()
  if (initialCursor) store.set(KV.gitlab.cursor(namespace), since)
  store.set(KV.gitlab.observed(namespace), { issues: since, mergeRequests: since, comments: since, ci: since })
  return { ctx, store, sources, commands, receive, engine, deployment, since, health: board.all }
}
function route(commands: Commands, handler: (path: string, query: URLSearchParams, args: string[]) => unknown,
  project = { default_branch: 'main' }) {
  return vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    const url = new URL(`http://local/${args[1]}`)
    if (url.pathname === '/projects/42') return JSON.stringify(project)
    if (!url.pathname.startsWith('/projects/42/')) throw new Error('Escaped project')
    const result = handler(url.pathname.slice('/projects/42/'.length), url.searchParams, args)
    if (result instanceof Error) throw result
    return typeof result === 'string' ? result : JSON.stringify(result)
  })
}
const ticket = (id: string, name = 'job'): Ticket => ({ id, title: id, decisionId: `decision-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'alice' }, scope: '' },
  execution: { name, directory: `/work/${name}`, assignment: '' }, channels: [], assignments: [], inputs: [], undelivered: [],
  origin: { triggerId: `origin-${id}`, triggerIds: [] }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })

describe('GitLab event identities and authority', () => {
  it('separates Issue and MR IIDs and the same IID on another hosting instance', () => {
    const openedIssue = openedTrigger(issue(), reference(), 'agent.bot')
    const openedMr = openedTrigger(mergeRequest(), reference(true), 'agent.bot')
    const elsewhere = openedTrigger(issue(), { ...reference(), namespace: repositoryScope('gitlab', 'https://other.internal', repository) }, 'agent.bot')
    expect(new Set([openedIssue.id, openedMr.id, elsewhere.id]).size).toBe(3)
    expect(openedIssue.threads[0]).not.toEqual(openedMr.threads[0])
    expect(openedIssue).toMatchObject({ actor: { source: 'gitlab', id: 'alice' }, human: true, addressed: 'mention' })
    expect(openedMr.meta).toMatchObject({ number: 7, isPr: true, namespace })
  })
  it('recognizes dotted usernames without admitting longer usernames or email addresses', () => {
    expect(mentions('Please @agent.bot, fix it.', 'agent.bot')).toBe(true)
    expect(mentions('@AGENT.BOT.', 'agent.bot')).toBe(true)
    expect(mentions('@agent.bot.more', 'agent.bot')).toBe(false)
    expect(mentions('email@agent.bot', 'agent.bot')).toBe(false)
  })
  it('keeps edited note versions distinct and marks machine or system content as non-human', () => {
    const original = noteTrigger(note(), reference(), 'agent.bot')
    const edited = noteTrigger({ ...note(), updated_at: new Date().toISOString() }, reference(), 'agent.bot')
    expect(original.id).not.toBe(edited.id)
    expect(noteTrigger({ ...note(), author: { ...author, bot: true } }, reference(), 'agent.bot').human).toBe(false)
    expect(noteTrigger({ ...note(), system: true }, reference(), 'agent.bot').human).toBe(false)
    expect(gitlabKind.scope!({ meta: { ...original.meta, namespace: 'another-project' } }, gitlabKind.schema.parse(config)))
      .toMatchObject({ listened: false })
  })
})

describe('GitLab polling', () => {
  it('takes new roots and comments into their distinct threads and checkpoints successful reads', async () => {
    const h = fixture()
    const openedIssue = issue(); const openedMr = mergeRequest(); const comment = note()
    route(h.commands, path => {
      if (path === 'issues') return [openedIssue]
      if (path === 'merge_requests') return [openedMr]
      if (path === 'events') return [{ id: 1, target_type: 'Note', created_at: comment.created_at,
        note: { ...comment, noteable_type: 'Issue', noteable_iid: 7 } }]
      if (path === 'issues/7') return openedIssue
      if (path === 'issues/7/notes/201') return comment
      if (path === 'merge_requests/7') return openedMr
      return []
    })
    await pollRound(h.ctx)
    const roots = [openedTrigger(openedIssue, reference(), 'agent.bot'), openedTrigger(openedMr, reference(true), 'agent.bot')]
    for (const root of roots) expect(h.store.triggers.get(root.id)?.actor.id).toBe('alice')
    expect(h.store.triggers.get(noteTrigger(comment, reference(), 'agent.bot').id)?.text).toContain('please fix this')
    expect(h.store.get(KV.gitlab.cursor(namespace))).not.toBe(h.since)
  })
  it('keeps the read checkpoint on a partial API failure while processing other streams', async () => {
    const h = fixture()
    const openedIssue = issue()
    route(h.commands, path => path === 'merge_requests' ? new CliError('Unavailable', 503) : path === 'issues' ? [openedIssue] : [])
    await expect(pollRound(h.ctx)).rejects.toThrow()
    expect(h.store.get(KV.gitlab.cursor(namespace))).toBe(h.since)
    expect(h.store.triggers.get(openedTrigger(openedIssue, reference(), 'agent.bot').id)?.text).toContain('Fix the margin')
  })
  it('recovers requests that arrive during the first polling outage without replaying earlier history', async () => {
    vi.useFakeTimers()
    try {
      const h = fixture({ observeIssues: false, observeMergeRequests: false, observeComments: false, observeCi: false }, false)
      const start = Date.now()
      route(h.commands, path => path === 'issues' ? new CliError('Unavailable', 503) : [])
      await expect(pollRound(h.ctx)).rejects.toThrow()
      vi.setSystemTime(start + 10_000)
      const duringOutage = issue()
      route(h.commands, path => path === 'issues' ? [duringOutage, { ...issue(), id: 100, iid: 6,
        created_at: new Date(start - 60_000).toISOString() }] : [])
      await pollRound(h.ctx)
      expect(h.store.triggers.get(openedTrigger(duringOutage, reference(), 'agent.bot').id)?.actor.id).toBe('alice')
      expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.number)).toEqual([7])
    } finally { vi.useRealTimers() }
  })
  it('reports CI failure and recovery after its initial baseline with a fresh event per transition', async () => {
    const h = fixture({ observeIssues: false, observeMergeRequests: false, observeComments: false })
    let status = 'failed'
    route(h.commands, path => path === 'pipelines' ? [{ id: 9, status, sha: 'abc', ref: 'main', web_url: `${origin}/pipeline/9` }]
      : path === 'pipelines/9/jobs' ? [{ id: 91, name: 'unit', status: 'failed' }] : [])
    await pollRound(h.ctx)
    expect(h.receive.mock.calls.filter(([trigger]) => trigger.meta.ci)).toEqual([])
    status = 'success'; await pollRound(h.ctx)
    status = 'failed'; await pollRound(h.ctx)
    status = 'success'; await pollRound(h.ctx)
    const changes = h.receive.mock.calls.map(([trigger]) => trigger).filter(trigger => trigger.meta.ci)
    expect(changes.map(trigger => trigger.meta.status)).toEqual(['success', 'failed', 'success'])
    expect(new Set(changes.map(trigger => trigger.id)).size).toBe(3)
  })
  it('does not consume a CI transition while the Source is disabled during a read', async () => {
    const h = fixture({ observeIssues: false, observeMergeRequests: false, observeComments: false })
    let status = 'success'
    let disable = false
    route(h.commands, path => {
      if (path === 'pipelines') return [{ id: 9, status, sha: 'abc', ref: 'main' }]
      if (path === 'pipelines/9/jobs') {
        if (disable) {
          const settings = h.store.settings()
          h.store.saveSettings({ ...settings, sources: { ...settings.sources, gitlab: { ...settings.sources.gitlab!, enabled: false } } })
        }
        return status === 'failed' ? [{ id: 91, name: 'unit', status: 'failed' }] : []
      }
      return []
    })
    await pollRound(h.ctx)
    status = 'failed'; disable = true
    await pollRound(h.ctx)
    expect(h.receive.mock.calls.filter(([trigger]) => trigger.meta.ci)).toEqual([])
    const settings = h.store.settings()
    h.store.saveSettings({ ...settings, sources: { ...settings.sources, gitlab: { ...settings.sources.gitlab!, enabled: true } } })
    disable = false
    await pollRound(h.ctx)
    expect(h.receive.mock.calls.map(([trigger]) => trigger).filter(trigger => trigger.meta.ci).map(trigger => trigger.meta.status)).toEqual(['failed'])
  })
})

describe('GitLab delivery and context', () => {
  it('keeps an internal reply private after its source note disappears', async () => {
    const h = fixture()
    const trigger = noteTrigger({ ...note(), internal: true }, reference(), 'agent.bot')
    let internal: boolean | undefined
    route(h.commands, (path, _query, args) => {
      if (path === 'issues/7/notes' && args.includes('POST')) {
        internal = args.includes('internal=true')
        return {}
      }
      return []
    })
    await sendGitlab(h.ctx, { id: 'private-reply', channel: trigger.channel!, text: 'Private answer', kind: 'reply' })
    expect(internal).toBe(true)
  })
  it('reconciles an uncertain POST by its own marker, not a forged marker from another user', async () => {
    const h = fixture()
    const ref = reference()
    const message = { id: 'stable-delivery', channel: gitlabChannel(ref), text: 'Done', kind: 'reply' as const }
    const notes = [{ ...note(), body: '<!-- dsh-superagent:stable-delivery -->' }]
    let posts = 0
    route(h.commands, (path, _query, args) => {
      if (path !== 'issues/7/notes') return []
      if (args.includes('POST')) {
        posts++
        const body = args.find(arg => arg.startsWith('body='))!.slice(5)
        notes.push({ ...note(202), body, author: { ...author, username: 'agent.bot' } })
        return new CliError('connection lost after write')
      }
      return notes
    })
    await expect(sendGitlab(h.ctx, message)).rejects.toThrow()
    expect(await sendGitlab(h.ctx, message)).toBe('sent')
    expect(posts).toBe(1)
  })
  it('refuses delivery to an old project namespace before contacting GitLab', async () => {
    const h = fixture()
    const run = vi.spyOn(h.commands, 'run')
    await expect(sendGitlab(h.ctx, { id: 'wrong-scope', channel: gitlabChannel({ ...reference(), namespace: 'old-project' }), text: 'No', kind: 'reply' }))
      .rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
  it('reads a root and paginated discussion without dropping the second page', async () => {
    const h = fixture()
    const root = issue()
    route(h.commands, (path, query) => path === 'issues/7' ? root : query.get('page') === '2'
      ? [note(301)] : Array.from({ length: 100 }, (_, index) => note(index + 1)))
    const trigger = openedTrigger(root, reference(), 'agent.bot')
    const first = await gitlabThreadContext.read(h.commands, trigger, 'thread', undefined, gitlabKind.schema.parse(config))
    expect(first.messages[0]?.text).toContain('Fix the margin')
    expect(first.next).toBe('2')
    const second = await gitlabThreadContext.read(h.commands, trigger, 'thread', first.next, gitlabKind.schema.parse(config))
    expect(second.messages.map(message => message.id)).toEqual([`${reference().url}#note_301`])
    expect(second.next).toBeUndefined()
  })
  it('binds only an agent-owned MR on the ticket branch and closes its ticket after merge', async () => {
    const h = fixture()
    h.store.tickets.save(ticket('one'))
    const own = { ...mergeRequest(), author: { ...author, username: 'agent.bot' } }
    expect(claimMergeRequest(h.ctx, 'one', own)).toBeUndefined()
    const thread = gitlabThread(reference(true))
    expect(h.store.tickets.get('one')?.follows).toEqual([{ thread: `gitlab:${thread.id}`, own: true }])
    h.store.tickets.save(ticket('two'))
    expect(claimMergeRequest(h.ctx, 'two', own)).toBeDefined()
    expect(claimMergeRequest(h.ctx, 'two', { ...own, iid: 8, source_branch: 'someone-else' })).toBeDefined()
    await observeMergeRequest(h.ctx, { ...own, state: 'merged', merged_at: new Date().toISOString() })
    expect(h.store.tickets.get('one')?.ended?.outcome).toBe('merged')
  })
})
