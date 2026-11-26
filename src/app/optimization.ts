/** Privacy-safe runtime evidence and explicitly verified project-improvement lessons in the existing SQLite store. */
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { key, latestAssignment, type DomainEvent, type Ticket, type WaitReason } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Store } from './store.ts'
import type { EffectKind } from './effects.ts'

declare const __SUPERAGENT_VERSION__: string
declare const __SUPERAGENT_BUILD__: string
const version = typeof __SUPERAGENT_VERSION__ === 'undefined' ? 'development' : __SUPERAGENT_VERSION__
const build = typeof __SUPERAGENT_BUILD__ === 'undefined' ? 'development' : __SUPERAGENT_BUILD__
export const OPTIMIZATION_TAG = 'project:dsh-superagent-prototype:optimization'
const RETENTION_MS = 90 * 86_400_000
/** Reject obvious credentials and private identifiers; authors must also review every lesson for sensitive context. */
export const privateText = /(?:\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|passwd|secret|authorization|cookie)\s*[:=]|\bBearer\s+\S+|-----BEGIN .*PRIVATE KEY-----|\b(?:sk-|ghp_|glpat-)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|\b(?:ou|oc|om)_[A-Za-z0-9]+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:10|127)\.\d+\.\d+\.\d+\b|\b192\.168\.\d+\.\d+\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+\b|\/home\/[^\s/]+|[A-Z]:\\Users\\)/i
const text = z.string().trim().max(2000).refine(value => !privateText.test(value), 'Remove credentials and private identifiers before recording a lesson')
export const OptimizationLessonInput = z.object({
  /** Stable caller-chosen id; omit to derive it from the content, which makes every edit a new lesson. */
  id: z.string().regex(/^[a-f0-9]{8,64}$/).optional(),
  status: z.enum(['hypothesis', 'verified']), problem: text.min(1), change: text.min(1), validation: text, effect: text,
  evidence: z.array(text.min(1)).max(20),
}).strict().superRefine((lesson, ctx) => {
  if (lesson.status === 'verified' && (!lesson.validation || !lesson.effect || !lesson.evidence.length))
    ctx.addIssue({ code: 'custom', message: 'Verified lessons require validation, observed effect and evidence', path: ['evidence'] })
})
export type LessonInput = z.infer<typeof OptimizationLessonInput>
export interface OptimizationLesson extends LessonInput { id: string; at: string }
export interface EffectAttempt {
  id: string; kind: EffectKind; ticketId?: string; at: string; durationMs: number; status: 'succeeded' | 'failed'; error?: unknown
}
/** Bounded structured error facts; arbitrary names, messages, stacks and codes never enter the ledger. */
export interface FailureDiagnostic { reason: string; name?: string; code?: string; status?: number }
export interface FailureObservation { reason: string; errors: FailureDiagnostic[] }
export interface OptimizationRecord {
  id: string; at: string; kind: string; component: string; status: string; reason?: string; ticket?: string; assignment?: string; durationMs?: number
  episode?: string
  versions: { version: string; build: string; settings: number; prompts: number; workerModel: string; evalModel: string }
  verification?: { reproduction: boolean; tests: boolean; testWorktree: boolean; live: boolean; published: boolean; resolved: boolean }
  errors?: FailureDiagnostic[]
}
const Query = z.object({
  since: z.iso.datetime({ offset: true }).optional(), until: z.iso.datetime({ offset: true }).optional(),
  offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict().superRefine((value, ctx) => {
  if (value.since && value.until && Date.parse(value.since) > Date.parse(value.until))
    ctx.addIssue({ code: 'custom', message: 'since must not be after until', path: ['since'] })
})
export type OptimizationQuery = z.input<typeof Query>
export interface OptimizationPage<T> { items: T[]; next_offset: number | null; since?: string; until?: string }
export interface OptimizationGroup {
  kind: string; component: string; status: string; reason: string | null; count: number; averageDurationMs: number | null; maxDurationMs: number | null
}
export interface OptimizationReport {
  since: string; until: string; recordingSince: string | undefined
  /** Verified observations older than this are deleted. */
  retentionDays: number
  /** Recorded lessons are never deleted; this states it so no consumer mistakes `retentionDays` for their lifetime. */
  lessonRetention: 'indefinite'
  groups: OptimizationGroup[]; caveats: string[]
}
const elapsed = (start: string, end: string) => Math.max(0, Date.parse(end) - Date.parse(start))
const ERROR_NAMES: Readonly<Record<string, true>> = {
  Error: true, AggregateError: true, TypeError: true, ReferenceError: true, SyntaxError: true,
  RangeError: true, TimeoutError: true, AbortError: true,
}
const ERROR_CODES: Readonly<Record<string, string>> = {
  ETIMEDOUT: 'timeout', ECONNRESET: 'network', ECONNREFUSED: 'network', EAI_AGAIN: 'network', ENOTFOUND: 'network', EPIPE: 'network',
  PREPARE_FAILED: 'prepare-failed', SUBAGENT_CATALOG_UNAVAILABLE: 'catalog-unavailable',
  AUTH: 'authentication-failed',
}
/** Visit at most 64 entries (including repeats), retaining at most eight allowlisted diagnostics. */
export function optimizationFailure(error: unknown): FailureObservation {
  const errors: FailureDiagnostic[] = [], seen = new Set<unknown>()
  let remaining = 64
  const visit = (value: unknown): void => {
    if (remaining === 0 || errors.length === 8) return
    remaining--
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const row = value as { name?: unknown; code?: unknown; status?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
    const name = typeof row.name === 'string' && Object.hasOwn(ERROR_NAMES, row.name) ? row.name : undefined
    const login = row.message === 'ChatGPT sign-in needs to be renewed'
    const code = typeof row.code === 'string' && Object.hasOwn(ERROR_CODES, row.code) ? row.code : undefined
    const status = typeof row.status === 'number' && Number.isInteger(row.status) && row.status >= 400 && row.status <= 599 ? row.status : undefined
    let reason = code ? ERROR_CODES[code]! : 'unknown'
    if (login) reason = 'auth-required'
    else if (status === 401 || code === 'AUTH') reason = 'authentication-failed'
    else if (status === 429) reason = 'rate-limited'
    else if (status === 408 || name === 'TimeoutError') reason = 'timeout'
    else if (status && status >= 500) reason = 'http-5xx'
    else if (reason === 'unknown' && name === 'TypeError') reason = 'type-error'
    errors.push({ reason, ...(name ? { name } : {}), ...(code ? { code } : {}), ...(status ? { status } : {}) })
    if (row.cause !== undefined) visit(row.cause)
    const children = row.errors
    if (Array.isArray(children)) {
      for (let i = 0; i < children.length && remaining > 0 && errors.length < 8; i++) visit(children[i])
    }
  }
  visit(error)
  const specific = errors.find(row => row.reason === 'auth-required')
    ?? errors.find(row => row.reason === 'authentication-failed')
    ?? errors.find(row => row.reason !== 'unknown' && row.reason !== 'type-error')
  return { reason: specific?.reason ?? errors.find(row => row.reason !== 'unknown')?.reason ?? 'unknown', errors }
}

/** Passive, savepoint-isolated observations; no raw source payload, report, error, model output or identity is stored. */
export class OptimizationLedger {
  private available = false
  private prunedAt = 0
  private readonly failedCommits = new WeakSet<object>()
  constructor(private readonly store: Store, private readonly health: HealthEntry,
    private readonly retain: (lesson: OptimizationLesson) => void, private readonly now = () => Date.now()) {
    this.observe(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS optimization_record (id TEXT PRIMARY KEY, at TEXT NOT NULL, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS optimization_record_at ON optimization_record(at, id);
        CREATE TABLE IF NOT EXISTS optimization_lesson (id TEXT PRIMARY KEY, at TEXT NOT NULL, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS optimization_lesson_at ON optimization_lesson(at, id)`)
      if (!store.get(KV.optimization.startedAt)) store.set(KV.optimization.startedAt, new Date(this.now()).toISOString())
      this.prune()
      this.store.afterCommit(batch => { this.available = true; this.ready(batch) })
    })
  }
  /** Runs inside the domain transaction, so rolled-back commands cannot leave observations behind. */
  domain(event: DomainEvent): void {
    const data = event.data
    if (!('ticketId' in data) || event.type === 'thread.subscribed' || event.type === 'thread.unsubscribed') return
    this.observe(() => {
      const ticket = this.store.tickets.get(data.ticketId)
      if (!ticket) return
      const assignment = 'assignmentId' in data ? ticket.assignments.find(row => row.id === data.assignmentId) : latestAssignment(ticket)
      const base = { ticket: key(ticket.id), ...(assignment ? { assignment: key(assignment.id) } : {}) }
      const add = (kind: string, status: string, component: string, unique: string, durationMs?: number) =>
        this.insert({ ...base, kind, status, component, id: key(kind, ticket.id, unique), at: event.at,
          ...(durationMs === undefined ? {} : { durationMs }), verification: this.verification(ticket) })
      switch (event.type) {
        case 'ticket.created': add('ticket-created', 'accepted', 'task', ticket.id); break
        case 'assignment.started': add('assignment-started', 'running', 'launch', event.data.assignmentId,
          assignment?.startedAt ? elapsed(assignment.createdAt, assignment.startedAt) : undefined); break
        case 'assignment.reported': add('report', event.data.state, 'execution', randomUUID()); break
        case 'assignment.ended':
          if (event.data.reason === 'retried') add('explicit-retry', 'requested', 'execution', event.data.assignmentId)
          break
        case 'ticket.human-input': add('human-input', 'received', 'execution', event.data.inputId); break
        case 'ticket.resumed': add('ticket-resumed', 'resumed', 'task', event.data.triggerId); break
        case 'ticket.ended': add('ticket-ended', event.data.outcome, 'task', key(assignment?.id ?? '', ticket.ended?.at ?? event.at),
          elapsed(ticket.createdAt, ticket.ended?.at ?? event.at)); break
      }
    })
  }
  effect(attempt: EffectAttempt): void {
    this.observe(() => { this.insert({ id: attempt.id, at: attempt.at, kind: 'effect-attempt', component: attempt.kind, status: attempt.status,
      durationMs: attempt.durationMs, ...(attempt.ticketId ? { ticket: key(attempt.ticketId) } : {}),
      ...(attempt.status === 'failed' ? optimizationFailure(attempt.error) : {}) }) })
  }
  workerRetry(ticketId: string, assignmentId: string, error: unknown, id: string): void {
    this.observe(() => { this.insert({ id: key('worker-retry', id), at: new Date(this.now()).toISOString(), kind: 'worker-retry',
      component: 'execution', status: 'scheduled', ticket: key(ticketId), assignment: key(assignmentId), ...optimizationFailure(error) }) })
  }
  workerFailure(ticketId: string | undefined, component: 'prepare' | 'launch' | 'execution' | 'cleanup' | 'background', error: unknown): void {
    this.observe(() => { this.insert({ id: randomUUID(), at: new Date(this.now()).toISOString(), kind: 'worker-failure',
      component, status: 'failed', ...(ticketId ? { ticket: key(ticketId) } : {}), ...optimizationFailure(error) }) })
  }
  /** A reissued notice does not restart the underlying wait. Only a different signature or assignment does. */
  intervention(ticketId: string, at: string, active?: { signature: string; assignmentId: string; reason?: WaitReason },
    end: 'cleared' | 'ended' = 'cleared'): void {
    if (!this.available) return
    this.observe(() => {
      const ticket = key(ticketId), name = KV.optimization.pendingWait(ticket), previous = this.store.get(name)
      const assignment = active && key(active.assignmentId)
      if (previous?.signature === active?.signature && previous?.assignment === assignment) return
      const base = { kind: 'blocker-wait', component: 'execution', ticket, at }
      if (previous) this.insert({ ...base, id: key(base.kind, previous.episode, 'end'), episode: previous.episode,
        assignment: previous.assignment, reason: previous.reason, status: active ? 'replaced' : end,
        durationMs: elapsed(previous.at, at) })
      if (!active || !assignment) { this.store.delete(name); return }
      const episode = key(randomUUID()), reason = active.reason ?? 'unknown'
      const next = { episode, signature: active.signature, assignment, reason, at }
      this.insert({ ...base, episode, assignment, reason, id: key(base.kind, episode, 'start'), status: 'started' })
      this.store.set(name, next)
    })
  }
  humanInput(ticketId: string, inputId: string): void {
    this.observe(() => { this.insert({ id: key('human-input', ticketId, inputId), at: new Date(this.now()).toISOString(), kind: 'human-input',
      component: 'execution', status: 'received', ticket: key(ticketId) }) })
  }
  private verification(ticket: Ticket): OptimizationRecord['verification'] {
    const proof = this.store.get(KV.zentao.workflow(ticket.id))
    return { reproduction: !!proof?.reproduction, tests: !!proof?.tests, testWorktree: !!proof?.testVerification,
      live: !!proof?.liveVerification, published: !!proof?.published, resolved: !!proof?.resolved }
  }
  private insert(record: Omit<OptimizationRecord, 'versions'>): void {
    if (!this.available) return
    this.prune()
    const settings = this.store.settings()
    const versions = { version, build, settings: this.store.get(KV.settings.revision) ?? 0, prompts: this.store.get(KV.prompts.revision) ?? 0,
      workerModel: key(JSON.stringify(settings.executor.model)), evalModel: key(JSON.stringify(settings.eval.model)) }
    const result = this.store.db.prepare('INSERT OR IGNORE INTO optimization_record VALUES (?, ?, ?)')
      .run(record.id, record.at, JSON.stringify({ ...record, versions }))
    if (result.changes) this.store.afterCommit(batch => { this.ready(batch) })
  }
  private prune(): void {
    const now = this.now()
    if (now - this.prunedAt < 3_600_000) return
    // Lessons are authored findings, not measurements, and are kept until removed on purpose; the report states both lifetimes.
    this.store.db.prepare('DELETE FROM optimization_record WHERE at < ?').run(new Date(now - RETENTION_MS).toISOString())
    this.store.afterCommit(() => { this.prunedAt = now })
  }
  private ready(batch?: object): void {
    if (batch && this.failedCommits.has(batch)) return
    this.health.set({ state: 'ready', detail: 'Privacy-safe optimization recording is ready' })
  }
  private observe(run: () => void): void {
    try {
      this.store.atomic(run)
    } catch {
      this.store.afterCommit(batch => {
        // A successful sibling observation must not hide records lost in this same commit.
        if (batch) this.failedCommits.add(batch)
        this.health.set({ state: 'error', detail: 'Optimization evidence could not be recorded; task behavior is unchanged' })
      })
    }
  }
  private window(query: OptimizationQuery) {
    const parsed = Query.parse(query), cutoff = new Date(this.now() - RETENTION_MS).toISOString()
    return { ...parsed, since: parsed.since ? new Date(Math.max(Date.parse(parsed.since), Date.parse(cutoff))).toISOString() : cutoff,
      until: parsed.until ? new Date(parsed.until).toISOString() : new Date(this.now()).toISOString() }
  }
  records(query: OptimizationQuery = {}): OptimizationPage<OptimizationRecord> {
    const { since, until, offset, limit } = this.window(query)
    const rows = this.store.db.prepare('SELECT value FROM optimization_record WHERE at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?')
      .all(since, until, limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as OptimizationRecord),
      next_offset: rows.length > limit ? offset + limit : null, since, until }
  }
  summary(query: OptimizationQuery = {}): OptimizationReport {
    const { since, until } = this.window(query)
    const groups = this.store.db.prepare(`SELECT value ->> '$.kind' AS kind, value ->> '$.component' AS component,
      value ->> '$.status' AS status, value ->> '$.reason' AS reason, COUNT(*) AS count,
      AVG(value ->> '$.durationMs') AS averageDurationMs, MAX(value ->> '$.durationMs') AS maxDurationMs
      FROM optimization_record WHERE at >= ? AND at <= ? GROUP BY kind, component, status, reason ORDER BY count DESC, kind, component, status, reason`).all(since, until) as unknown as OptimizationGroup[]
    return { since, until, recordingSince: this.store.get(KV.optimization.startedAt), retentionDays: 90,
      lessonRetention: 'indefinite', groups,
      caveats: ['Only events observed since recording began; no historical backfill.', 'Durations include waiting; not model time or token cost.',
        'Ready/completed is not proof of deployment or verification.', 'Explicit retries may originate in the panel, a human follow-up or the main agent; they do not prove human intervention.',
        'Human inputs and resumed tickets are separate observations, not a count of distinct people.',
        'Model fingerprints describe observed settings, not confirmed provider usage.',
        'Retention differs: observations expire after ninety days, recorded lessons persist until removed.'] }
  }
  lessons(query: OptimizationQuery = {}): OptimizationPage<OptimizationLesson> {
    const { offset, limit, since, until } = Query.parse(query)
    // Verified lessons are kept indefinitely, so only the caller's own bounds apply; '' sorts below every stored time.
    const lower = since ? new Date(since).toISOString() : ''
    const upper = until ? new Date(until).toISOString() : new Date(this.now()).toISOString()
    const rows = this.store.db.prepare(`SELECT value FROM optimization_lesson WHERE at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(lower, upper, limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as OptimizationLesson), next_offset: rows.length > limit ? offset + limit : null,
      ...(since ? { since: lower } : {}), until: upper }
  }
  /**
   * Records one lesson under a caller-stable id, so an edited lesson replaces the earlier text instead of leaving a stale
   * version beside it. The first submission fixes the id; later ones update the text and keep the original timestamp.
   */
  saveLesson(input: unknown): OptimizationLesson {
    const lesson = OptimizationLessonInput.parse(input), id = lesson.id ?? key(JSON.stringify(lesson))
    return this.store.atomic(() => {
      const previous = this.store.db.prepare('SELECT value FROM optimization_lesson WHERE id = ?').get(id)
      const record: OptimizationLesson = previous ? { ...lesson, id, at: JSON.parse(String(previous.value)).at }
        : { ...lesson, id, at: new Date(this.now()).toISOString() }
      this.store.db.prepare('INSERT INTO optimization_lesson VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value')
        .run(id, record.at, JSON.stringify(record))
      if (record.status === 'verified') this.retain(record)
      return record
    })
  }
  /** Revisit verified local lessons; the memory queue and successful content fingerprints suppress duplicate exports. */
  exportVerified(): void {
    this.observe(() => {
      const rows = this.store.db.prepare("SELECT value FROM optimization_lesson WHERE value ->> '$.status' = 'verified'").iterate()
      for (const row of rows) this.retain(JSON.parse(String(row.value)) as OptimizationLesson)
    })
  }
}
