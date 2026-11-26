import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ssh2 from 'ssh2'
import { z } from 'zod'
import { normalizeName } from './inventory.ts'
import {
  EnvironmentWriteSchema, FingerprintSchema, HostAuthSchema, HostWriteSchema, PostgresResourceSchema,
  PrivateKeySecretSchema, RemoteManagementError, ResourceWriteSchema, RevisionSchema, WebsiteResourceSchema, type EnvironmentWrite,
  RecordTransferSchema, type RecordTransfer,
  type HostCredentials, type HostWrite, type ManagedHost, type ManagedResource, type ManagedView, type PrivateKeySecret, type ResourceWrite,
} from './managed-types.ts'
import { MAX_PRIVATE_KEY_LENGTH } from './api.ts'
import { CatalogWriteSchema, SHARED_ENVIRONMENT, StoredCatalogSchema, type CatalogResource, type CatalogWrite,
  type StoredCatalog, type StoredProject } from './catalog-types.ts'
import { repositoryMarkdown, RepositorySnapshotSchema, type RepositorySnapshot } from './repository.ts'
import { ImportPasswordsSchema, ImportPrivateKeysSchema, planImport, PortableBundleSchema,
  type ImportPreview, type PortableBundle, type PortableEnvironment } from './portable.ts'

const MAX_STATE_BYTES = 16 * 1024 * 1024
const MAX_RECORDS_PER_TYPE = 1000
const PERMISSION_BITS = 0o7777
const PasswordSchema = HostWriteSchema.shape.password.unwrap().refine(value => value.length > 0)
const MAX_CREDENTIAL_JSON_BYTES = (MAX_PRIVATE_KEY_LENGTH + 4096) * 6 + 64
const Base64Schema = z.string().min(1).max(4 * Math.ceil(MAX_CREDENTIAL_JSON_BYTES / 3))
  .refine(value => Buffer.from(value, 'base64').toString('base64') === value)
const SecretSchema = z.object({
  iv: Base64Schema.refine(value => Buffer.from(value, 'base64').length === 12),
  tag: Base64Schema.refine(value => Buffer.from(value, 'base64').length === 16),
  ciphertext: Base64Schema.refine(value => Buffer.from(value, 'base64').length <= MAX_CREDENTIAL_JSON_BYTES),
}).strict()
const StoredHostSchema = HostWriteSchema.omit({ revision: true, password: true, privateKey: true, passphrase: true }).extend({
  id: z.string().uuid(), auth: HostAuthSchema, hostKeyFingerprint: FingerprintSchema.nullable(), secret: SecretSchema,
}).strict()
const resourceSecret = { id: z.uuid(), secret: SecretSchema }
const StoredResourceSchema = z.union([
  PostgresResourceSchema.extend(resourceSecret),
  // Old vaults may still have these fields. Ignore them on read and omit them on the next save.
  WebsiteResourceSchema.safeExtend({ ...resourceSecret, role: z.unknown().optional(), apiPaths: z.unknown().optional(),
    webPaths: z.unknown().optional() }).transform(({ role: _, apiPaths: _api, webPaths: _web, ...resource }) => resource),
])
const StoredEnvironmentSchema = EnvironmentWriteSchema.omit({ revision: true }).extend({
  id: z.string().uuid(), hosts: z.array(StoredHostSchema).max(MAX_RECORDS_PER_TYPE),
  resources: z.array(StoredResourceSchema).max(MAX_RECORDS_PER_TYPE).default([]),
  catalog: z.array(StoredCatalogSchema).max(MAX_RECORDS_PER_TYPE).default([]),
}).strict()
const StateSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]), revision: RevisionSchema, environments: z.array(StoredEnvironmentSchema).max(1001),
}).strict()
type State = z.infer<typeof StateSchema>
type StoredHost = z.infer<typeof StoredHostSchema>
type StoredResource = z.infer<typeof StoredResourceSchema>
type Secret = z.infer<typeof SecretSchema>

