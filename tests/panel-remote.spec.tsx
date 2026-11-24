// @vitest-environment jsdom
/** Remote inventory forms, secret lifetime, CAS, challenge trust and late-response isolation. */
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { ManagedEnvironment, ManagedHost } from '../src/remote-ops/managed-types.ts'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount as mountPanel, remount as remountPanel, settle, all, find, click, type, text, field, at } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import { RemotePage } from '../src/remote-ops/page.tsx'
import type { T } from '../src/client/text.ts'

const render = (t: T) => <RemotePage t={t} />
const mount = (dictionary = zh) => mountPanel(dictionary, render)
const remount = (dictionary = zh) => remountPanel(dictionary, render)

usePanel()
const fingerprint = `SHA256:${'a'.repeat(43)}`
const host = (id = 'host-a', trusted = false): ManagedHost => ({ id, name: id, host: `${id}.example.test`, port: 22, username: 'ops',
  auth: 'password', hasPassword: true, hostKeyFingerprint: trusted ? fingerprint : null, projects: [] })
const environment = (id = 'env-a', hosts = [host()]): ManagedEnvironment => ({ id, name: id, aliases: [], production: false, hosts })
const seed = (environments = [environment()]) => { server.remote = { revision: 4, environments } }
const requests = (method: string) => server.requests.filter(request => request.path.startsWith('remote') && request.method === method)
const input = (label: string) => field<HTMLInputElement>(label)
const area = (label: string) => field<HTMLTextAreaElement>(label)
const checkbox = (label: string) => all('label').find(item => item.textContent === label)!.querySelector<HTMLInputElement>('input')!
const buttonIn = (container: Element, label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button =>
  button.textContent === label)!
const card = (name = 'host-a') => document.querySelector<HTMLElement>(`article[aria-label="${name}"]`)!
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const noStoredPassword = (value: string) => {
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index++) expect(storage.getItem(storage.key(index)!)).not.toContain(value)
  }
  expect(document.querySelector('.dt-toast')?.textContent ?? '').not.toContain(value)
  expect(text()).not.toContain(value)
}

it('drops the previous Superagent tab and ignores its persisted route', async () => {
  at({ page: 'remote' })
  await mountPanel()
  expect(all('[role="tab"]').some(element => element.textContent === zh['tab.remote'])).toBe(false)
  expect(document.querySelector('a[href="/environment-resources"]')).toBeNull()
  expect(requests('GET')).toHaveLength(0)
})

it('manages empty environments in the standalone page without loading Superagent', async () => {
  await mount()
  expect(text()).toContain(zh.remoteNoEnvironments)
  expect(all('.dt-settings-link')).toHaveLength(0)
  await click(zh.remoteAddEnvironment)
  await type(input(zh.remoteEnvironmentName), 'Staging')
  await type(area(zh.remoteAliases), 'stage\nstg')
  await click(zh.save)
  expect(server.remote).toMatchObject({ revision: 1, environments: [{ name: 'Staging', aliases: ['stage', 'stg'], hosts: [] }] })
  expect(text()).toContain(zh.remoteNoResources)
  expect(requests('POST')[0]?.body).toEqual({ revision: 0, name: 'Staging', aliases: ['stage', 'stg'], production: false })
  await remount(en)
  expect(text()).toContain(en['tab.remote'])
  expect(server.requests.some(request => request.path === 'state')).toBe(false)
  expect(text()).toContain(en.remoteNoResources)
})

