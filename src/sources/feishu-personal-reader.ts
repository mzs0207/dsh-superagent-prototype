import { z } from 'zod'

const ChatId = z.string().regex(/^oc_[a-zA-Z0-9]+$/)
const MessageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/)
export const PersonalScope = z.object({ self: z.string().regex(/^ou_[a-zA-Z0-9]+$/), name: z.string().trim().min(1).max(100),
  groups: z.array(ChatId).default([]), directs: z.array(ChatId).default([]) })
type PersonalScope = z.infer<typeof PersonalScope>
export interface PersonalCandidate { id: string; chat: string; kind: 'direct' | 'group'; at: number; text: string }
const Chats = z.object({ has_more: z.literal(false), chats: z.array(z.object({ chat_id: ChatId, chat_mode: z.string().optional(),
  p2p_target_type: z.string().optional(), external: z.boolean().optional(), chat_status: z.string().optional() })).nullish() })
const Page = z.object({ has_more: z.boolean(), page_token: z.string().nullish(), items: z.array(z.unknown()).nullish() })
const Row = z.object({ message_id: MessageId, chat_id: ChatId, msg_type: z.literal('text'), create_time: z.string().regex(/^\d{13}$/),
  sender: z.object({ id: z.string().regex(/^ou_[a-zA-Z0-9]+$/), sender_type: z.literal('user') }), deleted: z.boolean().optional(),
  mentions: z.array(z.object({ id: z.string(), key: z.string().min(1) })).nullish(), body: z.object({ content: z.string() }) })
const Body = z.object({ text: z.string() })

/** Verify the entire allowlist before reading history, so a partial list cannot advance the shared cursor. */
export async function collectPersonal(call: (args: string[]) => Promise<unknown>, scope: PersonalScope, from: number, through: number): Promise<PersonalCandidate[]> {
  const list = ['im', '+chat-list', '--page-all', '--page-limit', '1000', '--page-size', '100']
  const chosen = new Map<string, PersonalCandidate['kind']>()
  if (scope.groups.length) {
    const allowed = new Set(scope.groups)
    for (const row of Chats.parse(await call(list)).chats ?? []) {
      if (row.external === false && row.chat_mode !== 'p2p' && (!row.chat_status || row.chat_status === 'normal') && allowed.delete(row.chat_id))
        chosen.set(row.chat_id, 'group')
    }
    if (allowed.size) throw new Error('Could not verify all configured internal Feishu groups')
  }
  if (scope.directs.length) {
    const allowed = new Set(scope.directs)
    for (const row of Chats.parse(await call([...list, '--types', 'p2p'])).chats ?? []) {
      if (row.chat_mode === 'p2p' && row.p2p_target_type === 'user' && allowed.delete(row.chat_id)) chosen.set(row.chat_id, 'direct')
    }
    if (allowed.size) throw new Error('Could not verify all configured Feishu direct chats')
  }
  const found = new Map<string, PersonalCandidate>()
  for (const [chat, kind] of chosen) {
    const tokens = new Set<string>()
    let token: string | undefined
    for (;;) {
      const page = Page.parse(await call(['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify({
        container_id_type: 'chat', container_id: chat, start_time: String(Math.floor(from / 1000)),
        end_time: String(Math.ceil(through / 1000)), sort_type: 'ByCreateTimeAsc', page_size: 50,
        ...token ? { page_token: token } : {},
      })]))
      for (const data of page.items ?? []) {
        const row = Row.safeParse(data)
        if (!row.success) continue
        const { chat_id, create_time, message_id, sender, deleted, mentions, body } = row.data
        const at = Number(create_time)
        if (chat_id !== chat || deleted || sender.id === scope.self || at <= from || at > through) continue
        let text: string
        try { text = Body.parse(JSON.parse(body.content)).text.trim() } catch { continue }
        const addressed = mentions?.some(item => item.id === scope.self)
        if (kind === 'group' && !addressed && !text.includes(scope.name)) continue
        for (const item of mentions ?? []) text = text.replaceAll(item.key, item.id === scope.self ? '@我' : item.id === 'all' ? '@全员' : '@其他人')
        if (kind === 'group') text = text.replaceAll(scope.name, '@我')
        if (text) found.set(message_id, { id: message_id, chat, kind, at, text: text.slice(0, 2000) })
      }
      if (!page.has_more) break
      if (!page.page_token || tokens.has(page.page_token)) throw new Error('Incomplete Feishu history pagination')
      token = page.page_token; tokens.add(token)
    }
  }
  return [...found.values()].sort((a, b) => a.at - b.at)
}