const unavailable = () => new RemoteManagementError(500, 'storage_unavailable',
  'Remote management storage is unavailable. Restore the private state and key from backup.')
const invalid = () => new RemoteManagementError(400, 'invalid_input', 'Invalid remote management input.')
function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw invalid()
  return parsed.data
}
function assertRevision(state: State, revision: number): void {
  if (state.revision !== revision) throw new RemoteManagementError(409, 'revision_conflict',
    'Remote management configuration changed. Reload before saving.')
}
function findEnvironment(state: State, id: string) {
  const environment = state.environments.find(value => value.id === id)
  if (!environment) throw new RemoteManagementError(404, 'environment_not_found', 'Remote environment was not found.')
  return environment
}
function findHost(state: State, environmentId: string, hostId: string): StoredHost {
  const host = findEnvironment(state, environmentId).hosts.find(value => value.id === hostId)
  if (!host) throw new RemoteManagementError(404, 'host_not_found', 'Remote host was not found.')
  return host
}
function assertCollections({ environments }: { environments: (Omit<PortableEnvironment, 'hosts'> & { hosts: Pick<StoredHost, 'id' | 'projects'>[] })[] }): void {
  const environmentNames = new Set<string>()
  const resourceIds = new Set<string>()
  const projectIds = new Set<string>()
  const relations: Extract<StoredCatalog, { type: 'project-relationship' }>[] = []
  for (const environment of environments) {
    if (environment.id === SHARED_ENVIRONMENT && (environment.production || environment.aliases.length)) throw invalid()
    // IDs share the selection namespace with names/aliases in the diagnostic inventory.
    for (const name of [environment.id, environment.name, ...environment.aliases]) {
      const normalized = normalizeName(name)
      if (environmentNames.has(normalized)) throw new RemoteManagementError(400, 'duplicate_environment',
        'Environment names and aliases must be unique.')
      environmentNames.add(normalized)
    }
    for (const resource of [...environment.resources, ...environment.catalog]) {
      if (resourceIds.has(resource.id)) throw invalid()
      resourceIds.add(resource.id)
      if (resource.type === 'project') projectIds.add(resource.id)
      else if (resource.type === 'project-relationship') relations.push(resource)
    }
    for (const host of environment.hosts) {
      const hostId = normalizeName(host.id)
      if (resourceIds.has(hostId)) throw invalid()
      resourceIds.add(hostId)
      const projects = new Set<string>()
      for (const project of host.projects) {
        const id = normalizeName(project.id)
        if (projects.has(id)) throw new RemoteManagementError(400, 'duplicate_project', 'Project identifiers must be unique on each host.')
        projects.add(id)
      }
    }
  }
  for (const relation of relations) {
    if (relation.source === relation.target || !projectIds.has(relation.source) || !projectIds.has(relation.target)) {
      throw new RemoteManagementError(400, 'project_referenced', 'Relationships must link two different existing projects. Remove a project’s relationships before deleting it.')
    }
  }
}
function hostView(host: StoredHost): ManagedHost {
  return { id: host.id, type: 'linux-host', notes: host.notes, name: host.name, host: host.host, port: host.port, username: host.username,
    auth: host.auth, hasPassword: host.auth === 'password', hostKeyFingerprint: host.hostKeyFingerprint, projects: structuredClone(host.projects) }
}
function resourceView({ secret: _, ...resource }: StoredResource): ManagedResource {
  return { ...resource, hasPassword: true }
}
function catalogView(item: StoredCatalog): CatalogResource {
  if (item.type !== 'project') return item
  const { snapshot, refreshRequired: _, ...fields } = item
  return { ...fields, ...(snapshot && { commit: snapshot.commit }) }
}

function ensureShared(state: State): void {
  if (state.environments.some(env => env.id === SHARED_ENVIRONMENT)) return
  const taken = new Set(state.environments.flatMap(env => [env.name, ...env.aliases]).map(normalizeName))
  let name = '公用环境'
  for (let number = 1; taken.has(normalizeName(name)); number++) name = `公用环境（内置 ${number}）`
  state.environments.push({ id: SHARED_ENVIRONMENT, name, aliases: [], production: false, hosts: [], resources: [], catalog: [] })
}