it('creates a password host with ordered Compose files, edits without echoing the old password and clears cancellations', async () => {
  seed([environment('empty', [])])
  await mount()
  await click(zh.remoteAddHost)
  expect(input(zh.remotePassword).required).toBe(true)
  await type(input(zh.remoteHostName), 'API')
  await type(input(zh.remoteAddress), 'api.example.test')
  await type(input(zh.remotePort), '2222')
  await type(input(zh.remoteUsername), 'deploy')
  await type(input(zh.remotePassword), 'never-display-password')
  await click(zh.remoteAddProject)
  await type(input(zh.remoteProjectId), 'api')
  await type(input(zh.remoteProjectDirectory), '/srv/api')
  await type(area(zh.remoteProjectFiles), 'compose.yml\ncompose.prod.yml')
  await type(input(zh.remoteProjectName), 'prod-api')
  await type(area(zh.remoteProjectProfiles), 'worker\nmetrics')
  const detached = input(zh.remotePassword)
  noStoredPassword('never-display-password')
  await click(zh.save)
  const saved = server.remote.environments[0]!.hosts[0]!
  expect(saved).toMatchObject({ name: 'API', host: 'api.example.test', port: 2222, username: 'deploy', auth: 'password', hasPassword: true,
    projects: [{ id: 'api', directory: '/srv/api', files: ['compose.yml', 'compose.prod.yml'], projectName: 'prod-api', profiles: ['worker', 'metrics'] }] })
  expect('password' in saved).toBe(false)
  expect(detached.value).toBe('')
  expect(server.remote.revision).toBe(5)
  noStoredPassword('never-display-password')
  await click(zh.remoteEditHost)
  expect(input(zh.remotePassword).value).toBe('')
  expect(input(zh.remotePassword).required).toBe(false)
  await type(input(zh.remoteHostName), 'API renamed')
  await click(zh.save)
  expect(server.remotePasswords[saved.id]).toBe('never-display-password')
  expect(requests('PUT').at(-1)?.body).toMatchObject({ revision: 5, name: 'API renamed', projects: saved.projects })
  expect(requests('PUT').at(-1)?.body).not.toHaveProperty('password')
  await click(zh.remoteEditHost)
  await type(input(zh.remotePassword), 'cancel-this-secret')
  const cancelled = input(zh.remotePassword)
  await click(zh.cancel)
  expect(cancelled.value).toBe('')
  await click(zh.remoteEditHost)
  expect(input(zh.remotePassword).value).toBe('')
  noStoredPassword('cancel-this-secret')
})

it('edits environments, removes project rows and confirms host/environment deletions inline with current revisions', async () => {
  const old = host()
  old.projects = [{ id: 'api', directory: '/srv/api', files: ['compose.yml'], label: 'Keep label', projectName: 'api', profiles: ['worker'] }]
  seed([environment('env-a', [old])])
  await mount()
  await click(zh.remoteEditEnvironment)
  await type(input(zh.remoteEnvironmentName), 'Production')
  await click(checkbox(zh.remoteProduction))
  await click(zh.save)
  expect(server.remote.revision).toBe(5)
  expect(server.remote.environments[0]).toMatchObject({ name: 'Production', production: true })
  await click(zh.remoteEditHost)
  await type(input(zh.remoteHostName), 'new-name')
  await click(zh.save)
  expect(server.remote.environments[0]!.hosts[0]!.projects[0]!.label).toBe('Keep label')
  await click(zh.remoteEditHost)
  await click(find(zh.remoteRemoveProject.replace('{number}', '1')))
  await click(zh.save)
  expect(server.remote.environments[0]!.hosts[0]!.projects).toEqual([])
  await click(buttonIn(card('new-name'), zh.remove))
  expect(requests('DELETE')).toHaveLength(0)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await click(zh.cancel)
  expect(requests('DELETE')).toHaveLength(0)
  await click(buttonIn(card('new-name'), zh.remove))
  await click(zh.remoteDeleteConfirm)
  expect(requests('DELETE')[0]?.body).toEqual({ revision: 7 })
  expect(text()).toContain(zh.remoteNoResources)
  await click(zh.remove)
  await click(zh.remoteDeleteConfirm)
  expect(requests('DELETE')[1]?.body).toEqual({ revision: 8 })
  expect(server.remote.environments).toEqual([])
  expect(text()).toContain(zh.remoteNoEnvironments)
})

it('requires probe, trusted-channel verification and token-bound trust before testing; only uses the returned ok', async () => {
  seed()
  await mount()
  expect(buttonIn(card(), zh.remoteTest).disabled).toBe(true)
  await click(zh.remoteProbe)
  expect(card().textContent).toContain(fingerprint)
  expect(buttonIn(card(), zh.remoteTrust).disabled).toBe(true)
  expect(server.remote.environments[0]!.hosts[0]!.hostKeyFingerprint).toBeNull()
  await click(checkbox(zh.remoteVerified))
  const challenge = Object.values(server.remoteChallenges)[0]!.probe
  await click(zh.remoteTrust)
  expect(requests('POST').at(-1)?.body).toEqual({ revision: 4, token: challenge.token })
  expect(server.remote.revision).toBe(5)
  expect(server.remote.environments[0]!.hosts[0]!.hostKeyFingerprint).toBe(fingerprint)
  expect(buttonIn(card(), zh.remoteTest).disabled).toBe(false)
  server.remoteTest = { ok: false, message: 'never display server details', durationMs: 19 }
  await click(zh.remoteTest)
  expect(text()).toContain(zh.remoteTestFailed.replace('{duration}', '19'))
  expect(text()).not.toContain('never display server details')
  expect(text()).not.toContain(zh.remoteTestOk.replace('{duration}', '19'))
  server.remoteTest = { ok: true, message: '', durationMs: 7 }
  await click(zh.remoteTest)
  expect(text()).toContain(zh.remoteTestOk.replace('{duration}', '7'))
  expect(requests('POST').at(-1)?.body).toEqual({ revision: 5 })
})

