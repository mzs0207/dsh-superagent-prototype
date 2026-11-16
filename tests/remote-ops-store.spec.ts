import { createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedStore } from '../src/remote-ops/managed-store.ts'
import { RemoteManagementError, type HostWrite, type ManagedView } from '../src/remote-ops/managed-types.ts'

const faults = vi.hoisted(() => ({ failRename: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (faults.failRename) throw new Error('fixture-only private filesystem failure')
    return actual.rename(...args)
  } }
})

const directories: string[] = []
const PASSWORD = 'fixture-only secret 你好 \'$(not-a-command)'
const FINGERPRINT = `SHA256:${'a'.repeat(43)}`
const hostInput = (revision: number, overrides: Partial<HostWrite> = {}): HostWrite => ({
  revision, name: '诊断节点', host: 'app.example.invalid', username: 'diagnostic', password: PASSWORD,
  projects: [{ id: 'community', label: '社区', directory: '/srv/community' }], ...overrides,
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'remote-ops-store-'))
  directories.push(root)
  const directory = join(root, 'remote-ops')
  return { root, directory, statePath: join(directory, 'state.json'), keyPath: join(directory, 'master.key'), store: new ManagedStore(directory) }
}
async function populated(overrides: Partial<HostWrite> = {}) {
  const value = await fixture()
  let view = await value.store.createEnvironment({ revision: 0, name: '开发', aliases: ['研发'], production: false })
  const environmentId = view.environments[0]!.id
  view = await value.store.createHost(environmentId, hostInput(view.revision, overrides))
  return { ...value, view, environmentId, hostId: view.environments[0]!.hosts[0]!.id }
}
async function stored(path: string): Promise<any> { return JSON.parse(await readFile(path, 'utf8')) }
async function rewrite(path: string, value: unknown) { await writeFile(path, JSON.stringify(value), { mode: 0o600 }) }
function noSecrets(view: ManagedView) {
  const serialized = JSON.stringify(view)
  expect(serialized).not.toContain(PASSWORD)
  for (const field of ['"secret"', '"ciphertext"', '"iv"', '"tag"', '"password":', 'master.key']) expect(serialized).not.toContain(field)
}
async function failure(promise: Promise<unknown>, status: number, code?: string): Promise<RemoteManagementError> {
  let thrown: unknown
  try { await promise } catch (error) { thrown = error }
  expect(thrown).toBeInstanceOf(RemoteManagementError)
  expect((thrown as RemoteManagementError).status).toBe(status)
  if (code) expect((thrown as RemoteManagementError).code).toBe(code)
  expect((thrown as Error).message).not.toContain(PASSWORD)
  return thrown as RemoteManagementError
}
afterEach(async () => {
  faults.failRename = false
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('managed remote store CRUD and CAS', () => {
  it('initializes lazily, permits empty environments, and publishes no private material', async () => {
    const { store, directory } = await fixture()
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.view()).toEqual({ revision: 0, environments: [] })
    const view = await store.createEnvironment({ revision: 0, name: ' 验收 ', aliases: ['亚太'], production: true })
    expect(view.revision).toBe(1)
    expect(view.environments[0]).toMatchObject({ name: '验收', aliases: ['亚太'], production: true, hosts: [] })
    expect(view.environments[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
    noSecrets(view)
  })

  it('creates, updates and deletes environments while keeping public revisions monotonic', async () => {
    const { store } = await fixture()
    let view = await store.createEnvironment({ revision: 0, name: '开发' })
    const id = view.environments[0]!.id
    view = await store.updateEnvironment(id, { revision: 1, name: '生产', aliases: ['线上'], production: true })
    expect(view).toEqual({ revision: 2, environments: [{ id, name: '生产', aliases: ['线上'], production: true, hosts: [] }] })
    view.environments[0]!.aliases.push('external mutation')
    expect((await store.view()).environments[0]!.aliases).toEqual(['线上'])
    expect(await store.deleteEnvironment(id, 2)).toEqual({ revision: 3, environments: [] })
    await failure(store.deleteEnvironment(id, 3), 404, 'environment_not_found')
  })

  it('creates password hosts, retains an opaque password across restart, and never returns it through CRUD', async () => {
    const { store, directory, view, environmentId, hostId } = await populated()
    const host = view.environments[0]!.hosts[0]!
    expect(host).toMatchObject({ id: hostId, name: '诊断节点', port: 22, username: 'diagnostic', auth: 'password',
      hasPassword: true, hostKeyFingerprint: null, projects: [{ id: 'community', directory: '/srv/community' }] })
    noSecrets(view)
    noSecrets(await store.view())
    const reopened = new ManagedStore(directory)
    expect(await reopened.credentials(environmentId, hostId, view.revision)).toEqual({ revision: view.revision, host, password: PASSWORD })
    const renamed = await reopened.updateEnvironment(environmentId, { revision: view.revision, name: '集成', aliases: ['开发集成'] })
    noSecrets(renamed)
    expect((await reopened.credentials(environmentId, hostId, renamed.revision)).password).toBe(PASSWORD)
  })

  it('requires a nonempty password at creation and rejects invalid input without reflecting secrets', async () => {
    const { store } = await fixture()
    const view = await store.createEnvironment({ revision: 0, name: '开发' })
    const id = view.environments[0]!.id
    for (const password of [undefined, '']) {
      await failure(store.createHost(id, hostInput(view.revision, { password })), 400, 'password_required')
    }
    for (const overrides of [{ password: `${PASSWORD}\u0000` }, { password: 'x'.repeat(4097) }, { host: PASSWORD },
      { username: PASSWORD }, { port: 0 }, { projects: [{ id: 'a', directory: 'relative' }] }, { command: PASSWORD }]) {
      const error = await failure(store.createHost(id, hostInput(view.revision, overrides)), 400, 'invalid_input')
      expect(error.message).toBe('Invalid remote management input.')
    }
    expect(await store.view()).toEqual(view)
    await failure(store.createEnvironment({ revision: 1, name: 'x', password: PASSWORD } as any), 400, 'invalid_input')
    await failure(store.createEnvironment({ revision: -1, name: 'x' }), 400, 'invalid_input')
  })

  it('keeps password on omitted/empty edits and accepts replacement without trimming or shell evaluation', async () => {
    const { store, environmentId, hostId, view } = await populated()
    let current = view
    for (const password of [undefined, '']) {
      current = await store.updateHost(environmentId, hostId, hostInput(current.revision, { name: '改名', password }))
      noSecrets(current)
      expect((await store.credentials(environmentId, hostId, current.revision)).password).toBe(PASSWORD)
    }
    const replacement = '  replacement\n secret \ud800  '
    current = await store.updateHost(environmentId, hostId, hostInput(current.revision, { password: replacement }))
    expect((await store.credentials(environmentId, hostId, current.revision)).password).toBe(replacement)
    expect(JSON.stringify(current)).not.toContain(replacement)
  })

  it('supports the entire allowed opaque password length including JSON-escaped characters', async () => {
    const opaque = '\u0001'.repeat(4096)
    const { store, environmentId, hostId, view } = await populated({ password: opaque })
    expect((await store.credentials(environmentId, hostId, view.revision)).password).toBe(opaque)
  })

  it('keeps the host-key pin for name/username/password/project edits but clears it for address or port changes', async () => {
    const { store, environmentId, hostId, view } = await populated()
    let current = await store.trustHost(environmentId, hostId, view.revision, FINGERPRINT)
    noSecrets(current)
    current = await store.updateHost(environmentId, hostId, hostInput(current.revision, { username: 'other', name: '改名', password: 'new-fixture', projects: [] }))
    expect(current.environments[0]!.hosts[0]!.hostKeyFingerprint).toBe(FINGERPRINT)
    current = await store.updateHost(environmentId, hostId, hostInput(current.revision, { host: 'other.example.invalid', password: '' }))
    expect(current.environments[0]!.hosts[0]!.hostKeyFingerprint).toBeNull()
    current = await store.trustHost(environmentId, hostId, current.revision, FINGERPRINT)
    current = await store.updateHost(environmentId, hostId, hostInput(current.revision, { host: 'other.example.invalid', port: 2222, password: '' }))
    expect(current.environments[0]!.hosts[0]!.hostKeyFingerprint).toBeNull()
    await failure(store.trustHost(environmentId, hostId, current.revision, PASSWORD), 400, 'invalid_input')
  })

  it('deletes host ciphertext and cascades environment deletion without retaining plaintext or orphan credentials', async () => {
    const { store, statePath, environmentId, hostId, view } = await populated()
    const before = await stored(statePath)
    const ciphertext = before.environments[0].hosts[0].secret.ciphertext
    const removed = await store.deleteHost(environmentId, hostId, view.revision)
    expect(removed.environments[0]!.hosts).toEqual([])
    expect(await readFile(statePath, 'utf8')).not.toContain(ciphertext)
    await failure(store.credentials(environmentId, hostId, removed.revision), 404, 'host_not_found')
    const recreated = await store.createHost(environmentId, hostInput(removed.revision))
    const newCiphertext = (await stored(statePath)).environments[0].hosts[0].secret.ciphertext
    noSecrets(await store.deleteEnvironment(environmentId, recreated.revision))
    expect(await readFile(statePath, 'utf8')).not.toContain(newCiphertext)
  })

  it('enforces normalized environment selection names across aliases and IDs without restricting arbitrary Chinese environments', async () => {
    const { store } = await fixture()
    let view = await store.createEnvironment({ revision: 0, name: '研发', aliases: ['ＤＥＶ'] })
    const id = view.environments[0]!.id
    for (const input of [{ name: ' dev ' }, { name: '其他', aliases: ['研发'] }, { name: '测试', aliases: ['test', 'ＴＥＳＴ'] },
      { name: '测试', aliases: ['测试'] }, { name: id }]) {
      await failure(store.createEnvironment({ revision: view.revision, ...input }), 400, 'duplicate_environment')
    }
    expect(await store.view()).toEqual(view)
    view = await store.createEnvironment({ revision: view.revision, name: '任意环境', aliases: ['亚太验收'] })
    await failure(store.updateEnvironment(view.environments[1]!.id,
      { revision: view.revision, name: '验收', aliases: ['ｄｅｖ'] }), 400, 'duplicate_environment')
    expect((await store.view()).environments[1]!.name).toBe('任意环境')
  })

  it('enforces normalized project ids per host while allowing the same project on other hosts', async () => {
    const { store, environmentId, view } = await populated()
    const duplicate = [{ id: 'app', directory: '/srv/app' }, { id: ' ＡＰＰ ', directory: '/srv/other' }]
    await failure(store.createHost(environmentId, hostInput(view.revision, { projects: duplicate })), 400, 'duplicate_project')
    const second = await store.createHost(environmentId, hostInput(view.revision, { name: 'second' }))
    expect(second.environments[0]!.hosts).toHaveLength(2)
    expect(new Set(second.environments[0]!.hosts.map(host => host.id)).size).toBe(2)
  })

  it('serializes writes, rejects stale CAS, keeps the queue usable after failures and checks credentials revisions', async () => {
    const { store } = await fixture()
    const results = await Promise.allSettled([
      store.createEnvironment({ revision: 0, name: 'first' }), store.createEnvironment({ revision: 0, name: 'second' }),
    ])
    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'revision_conflict' } })
    const view = await store.view()
    expect(view.revision).toBe(1)
    expect(view.environments).toHaveLength(1)
    const id = view.environments[0]!.id
    const created = await store.createHost(id, hostInput(view.revision))
    const hostId = created.environments[0]!.hosts[0]!.id
    const edits = [
      store.updateEnvironment(id, { revision: 1, name: 'stale' }), store.deleteEnvironment(id, 1),
      store.createHost(id, hostInput(1)), store.updateHost(id, hostId, hostInput(1)), store.deleteHost(id, hostId, 1),
      store.trustHost(id, hostId, 1, FINGERPRINT), store.credentials(id, hostId, 1),
    ]
    for (const promise of edits) await failure(promise, 409, 'revision_conflict')
    expect((await store.credentials(id, hostId, created.revision)).password).toBe(PASSWORD)
    expect(await store.view()).toEqual(created)
  })

  it('uses fixed not-found failures and never leaks endpoint/password contents through validation errors', async () => {
    const { store, environmentId, hostId, view } = await populated()
    for (const promise of [store.updateEnvironment('unknown', { revision: view.revision, name: 'new' }),
      store.createHost('unknown', hostInput(view.revision)), store.credentials('unknown', hostId, view.revision)]) {
      await failure(promise, 404, 'environment_not_found')
    }
    for (const promise of [store.updateHost(environmentId, 'unknown', hostInput(view.revision)),
      store.deleteHost(environmentId, 'unknown', view.revision), store.trustHost(environmentId, 'unknown', view.revision, FINGERPRINT),
      store.credentials(environmentId, 'unknown', view.revision)]) await failure(promise, 404, 'host_not_found')
  })
})

