import { createServer, request, type Server } from 'node:http'
import { scryptSync } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { startGateway } from '../src/mobile/gateway.ts'

let upstream: Server, gateway: Awaited<ReturnType<typeof startGateway>>
let seen: string[], mode: 'ok' | 'missing' | 'redirect' | 'broken'
const password = { salt: 'b'.repeat(32), hash: scryptSync('viewer-password', 'b'.repeat(32), 32).toString('hex') }
let sessionCookie = ''
const item = { id: 't1', title: '<img src=x onerror=alert(1)>', stage: 'person', action: 'blocked',
  summary: 'Waiting for review', updatedAt: '2026-11-06T10:00:00Z', createdAt: '2026-11-06T09:00:00Z',
  attention: { question: 'Which target?' }, threads: [{ source: 'zentao', title: 'Bug 1', url: 'http://internal/bug/1', facts: { secret: 'private' } }],
  actions: { retry: true, stop: true }, sessionId: 'secret-session', directory: '/private/work',
  environment: [{ key: 'SECRET', value: 'private-token' }], mandate: { scope: 'Fix the bug', actor: { id: 'private-user' } },
  assignments: [{ id: 'a1', state: 'running', createdAt: '2026-11-06T09:00:00Z', report: { state: 'blocked', summary: 'Review required', at: '2026-11-06T10:00:00Z' }, ref: 'private-session', args: 'private-arguments' }] }

beforeEach(async () => {
  seen = []; mode = 'ok'
  upstream = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    expect(req.headers['x-orchestrator-request']).toBe('1')
    expect(req.headers.authorization).toBeUndefined()
    expect(req.headers.cookie).toBeUndefined()
    if (mode === 'redirect') { res.writeHead(302, { location: '/orchestrator/api/settings' }); res.end(); return }
    if (mode === 'missing') { res.writeHead(404); res.end('private error'); return }
    if (mode === 'broken') { res.writeHead(500); res.end('private stack'); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url?.startsWith('/orchestrator/api/tickets?') ? { items: [item], total: 24, next_offset: 20 } : item))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No upstream port')
  gateway = await startGateway({ host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${address.port}`, password })
  const login = await call('/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'POST', 'password=viewer-password')
  expect(login.status).toBe(200)
  sessionCookie = (login.headers['set-cookie'] as string[])[0]!.split(';')[0]!
})
afterEach(async () => {
  await gateway.close()
  upstream.closeAllConnections()
  await new Promise<void>(resolve => upstream.close(() => resolve()))
})
function call(path: string, headers: Record<string, string | undefined> = { cookie: sessionCookie }, method = 'GET', body?: string) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request(`${gateway.origin}${path}`, { method, headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }))
    }); req.on('error', reject); req.end(body)
  })
}
it('requires password login without accepting passwords or old keys in URLs or headers', async () => {
  for (const headers of [{}, { authorization: 'Bearer wrong' }]) expect((await call('/api/tickets', headers)).status).toBe(401)
  expect((await call('/api/tickets?password=viewer-password', {})).status).toBe(401)
  const failed = await call('/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'POST', 'password=wrong')
  expect(failed.status).toBe(401)
  expect(failed.headers['set-cookie']).toBeUndefined()
  expect(seen).toEqual([])
})
it('exposes only ticket GET routes and never forwards mutations or management paths', async () => {
  for (const path of ['/api/settings', '/orchestrator/api/tickets', '/api/tickets/t1/retry', '/api/tickets/%2e%2e%2fsettings']) {
    expect((await call(path)).status, path).toBe(404)
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect((await call('/api/tickets/t1', undefined, method)).status).toBe(405)
  expect(seen).toEqual([])
})
it('projects task content without leaking management fields or nested secrets', async () => {
  const list = await call('/api/tickets?state=person&offset=20&limit=20')
  expect(list.status).toBe(200)
  expect(JSON.parse(list.body)).toMatchObject({ items: [{ id: 't1', title: item.title, stage: 'person', action: 'blocked' }], total: 24, next_offset: 20 })
  const detail = await call('/api/tickets/t1')
  expect(JSON.parse(detail.body)).toMatchObject({ description: 'Fix the bug', summary: 'Waiting for review',
    attention: 'Which target?', reports: [{ state: 'blocked', summary: 'Review required' }] })
  for (const response of [list, detail]) {
    expect(response.body).not.toMatch(/private|secret-session|environment|sessionId|"actions"|"ref"/)
    expect(response.headers['cache-control']).toBe('no-store')
  }
  expect(seen).toEqual(['GET /orchestrator/api/tickets?state=person&offset=20&limit=20', 'GET /orchestrator/api/tickets/t1'])
})
it('validates pagination and ignores no hidden upstream query parameters', async () => {
  for (const query of ['state=invalid', 'offset=-1', 'limit=101', 'limit=0', 'offset=1.5', 'offset=0&offset=1', 'extra=settings']) {
    expect((await call(`/api/tickets?${query}`)).status, query).toBe(400)
  }
  expect(seen).toEqual([])
})
it('rejects wrong Host and cross-origin browser requests', async () => {
  for (const extra of [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    expect((await call('/api/tickets', { cookie: sessionCookie, ...extra })).status).toBe(403)
  }
  expect(seen).toEqual([])
})
it('sets an HttpOnly host-only cookie usable over LAN HTTP on subsequent reads', async () => {
  const login = await call('/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'POST', 'password=viewer-password')
  expect(login.status).toBe(200)
  const cookie = (login.headers['set-cookie'] as string[])[0]!
  expect(cookie).toContain('HttpOnly'); expect(cookie).not.toContain('Secure'); expect(cookie).toContain('SameSite=Strict')
  expect(cookie).not.toContain('Domain=')
  expect((await call('/api/tickets', { cookie: cookie.split(';')[0]! })).status).toBe(200)
  expect(cookie).not.toContain('viewer-password')
  expect((await call('/api/tickets', { cookie: 'superagent-view=wrong' })).status).toBe(401)
})
it('keeps missing tasks distinct from upstream failures without forwarding internal error details', async () => {
  mode = 'missing'; expect((await call('/api/tickets/t1')).status).toBe(404)
  mode = 'broken'; const failed = await call('/api/tickets/t1'); expect(failed.status).toBe(502); expect(failed.body).not.toContain('private')
  mode = 'redirect'; expect((await call('/api/tickets')).status).toBe(502)
  expect(seen).not.toContain('GET /orchestrator/api/settings')
})
it('forbids non-loopback upstreams before any listener is created', async () => {
  await expect(startGateway({ host: '127.0.0.1', port: 0, upstream: 'http://192.168.1.1:3082', password })).rejects.toThrow(/loopback/i)
})
it('rejects cross-origin login and oversized password bodies without issuing a session', async () => {
  const cross = await call('/login', { origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, 'POST', 'password=viewer-password')
  expect(cross.status).toBe(403); expect(cross.headers['set-cookie']).toBeUndefined()
  const large = await call('/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'POST', 'password=' + 'x'.repeat(4096))
  expect(large.status).toBe(413); expect(large.headers['set-cookie']).toBeUndefined()
})
it('rejects malformed request targets without killing the viewer', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(gateway.origin, { path: 'http://[', headers: { cookie: sessionCookie } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!))
    })
    req.on('error', reject); req.end()
  })
  expect(status).toBe(400)
  expect((await call('/api/tickets')).status).toBe(200)
})