it('disables expired challenge trust and asks for a fresh fingerprint', async () => {
  seed()
  await mount()
  await click(zh.remoteProbe)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 301_000)
  try {
    await click(checkbox(zh.remoteVerified))
    await click(zh.remoteTrust)
    expect(text()).toContain(zh.remoteProbeExpired)
    expect(buttonIn(card(), zh.remoteTrust).disabled).toBe(true)
    expect(requests('POST').filter(item => item.path.endsWith('/trust'))).toHaveLength(0)
  } finally { vi.restoreAllMocks() }
})

it('rejects stale saves explicitly, never silently retries and only refreshes on request', async () => {
  seed()
  await mount()
  await click(zh.remoteEditHost)
  await type(input(zh.remoteHostName), 'my edit')
  await type(input(zh.remotePassword), 'clear-on-conflict')
  server.remote.revision = 5
  server.remote.environments[0]!.hosts[0]!.name = 'changed elsewhere'
  const reads = requests('GET').length
  await click(zh.save)
  expect(text()).toContain(zh.remoteConflict)
  expect(requests('GET')).toHaveLength(reads)
  expect(requests('PUT')).toHaveLength(1)
  expect(input(zh.remoteHostName).value).toBe('my edit')
  expect(input(zh.remotePassword).value).toBe('')
  expect(find(zh.save).matches(':disabled')).toBe(true)
  await click(zh.save)
  expect(requests('PUT')).toHaveLength(1)
  noStoredPassword('clear-on-conflict')
  await click(zh.remoteRefresh)
  expect(text()).not.toContain(zh.remoteConflict)
  expect(text()).toContain('changed elsewhere')
  await click(zh.remoteEditHost)
  await type(input(zh.remoteHostName), 'compared edit')
  await click(zh.save)
  expect(requests('PUT').at(-1)?.body).toMatchObject({ revision: 5, name: 'compared edit' })
})

it('clears secrets on environment and unmount switches and ignores old probe/test results for a new target', async () => {
  seed([environment('env-a', [host('host-a', true)]), environment('env-b', [host('host-b', true)])])
  await mount()
  await click(zh.remoteEditHost)
  await type(input(zh.remotePassword), 'switch-secret')
  const switched = input(zh.remotePassword)
  await click('env-b')
  expect(switched.value).toBe('')
  await click(zh.remoteEditHost)
  expect(input(zh.remotePassword).value).toBe('')
  const hold = deferred()
  server.remoteWaiting = async (operation, id) => { if (operation === 'probe' && id === 'host-a') await hold.promise }
  await click('env-a')
  await click(zh.remoteProbe)
  expect(buttonIn(card(), zh.remoteProbe).matches(':disabled')).toBe(true)
  await click('env-b')
  expect(all('.dt-remote-trust')).toHaveLength(0)
  await act(async () => { hold.resolve() }); await settle()
  expect(all('.dt-remote-trust')).toHaveLength(0)
  expect(card('host-b').textContent).not.toContain(zh.remoteProbeExpires.split('{time}')[0])
  const testing = deferred()
  server.remoteWaiting = async (operation, id) => { if (operation === 'test' && id === 'host-a') await testing.promise }
  await click('env-a')
  await click(zh.remoteTest)
  await click('env-b')
  await act(async () => { testing.resolve() }); await settle()
  expect(card('host-b').textContent).not.toContain(zh.remoteTestOk.replace('{duration}', '12'))
  await click(zh.remoteEditHost)
  await type(input(zh.remotePassword), 'unmount-secret')
  const unmounted = input(zh.remotePassword)
  await remount()
  expect(unmounted.value).toBe('')
  noStoredPassword('switch-secret'); noStoredPassword('unmount-secret')
})

