import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { normalizeName } from './inventory.ts'
import {
  EnvironmentWriteSchema, FingerprintSchema, HostWriteSchema, PostgresResourceSchema, RemoteManagementError, ResourceWriteSchema,
  RevisionSchema, WebsiteResourceSchema, type EnvironmentWrite, type HostCredentials, type HostWrite, type ManagedHost,
  type ManagedResource, type ManagedView, type ResourceWrite,
} from './managed-types.ts'

const MAX_STATE_BYTES = 16 * 1024 * 1024
const PERMISSION_BITS = 0o7777
const PasswordSchema = HostWriteSchema.shape.password.unwrap().refine(value => value.length > 0)
const MAX_PASSWORD_JSON_BYTES = 4096 * 6 + 2
const Base64Schema = z.string().min(1).max(4 * Math.ceil(MAX_PASSWORD_JSON_BYTES / 3))
  .refine(value => Buffer.from(value, 'base64').toString('base64') === value)
const SecretSchema = z.object({
  iv: Base64Schema.refine(value => Buffer.from(value, 'base64').length === 12),
  tag: Base64Schema.refine(value => Buffer.from(value, 'base64').length === 16),
  ciphertext: Base64Schema.refine(value => Buffer.from(value, 'base64').length <= MAX_PASSWORD_JSON_BYTES),
}).strict()
const StoredHostSchema = HostWriteSchema.omit({ revision: true, password: true }).extend({
  id: z.string().uuid(), auth: z.literal('password'), hostKeyFingerprint: FingerprintSchema.nullable(), secret: SecretSchema,
}).strict()
const resourceSecret = { id: z.uuid(), secret: SecretSchema }
const StoredResourceSchema = z.union([
  PostgresResourceSchema.extend(resourceSecret),
  // Old vaults may still have these fields. Ignore them on read and omit them on the next save.
  WebsiteResourceSchema.safeExtend({ ...resourceSecret, role: z.unknown().optional(), apiPaths: z.unknown().optional(),
    webPaths: z.unknown().optional() }).transform(({ role: _, apiPaths: _api, webPaths: _web, ...resource }) => resource),
])
const StoredEnvironmentSchema = EnvironmentWriteSchema.omit({ revision: true }).extend({
  id: z.string().uuid(), hosts: z.array(StoredHostSchema).max(1000),
  resources: z.array(StoredResourceSchema).max(1000).default([]),
}).strict()
const StateSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), revision: RevisionSchema, environments: z.array(StoredEnvironmentSchema).max(1000),
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
function assertCollections(state: State): void {
  const environmentNames = new Set<string>()
  const resourceIds = new Set<string>()
  for (const environment of state.environments) {
    // IDs share the selection namespace with names/aliases in the diagnostic inventory.
    for (const name of [environment.id, environment.name, ...environment.aliases]) {
      const normalized = normalizeName(name)
      if (environmentNames.has(normalized)) throw new RemoteManagementError(400, 'duplicate_environment',
        'Environment names and aliases must be unique.')
      environmentNames.add(normalized)
    }
    for (const resource of environment.resources) {
      if (resourceIds.has(resource.id)) throw invalid()
      resourceIds.add(resource.id)
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
}
function hostView(host: StoredHost): ManagedHost {
  return { id: host.id, type: 'linux-host', notes: host.notes, name: host.name, host: host.host, port: host.port, username: host.username,
    auth: 'password', hasPassword: true, hostKeyFingerprint: host.hostKeyFingerprint, projects: structuredClone(host.projects) }
}
function resourceView({ secret: _, ...resource }: StoredResource): ManagedResource {
  return { ...resource, hasPassword: true }
}
function viewOf(state: State): ManagedView {
  return { revision: state.revision, environments: state.environments.map(environment => ({
    id: environment.id, name: environment.name, aliases: [...environment.aliases], production: environment.production,
    hosts: environment.hosts.map(hostView),
    ...(environment.resources.length ? { resources: environment.resources.map(resourceView) } : {}),
  })) }
}
function encrypt(key: Buffer, hostId: string, password: string): Secret {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(hostId, 'utf8'))
  // JSON preserves even opaque passwords containing unpaired UTF-16 surrogates.
  const plaintext = Buffer.from(JSON.stringify(password), 'utf8')
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
  } finally { plaintext.fill(0) }
}
function decrypt(key: Buffer, host: { id: string; secret: Secret }): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(host.secret.iv, 'base64'))
  decipher.setAAD(Buffer.from(host.id, 'utf8'))
  decipher.setAuthTag(Buffer.from(host.secret.tag, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(host.secret.ciphertext, 'base64')), decipher.final()])
  try {
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    const parsed = PasswordSchema.safeParse(decoded)
    if (!parsed.success) throw unavailable()
    return parsed.data
  } finally { plaintext.fill(0) }
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
      state.environments.push({ ...fields, id: randomUUID(), hosts: [], resources: [] })
      return this.#commit(state)
    })
  }

  updateEnvironment(id: string, input: EnvironmentWrite): Promise<ManagedView> {
    return this.#execute(async state => {
      const parsed = parseInput(EnvironmentWriteSchema, input)
      assertRevision(state, parsed.revision)
      const environment = findEnvironment(state, id)
      const { revision: _, ...fields } = parsed
      Object.assign(environment, fields)
      return this.#commit(state)
    })
  }

  deleteEnvironment(id: string, revision: number): Promise<ManagedView> {
    return this.#execute(async state => {
      assertRevision(state, parseInput(RevisionSchema, revision))
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
      if (!parsed.password) throw new RemoteManagementError(400, 'password_required', 'A password is required when creating a host.')
      const { revision: _, password, ...fields } = parsed
      const id = randomUUID()
      environment.hosts.push({ ...fields, id, auth: 'password', hostKeyFingerprint: null, secret: encrypt(key, id, password) })
      return this.#commit(state)
    })
  }

  updateHost(environmentId: string, hostId: string, input: HostWrite): Promise<ManagedView> {
    return this.#execute(async (state, key) => {
      const parsed = parseInput(HostWriteSchema, input)
      assertRevision(state, parsed.revision)
      const host = findHost(state, environmentId, hostId)
      const { revision: _, password, ...fields } = parsed
      // Endpoint identity changes require a new independently verified host-key pin.
      if (host.host !== fields.host || host.port !== fields.port) host.hostKeyFingerprint = null
      Object.assign(host, fields)
      if (password !== undefined && password !== '') host.secret = encrypt(key, host.id, password)
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

  resourceCredentials(environmentId: string, id: string, expectedRevision: number, worker: boolean) {
    return this.#execute(async (state, key) => {
      assertRevision(state, expectedRevision)
      const environment = findEnvironment(state, environmentId)
      const resource = environment.resources.find(item => item.id === id)
      if (!resource) throw new RemoteManagementError(404, 'resource_not_found', 'Environment resource was not found.')
      if (environment.production || (worker && !resource.allowWorker)) {
        throw new RemoteManagementError(400, 'resource_not_allowed', 'Credential use is not enabled for this environment and session.')
      }
      return { resource: resourceView(resource), password: decrypt(key, resource) }
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
      return { revision: state.revision, host: hostView(host), password: decrypt(key, host) }
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
    state.version = 2
    state.revision++
    const parsed = StateSchema.parse(state)
    const encoded = Buffer.from(JSON.stringify(parsed), 'utf8')
    if (encoded.length > MAX_STATE_BYTES) throw unavailable()
    await this.#atomicWrite('state.json', encoded)
    return viewOf(parsed)
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
        return { state, key }
      }
      if (key.length !== 32 || json === null) throw unavailable()
      const state = StateSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)))
      try {
        assertCollections(state)
        // Authenticate all stored secrets before exposing any supposedly healthy snapshot.
        for (const environment of state.environments) {
          for (const host of environment.hosts) decrypt(key, host)
          for (const resource of environment.resources) decrypt(key, resource)
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