function portableView(state: State): PortableBundle {
  return { format: 'dsh-environment-resources', version: 1, environments: state.environments.map(({ hosts, resources, catalog, ...environment }) => ({
    ...environment,
    hosts: hosts.map(({ secret: _, auth, hostKeyFingerprint: _trust, ...host }) =>
      auth === 'private-key' ? { ...host, auth } : host),
    resources: resources.map(({ secret: _, allowWorker: _worker, ...resource }) => {
      if (resource.type === 'postgresql') return resource
      const { communityTermsAccepted: _terms, ...fields } = resource
      return fields
    }),
    catalog: catalog.map(item => {
      if (item.type !== 'project') return item
      const { model: _model, scanEnabled: _scan, refreshRequired: _refresh, ...fields } = item
      return fields
    }),
  })) }
}

function sameProject(before: StoredProject, after: Pick<StoredProject, 'localPath' | 'repository' | 'model'>): boolean {
  return before.localPath === after.localPath && before.repository === after.repository
    && before.model?.provider === after.model?.provider && before.model?.model === after.model?.model
}

function findProject(state: State, environment: string, id: string): StoredProject {
  const project = findEnvironment(state, environment).catalog.find(item => item.id === id)
  if (project?.type !== 'project') throw new RemoteManagementError(404, 'project_not_found', 'Repository project was not found.')
  return project
}
function viewOf(state: State): ManagedView {
  return { revision: state.revision, environments: state.environments.map(environment => ({
    id: environment.id, name: environment.name, aliases: [...environment.aliases], production: environment.production,
    hosts: environment.hosts.map(hostView),
    ...(environment.id === SHARED_ENVIRONMENT ? { shared: true as const } : {}),
    ...(environment.resources.length ? { resources: environment.resources.map(resourceView) } : {}),
    ...(environment.catalog.length ? { catalog: environment.catalog.map(catalogView) } : {}),
  })) }
}
function encrypt(key: Buffer, hostId: string, secret: string | PrivateKeySecret): Secret {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(hostId, 'utf8'))
  // JSON preserves even opaque passwords containing unpaired UTF-16 surrogates.
  const plaintext = Buffer.from(JSON.stringify(secret), 'utf8')
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
  } finally { plaintext.fill(0) }
}
function decrypt<T>(key: Buffer, host: { id: string; secret: Secret }, schema: z.ZodType<T>): T {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(host.secret.iv, 'base64'))
  decipher.setAAD(Buffer.from(host.id, 'utf8'))
  decipher.setAuthTag(Buffer.from(host.secret.tag, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(host.secret.ciphertext, 'base64')), decipher.final()])
  try {
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    const parsed = schema.safeParse(decoded)
    if (!parsed.success) throw unavailable()
    return parsed.data
  } finally { plaintext.fill(0) }
}

function decryptHost(key: Buffer, host: StoredHost) {
  return host.auth === 'password' ? decrypt(key, host, PasswordSchema) : decrypt(key, host, PrivateKeySecretSchema)
}

function validatePrivateKey(secret: PrivateKeySecret): PrivateKeySecret {
  try {
    const key = ssh2.utils.parseKey(secret.privateKey, secret.passphrase || undefined)
    if (!(key instanceof Error) && !Array.isArray(key) && key.isPrivateKey()) return secret
  } catch { /* SSH parser errors may contain credential details. */ }
  throw new RemoteManagementError(400, 'invalid_private_key', 'Invalid SSH private key or passphrase.')
}

