/** Mobile-sized projections of existing DSH conversations; no second session store or agent loop. */
import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import { once } from 'node:events'
import { z } from 'zod'
import { BlockAssembler, assembleAssistantStream, type AssistantStreamRecord, type ContentBlock, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHistoryRecord, SessionRequestId, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HttpHost } from './http.ts'
import { transcriptEntry } from './context.ts'
import { ticketOfSession } from '../executor/dsh.ts'
import { liveTicket } from '../core/index.ts'

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
const createBody = z.object({ requestId }).strict()
const promptBody = z.object({ requestId, text: z.string().trim().min(1).max(32_000) }).strict()
const pageQuery = z.object({ through: z.coerce.number().int().nonnegative(), before: z.coerce.number().int().nonnegative() }).strict()
  .refine(value => value.before <= value.through)
const listQuery = z.object({ offset: z.coerce.number().int().nonnegative().default(0) }).strict()
const sessionId = (id: string) => identity.parse(id) as SessionId
const textOf = (blocks: readonly ContentBlock[]) => blocks.filter(block => block.type !== 'reasoning')
  .map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
interface ConversationMessage { seq: number; at: number; role: string; text: string; requestId?: string; interrupted?: true }

/** Select human-visible messages only; model replacement copies must not erase or duplicate the original transcript. */
function entry(event: SessionWireEvent): ConversationMessage[] {
  const source = event as unknown as SessionEvent
  if (source.type === 'assistant/attempt') {
    const text = textOf(assembleAssistantStream(source.data.stream).interruptedBlocks())
    return text ? [{ seq: event.seq, at: event.time, role: 'assistant', text, interrupted: true }] : []
  }
  if (source.type === 'turn/end') {
    const reason = source.data.reason
    const text = reason.kind === 'error' ? reason.error.message
      : reason.kind === 'blocked' ? '会话被阻止，请在电脑端检查权限或配置'
      : reason.kind === 'aborted' || reason.kind === 'interrupted' ? '本轮生成已中断' : ''
    return text ? [{ seq: event.seq, at: event.time, role: 'status', text }] : []
  }
  if (event.surfaceOp !== 'append') return []
  const value = transcriptEntry(source)
  if (!value) return []
  const correlation = source.type === 'user/message' && 'rpcId' in source.data.source ? source.data.source.rpcId : undefined
  const role = source.type === 'user/message' && source.data.source.kind !== 'user' ? 'context' : value.message.role
  return [{ seq: event.seq, at: event.time, role, text: textOf(value.message.content),
    ...(typeof correlation === 'string' ? { requestId: correlation } : {}),
    ...(source.type === 'assistant/message' && source.data.interrupted ? { interrupted: true } : {}) }]
}
function history(records: readonly SessionHistoryRecord[], hasMore: boolean) {
  return { messages: records.flatMap(record => entry(record.event)), before: records[0]?.event.seq ?? null, hasMore }
}

/**
 * Adapts the host Session Controller for the private mobile gateway. Reads project only conversation content,
 * prompt IDs retain DSH's admission deduplication, and stopping an active worker withdraws its ticket mandate
 * through the existing Engine so background work and task state stop together.
 */