describe('managed remote store encrypted private persistence', () => {
  it('creates 0700/0600 files, stores only authenticated ciphertext and uses atomic state replacement', async () => {
    const { store, directory, keyPath, statePath, view, environmentId, hostId } = await populated()
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
    expect((await lstat(keyPath)).mode & 0o777).toBe(0o600)
    expect((await lstat(statePath)).mode & 0o777).toBe(0o600)
    const key = await readFile(keyPath)
    expect(key).toHaveLength(32)
    const raw = await readFile(statePath, 'utf8')
    expect(raw).not.toContain(PASSWORD)
    expect(raw).not.toContain(JSON.stringify(PASSWORD))
    const state = JSON.parse(raw)
    const host = state.environments[0].hosts[0]
    const secret = host.secret
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'))
    decipher.setAAD(Buffer.from(hostId)); decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64')), decipher.final()])
    expect(JSON.parse(plaintext.toString('utf8'))).toBe(PASSWORD)
    const previous = await lstat(statePath)
    const previousKey = Buffer.from(key)
    const updated = await store.updateHost(environmentId, hostId, hostInput(view.revision, { password: '' }))
    expect((await lstat(statePath)).ino).not.toBe(previous.ino)
    expect((await lstat(statePath)).mode & 0o777).toBe(0o600)
    expect(await readFile(keyPath)).toEqual(previousKey)
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['master.key', 'state.json']))
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
    noSecrets(updated)
  })

  it('preserves the complete previous snapshot and cleans private temporaries when atomic publication fails', async () => {
    const { store, directory, statePath, environmentId, hostId, view } = await populated()
    const before = await readFile(statePath)
    faults.failRename = true
    await failure(store.updateHost(environmentId, hostId, hostInput(view.revision, { password: 'replacement-fixture' })),
      500, 'storage_unavailable')
    faults.failRename = false
    expect(await readFile(statePath)).toEqual(before)
    expect(await store.view()).toEqual(view)
    expect((await store.credentials(environmentId, hostId, view.revision)).password).toBe(PASSWORD)
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
    const updated = await store.updateHost(environmentId, hostId, hostInput(view.revision, { password: 'replacement-fixture' }))
    expect(updated.revision).toBe(view.revision + 1)
  })

  it('uses fresh IVs even for identical replacements and rejects ciphertext replay under another host UUID', async () => {
    const { store, directory, statePath, environmentId, hostId, view } = await populated()
    const first = await stored(statePath)
    const updated = await store.updateHost(environmentId, hostId, hostInput(view.revision))
    const second = await stored(statePath)
    expect(first.environments[0].hosts[0].secret.iv).not.toBe(second.environments[0].hosts[0].secret.iv)
    expect(first.environments[0].hosts[0].secret.ciphertext).not.toBe(second.environments[0].hosts[0].secret.ciphertext)
    await store.createHost(environmentId, hostInput(updated.revision, { name: 'second' }))
    const replay = await stored(statePath)
    replay.environments[0].hosts[1].secret = replay.environments[0].hosts[0].secret
    await rewrite(statePath, replay)
    await failure(new ManagedStore(directory).view(), 500, 'storage_unavailable')
    await failure(store.credentials(environmentId, hostId, updated.revision + 1), 500, 'storage_unavailable')
  })

  it('fails closed when a populated state loses its key and never regenerates or overwrites the state', async () => {
    const { store, directory, statePath, keyPath } = await populated()
    const before = await readFile(statePath)
    await unlink(keyPath)
    await failure(store.view(), 500, 'storage_unavailable')
    await failure(new ManagedStore(directory).view(), 500, 'storage_unavailable')
    expect(await readFile(statePath)).toEqual(before)
    await expect(lstat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('also fails closed when existing key material loses its state instead of resetting revisions', async () => {
    const { store, statePath, keyPath } = await populated()
    const before = await readFile(keyPath)
    await unlink(statePath)
    await failure(store.view(), 500, 'storage_unavailable')
    expect(await readFile(keyPath)).toEqual(before)
    await expect(lstat(statePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects corrupted key/state/ciphertext without returning crypto or parser internals', async () => {
    const { store, statePath, keyPath } = await populated()
    const key = await readFile(keyPath)
    const state = await readFile(statePath)
    const original = JSON.parse(state.toString('utf8'))
    const attempts: (() => Promise<unknown>)[] = [
      () => writeFile(keyPath, Buffer.alloc(31)),
      () => writeFile(keyPath, randomBytes(32)),
      () => writeFile(statePath, '{'),
      () => writeFile(statePath, Buffer.from([0xff])),
      () => rewrite(statePath, { ...original, version: 9 }),
      () => rewrite(statePath, { ...original, password: PASSWORD }),
      async () => { const value = structuredClone(original); value.environments[0].hosts[0].secret.tag = randomBytes(16).toString('base64'); await rewrite(statePath, value) },
      async () => { const value = structuredClone(original); value.environments[0].hosts[0].secret.ciphertext = 'not base64'; await rewrite(statePath, value) },
      async () => { const value = structuredClone(original); value.environments[0].aliases.push('开发'); await rewrite(statePath, value) },
      async () => { const value = structuredClone(original); value.environments[0].hosts.push(structuredClone(value.environments[0].hosts[0])); await rewrite(statePath, value) },
    ]
    for (const tamper of attempts) {
      await writeFile(keyPath, key); await writeFile(statePath, state)
      await tamper()
      const error = await failure(store.view(), 500, 'storage_unavailable')
      expect(error.message).toBe('Remote management storage is unavailable. Restore the private state and key from backup.')
      expect(error).not.toHaveProperty('cause')
    }
    await writeFile(keyPath, key); await writeFile(statePath, state)
    expect((await store.view()).revision).toBe(original.revision)
  })

  it('rejects oversized state files before reading them as JSON', async () => {
    const { store, statePath } = await populated()
    await writeFile(statePath, ' '.repeat(16 * 1024 * 1024 + 1))
    await failure(store.view(), 500, 'storage_unavailable')
  })

  it('refuses permissive directory/key/state modes without silently changing or deleting them', async () => {
    for (const target of ['directory', 'keyPath', 'statePath'] as const) {
      const value = await populated()
      await chmod(value[target], target === 'directory' ? 0o755 : 0o644)
      await failure(value.store.view(), 500, 'storage_unavailable')
      expect((await lstat(value[target])).mode & 0o777).toBe(target === 'directory' ? 0o755 : 0o644)
      await chmod(value[target], target === 'directory' ? 0o700 : 0o600)
    }
  })

  it('refuses final-directory/key/state symlinks, hardlinked secrets and non-regular files', async () => {
    const initial = await populated()
    const alias = join(initial.root, 'alias')
    await symlink(initial.directory, alias, 'dir')
    await failure(new ManagedStore(alias).view(), 500, 'storage_unavailable')
    for (const name of ['master.key', 'state.json']) {
      const value = await populated()
      const path = join(value.directory, name)
      const real = join(value.root, 'saved')
      await rename(path, real); await symlink(real, path)
      await failure(value.store.view(), 500, 'storage_unavailable')
      expect((await lstat(path)).isSymbolicLink()).toBe(true)
      await unlink(path); await mkdir(path, { mode: 0o700 })
      await failure(value.store.view(), 500, 'storage_unavailable')
    }
    const hardlinked = await populated()
    await link(hardlinked.keyPath, join(hardlinked.root, 'extra-key'))
    await failure(hardlinked.store.view(), 500, 'storage_unavailable')
  })

  it('never touches unrelated public files when an unsafe preexisting vault is encountered', async () => {
    const { root, directory, store } = await fixture()
    await mkdir(directory, { mode: 0o700 })
    const outside = join(root, 'outside')
    await writeFile(outside, 'do not overwrite', { mode: 0o600 })
    await symlink(outside, join(directory, 'master.key'))
    await failure(store.createEnvironment({ revision: 0, name: '开发' }), 500, 'storage_unavailable')
    expect(await readFile(outside, 'utf8')).toBe('do not overwrite')
    await expect(lstat(join(directory, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
