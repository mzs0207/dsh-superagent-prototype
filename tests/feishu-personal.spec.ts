import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { classifyPersonal, observePersonal } from '../src/app/feishu-personal.ts'
import { Store } from '../src/app/store.ts'
import { collectPersonal } from '../src/sources/feishu-personal-reader.ts'

const now = 1_800_000_000_000
const scope = { self: 'ou_me', name: '小王', groups: ['oc_inside'], directs: [] }
const message = (chat_id: string, message_id: string, text: string, data: Record<string, unknown> = {}) => ({
  chat_id, message_id, msg_type: 'text', create_time: String(now + 1), body: { content: JSON.stringify({ text }) },
  sender: { sender_type: 'user', id: 'ou_colleague' }, ...data,
})
const candidate = { id: 'om_task', chat: 'oc_work', kind: 'direct' as const, at: now + 1, text: '帮忙核对工单 42' }
const task = { title: '核对工单 42', action: '确认工单的当前状态' }
const signal = new AbortController().signal

function chatApi() {
  return vi.fn(async (args: string[]) => {
    if (args.includes('+chat-list')) {
      return { chats: args.includes('p2p') ? [{ chat_id: 'oc_work', chat_mode: 'p2p', p2p_target_type: 'user' }]
        : [{ chat_id: 'oc_inside', external: false }, { chat_id: 'oc_outside', external: true }, { chat_id: 'oc_unknown' }, { chat_id: 'oc_other', external: false }], has_more: false }
    }
    const query = JSON.parse(args[args.indexOf('--params') + 1]!)
    if (query.container_id === 'oc_work') return { has_more: false, items: [message('oc_work', 'om_task', '帮忙核对工单 42'),
      message('oc_work', 'om_self', '我明天处理', { sender: { sender_type: 'user', id: 'ou_me' } }),
      message('oc_work', 'om_old', '旧消息', { create_time: String(now) })] }
    if (query.container_id === 'oc_inside') {
      if (!query.page_token) return { has_more: true, page_token: 'next', items: [message('oc_inside', 'om_all', '@_all 大家看一下'),
        message('oc_inside', 'om_group', '@_user_1 帮忙验证修复', { mentions: [{ id: 'ou_me', key: '@_user_1' }] })] }
      return { has_more: false, items: [message('oc_inside', 'om_named', '小王，核对今天的回归结果')] }
    }
    throw new Error('an unapproved chat was read')
  })
}
function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'observe-feishu-'))
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('Feishu personal observation', () => {
  it('reads only selected internal groups in group-only mode, without a private-chat query', async () => {
    const call = chatApi()
    const result = await collectPersonal(call, scope, now, now + 1_000)
    expect(result.map(row => [row.id, row.text])).toEqual([['om_group', '@我 帮忙验证修复'], ['om_named', '@我，核对今天的回归结果']])
    expect(call.mock.calls.some(([args]) => args.includes('p2p'))).toBe(false)
  })

  it('reads selected human DMs when explicitly enabled and ignores self and older messages', async () => {
    const call = chatApi()
    const result = await collectPersonal(call, { ...scope, groups: [], directs: ['oc_work'] }, now, now + 1_000)
    expect(result).toEqual([candidate])
    expect(call.mock.calls.filter(([args]) => args.includes('+chat-list')).every(([args]) => args.includes('p2p'))).toBe(true)
  })

  it.each([
    { status: 'missing', chats: [] },
    { status: 'missing the internal flag', chats: [{ chat_id: 'oc_inside' }] },
    { status: 'marked external', chats: [{ chat_id: 'oc_inside', external: true }] },
  ])('reads the skipped window after a configured group is temporarily $status', async ({ chats }) => {
    const { store, close } = openStore()
    try {
      const api = chatApi()
      let unverified = true
      const call = (args: string[]) => unverified ? Promise.resolve({ chats, has_more: false }) : api(args)
      const read = vi.fn((from: number, through: number) => collectPersonal(call, scope, from, through))
      const source = { id: 'local-reader', read, classify: async () => task }
      await observePersonal(store, source, now, signal)
      const failed = await observePersonal(store, source, now + 10_000, signal).then(() => false, () => true)
      unverified = false
      const recovered = await observePersonal(store, source, now + 20_000, signal)
      expect(recovered.map(row => row.id).sort()).toEqual(['om_group', 'om_named'])
      expect(failed).toBe(true)
      expect(read.mock.calls.map(([from]) => from)).toEqual([now, now])
    } finally { close() }
  })

  it('starts at enable time and persists summaries without creating triggers or tickets, even when execution is auto', async () => {
    const { store, close } = openStore()
    try {
      store.saveSettings({ ...store.settings(), eval: { ...store.settings().eval, mode: 'auto' } })
      const read = vi.fn(async () => [candidate]), classify = vi.fn(async () => task)
      const source = { id: 'local-reader', read, classify }
      expect(await observePersonal(store, source, now, signal)).toEqual([])
      expect(read).not.toHaveBeenCalled()
      const next = await observePersonal(store, source, now + 10_000, signal)
      expect(next).toEqual([{ id: 'om_task', chat: 'oc_work', kind: 'direct', at: now + 1, ...task }])
      expect(JSON.stringify(next)).not.toContain(candidate.text)
      expect(await observePersonal(store, source, now + 20_000, signal)).toEqual(next)
      expect(classify).toHaveBeenCalledTimes(1)
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM trigger').get()?.n).toBe(0)
      expect(store.tickets.list()).toEqual([])
    } finally { close() }
  })

  it('does not advance an unclassified window across a model failure', async () => {
    const { store, close } = openStore()
    try {
      const read = vi.fn(async (_from: number) => [candidate])
      const classify = vi.fn<() => Promise<typeof task>>().mockRejectedValueOnce(new Error('model unavailable')).mockResolvedValue(task)
      const source = { id: 'local-reader', read, classify }
      await observePersonal(store, source, now, signal)
      await expect(observePersonal(store, source, now + 10_000, signal)).rejects.toThrow('model unavailable')
      expect(await observePersonal(store, source, now + 20_000, signal)).toHaveLength(1)
      expect(read.mock.calls.map(args => args[0])).toEqual([now, now])
    } finally { close() }
  })

  it('keeps candidate text out of agent sessions and rejects a model tool-call finish', async () => {
    const stream = vi.fn(async function* (_: GenerateOptions): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })
    await expect(classifyPersonal({ stream }, { provider: 'provider', model: 'model' }, candidate, signal)).rejects.toThrow()
    const [request] = stream.mock.calls[0]!
    expect(request.tools).toEqual([])
    expect(request.sessionId).toBeUndefined()
    expect(JSON.stringify(request.messages)).toContain(candidate.text)
    expect(JSON.stringify(request.messages)).not.toContain(candidate.chat)
  })

  it('parses only the task projection from a completed tool-free model response', async () => {
    const stream = async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '```json\n' + JSON.stringify(task) + '\n```' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await expect(classifyPersonal({ stream }, { provider: 'provider', model: 'model' }, candidate, signal)).resolves.toEqual(task)
  })
})