export class Conversations {
  // Native deduplication misses prompts between inbox claim and journal append. Keep the receipt for that Session's lifetime.
  private readonly admitted = new WeakMap<Session, Set<string>>()
  private readonly submitting = new Map<string, Promise<{ accepted: true }>>()
  constructor(private readonly ctx: Context, private readonly host: Pick<HttpHost, 'store' | 'engine' | 'masterId'>) {}
  private info(id: string, title?: unknown) {
    const ticketId = ticketOfSession(id), ticket = ticketId ? this.host.store.tickets.get(ticketId) : undefined
    const kind = id === this.host.masterId ? 'orchestrator' : ticket ? 'worker' : 'conversation'
    return { id, kind, title: typeof title === 'string' && title ? title : ticket?.title ?? (kind === 'orchestrator' ? '主调度会话' : '未命名会话'),
      stopTask: !!ticket && liveTicket(ticket), ...(ticket ? { ticketId: ticket.id } : {}) }
  }
  async list(query: Record<string, string>) {
    const { offset } = listQuery.parse(query)
    const { items } = await this.ctx.sessionController.list({}, AbortSignal.timeout(10_000))
    const visible = items.filter(item => item.origin !== 'subagent')
    return { items: visible.slice(offset, offset + 20).map(item => ({ ...this.info(item.sessionId, item.projections?.values.title),
      running: item.running, updatedAt: item.updatedAt })), total: visible.length,
      next_offset: offset + 20 < visible.length ? offset + 20 : null }
  }
  async create(body: unknown) {
    const { requestId } = createBody.parse(body)
    const result = await this.ctx.sessionController.create({ sessionId: sessionId(`mobile-${requestId}`) })
    return { id: result.sessionId }
  }
  async history(id: string, query: Record<string, string>) {
    const { through, before } = pageQuery.parse(query)
    const page = await this.ctx.sessionController.page({ address: { kind: 'session', sessionId: sessionId(id) },
      throughSeq: through, beforeSeq: before, maxMessages: 50 }, AbortSignal.timeout(10_000))
    return history(page.records, page.hasMore)
  }
  async prompt(id: string, body: unknown) {
    const value = promptBody.parse(body), target = sessionId(id), key = `${id}:${value.requestId}`
    const pending = this.submitting.get(key)
    if (pending) return pending
    const send = (async () => {
      const session = this.ctx.agents.get(target)?.session
      if (!session || !this.admitted.get(session)?.has(value.requestId)) {
        await this.ctx.sessionController.prompt({ sessionId: target, requestId: value.requestId as SessionRequestId,
          mode: 'steer', content: [{ type: 'text', text: value.text }] }, AbortSignal.timeout(10_000))
        const accepted = this.ctx.agents.get(target)?.session
        if (accepted) {
          let ids = this.admitted.get(accepted)
          if (!ids) { ids = new Set(); this.admitted.set(accepted, ids) }
          ids.add(value.requestId)
        }
      }
      // A successful response survives restart; a failed flush remains retryable without admitting another prompt.
      await this.ctx.sessionPersistence.flush()
      return { accepted: true as const }
    })()
    this.submitting.set(key, send)
    try { return await send } finally { this.submitting.delete(key) }
  }
  stop(id: string) {
    sessionId(id)
    const ticketId = ticketOfSession(id), ticket = ticketId ? this.host.store.tickets.get(ticketId) : undefined
    if (ticket && liveTicket(ticket)) {
      this.host.engine.stopTicket(ticket.id, 'Stopped from mobile conversation')
      return { accepted: true as const, taskStopped: true }
    }
    return { ...this.ctx.sessionController.cancel({ sessionId: sessionId(id) }), taskStopped: false }
  }
  /** Follow the canonical DSH journal; disconnect removes listeners and abandons only the read, never the agent turn. */
  async stream(id: string, res: ServerResponse, lifetime: AbortSignal) {
    const target = sessionId(id), closed = new AbortController()
    const signal = AbortSignal.any([closed.signal, lifetime])
    res.once('close', () => closed.abort())
    let heartbeat: ReturnType<typeof setInterval> | undefined, assembler = new BlockAssembler(), attempt = ''
    const send = async (value: unknown) => {
      signal.throwIfAborted()
      if (!res.write(`data: ${JSON.stringify(value)}\n\n`)) await once(res, 'drain', { signal })
    }
    try {
      for await (const frame of this.ctx.sessionController.follow({ address: { kind: 'session', sessionId: target },
        assistantStream: true, maxMessages: 50 }, signal)) {
        if (frame.type === 'snapshot') {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
          res.flushHeaders()
          heartbeat = setInterval(() => { if (!res.writableNeedDrain) res.write(': heartbeat\n\n') }, 10_000)
          const active = frame.assistantStream?.activeAttempt
          attempt = active?.attemptId ?? ''
          assembler = active ? assembleAssistantStream(active.stream as unknown as AssistantStreamRecord[]) : new BlockAssembler()
          const agent = this.ctx.agents.get(target)
          const pending = [...agent?.inbox.nextTurn ?? [], ...agent?.inbox.nextStep ?? []].flatMap(message => {
            const source = message.source
            return source.kind === 'user' && 'rpcId' in source
              ? [{ requestId: source.rpcId, text: textOf(message.content) }] : []
          })
          await send({ type: 'snapshot', ...history(frame.records, frame.hasMore), through: frame.cursor,
            conversation: { ...this.info(id, frame.projections.values.title), running: agent?.status === 'running' },
            pending, live: textOf(assembler.interruptedBlocks()) })
        } else if (frame.type === 'event') {
          for (const message of entry(frame.event)) await send({ type: 'message', message })
          if (frame.event.type === 'turn/start' || frame.event.type === 'turn/end') {
            await send({ type: 'status', running: frame.event.type === 'turn/start', ...this.info(id) })
          }
          if (frame.event.type === 'session/title') await send({ type: 'title', title: (frame.event.data as { title: string }).title })
        } else {
          const live = frame.frame
          if (live.type === 'start') { attempt = live.attemptId; assembler = new BlockAssembler(); await send({ type: 'live', text: '' }) }
          else if (live.attemptId === attempt && live.type === 'chunk') {
            const chunk = live.chunk as unknown as StreamChunk
            assembler.push(chunk)
            if (chunk.type === 'text-delta') await send({ type: 'delta', text: chunk.text })
            else if (chunk.type === 'block-end') await send({ type: 'live', text: textOf(assembler.interruptedBlocks()) })
          } else if (live.attemptId === attempt && live.type === 'end') {
            attempt = ''; await send({ type: 'live', text: '' })
          }
        }
      }
      res.end()
    } catch (error) {
      if (!signal.aborted && !res.headersSent) throw error
      if (!res.destroyed) res.end()
    } finally { clearInterval(heartbeat); closed.abort() }
  }
}
