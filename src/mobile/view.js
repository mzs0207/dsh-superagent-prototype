/** Read-only view. Task strings are always text nodes; hidden pages never poll. */
const byId = id => document.getElementById(id)
const content = byId('content'), refresh = byId('refresh'), filter = byId('filter')
const states = { open: '未结束', working: '执行中', person: '待处理', idle: '等待中', ended: '已结束' }
const actions = { queued: '排队中', blocked: '已阻塞', failed: '执行失败', answer: '待答复', review: '待审核', delivery: '投递失败' }
const reports = { progress: '进展', waiting: '等待中', ready: '已就绪', blocked: '已阻塞', failed: '失败', dropped: '已放弃' }
const outcomes = { completed: '完成', merged: '已合并', closed: '已关闭', stopped: '已停止', dropped: '已放弃' }
let controller, timer, generation = 0, busy = false, nextOffset = null, route, listHash = '#state=open'
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
  if (ticket.attention) fragment.append(section('需要答复', ticket.attention))
  if (ticket.ended) fragment.append(section('执行结果', `${outcomes[ticket.ended.outcome] || ticket.ended.outcome}\n${ticket.ended.reason || ''}\n${time(ticket.ended.at)}`))
  fragment.append(section('任务说明', ticket.description), section(ticket.action === 'blocked' ? '阻塞原因' : ticket.action === 'failed' ? '失败原因' : '最新进展', ticket.summary))
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
async function load() {
  if (document.hidden || busy) return
  clearTimeout(timer); busy = true; refresh.disabled = true
  controller = new AbortController()
  const current = generation
  content.setAttribute('aria-busy', 'true')
  try {
    const path = route.ticket ? `/api/tickets/${encodeURIComponent(route.ticket)}` : `/api/tickets?state=${route.state}&offset=${route.offset}&limit=20`
    const response = await fetch(path, { cache: 'no-store', signal: controller.signal })
    const data = await response.json()
    if (current !== generation) return
    if (!response.ok) {
      if (response.status === 401) { stop(); location.replace('/'); return }
      if (response.status === 404) content.replaceChildren(node('p', 'empty', data.error))
      throw new Error(data.error || '读取失败，请重试')
    }
    if (route.ticket) showDetail(data); else showList(data)
    byId('error').hidden = true
    byId('connection').textContent = '已连接 · 每 5 秒刷新'
    byId('updated').textContent = `刷新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  } catch (error) {
    if (current !== generation || error.name === 'AbortError') return
    byId('connection').textContent = '连接异常 · 已显示内容可能不是最新'
    byId('error').textContent = error instanceof TypeError ? '无法连接电脑，请检查网络与只读服务。' : error.message
    byId('error').hidden = false
  } finally {
    if (current === generation) {
      busy = false; refresh.disabled = false; content.setAttribute('aria-busy', 'false')
      if (!document.hidden) timer = setTimeout(load, 5000)
    }
  }
}
function stop() { clearTimeout(timer); generation++; controller?.abort(); busy = false; refresh.disabled = false }
function navigate() {
  stop()
  const params = new URLSearchParams(location.hash.slice(1))
  const ticket = params.get('ticket'), state = params.get('state') || 'open', offset = Number(params.get('offset') || 0)
  route = { ticket: ticket || '', state: Object.hasOwn(states, state) ? state : 'open', offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0 }
  if (!route.ticket) listHash = `#state=${route.state}&offset=${route.offset}`
  filter.value = route.state
  byId('filter-label').hidden = !!route.ticket; byId('back').hidden = !route.ticket
  byId('pagination').hidden = true; byId('error').hidden = true
  byId('updated').textContent = ''; byId('connection').textContent = '正在读取…'
  content.replaceChildren(node('p', 'empty', '正在读取任务…'))
  window.scrollTo(0, 0); void load()
}
refresh.onclick = () => { void load() }
filter.onchange = () => { location.hash = `state=${filter.value}&offset=0` }
byId('back').onclick = () => { location.hash = listHash }
byId('previous').onclick = () => { location.hash = `state=${route.state}&offset=${Math.max(0, route.offset - 20)}` }
byId('next').onclick = () => { if (nextOffset !== null) location.hash = `state=${route.state}&offset=${nextOffset}` }
window.addEventListener('hashchange', navigate)
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else void load() })
window.addEventListener('pagehide', stop)
window.addEventListener('pageshow', event => { if (event.persisted) void load() })
navigate()
