/** Self-managed GitLab Source: native project events, Issue/MR roots, subscribed notes and CI. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { threadKey, type Thread, type Trigger } from '../core/index.ts'
import { GitlabAccountsSchema, gitlabOrigin, repositoryScope } from '../deployment.ts'
import { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import type { FieldSpec, Localized, SourceKind } from './kind.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { cursorAt, pause, pollThreads as pollEach, POLL_HORIZON_MS } from './poll.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { mergeRequestRef, mergeRequestsOf, observeMergeRequest, readMergeRequest } from './gitlab-change.ts'
import { discussionForNote, gitlabThreadContext, pipelineFailures, pipelineSnapshot, pipelineSummary, resourcePath } from './gitlab-read.ts'
import { GitlabItemSchema, GitlabMergeRequestSchema, GitlabNoteSchema, PipelineSchema, SOURCE, gitlabPage, gitlabThread,
  mentions, noteTrigger, openedTrigger, parseGitlabThread, pipelineTrigger,
  type GitlabMergeRequest, type GitlabNote, type GitlabRef } from './gitlab-trigger.ts'

const HostSchema = z.string().trim().refine(value => {
  if (!value) return true
  try { gitlabOrigin(value); return true } catch { return false }
}, 'An HTTP(S) origin without credentials, path, query or fragment').default('')
export const GitlabConfigSchema = GitlabAccountsSchema.extend({ host: HostSchema,
  pollSeconds: z.number().int().min(60).max(3600).default(60), failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false),
  observeComments: z.boolean().default(false), observeCi: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', mergeRequests: 'observeMergeRequests', comments: 'observeComments', ci: 'observeCi' } as const
type Observation = keyof typeof OBSERVED
function scopeNamespace(config: Pick<GitlabConfig, 'host' | 'repository'>): string | undefined {
  return config.host && config.repository ? repositoryScope('gitlab', gitlabOrigin(config.host), config.repository) : undefined
}
function rowOf(meta: Record<string, unknown>): Observation | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'merge_request') return 'mergeRequests'
  return typeof meta.commentId === 'number' ? 'comments' : undefined
}
const switches: FieldSpec[] = [
  { key: 'observeIssues', type: 'switch', label: { zh: '接收新的 Issue', en: 'Receive new Issues' } },
  { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收新的 MR', en: 'Receive new merge requests' } },
  { key: 'observeComments', type: 'switch', label: { zh: '接收项目评论', en: 'Receive project comments' } },
  { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支 CI', en: 'Receive default-branch CI' } },
]
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE, repositoryProvider: 'gitlab', defaultEnabled: false,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '自托管 GitLab 项目的 Issue、MR、评论、已订阅讨论和 CI；使用轮询，无需公网 Webhook。执行器须选择 GitLab 平台。',
    en: 'Issues, MRs, notes, subscribed discussions and CI in a self-managed GitLab project. Polling needs no public webhook; select GitLab as repository hosting.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', label: { zh: 'GitLab 主机', en: 'GitLab host' },
      hint: { zh: '完整 HTTP(S) 源地址，可包含端口；不含项目路径、账号密码或查询参数。内网主机绕过云模型代理。', en: 'HTTP(S) origin, including a port when needed; no project path, credentials or query. This host bypasses cloud-model proxies.' } },
    { key: 'repository', type: 'text', pattern: '([A-Za-z0-9_.\\-]+/)+[A-Za-z0-9_.\\-]+', label: { zh: '项目命名空间路径', en: 'Project namespace path' },
      hint: { zh: '例如 group/subgroup/project。支持嵌套子组；保存时读取实际项目和账号写入角色。', en: 'For example group/subgroup/project. Nested groups are supported; saving checks the real project and account write role.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '使用独立 GLAB_CONFIG_DIR 的 glab 包装脚本，命令名或绝对路径。不要给智能体个人账号的令牌。', en: 'A glab wrapper with its own GLAB_CONFIG_DIR, as a command name or absolute path. Do not give the agent a personal account token.' } },
    { key: 'caFile', type: 'text', advanced: true, label: { zh: '私有 CA 文件', en: 'Private CA file' },
      hint: { zh: '可选的绝对 PEM 路径，用于私有证书。保留 TLS 校验，不使用 insecure 或关闭 sslVerify。', en: 'Optional absolute PEM path for private certificates. TLS verification remains on; do not use insecure or disable sslVerify.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告', en: 'Failed polls before reporting' } },
    ...switches,
  ],
  health: ['gitlab'], channel: { send: sendGitlab, link: gitlabLink,
    allowed: (address, config) => address.namespace === scopeNamespace(config) },
  threadContext: gitlabThreadContext,
  scope: ({ meta }, config) => {
    const namespace = scopeNamespace(config)
    if (!namespace || meta.namespace !== namespace) return { listened: false, reason: 'The GitLab project does not match this Source' }
    const row = rowOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  find: (query, stored) => {
    const config = GitlabConfigSchema.parse(stored ?? {})
    const namespace = scopeNamespace(config)
    if (!namespace) return { threads: [], terms: [] }
    const match = /^([#!]?)([1-9]\d*)$/.exec(query.trim())
    let marker: string
    let number: number
    if (match) { marker = match[1]!; number = Number(match[2]) }
    else {
      try {
        const url = new URL(query)
        const base = `/${config.repository}/-/`
        if (url.origin !== gitlabOrigin(config.host) || !url.pathname.toLowerCase().startsWith(base.toLowerCase())) return { threads: [], terms: [] }
        const address = /\/-\/(issues|merge_requests)\/([1-9]\d*)$/.exec(url.pathname)
        if (!address) return { threads: [], terms: [] }
        marker = address[1] === 'issues' ? '#' : '!'; number = Number(address[2])
      } catch { return { threads: [], terms: [] } }
    }
    const kinds = marker === '!' ? [true] : marker === '#' ? [false] : [false, true]
    return { threads: kinds.map(isPr => `${SOURCE}:${gitlabThread({ namespace, number, isPr }).id}`), terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().optional() }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '可以发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的用户在 Issue、MR 或评论中 @ 智能体的 GitLab 用户名。', en: 'A listed user mentions the agent GitLab username in an Issue, MR or note.' },
    rows: stored => {
      const config = GitlabConfigSchema.partial().parse(stored)
      const row = (id: Observation, label: { zh: string; en: string }) => ({ id, label,
        note: config[OBSERVED[id]] ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mergeRequests', { zh: '新 MR', en: 'New MRs' }),
        row('comments', { zh: '评论', en: 'Notes' }), { id: 'ci', label: { zh: '默认分支 CI', en: 'Default branch CI' },
          note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.provider === 'gitlab' ? {
    cli: { zh: `当前账号 @${deployment.account.login}`, en: `Current account @${deployment.account.login}` },
    repository: { zh: `项目 #${deployment.projectId}: ${deployment.repository}`, en: `Project #${deployment.projectId}: ${deployment.repository}` },
  } : {},
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_ISSUE_IID', description: { zh: '源 GitLab Issue 的项目内编号；其他来源为空', en: 'Project-local IID of the source GitLab Issue; empty for other origins' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_IID', description: { zh: '源 GitLab MR 的项目内编号；其他来源为空', en: 'Project-local IID of the source GitLab MR; empty for other origins' } },
      { key: 'DSH_SUPERAGENT_GITLAB_NOTE_ID', description: { zh: '源 GitLab 评论的 ID；不是评论时为空', en: 'Source GitLab note ID; empty when not a note' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PIPELINE_ID', description: { zh: '源 GitLab 流水线 ID；其他触发为空', en: 'Source GitLab pipeline ID; empty for other triggers' } },
    ],
    values: ({ trigger }) => {
      const meta = trigger?.source === SOURCE ? trigger.meta : {}
      return { DSH_SUPERAGENT_GITLAB_ISSUE_IID: meta.isPr === false ? String(meta.number ?? '') : '',
        DSH_SUPERAGENT_GITLAB_MR_IID: meta.isPr === true ? String(meta.number ?? '') : '',
        DSH_SUPERAGENT_GITLAB_NOTE_ID: String(meta.commentId ?? ''), DSH_SUPERAGENT_GITLAB_PIPELINE_ID: String(meta.pipelineId ?? '') }
    },
  },
}

interface Round {
  started: string
  since: string
  signal?: AbortSignal | undefined
  commands: Commands
  config: GitlabConfig
  observed: Record<string, string>
  issues: Map<number, z.infer<typeof GitlabItemSchema>>
  requests: Map<number, GitlabMergeRequest>
  seen: Set<string>
  read: Set<string>
  failures: string[]
  tally: Tally
}
const stopped = (ctx: SourceContext, round: Round) => !!round.signal?.aborted || !ctx.config(SOURCE)
async function intake(ctx: SourceContext, round: Round, trigger: Trigger, row: Observation): Promise<void> {
  if (stopped(ctx, round) || round.seen.has(trigger.id)) return
  const subscribed = ctx.threads.get(threadKey(trigger.threads[0]!))?.subscriptions.length
  const observed = round.config[OBSERVED[row]] && Date.parse(trigger.at) >= Date.parse(round.observed[row] ?? round.started)
  if (!trigger.addressed && !observed && !subscribed) return
  round.seen.add(trigger.id)
  await ctx.receive(trigger)
}
function describe(ctx: SourceContext, ref: GitlabRef, title: string): void {
  const key = `${SOURCE}:${gitlabThread(ref).id}`
  ctx.threads.describe(key, { label: `GitLab ${ref.isPr ? '!' : '#'}${ref.number} ${title}`, url: ref.url })
  ctx.threads.patch(key, { namespace: ref.namespace, number: ref.number, isPr: ref.isPr, url: ref.url, ...ref.prAuthor ? { prAuthor: ref.prAuthor } : {} })
}
async function resource(ctx: SourceContext, round: Round, number: number, isPr: boolean): Promise<GitlabRef> {
  if (isPr) {
    const request = round.requests.get(number) ?? await readMergeRequest(ctx, number, round.signal)
    round.requests.set(number, request)
    const ref = mergeRequestRef(ctx, request)
    if (!stopped(ctx, round)) { await observeMergeRequest(ctx, request); describe(ctx, ref, request.title) }
    return ref
  }
  const item = round.issues.get(number) ?? await round.commands.api(GitlabItemSchema, `issues/${number}`)
  round.issues.set(number, item)
  const ref = { namespace: ctx.deployment.namespace, number, isPr: false, url: gitlabPage(ctx.deployment, number) }
  describe(ctx, ref, item.title)
  return ref
}
async function note(ctx: SourceContext, round: Round, item: GitlabNote, ref: GitlabRef): Promise<void> {
  if (item.system || sameName(item.author.username, ctx.deployment.account.login)) return
  if (item.type && item.type !== 'Note' && !ref.discussionId) {
    const discussion = await discussionForNote(round.commands, ref, item.id)
    if (discussion) ref = { ...ref, discussionId: discussion.id }
  }
  await intake(ctx, round, noteTrigger(item, ref, ctx.deployment.account.login), 'comments')
}
/** Read newest pages until the overlap window is complete; deliver the retained events oldest first. */
async function recent<T extends { id: number }>(round: Round, schema: z.ZodType<T>, path: string, since: string,
  time: (item: T) => string): Promise<T[]> {
  const result: T[] = []
  const after = Date.parse(since)
  let previous: string | undefined
  for (let page = 1; page <= 1000; page++) {
    round.signal?.throwIfAborted()
    const raw = await round.commands.api(z.array(z.unknown()), `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    const items = validItems(schema, raw, round.tally)
    const identity = items.length ? `${items[0]!.id}:${items.at(-1)!.id}` : undefined
    if (identity && identity === previous) throw new CliError('GitLab pagination did not advance')
    let older = false
    for (const item of items) {
      const at = Date.parse(time(item))
      if (!Number.isFinite(at)) { round.tally.skipped++; continue }
      if (at < after) older = true
      else result.push(item)
    }
    if (older || raw.length < 100) return result.sort((a, b) => Date.parse(time(a)) - Date.parse(time(b)))
    previous = identity
  }
  throw new CliError('GitLab pagination exceeded 1000 pages')
}
async function roots(ctx: SourceContext, round: Round): Promise<void> {
  const suffix = `scope=all&state=all&order_by=updated_at&sort=desc&updated_after=${encodeURIComponent(round.since)}`
  const tasks = [async () => {
    const issues = await round.commands.pages(GitlabItemSchema, `issues?${suffix}`, round.tally)
    for (const item of issues) {
      if (stopped(ctx, round)) return
      round.issues.set(item.iid, item)
      if (Date.parse(item.created_at) < Date.parse(round.since) || sameName(item.author.username, ctx.deployment.account.login)) continue
      const ref = { namespace: ctx.deployment.namespace, number: item.iid, isPr: false, url: gitlabPage(ctx.deployment, item.iid) }
      await intake(ctx, round, openedTrigger(item, ref, ctx.deployment.account.login), 'issues')
      describe(ctx, ref, item.title)
    }
  }, async () => {
    const requests = await round.commands.pages(GitlabMergeRequestSchema, `merge_requests?${suffix}`, round.tally)
    for (const item of requests) {
      if (stopped(ctx, round)) return
      round.requests.set(item.iid, item)
      await observeMergeRequest(ctx, item)
      const ref = mergeRequestRef(ctx, item); describe(ctx, ref, item.title)
      if (Date.parse(item.created_at) < Date.parse(round.since) || sameName(item.author.username, ctx.deployment.account.login)) continue
      await intake(ctx, round, openedTrigger(item, ref, ctx.deployment.account.login), 'mergeRequests')
    }
  }]
  for (const task of tasks) {
    if (stopped(ctx, round)) return
    await task().catch(error => { if (!stopped(ctx, round)) round.failures.push(String(error)) })
  }
}
const EventSchema = z.looseObject({ id: z.number(), created_at: z.string(), note: z.unknown().optional() })
const EventNoteSchema = GitlabNoteSchema.extend({ noteable_type: z.string(), noteable_iid: z.number().int().positive() })
async function events(ctx: SourceContext, round: Round): Promise<void> {
  const listed = await recent(round, EventSchema, `events?target_type=note&sort=desc&after=${round.since.slice(0, 10)}`, round.since, event => event.created_at)
  for (const event of listed) {
    if (stopped(ctx, round)) return
    const parsed = EventNoteSchema.safeParse(event.note)
    if (!parsed.success) { round.tally.skipped++; continue }
    const item = parsed.data
    if (!['Issue', 'MergeRequest'].includes(item.noteable_type)) continue
    if (item.system || sameName(item.author.username, ctx.deployment.account.login)) continue
    const ref = await resource(ctx, round, item.noteable_iid, item.noteable_type === 'MergeRequest')
    if (stopped(ctx, round)) return
    const subscribed = ctx.threads.get(`${SOURCE}:${gitlabThread(ref).id}`)?.subscriptions.length
    if (!mentions(item.body, ctx.deployment.account.login) && !round.config.observeComments && !subscribed) continue
    const current = await round.commands.api(GitlabNoteSchema, `${resourcePath(ref)}/notes/${item.id}`)
      .catch((error: unknown) => {
        if (error instanceof CliError && (error.code === 404 || error.code === 410)) { round.tally.skipped++; return undefined }
        throw error
      })
    if (current && !stopped(ctx, round)) await note(ctx, round, current, ref)
  }
}
async function thread(ctx: SourceContext, round: Round, ref: GitlabRef, value?: Thread): Promise<void> {
  const key = gitlabThread(ref).id
  if (round.read.has(key) || stopped(ctx, round)) return
  round.read.add(key)
  await resource(ctx, round, ref.number, ref.isPr)
  if (stopped(ctx, round)) return
  const since = ctx.state.get(KV.gitlab.thread(key)) ?? value?.createdAt ?? round.since
  const notes = await recent(round, GitlabNoteSchema, `${resourcePath(ref)}/notes?sort=desc&order_by=updated_at`, since, item => item.updated_at ?? item.created_at)
  for (const item of notes) { if (stopped(ctx, round)) return; await note(ctx, round, item, ref) }
  if (!stopped(ctx, round)) ctx.state.set(KV.gitlab.thread(key), cursorAt(round.started))
}
async function ci(ctx: SourceContext, round: Round, target: GitlabRef | { branch: string }, pipeline: z.infer<typeof PipelineSchema>): Promise<void> {
  if (stopped(ctx, round)) return
  const snapshot = await pipelineSnapshot(round.commands, pipeline, round.tally)
  if (stopped(ctx, round)) return
  const failures = pipelineFailures(snapshot)
  const key = 'branch' in target ? `branch:${target.branch}` : `mr:${target.number}`
  const stateKey = KV.gitlab.ci(ctx.deployment.namespace, key)
  const previous = ctx.state.get(stateKey) ?? { revision: 0 }
  const fingerprint = JSON.stringify(failures)
  const terminal = pipeline.status === 'failed' || pipeline.status === 'success'
  if (previous.fingerprint === undefined) ctx.state.set(stateKey, { fingerprint, revision: previous.revision })
  else if (terminal && fingerprint !== previous.fingerprint) {
    const revision = previous.revision + 1
    await ctx.receive(pipelineTrigger(ctx.deployment, target, pipeline, revision,
      pipelineSummary(snapshot, 'branch' in target ? target.branch : `MR !${target.number}`)))
    ctx.state.set(stateKey, { fingerprint, revision })
  }
  const id = 'branch' in target ? `${ctx.deployment.namespace}:ci:${encodeURIComponent(target.branch)}` : gitlabThread(target).id
  ctx.threads.describe(`${SOURCE}:${id}`, { facts: { ci: { label: { zh: 'CI', en: 'CI' },
    value: { zh: pipeline.status === 'failed' ? `失败 ${failures.length}` : pipeline.status, en: pipeline.status === 'failed' ? `${failures.length} failed` : pipeline.status },
    ...pipeline.status === 'failed' ? { problem: true as const } : {} } } })
}
async function ticketRequests(ctx: SourceContext, round: Round): Promise<void> {
  const numbers = [...new Set(ctx.tickets.open().flatMap(ticket => mergeRequestsOf(ticket, ctx.deployment.namespace, true)))]
  for (const number of numbers) {
    if (stopped(ctx, round)) return
    try {
      const ref = await resource(ctx, round, number, true)
      await thread(ctx, round, ref, ctx.threads.get(`${SOURCE}:${gitlabThread(ref).id}`))
      const pipelines = await round.commands.api(z.array(PipelineSchema), `merge_requests/${number}/pipelines?per_page=1`)
      if (pipelines[0]) await ci(ctx, round, ref, pipelines[0])
    } catch (error) {
      if (!stopped(ctx, round)) round.failures.push(`MR !${number}: ${String(error)}`)
    }
  }
}
async function branchCi(ctx: SourceContext, round: Round): Promise<void> {
  if (!round.config.observeCi) return
  const project = await round.commands.api(z.looseObject({ default_branch: z.string().nullish() }), '')
  if (stopped(ctx, round)) return
  const branch = project.default_branch
  if (!branch) return
  const previous = ctx.state.get(KV.gitlab.branch(ctx.deployment.namespace))
  if (previous !== branch || round.observed.ci === round.started) {
    const stateKey = KV.gitlab.ci(ctx.deployment.namespace, `branch:${branch}`)
    const state = ctx.state.get(stateKey)
    if (state) ctx.state.set(stateKey, { revision: state.revision })
    ctx.state.set(KV.gitlab.branch(ctx.deployment.namespace), branch)
  }
  const pipelines = await round.commands.api(z.array(PipelineSchema), `pipelines?ref=${encodeURIComponent(branch)}&order_by=id&sort=desc&per_page=1`)
  if (pipelines[0]) {
    if (pipelines[0].ref !== branch) throw new Error('GitLab returned a pipeline for another branch')
    await ci(ctx, round, { branch }, pipelines[0])
  }
}

export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config || ctx.deployment.provider !== 'gitlab') return 60
  const started = new Date().toISOString()
  const stored = ctx.state.get(KV.gitlab.cursor(ctx.deployment.namespace))
  const horizon = new Date(Date.now() - POLL_HORIZON_MS).toISOString()
  const since = stored ? stored < horizon ? horizon : stored : started
  // Establish the initial baseline before I/O so a first-round outage cannot move it past new requests.
  if (!stored) ctx.state.set(KV.gitlab.cursor(ctx.deployment.namespace), since)
  const observed = { ...ctx.state.get(KV.gitlab.observed(ctx.deployment.namespace)) }
  for (const [row, key] of Object.entries(OBSERVED) as [Observation, typeof OBSERVED[Observation]][]) {
    if (!config[key]) delete observed[row]
    else if (!observed[row]) observed[row] = started
  }
  ctx.state.set(KV.gitlab.observed(ctx.deployment.namespace), observed)
  const round: Round = { started, since, signal, config, observed, commands: ctx.commands.withSignal(signal),
    issues: new Map(), requests: new Map(), seen: new Set(), read: new Set(), failures: [], tally: { skipped: 0 } }
  await roots(ctx, round)
  for (const task of [() => events(ctx, round), () => ticketRequests(ctx, round), () => branchCi(ctx, round)]) {
    if (stopped(ctx, round)) return config.pollSeconds
    await task().catch(error => { if (!stopped(ctx, round)) round.failures.push(String(error)) })
  }
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async value => {
    const ref = parseGitlabThread(value.ref.id, ctx.deployment)
    if (ref) await thread(ctx, round, ref, value)
  })
  if (stopped(ctx, round)) return config.pollSeconds
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  ctx.state.set(KV.gitlab.cursor(ctx.deployment.namespace), cursorAt(started))
  ctx.report('gitlab', { state: 'ready', detail: `${round.seen.size} GitLab events; next poll ≥ ${config.pollSeconds}s${round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''}`, at: started })
  return config.pollSeconds
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures++
      if (!signal.aborted && failures >= (config?.failuresBeforeError ?? 1)) ctx.report('gitlab', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch(error => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