it('isolates concurrent host probes within one environment and ignores a probe after switching to another host editor', async () => {
  seed([environment('env-a', [host('host-a', true), host('host-b', true)])])
  await mount()
  const hold = deferred()
  server.remoteWaiting = async (operation, id) => { if (operation === 'probe' && id === 'host-a') await hold.promise }
  await click(buttonIn(card('host-a'), zh.remoteProbe))
  await click(buttonIn(card('host-b'), zh.remoteProbe))
  expect(card('host-a').querySelector('.dt-remote-trust')).toBeNull()
  expect(card('host-b').querySelector('.dt-remote-trust')).not.toBeNull()
  expect(buttonIn(card('host-a'), zh.remoteProbe).matches(':disabled')).toBe(true)
  await click(buttonIn(card('host-b'), zh.remoteEditHost))
  expect(input(zh.remoteHostName).value).toBe('host-b')
  await act(async () => { hold.resolve() }); await settle()
  expect(all('.dt-remote-trust')).toHaveLength(0)
  await click(zh.cancel)
  expect(all('.dt-remote-trust')).toHaveLength(0)
})

it('shows loading/retry errors, disables pending saves and never reflects a faulty server password error', async () => {
  seed([environment('env-a', [])])
  server.down = true
  await mount()
  expect(text()).toContain(zh.remoteFailed)
  server.down = false
  const hold = deferred()
  server.remoteWaiting = async operation => { if (operation === 'get') await hold.promise }
  await click(zh.remoteRefresh)
  expect(text()).toContain(zh.loading)
  expect(find(zh.remoteRefresh).matches(':disabled')).toBe(true)
  await act(async () => { hold.resolve() }); await settle()
  await click(zh.remoteAddHost)
  await type(input(zh.remoteHostName), 'API')
  await type(input(zh.remoteAddress), 'api.example.test')
  await type(input(zh.remoteUsername), 'ops')
  await type(input(zh.remotePassword), 'faulty-echo-secret')
  const original = fetch
  const delayed = deferred()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.endsWith('/hosts')) {
      await delayed.promise
      return new Response(JSON.stringify({ error: 'faulty-echo-secret' }), { status: 400 })
    }
    return original(url, init)
  }))
  await click(zh.save)
  expect(find(zh.save).matches(':disabled')).toBe(true)
  expect(input(zh.remotePassword).value).toBe('')
  await act(async () => { delayed.resolve() }); await settle()
  expect(text()).toContain(zh.remoteInvalid)
  noStoredPassword('faulty-echo-secret')
})

it('records a website account separately from host fields and displays its notes without its password', async () => {
  seed([environment('staging', [])])
  await mount()
  await click('新增网站账号')
  const form = document.querySelector('form[aria-label="新增网站账号"]')
  expect(form?.querySelector('[name=role], [name=webPaths], [name=apiPaths]')).toBeNull()
  await type(input('资源名称'), 'OMS verifier')
  const origin = input(zh.remoteWebOrigin)
  await type(origin, 'http://oms.example.invalid')
  await type(input('登录邮箱'), 'test@example.invalid')
  await type(input('资源密码'), 'never-return-account-password')
  await type(area('备注'), '退款场景，只读验证')
  await click(zh.save)
  expect(requests('POST')).toHaveLength(0)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('公网地址必须使用 HTTPS')
  expect(origin.getAttribute('aria-invalid')).toBe('true')
  expect(input('资源密码').value).toBe('never-return-account-password')
  await type(origin, 'https://oms.example.invalid/login')
  await click(zh.save)
  expect(requests('POST')).toHaveLength(0)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('不要带路径')
  await type(origin, 'http://192.168.77.10')
  const detached = input('资源密码')
  await click(zh.save)
  expect(requests('POST').at(-1)?.body).toMatchObject({ type: 'website-account', origin: 'http://192.168.77.10', notes: '退款场景，只读验证' })
  expect(text()).toContain('退款场景，只读验证')
  expect(detached.value).toBe('')
  noStoredPassword('never-return-account-password')
})

it('accepts a ZenTao username and installation path without adding per-account path lists', async () => {
  seed([environment('staging', [])])
  await mount()
  await click('新增网站账号')
  await type(field<HTMLSelectElement>('登录系统'), 'zentao')
  await type(input('资源名称'), 'ZenTao QA')
  await type(input(zh.remoteWebOrigin), 'http://192.168.77.10:8080/zentao')
  await type(input('登录用户名'), 'qa_user')
  await type(input('资源密码'), 'fixture-credential')
  await click(zh.save)
  expect(requests('POST').at(-1)?.body).toMatchObject({
    system: 'zentao', origin: 'http://192.168.77.10:8080/zentao', username: 'qa_user',
  })
  expect(text()).toContain('ZenTao QA')
  noStoredPassword('fixture-credential')
})
