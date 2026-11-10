/** Private task and conversation view. Untrusted text never becomes HTML; hidden pages stop all reads. */
const byId = id => document.getElementById(id)
const content = byId('content'), refresh = byId('refresh'), filter = byId('filter')
const states = { open: '未结束', working: '执行中', person: '待处理', idle: '等待中', ended: '已结束' }
const actions = { queued: '排队中', blocked: '已阻塞', failed: '执行失败', answer: '待答复', review: '待审核', delivery: '投递失败' }
const reports = { progress: '进展', waiting: '等待中', ready: '已就绪', blocked: '已阻塞', failed: '失败', dropped: '已放弃' }
const outcomes = { completed: '完成', merged: '已合并', closed: '已关闭', stopped: '已停止', dropped: '已放弃' }
let controller, timer, generation = 0, busy = false, nextOffset = null, route, listHash = '#state=open'
const kinds = { conversation: '普通会话', orchestrator: '主调度', worker: '任务执行' }
const drafts = new Map(), submissions = new Map()
let chatInfo, chatReady = false, chatThrough, chatBefore, creation, creating = false
let messages = new Map()
function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = String(text)
  return element
}
function time(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false })
}
function status(ticket) { return actions[ticket.action] || states[ticket.stage] || ticket.stage }
function badge(ticket) {
  return node('span', `badge ${Object.hasOwn(states, ticket.stage) ? ticket.stage : ''}`, status(ticket))
}
function section(title, text) {
  const block = node('section', 'card detail-section')
  block.append(node('h3', '', title), node('p', 'prose', text || '暂无记录'))
  return block
}
function deliveryCard(card) {
  const block = node('section', 'card detail-section'), w = card.workflow
  block.append(node('h3', '', '交付验收'), node('p', 'source', '仅展示已记录证据；历史验证不代表当前环境版本。'))
  const field = (label, value) => {
    const row = node('div', 'report')
    row.append(node('strong', '', label), node('p', 'prose', value || '尚无证据'))
    block.append(row)
  }
  field('任务范围', card.scope)
  if (card.summary && card.summary !== card.humanAction) field('最新结论', card.summary)
  if (card.humanAction) field('待你处理', card.humanAction)
  if (w) {
    for (const [key, label] of [['cause', '问题根因'], ['changes', '修复范围'], ['reproduction', '修复前复现'],
      ['tests', '修复后验证'], ['head', '已验证 HEAD'], ['mergeCommit', 'develop SHA'], ['testCommit', 'test SHA'],
      ['testVerification', 'test 分支验证']]) field(label, w[key])
    const link = (label, url) => {
      if (!url) return
      try {
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return
        const anchor = node('a', 'prose', `${label}: ${parsed.href}`)
        anchor.href = parsed.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'
        block.append(anchor)
      } catch { /* Bad artifact URLs never become links. */ }
    }
    field('MR', w.mr && `!${w.mr.number}`); link('打开 MR', w.mr?.url)
    field('test 推送记录', w.published ? '已记录' : undefined)
    field('部署核验证据', w.deployment ? time(w.deployment.at) : undefined)
    for (const build of w.deployment?.builds || []) {
      field(`${build.service} #${build.number}`, build.commit); link('打开构建', build.url)
    }
    field('部署后复验', w.liveVerification)
    field('禅道解决记录', w.resolved ? '已记录' : undefined)
  }
  return block
}
function showList(data) {
  const fragment = document.createDocumentFragment()
  if (!data.items.length) fragment.append(node('p', 'empty', route.offset ? '当前页已无任务，请返回上一页。' : '此状态下暂无任务'))
  for (const ticket of data.items) {
    const card = node('a', 'card task')
    card.href = `#ticket=${encodeURIComponent(ticket.id)}`
    const top = node('div', 'card-top')
    top.append(badge(ticket), node('span', 'source', ticket.sources.join(' · ') || '任务'))
    card.append(top, node('h2', '', ticket.title), node('p', 'summary', ticket.summary || '暂无进展摘要'), node('time', '', `更新于 ${time(ticket.updatedAt)}`))
    fragment.append(card)
  }
  content.replaceChildren(fragment)
  nextOffset = data.next_offset
  byId('pagination').hidden = false
  byId('previous').disabled = route.offset === 0
  byId('next').disabled = nextOffset === null
  byId('count').textContent = `第 ${Math.floor(route.offset / 20) + 1} 页 · 共 ${data.total} 项`
}
function showDetail(ticket) {
  const fragment = document.createDocumentFragment(), head = node('section', 'card')
  head.append(badge(ticket), node('h2', '', ticket.title), node('p', 'source', ticket.sources.join(' · ')), node('time', '', `更新于 ${time(ticket.updatedAt)}`))
  fragment.append(head)
  if (ticket.ended) fragment.append(section('执行结果', `${outcomes[ticket.ended.outcome] || ticket.ended.outcome}\n${ticket.ended.reason || ''}\n${time(ticket.ended.at)}`))
  fragment.append(deliveryCard(ticket.delivery))
  if (ticket.reports.length) {
    const history = node('section', 'card detail-section')
    history.append(node('h3', '', '执行报告'))
    for (const report of ticket.reports) {
      const entry = node('div', 'report')
      entry.append(node('strong', '', reports[report.state] || report.state), node('time', '', time(report.at)), node('p', 'prose', report.summary))
      history.append(entry)
    }
    fragment.append(history)
  }
  content.replaceChildren(fragment)
}
function showConversations(data) {
  const fragment = document.createDocumentFragment()
  for (const item of data.items) {
    const card = node('a', 'card task')
    card.href = `#conversation=${encodeURIComponent(item.id)}`
    card.append(node('span', 'badge', `${kinds[item.kind]} · ${item.running ? '运行中' : '空闲'}`),
      node('h2', '', item.title), node('time', '', `更新于 ${time(item.updatedAt)}`))
    fragment.append(card)
  }
  if (!data.items.length) fragment.append(node('p', 'empty', '暂无会话，点击「新建会话」开始'))
  content.replaceChildren(fragment)
  nextOffset = data.next_offset
  byId('pagination').hidden = false
  byId('previous').disabled = route.offset === 0
  byId('next').disabled = nextOffset === null
  byId('count').textContent = `第 ${Math.floor(route.offset / 20) + 1} 页 · 共 ${data.total} 项`
}
function showError(error) {
  byId('error').textContent = error instanceof TypeError ? '无法连接电脑，请检查网络与服务。' : error.message
  byId('error').hidden = false
}
function pendingFor(id) {
  if (!submissions.has(id)) submissions.set(id, new Map())
  return submissions.get(id)
}
function updateComposer() {
  const blocked = [...pendingFor(route.conversation).values()].some(item => item.state !== 'accepted')
  byId('send-message').disabled = !chatReady || blocked || !byId('message').value.trim()
  byId('stop-conversation').disabled = !chatReady || (!chatInfo?.running && !chatInfo?.stopTask)
  byId('stop-conversation').textContent = chatInfo?.stopTask ? '停止任务' : '停止生成'
}
function showPending() {
  const fragment = document.createDocumentFragment()
  for (const item of pendingFor(route.conversation).values()) {
    const card = node('article', 'card message user')
    const state = item.state === 'sending' ? '发送中' : item.state === 'accepted' ? '已接收，等待处理' : '未确认送达'
    card.append(node('strong', '', `你 · ${state}`), node('p', 'prose', item.text))
    if (item.state === 'failed') {
      const retry = node('button', '', '重试发送')
      retry.type = 'button'; retry.disabled = !chatReady
      retry.onclick = () => { void sendSubmission(route.conversation, item) }
      card.append(node('p', 'source', '重试使用同一消息编号，不会重复发送已接收的消息。'), retry)
    }
    fragment.append(card)
  }
  byId('pending').replaceChildren(fragment); updateComposer()
}
function renderMessages() {
  const fragment = document.createDocumentFragment()
  for (const message of [...messages.values()].sort((a, b) => a.seq - b.seq)) {
    const folded = message.role === 'context' || message.role === 'tool'
    const card = node(folded ? 'details' : 'article', `card message ${message.role}`)
    const label = message.role === 'user' ? '你' : message.role === 'context' ? '上下文 / 任务输入'
      : message.role === 'tool' ? '工具结果' : message.role === 'status' ? '运行状态' : '助手'
    card.append(node(folded ? 'summary' : 'strong', '', label + (message.interrupted ? ' · 未完成' : '')),
      node('time', '', time(message.at)), node('p', 'prose', message.text || '（无文本内容）'))
    fragment.append(card)
  }
  byId('messages').replaceChildren(fragment)
}
function conversationFrame(frame) {
  const atBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 140
  if (frame.type === 'snapshot') {
    messages = new Map(frame.messages.map(message => [message.seq, message]))
    chatThrough = frame.through; chatBefore = frame.before; chatInfo = frame.conversation; chatReady = true
    byId('chat-title').textContent = chatInfo.title
    byId('chat-info').textContent = `${kinds[chatInfo.kind]} · ${chatInfo.running ? '运行中' : '空闲'}`
    byId('older').hidden = !frame.hasMore; byId('older').disabled = false
    for (const pending of frame.pending) pendingFor(route.conversation).set(pending.requestId, { ...pending, state: 'accepted' })
    for (const message of frame.messages) if (message.requestId) pendingFor(route.conversation).delete(message.requestId)
    renderMessages(); showPending()
    byId('live-text').textContent = frame.live; byId('live').hidden = !frame.live
    byId('connection').textContent = '已连接 · 实时更新'; byId('error').hidden = true
    content.setAttribute('aria-busy', 'false')
  } else if (frame.type === 'message') {
    messages.set(frame.message.seq, frame.message)
    if (frame.message.requestId) pendingFor(route.conversation).delete(frame.message.requestId)
    renderMessages(); showPending()
  } else if (frame.type === 'live') {
    byId('live-text').textContent = frame.text; byId('live').hidden = !frame.text
  } else if (frame.type === 'delta') {
    byId('live-text').append(document.createTextNode(frame.text)); byId('live').hidden = false
  } else if (frame.type === 'status') {
    chatInfo = { ...chatInfo, running: frame.running, stopTask: frame.stopTask }
    byId('chat-info').textContent = `${kinds[chatInfo.kind]} · ${frame.running ? '运行中' : '空闲'}`
    updateComposer()
  } else if (frame.type === 'title') {
    byId('chat-title').textContent = frame.title
  }
  byId('updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  if (atBottom && frame.type !== 'status') window.scrollTo(0, document.documentElement.scrollHeight)
}
async function readConversation(signal, current) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(route.conversation)}/events`, { signal, cache: 'no-store' })
  if (response.status === 401) { stop(); location.replace('/'); return }
  if (!response.ok) throw new Error((await response.json()).error || '无法读取会话')
  refresh.disabled = false
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  try {
    while (current === generation) {
      const { value, done } = await reader.read()
      if (done) throw new Error('实时连接已断开，正在重新连接…')
      buffer += decoder.decode(value, { stream: true })
      let end
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (current !== generation) return
        if (event.startsWith('data: ')) conversationFrame(JSON.parse(event.slice(6)))
      }
    }
  } finally { await reader.cancel().catch(() => {}) }
}
async function post(path, value) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-superagent-request': '1' },
    body: JSON.stringify(value), signal: AbortSignal.timeout(20_000) })
  if (response.status === 401) { stop(); location.replace('/'); throw new Error('登录已失效') }
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '操作失败')
  return result
}
function newId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('')
}
async function sendSubmission(id, item) {
  item.state = 'sending'
  if (route.conversation === id) showPending()
  try {
    await post(`/api/conversations/${encodeURIComponent(id)}/messages`, { requestId: item.requestId, text: item.text })
    item.state = 'accepted'
  } catch (error) {
    item.state = 'failed'
    if (route.conversation === id) showError(error)
  } finally { if (route.conversation === id) showPending() }
}
async function load() {
  if (document.hidden || busy) return
  clearTimeout(timer); busy = true; refresh.disabled = true
  controller = new AbortController()
  const current = generation
  content.setAttribute('aria-busy', 'true')
  try {
    if (route.conversation) { await readConversation(controller.signal, current); return }
    const path = route.conversations ? `/api/conversations?offset=${route.offset}`
      : route.ticket ? `/api/tickets/${encodeURIComponent(route.ticket)}` : `/api/tickets?state=${route.state}&offset=${route.offset}&limit=20`
    const response = await fetch(path, { cache: 'no-store', signal: controller.signal })
    const data = await response.json()
    if (current !== generation) return
    if (!response.ok) {
      if (response.status === 401) { stop(); location.replace('/'); return }
      if (response.status === 404) content.replaceChildren(node('p', 'empty', data.error))
      throw new Error(data.error || '读取失败，请重试')
    }
    if (route.conversations) showConversations(data); else if (route.ticket) showDetail(data); else showList(data)
    byId('error').hidden = true
    byId('connection').textContent = '已连接 · 每 5 秒刷新'
    byId('updated').textContent = `刷新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  } catch (error) {
    if (current !== generation || error.name === 'AbortError') return
    byId('connection').textContent = '连接异常 · 已显示内容可能不是最新'
    chatReady = false
    if (route.conversation) showPending()
    showError(error)
  } finally {
    if (current === generation) {
      busy = false; refresh.disabled = false; content.setAttribute('aria-busy', 'false')
      if (!document.hidden) timer = setTimeout(load, 5000)
    }
  }
}
function stop() {
  clearTimeout(timer); generation++; controller?.abort(); busy = false; chatReady = false; refresh.disabled = false
  if (route?.conversation) showPending()
}
function navigate() {
  stop()
  const params = new URLSearchParams(location.hash.slice(1))
  const ticket = params.get('ticket'), conversation = params.get('conversation'), state = params.get('state') || 'open', offset = Number(params.get('offset') || 0)
  route = { ticket: ticket || '', conversation: conversation || '', conversations: params.has('conversations') || !!conversation,
    state: Object.hasOwn(states, state) ? state : 'open', offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0 }
  if (!route.ticket && !route.conversations) listHash = `#state=${route.state}&offset=${route.offset}`
  filter.value = route.state
  byId('page-title').textContent = route.conversations ? '会话' : '任务'
  byId('tasks-tab').setAttribute('aria-current', route.conversations ? 'false' : 'page')
  byId('conversations-tab').setAttribute('aria-current', route.conversations ? 'page' : 'false')
  byId('filter-label').hidden = !!route.ticket || route.conversations
  byId('back').hidden = !route.ticket && !route.conversation
  byId('new-conversation').hidden = !route.conversations
  byId('pagination').hidden = true; byId('error').hidden = true
  byId('chat').hidden = !route.conversation; content.hidden = !!route.conversation
  byId('updated').textContent = ''; byId('connection').textContent = '正在读取…'
  content.replaceChildren(node('p', 'empty', '正在读取…'))
  messages = new Map(); chatInfo = undefined; chatThrough = undefined; chatBefore = null
  byId('messages').replaceChildren(); byId('live').hidden = true; byId('chat-notice').hidden = true
  byId('chat-title').textContent = '正在读取会话…'; byId('chat-info').textContent = ''
  byId('older').hidden = true; byId('stop-confirm').hidden = true
  byId('message').value = drafts.get(route.conversation) || ''
  if (route.conversation) showPending()
  window.scrollTo(0, 0); void load()
}
refresh.onclick = () => { stop(); void load() }
filter.onchange = () => { location.hash = `state=${filter.value}&offset=0` }
byId('back').onclick = () => { location.hash = route.conversation ? '#conversations' : listHash }
const pageHash = offset => route.conversations ? `conversations&offset=${offset}` : `state=${route.state}&offset=${offset}`
byId('previous').onclick = () => { location.hash = pageHash(Math.max(0, route.offset - 20)) }
byId('next').onclick = () => { if (nextOffset !== null) location.hash = pageHash(nextOffset) }
byId('message').oninput = () => { drafts.set(route.conversation, byId('message').value); updateComposer() }
byId('composer').onsubmit = event => {
  event.preventDefault()
  if (byId('send-message').disabled) return
  const id = route.conversation, item = { requestId: newId(), text: byId('message').value.trim(), state: 'sending' }
  pendingFor(id).set(item.requestId, item)
  byId('message').value = ''; drafts.delete(id)
  void sendSubmission(id, item)
}
byId('new-conversation').onclick = async () => {
  if (creating) return
  creating = true; byId('new-conversation').disabled = true
  const current = generation
  creation ||= newId()
  try {
    const result = await post('/api/conversations', { requestId: creation })
    creation = undefined
    if (current === generation) location.hash = `conversation=${encodeURIComponent(result.id)}`
  } catch (error) { if (current === generation) showError(error) }
  finally { creating = false; byId('new-conversation').disabled = false }
}
byId('older').onclick = async () => {
  if (chatBefore === null || chatThrough === undefined) return
  const current = generation, through = chatThrough, previousHeight = document.documentElement.scrollHeight
  byId('older').disabled = true
  try {
    const response = await fetch(`/api/conversations/${encodeURIComponent(route.conversation)}/history?through=${through}&before=${chatBefore}`,
      { cache: 'no-store', signal: controller.signal })
    if (response.status === 401) { stop(); location.replace('/'); return }
    const data = await response.json()
    if (current !== generation || through !== chatThrough) return
    if (!response.ok) throw new Error(data.error || '无法读取历史')
    for (const message of data.messages) messages.set(message.seq, message)
    chatBefore = data.before; byId('older').hidden = !data.hasMore
    renderMessages(); window.scrollBy(0, document.documentElement.scrollHeight - previousHeight)
  } catch (error) { if (current === generation && error.name !== 'AbortError') showError(error) }
  finally { if (current === generation) byId('older').disabled = false }
}
byId('stop-conversation').onclick = () => {
  byId('stop-warning').textContent = chatInfo.stopTask
    ? '这会停止整个任务、撤回执行授权，并停止其后台工作，不只是停止回复。确认继续？'
    : chatInfo.kind === 'orchestrator' ? '仅停止主调度当前生成；新的事件仍可能唤醒调度。确认继续？' : '停止当前生成；已排队的消息不会被删除。确认继续？'
  byId('stop-confirm').hidden = false
}
byId('cancel-stop').onclick = () => { byId('stop-confirm').hidden = true }
byId('confirm-stop').onclick = async () => {
  const id = route.conversation, current = generation
  byId('confirm-stop').disabled = true
  try {
    const result = await post(`/api/conversations/${encodeURIComponent(id)}/stop`, {})
    if (current !== generation) return
    byId('stop-confirm').hidden = true
    byId('chat-notice').textContent = result.taskStopped ? '任务已停止' : '已请求停止当前生成'
    byId('chat-notice').hidden = false
    stop(); void load()
  } catch (error) { if (current === generation) showError(error) }
  finally { byId('confirm-stop').disabled = false }
}
window.addEventListener('hashchange', navigate)
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else void load() })
window.addEventListener('pagehide', stop)
window.addEventListener('pageshow', event => { if (event.persisted) void load() })
navigate()
