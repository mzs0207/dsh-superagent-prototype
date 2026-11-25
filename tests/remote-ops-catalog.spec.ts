import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ManagedRemoteOps } from '../src/remote-ops/managed.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-catalog-'))
  directories.push(directory)
  return new ManagedRemoteOps(directory)
}

it('projects are linked by stable IDs; common metadata is visible but credential actions stay scoped', async () => {
  const remote = await setup(), { store } = remote
  let view = await store.view()
  const common = view.environments.find(env => env.shared)!
  expect(common).toMatchObject({ name: '公用环境', production: false })
  await expect(store.deleteEnvironment(common.id, view.revision)).rejects.toMatchObject({ code: 'shared_environment' })
  view = await store.createEnvironment({ revision: view.revision, name: 'Production', production: true })
  const prod = view.environments.find(env => env.production)!.id
  view = await store.saveCatalog(common.id, undefined, { revision: view.revision, type: 'project', name: 'Frontend', localPath: '/work/frontend', repository: 'git@example.invalid:org/frontend.git' })
  const frontend = view.environments.find(env => env.shared)!.catalog![0]!.id
  view = await store.saveCatalog(prod, undefined, { revision: view.revision, type: 'project', name: 'API', localPath: '/work/api', repository: 'https://example.invalid/org/api.git' })
  const api = view.environments.find(env => env.id === prod)!.catalog![0]!.id
  view = await store.saveCatalog(prod, undefined, { revision: view.revision, type: 'project-relationship', name: 'API dependency', source: api, target: frontend, description: 'Shares schema' })
  await expect(store.deleteCatalog(common.id, frontend, view.revision)).rejects.toMatchObject({ code: 'project_referenced' })
  expect(await remote.findResources({ environment: prod, resource: frontend })).toMatchObject({ resources: [{ id: frontend, environment: '公用环境' }] })
  view = await store.saveResource(common.id, undefined, { revision: view.revision, name: 'DB', type: 'postgresql', host: 'db.example.invalid', database: 'app', username: 'readonly', password: 'test-secret' })
  const database = view.environments.find(env => env.shared)!.resources![0]!.id
  await expect(remote.check({ environment: prod, resource: database, action: 'database' }, new AbortController().signal, false)).rejects.toMatchObject({ code: 'resource_not_found' })
})

it('transfers references and metadata without carrying credentials, fingerprint trust or model consent', async () => {
  const { store: source } = await setup(), { store: target } = await setup()
  let view = await source.view()
  const shared = view.environments.find(env => env.shared)!.id
  view = await source.saveCatalog(shared, undefined, { revision: view.revision, type: 'project', name: 'Service', localPath: '/work/service', repository: 'https://example.invalid/repo.git', model: { provider: 'test', model: 'model' } })
  view = await source.saveCatalog(shared, undefined, { revision: view.revision, type: 'person', name: 'Operator', position: 'Developer', responsibility: 'Orders' })
  view = await source.saveCatalog(shared, undefined, { revision: view.revision, type: 'team', name: 'Development', members: [{ name: 'Operator', email: 'operator@example.invalid' }] })
  view = await source.createHost(shared, { revision: view.revision, host: 'host.example.invalid', name: 'Host', username: 'user', password: 'never-export-password' })
  const host = view.environments.find(env => env.shared)!.hosts[0]!.id
  await source.trustHost(shared, host, view.revision, `SHA256:${'A'.repeat(43)}`)
  const bundle = await source.exportCatalog()
  expect(JSON.stringify(bundle)).not.toMatch(/never-export-password|hostKeyFingerprint|hasPassword|ciphertext|scanEnabled|provider/)
  const preview = await target.previewImport(bundle)
  expect(preview.passwords).toEqual([{ id: host, name: 'Host', environment: '公用环境' }])
  await expect(target.importCatalog(bundle, preview.revision, {})).rejects.toMatchObject({ code: 'password_required' })
  expect((await target.view()).revision).toBe(preview.revision)
  const imported = await target.importCatalog(bundle, preview.revision, { [host]: 'new-secret' })
  const common = imported.environments.find(env => env.shared)!
  expect(common.hosts[0]).toMatchObject({ id: host, hostKeyFingerprint: null })
  expect(common.catalog).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'project', scanEnabled: false }), expect.objectContaining({ type: 'person' }), expect.objectContaining({ type: 'team' })]))
  expect((await target.previewImport(bundle)).passwords).toEqual([])
  await expect(target.importCatalog(bundle, preview.revision, {})).rejects.toMatchObject({ code: 'revision_conflict' })
})