function submittedHostSecret(auth: ManagedHost['auth'], { password, privateKey, passphrase }: HostWrite, required: boolean) {
  if (auth === 'password') {
    if (privateKey || passphrase) throw invalid()
    if (!password && required) throw new RemoteManagementError(400, 'password_required', 'Enter an SSH password.')
    return password || undefined
  }
  if (password) throw invalid()
  if (privateKey) return validatePrivateKey({ privateKey, passphrase })
  if (required || passphrase) throw new RemoteManagementError(400, 'private_key_required', 'Enter an SSH private key.')
  return undefined
}
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Private lazy password vault. Runtime owns the enclosing stateDir process lock. */
export class ManagedStore {
  readonly #directory: string
  #queue: Promise<void> = Promise.resolve()
  #closed = false

  constructor(directory: string) { this.#directory = resolve(directory) }

  view(): Promise<ManagedView> { return this.#execute(async state => viewOf(state)) }

  createEnvironment(input: EnvironmentWrite): Promise<ManagedView> {
    return this.#execute(async state => {
      const parsed = parseInput(EnvironmentWriteSchema, input)
      assertRevision(state, parsed.revision)
      const { revision: _, ...fields } = parsed
      state.environments.splice(state.environments.findIndex(env => env.id === SHARED_ENVIRONMENT), 0,
        { ...fields, id: randomUUID(), hosts: [], resources: [], catalog: [] })
      return this.#commit(state)
    })
  }

  updateEnvironment(id: string, input: EnvironmentWrite): Promise<ManagedView> {
    return this.#execute(async state => {
      const parsed = parseInput(EnvironmentWriteSchema, input)
      assertRevision(state, parsed.revision)
      if (id === SHARED_ENVIRONMENT) throw new RemoteManagementError(400, 'shared_environment', 'The built-in shared environment cannot be renamed or changed.')
      const environment = findEnvironment(state, id)
      const { revision: _, ...fields } = parsed
      Object.assign(environment, fields)
      return this.#commit(state)
    })
  }

  deleteEnvironment(id: string, revision: number): Promise<ManagedView> {
    return this.#execute(async state => {
      assertRevision(state, parseInput(RevisionSchema, revision))
      if (id === SHARED_ENVIRONMENT) throw new RemoteManagementError(400, 'shared_environment', 'The built-in shared environment cannot be deleted.')
      const environment = findEnvironment(state, id)
      state.environments.splice(state.environments.indexOf(environment), 1)
      return this.#commit(state)
    })
  }

  createHost(environmentId: string, input: HostWrite): Promise<ManagedView> {
    return this.#execute(async (state, key) => {
      const parsed = parseInput(HostWriteSchema, input)
      assertRevision(state, parsed.revision)
      const environment = findEnvironment(state, environmentId)
      const { revision: _, auth = 'password', password, privateKey, passphrase, ...fields } = parsed
      const secret = submittedHostSecret(auth, parsed, true)!
      const id = randomUUID()
      environment.hosts.push({ ...fields, id, auth, hostKeyFingerprint: null, secret: encrypt(key, id, secret) })
      return this.#commit(state)
    })
  }

  updateHost(environmentId: string, hostId: string, input: HostWrite): Promise<ManagedView> {
    return this.#execute(async (state, key) => {
      const parsed = parseInput(HostWriteSchema, input)
      assertRevision(state, parsed.revision)
      const host = findHost(state, environmentId, hostId)
      const { revision: _, auth = host.auth, password, privateKey, passphrase, ...fields } = parsed
      const secret = submittedHostSecret(auth, parsed, auth !== host.auth)
      // Endpoint identity changes require a new independently verified host-key pin.
      if (host.host !== fields.host || host.port !== fields.port) host.hostKeyFingerprint = null
      Object.assign(host, fields, { auth })
      if (secret !== undefined) host.secret = encrypt(key, host.id, secret)
      return this.#commit(state)
    })
  }

  deleteHost(environmentId: string, hostId: string, revision: number): Promise<ManagedView> {
    return this.#execute(async state => {
      assertRevision(state, parseInput(RevisionSchema, revision))
      const environment = findEnvironment(state, environmentId)
      const host = findHost(state, environmentId, hostId)
      environment.hosts.splice(environment.hosts.indexOf(host), 1)
      return this.#commit(state)
    })
  }

  saveResource(environmentId: string, id: string | undefined, input: ResourceWrite): Promise<ManagedView> {
    return this.#execute(async (state, key) => {
      const { revision, password, ...submitted } = parseInput(ResourceWriteSchema, input)
      assertRevision(state, revision)
      const { resources } = findEnvironment(state, environmentId)
      const index = id === undefined ? -1 : resources.findIndex(item => item.id === id)
      const previous = resources[index]
      // Omitted on legacy writes: preserve the stored mode on edits, default new records to no TLS.
      const fields = submitted.type === 'postgresql'
        ? { ...submitted, tls: submitted.tls ?? (previous?.type === 'postgresql' && previous.tls) }
        : submitted
      if (id === undefined) {
        if (!password) throw new RemoteManagementError(400, 'password_required', 'A password is required for a new resource.')
        const uid = randomUUID()
        resources.push({ ...fields, id: uid, secret: encrypt(key, uid, password) })
      } else {
        if (!previous) throw new RemoteManagementError(404, 'resource_not_found', 'Environment resource was not found.')
        if (previous.type !== fields.type) throw invalid()
        const changedTarget = fields.username !== previous.username || (fields.type === 'postgresql' && previous.type === 'postgresql'
          ? fields.host !== previous.host || fields.port !== previous.port || fields.database !== previous.database || fields.ca !== previous.ca
          : fields.type === 'website-account' && previous.type === 'website-account'
            && (fields.origin !== previous.origin || fields.system !== previous.system))
        if (changedTarget && !password) throw new RemoteManagementError(400, 'password_required', 'Re-enter the password when changing a login target.')
        resources[index] = { ...fields, id, secret: password ? encrypt(key, id, password) : previous.secret }
      }
      return this.#commit(state)
    })
  }

  deleteResource(environmentId: string, id: string, revision: number): Promise<ManagedView> {
    return this.#execute(async state => {
      assertRevision(state, revision)
      const { resources } = findEnvironment(state, environmentId)
      const index = resources.findIndex(item => item.id === id)
      if (index === -1) throw new RemoteManagementError(404, 'resource_not_found', 'Environment resource was not found.')
      resources.splice(index, 1)
      return this.#commit(state)
    })
  }

  saveCatalog(environmentId: string, id: string | undefined, input: CatalogWrite): Promise<ManagedView> {
    return this.#execute(async state => {
      const { revision, ...fields } = parseInput(CatalogWriteSchema, input)
      assertRevision(state, revision)
      const { catalog } = findEnvironment(state, environmentId)
      const index = id === undefined ? -1 : catalog.findIndex(record => record.id === id)
      const prior = catalog[index]
      if (id !== undefined && !prior) throw new RemoteManagementError(404, 'resource_not_found', 'Environment resource was not found.')
      if (prior && prior.type !== fields.type) throw invalid()
      const recordId = id ?? randomUUID()
      let record: StoredCatalog
      if (fields.type === 'project') {
        const previous = prior?.type === 'project' ? prior : undefined
        const sameRepository = previous && previous.localPath === fields.localPath && previous.repository === fields.repository
        record = { ...fields, id: recordId, scanEnabled: true, snapshot: sameRepository ? previous.snapshot : undefined,
          refreshRequired: !!previous && (previous.refreshRequired || !sameProject(previous, fields)) }
      } else record = { ...fields, id: recordId }
      if (index === -1) catalog.push(record); else catalog[index] = record
      return this.#commit(state)
    })
  }

  deleteCatalog(environmentId: string, id: string, revision: number): Promise<ManagedView> {
    return this.#execute(async state => {
      assertRevision(state, revision)
      const { catalog } = findEnvironment(state, environmentId)
      const index = catalog.findIndex(record => record.id === id)
      if (index === -1) throw new RemoteManagementError(404, 'resource_not_found', 'Environment resource was not found.')
      catalog.splice(index, 1)
      return this.#commit(state)
    })
  }

  transferRecord(sourceId: string, recordId: string, input: RecordTransfer): Promise<ManagedView> {
    return this.#execute(async (state, key) => {
      const { revision, destination, mode } = parseInput(RecordTransferSchema, input)
      assertRevision(state, revision)
      if (sourceId === destination) throw invalid()
      const source = findEnvironment(state, sourceId), target = findEnvironment(state, destination)
      const copy = mode === 'copy'
      const moveOrCopy = <T extends { id: string }>(from: T[], to: T[], prepare: (record: T, id: string) => T) => {
        const index = from.findIndex(item => item.id === recordId)
        if (index === -1) return false
        if (to.length >= MAX_RECORDS_PER_TYPE) {
          throw new RemoteManagementError(400, 'environment_full', 'The destination environment has reached its record limit.')
        }
        to.push(prepare(from[index]!, copy ? randomUUID() : recordId))
        if (!copy) from.splice(index, 1)
        return true
      }
      const transferred = moveOrCopy(source.hosts, target.hosts, (host, id) => copy
        ? { ...host, id, secret: encrypt(key, id, decryptHost(key, host)) } : host)
        || moveOrCopy(source.resources, target.resources, (resource, id) => ({
          ...resource, id, allowWorker: false,
          secret: copy ? encrypt(key, id, decrypt(key, resource, PasswordSchema)) : resource.secret,
        }))
        || moveOrCopy(source.catalog, target.catalog, (record, id) => {
          if (!copy) return record
          if (record.type !== 'project') return { ...record, id }
          const { model: _, ...project } = record
          return { ...project, id, scanEnabled: false, refreshRequired: true }
        })
      if (!transferred) throw new RemoteManagementError(404, 'resource_not_found', 'Environment resource was not found.')
      return this.#commit(state)
    })
  }

  scanTargets() {
    return this.#execute(async state => state.environments.flatMap(env => env.catalog.flatMap(record =>
      record.type === 'project' && record.scanEnabled ? [{ environment: env.id, project: record }] : [])))
  }

  projectScanTarget(environment: string, id: string) {
    return this.#execute(async state => findProject(state, environment, id))
  }

  projectSummary(environment: string, id: string) {
    return this.#execute(async state => {
      const { snapshot } = findProject(state, environment, id)
      return snapshot ? { commit: snapshot.commit, ...repositoryMarkdown(snapshot) } : null
    })
  }

  saveProjectSummary(environment: string, pending: StoredProject, snapshot: RepositorySnapshot): Promise<void> {
    return this.#execute(async state => {
      const project = findProject(state, environment, pending.id)
      if (!project.scanEnabled || !sameProject(project, pending) || project.refreshRequired !== pending.refreshRequired
        || project.snapshot?.commit !== pending.snapshot?.commit) return
      if (!project.refreshRequired && project.snapshot?.commit === snapshot.commit) return
      project.snapshot = RepositorySnapshotSchema.parse(snapshot)
      project.refreshRequired = false
      // A Git refresh is not a configuration edit and must not expire website leases or dirty forms.
      await this.#writeState(state)
    })
  }

  exportCatalog(): Promise<PortableBundle> {
    return this.#execute(async state => portableView(state))
  }

  previewImport(input: unknown): Promise<ImportPreview> {
    return this.#execute(async state => {
      const plan = planImport(portableView(state), parseInput(PortableBundleSchema, input), state.revision)
      assertCollections(plan.bundle)
      return plan.preview
    })
  }

  importCatalog(input: unknown, revision: number, passwords: unknown, privateKeys: unknown = {}): Promise<ManagedView> {
    return this.#execute(async (state, key) => {
      assertRevision(state, parseInput(RevisionSchema, revision))
      const plan = planImport(portableView(state), parseInput(PortableBundleSchema, input), state.revision)
      assertCollections(plan.bundle)
      const secrets = parseInput(ImportPasswordsSchema, passwords)
      if (plan.preview.passwords.some(item => !secrets[item.id])) {
        throw new RemoteManagementError(400, 'password_required', 'Enter a password for every newly imported password-based connection.')
      }
      if (Object.keys(secrets).length !== plan.preview.passwords.length) throw invalid()
      const keys = parseInput(ImportPrivateKeysSchema, privateKeys)
      const keyRequests = plan.preview.privateKeys ?? []
      if (keyRequests.some(item => !keys[item.id])) {
        throw new RemoteManagementError(400, 'private_key_required', 'Enter a private key for every newly imported key-based host.')
      }
      if (Object.keys(keys).length !== keyRequests.length) throw invalid()
      if (!plan.preview.added) return viewOf(state)
      const environments = new Map(state.environments.map(environment => [environment.id, environment]))
      state.environments = plan.bundle.environments.map(({ hosts, resources, catalog, ...env }) => {
        const existing = environments.get(env.id)
        const oldHosts = new Map(existing?.hosts.map(item => [item.id, item]))
        const oldResources = new Map(existing?.resources.map(item => [item.id, item]))
        const oldCatalog = new Map(existing?.catalog.map(item => [item.id, item]))
        return {
          ...env,
          hosts: hosts.map(host => oldHosts.get(host.id) ?? { ...host, auth: host.auth ?? 'password', hostKeyFingerprint: null,
            secret: encrypt(key, host.id, host.auth === 'private-key' ? validatePrivateKey(keys[host.id]!) : secrets[host.id]!) }),
          resources: resources.map(resource => oldResources.get(resource.id) ?? { ...resource, allowWorker: false,
            secret: encrypt(key, resource.id, secrets[resource.id]!) }),
          catalog: catalog.map(record => oldCatalog.get(record.id) ?? (record.type === 'project'
            ? { ...record, scanEnabled: false, refreshRequired: true } : record)),
        }
      })
      return this.#commit(state)
    })
  }

  resourceCredentials(environmentId: string, id: string, expectedRevision: number, worker: boolean) {
    return this.#execute(async (state, key) => {
      assertRevision(state, expectedRevision)
      const environment = findEnvironment(state, environmentId)
      const resource = environment.resources.find(item => item.id === id)
      if (!resource) throw new RemoteManagementError(404, 'resource_not_found', 'Environment resource was not found.')
      if (environment.production || (worker && !resource.allowWorker)) {
        throw new RemoteManagementError(400, 'resource_not_allowed', 'Credential use is not enabled for this environment and session.')
      }
      return { resource: resourceView(resource), password: decrypt(key, resource, PasswordSchema) }
    })
  }

  /** Internal-only: the manager must validate/consume its endpoint-bound challenge first. */
  trustHost(environmentId: string, hostId: string, revision: number, fingerprint: string): Promise<ManagedView> {
    return this.#execute(async state => {
      const parsed = parseInput(FingerprintSchema, fingerprint)
      assertRevision(state, parseInput(RevisionSchema, revision))
      findHost(state, environmentId, hostId).hostKeyFingerprint = parsed
      return this.#commit(state)
    })
  }

  /** Internal-only material, deliberately absent from view()/CRUD response shapes. */
  credentials(environmentId: string, hostId: string, expectedRevision: number): Promise<HostCredentials> {
    return this.#execute(async (state, key) => {
      assertRevision(state, parseInput(RevisionSchema, expectedRevision))
      const host = findHost(state, environmentId, hostId)
      const secret = decryptHost(key, host)
      return { revision: state.revision, host: hostView(host), ...(typeof secret === 'string' ? { password: secret } : secret) }
    })
  }

  /** Refuse new submissions and drain accepted writes before Runtime releases its stateDir lock. */
  close(): Promise<void> { this.#closed = true; return this.#queue }

  #execute<T>(operation: (state: State, key: Buffer) => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new RemoteManagementError(409, 'remote/stopped', 'Remote management is stopping; reload after restart.'))
    const result = this.#queue.then(async () => {
      let key: Buffer | undefined
      try {
        const loaded = await this.#load()
        key = loaded.key
        return await operation(loaded.state, loaded.key)
      } catch (error) {
        if (error instanceof RemoteManagementError) throw error
        throw unavailable()
      } finally { key?.fill(0) }
    })
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  async #commit(state: State): Promise<ManagedView> {
    assertCollections(state)
    if (state.revision >= Number.MAX_SAFE_INTEGER) throw unavailable()
    state.revision++
    return viewOf(await this.#writeState(state))
  }

  async #writeState(state: State): Promise<State> {
    state.version = 3
    const parsed = StateSchema.parse(state)
    const encoded = Buffer.from(JSON.stringify(parsed), 'utf8')
    if (encoded.length > MAX_STATE_BYTES) throw unavailable()
    await this.#atomicWrite('state.json', encoded)
    return parsed
  }

  async #load(): Promise<{ state: State, key: Buffer }> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.#directory)
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & PERMISSION_BITS) !== 0o700
      || (process.getuid && directory.uid !== process.getuid())) throw unavailable()
    let key: Buffer | undefined
    try {
      key = (await this.#readSecure('master.key', 32)) ?? undefined
      const json = await this.#readSecure('state.json', MAX_STATE_BYTES)
      // Never silently reset an existing vault when either half is absent or damaged.
      if ((key === undefined) !== (json === null)) throw unavailable()
      if (key === undefined) {
        key = randomBytes(32)
        const state: State = { version: 2, revision: 0, environments: [] }
        await this.#atomicWrite('master.key', key, true)
        await this.#atomicWrite('state.json', Buffer.from(JSON.stringify(state)), true)
        ensureShared(state)
        return { state, key }
      }
      if (key.length !== 32 || json === null) throw unavailable()
      const state = StateSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)))
      try {
        ensureShared(state)
        assertCollections(state)
        // Authenticate all stored secrets before exposing any supposedly healthy snapshot.
        for (const environment of state.environments) {
          for (const host of environment.hosts) decryptHost(key, host)
          for (const resource of environment.resources) decrypt(key, resource, PasswordSchema)
        }
      } catch { throw unavailable() }
      return { state, key }
    } catch (error) {
      key?.fill(0)
      if (error instanceof RemoteManagementError) throw error
      throw unavailable()
    }
  }

  async #readSecure(name: string, maxBytes: number): Promise<Buffer | null> {
    const path = join(this.#directory, name)
    let before
    try { before = await lstat(path) } catch (error) { if (isMissing(error)) return null; throw error }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & PERMISSION_BITS) !== 0o600
      || (process.getuid && before.uid !== process.getuid())) throw unavailable()
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || (info.mode & PERMISSION_BITS) !== 0o600 || info.ino !== before.ino || info.dev !== before.dev
        || info.size > maxBytes || (process.getuid && info.uid !== process.getuid())) throw unavailable()
      // Bound even a concurrently growing file without trusting readFile() after stat().
      const bytes = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length !== info.size) throw unavailable()
      return bytes.subarray(0, length)
    } finally { await file.close() }
  }

  async #atomicWrite(name: string, bytes: Buffer, exclusive = false): Promise<void> {
    const target = join(this.#directory, name)
    const temporary = join(this.#directory, `.${name}.${randomUUID()}.tmp`)
    let created = false
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      if (exclusive) {
        // Publish a fully written key/state only if no destination exists; never overwrite a key.
        await link(temporary, target)
        await unlink(temporary)
        created = false
      } else {
        // Refuse special files/symlinks instead of "repairing" them by replacement.
        const existing = await lstat(target)
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || (existing.mode & PERMISSION_BITS) !== 0o600
          || (process.getuid && existing.uid !== process.getuid())) throw unavailable()
        await rename(temporary, target)
        created = false
      }
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
    } finally {
      if (created) await unlink(temporary).catch(() => undefined)
    }
  }
}
