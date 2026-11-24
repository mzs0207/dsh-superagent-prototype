/** Shared management service: UI-only writes and password-free agent discovery/diagnostics. */
import { randomUUID } from 'node:crypto'
import { ManagedStore } from './managed-store.ts'
import { InventorySchema, normalizeName, type Inventory } from './inventory.ts'
import { diagnosticCommand, InspectSchema, planInspection } from './commands.ts'
import { RemoteOps, type ProcessLimits, type ProcessResult } from './runner.ts'
import { probeHostKey, runPasswordSsh, type PasswordConnection, type ProbeAddress } from './password-ssh.ts'
import { checkResource, isWebsiteReadPath, openWebsite, type WebsiteConnection, type WebsiteReadResult } from './resource-checks.ts'
import { RemoteManagementError, ProbeSchema, TrustSchema, ResourceActionSchema, ResourceLoginSchema, ResourceSearchSchema,
  ResourceSessionReadSchema, type ConnectionTest, type HostKeyProbe, type ManagedEnvironment, type ManagedHost, type ManagedView } from './managed-types.ts'

interface PasswordTransport {
  probe(address: ProbeAddress, signal: AbortSignal, limits: ProcessLimits): Promise<string>
  run(connection: PasswordConnection, command: string | undefined, signal: AbortSignal, limits: ProcessLimits): Promise<ProcessResult>
}
interface Challenge { environment: string; host: string; address: string; port: number; revision: number; fingerprint: string; expires: number }
const LIMITS = { timeoutMs: 30000, maxOutputBytes: 65536 }
const WEBSITE_TTL_MS = 5 * 60_000
const MAX_WEBSITE_SESSIONS = 4
interface WebsiteOpening { owner: object; key: string; stop: AbortController }
interface WebsiteLease extends WebsiteOpening {
  connection: WebsiteConnection
  revision: number
  expiresAt: number
  timer: NodeJS.Timeout
  busy: boolean
}

function selectEnvironment(view: ManagedView, selector: string): ManagedEnvironment {
  const key = normalizeName(selector)
  const environment = view.environments.find(item => [item.id, item.name, ...item.aliases].some(value => normalizeName(value) === key))
  if (!environment) throw new RemoteManagementError(404, 'remote/not-found', 'Remote environment not found; create it in the environment management page')
  return environment
}

/** Owns an encrypted host store, UI trust challenges, and the common bounded diagnostic connection lifecycle. */
export class ManagedRemoteOps {
  readonly store: ManagedStore
  private readonly runner = new RemoteOps({ inventoryFile: '', maxConcurrent: 2, ...LIMITS })
  private readonly challenges = new Map<string, Challenge>()
  private readonly opening = new Set<WebsiteOpening>()
  private readonly logins = new Set<WebsiteLease>()
  private readonly closingLogins = new Set<Promise<void>>()
  private readonly stopped = new AbortController()
  constructor(directory: string,
    private readonly ssh: PasswordTransport = { probe: probeHostKey, run: runPasswordSsh },
    private readonly browserExecutable = '') {
    this.store = new ManagedStore(directory)
  }
  private signal(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, this.stopped.signal]) }
  private async target(environment: string, host: string, revision: number): Promise<ManagedHost> {
    const view = await this.store.view()
    if (view.revision !== revision) throw new RemoteManagementError(409, 'remote/conflict', 'Remote configuration changed; reload before continuing')
    const target = view.environments.find(item => item.id === environment)?.hosts.find(item => item.id === host)
    if (!target) throw new RemoteManagementError(404, 'remote/not-found', 'Remote host not found')
    return target
  }
  async probe(environment: string, host: string, input: unknown, signal: AbortSignal): Promise<HostKeyProbe> {
    const { revision } = ProbeSchema.parse(input), linked = this.signal(signal)
    for (const [token, value] of this.challenges) if (value.expires <= Date.now()) this.challenges.delete(token)
    if (this.challenges.size >= 100) throw new RemoteManagementError(400, 'remote/busy', 'Too many pending fingerprint checks; wait and retry')
    const target = await this.target(environment, host, revision)
    const fingerprint = await this.runner.withSlot(linked, async active => {
      await this.target(environment, host, revision)
      return this.ssh.probe({ host: target.host, port: target.port }, active, LIMITS)
    })
    linked.throwIfAborted()
    await this.target(environment, host, revision)
    const token = randomUUID(), expires = Date.now() + 5 * 60 * 1000
    this.challenges.set(token, { environment, host, address: target.host, port: target.port, revision, fingerprint, expires })
    return { fingerprint, token, expiresAt: new Date(expires).toISOString() }
  }
  async trust(environment: string, host: string, input: unknown): Promise<ManagedView> {
    const { revision, token } = TrustSchema.parse(input)
    const challenge = this.challenges.get(token)
    if (!challenge || challenge.expires <= Date.now() || challenge.environment !== environment || challenge.host !== host || challenge.revision !== revision) {
      throw new RemoteManagementError(400, 'remote/challenge', 'Fingerprint confirmation expired or does not match this host; obtain it again')
    }
    const target = await this.target(environment, host, revision)
    if (target.host !== challenge.address || target.port !== challenge.port) throw new RemoteManagementError(409, 'remote/conflict', 'Remote endpoint changed; obtain its fingerprint again')
    this.challenges.delete(token)
    return this.store.trustHost(environment, host, revision, challenge.fingerprint)
  }
  async test(environment: string, host: string, input: unknown, signal: AbortSignal): Promise<ConnectionTest> {
    const { revision } = ProbeSchema.parse(input), linked = this.signal(signal)
    const target = await this.target(environment, host, revision)
    if (!target.hostKeyFingerprint) throw new RemoteManagementError(400, 'remote/untrusted', 'Verify and trust the SSH host fingerprint before sending a password')
    const result = await this.runner.withSlot(linked, async active => {
      const credentials = await this.store.credentials(environment, host, revision)
      if (!credentials.host.hostKeyFingerprint) throw new RemoteManagementError(400, 'remote/untrusted', 'SSH host fingerprint is not trusted')
      return this.ssh.run({ host: credentials.host.host, port: credentials.host.port, username: credentials.host.username,
        password: credentials.password, fingerprint: credentials.host.hostKeyFingerprint }, undefined, active, LIMITS)
    })
    return { ok: result.ok, message: result.ok ? 'SSH password authentication succeeded; no remote command was executed'
      : result.error ?? 'SSH connection test failed', durationMs: result.durationMs }
  }
  async inventory() {
    const view = await this.store.view()
    return { configured: true, source: 'managed', readOnly: true, environments: view.environments.map(environment => ({
      id: environment.id, label: environment.name, aliases: environment.aliases, production: environment.production,
      servers: environment.hosts.map(host => ({ id: host.id, label: host.name, trusted: !!host.hostKeyFingerprint,
        projects: host.projects.map(project => ({ id: project.id, ...(project.label ? { label: project.label } : {}) })) })),
    })) }
  }
  async findResources(input: unknown) {
    const request = ResourceSearchSchema.parse(input), view = await this.store.view()
    const environment = selectEnvironment(view, request.environment)
    const keyword = request.keyword?.normalize('NFKC').toLowerCase()
    const resources = [
      ...environment.hosts.map(host => ({ id: host.id, name: host.name, type: 'linux-host' as const, notes: host.notes ?? '',
        trusted: !!host.hostKeyFingerprint, projects: host.projects.map(project => project.id) })),
      ...(environment.resources ?? []).map(resource => resource.type === 'postgresql'
        ? { id: resource.id, name: resource.name, type: resource.type, notes: resource.notes, allowWorker: resource.allowWorker,
            host: resource.host, port: resource.port, database: resource.database }
        : { id: resource.id, name: resource.name, type: resource.type, notes: resource.notes, allowWorker: resource.allowWorker,
            origin: resource.origin, system: resource.system }),
    ].filter(resource => (!request.resource || resource.id === request.resource) && (!request.type || resource.type === request.type)
      && (!keyword || `${resource.name}\n${resource.notes}`.normalize('NFKC').toLowerCase().includes(keyword)))
    return { environment: environment.name, production: environment.production, resources: resources.slice(0, 30), truncated: resources.length > 30 }
  }
  async check(input: unknown, signal: AbortSignal, worker: boolean, expectedRevision?: number): Promise<ConnectionTest> {
    const request = ResourceActionSchema.parse(input), view = await this.store.view()
    if (expectedRevision !== undefined && view.revision !== expectedRevision) {
      throw new RemoteManagementError(409, 'remote/conflict', 'Remote configuration changed; reload before continuing')
    }
    const environment = selectEnvironment(view, request.environment)
    const target = environment.resources?.find(resource => resource.id === request.resource)
    if (!target) throw new RemoteManagementError(404, 'resource_not_found', 'Environment resource was not found.')
    if ((target.type === 'postgresql') !== (request.action === 'database')) {
      throw new RemoteManagementError(400, 'resource_type_mismatch', 'This operation does not match the resource type.')
    }
    return this.runner.withSlot(this.signal(signal), async active => {
      const { resource, password } = await this.store.resourceCredentials(environment.id, target.id, view.revision, worker)
      active.throwIfAborted()
      return checkResource(resource, password, request.action, this.browserExecutable, active)
    })
  }
  async login(input: unknown, owner: object, signal: AbortSignal, worker: boolean) {
    const request = ResourceLoginSchema.parse(input), view = await this.store.view()
    const environment = selectEnvironment(view, request.environment)
    const target = environment.resources?.find(resource => resource.id === request.resource)
    if (target?.type !== 'website-account') throw new RemoteManagementError(404, 'resource_not_found', 'Website account was not found.')
    const key = `${environment.id}:${request.resource}:${request.mode}`
    const previous = [...this.logins].find(login => login.owner === owner && login.key === key)
    if (this.logins.size - Number(!!previous) + this.opening.size >= MAX_WEBSITE_SESSIONS
      || [...this.opening].some(login => login.owner === owner && login.key === key)) {
      throw new RemoteManagementError(400, 'resource_busy', 'A website login is already opening or the session limit has been reached.')
    }
    const opening = { owner, key, stop: new AbortController() }
    this.opening.add(opening)
    const linked = AbortSignal.any([this.signal(signal), opening.stop.signal])
    try {
      if (previous) await this.closeLogin(previous)
      return await this.runner.withSlot(linked, async active => {
        const { resource, password } = await this.store.resourceCredentials(environment.id, target.id, view.revision, worker)
        active.throwIfAborted()
        let connection: WebsiteConnection | undefined
        try {
          if (resource.type === 'website-account') connection = await openWebsite(resource, password, request.mode, this.browserExecutable,
            AbortSignal.any([active, AbortSignal.timeout(25_000)]))
        } catch { /* Authentication failures can include secrets. */ }
        if (!connection) { active.throwIfAborted(); return { ok: false, message: 'Website login could not be verified.' } }
        if (active.aborted) { await connection.close(); active.throwIfAborted() }
        const expiresAt = Date.now() + WEBSITE_TTL_MS
        const lease: WebsiteLease = { ...opening, connection, revision: view.revision, expiresAt, busy: false,
          timer: setTimeout(() => { void this.closeLogin(lease) }, WEBSITE_TTL_MS) }
        lease.timer.unref()
        this.logins.add(lease)
        return { ok: true, origin: target.origin, system: target.system, expiresAt: new Date(expiresAt).toISOString() }
      })
    } finally { this.opening.delete(opening) }
  }

  async readSession(input: unknown, owner: object, signal: AbortSignal, worker: boolean): Promise<WebsiteReadResult> {
    const request = ResourceSessionReadSchema.parse(input), view = await this.store.view()
    const environment = selectEnvironment(view, request.environment)
    const login = [...this.logins].find(candidate => candidate.owner === owner
      && candidate.key === `${environment.id}:${request.resource}:${request.mode}`)
    if (!login) throw new RemoteManagementError(400, 'login_required', 'Sign in from this conversation before reading the resource.')
    const resource = environment.resources?.find(item => item.id === request.resource)
    if (login.expiresAt <= Date.now() || login.revision !== view.revision || resource?.type !== 'website-account'
      || environment.production || (worker && !resource.allowWorker)) {
      await this.closeLogin(login)
      throw new RemoteManagementError(400, 'login_expired', 'Sign in again; the resource configuration or login has changed.')
    }
    if (!isWebsiteReadPath(resource.system, request.mode, request.path)) {
      throw new RemoteManagementError(400, 'path_not_allowed', 'This path is not allowed for the selected system and read mode.')
    }
    if (login.busy) throw new RemoteManagementError(400, 'resource_busy', 'This website session is already serving a read.')
    login.busy = true
    const linked = AbortSignal.any([this.signal(signal), login.stop.signal, AbortSignal.timeout(12_000)])
    try {
      linked.throwIfAborted()
      const result = await login.connection.read(request.path, linked).catch(() => ({ ok: false, path: request.path }))
      if (linked.aborted || !result.ok) await this.closeLogin(login)
      return linked.aborted ? { ok: false, path: request.path } : result
    } finally { login.busy = false }
  }

  async releaseOwner(owner: object): Promise<void> {
    for (const opening of this.opening) if (opening.owner === owner) opening.stop.abort()
    await Promise.all([...this.logins].filter(login => login.owner === owner).map(login => this.closeLogin(login)))
  }

  private async closeLogin(login: WebsiteLease): Promise<void> {
    if (!this.logins.delete(login)) return
    clearTimeout(login.timer); login.stop.abort()
    const work = login.connection.close().catch(() => undefined)
    this.closingLogins.add(work)
    try { await work } finally { this.closingLogins.delete(work) }
  }

  async inspect(input: unknown, signal: AbortSignal): Promise<unknown> {
    const linked = this.signal(signal), request = InspectSchema.parse(input), view = await this.store.view()
    linked.throwIfAborted()
    const environment = selectEnvironment(view, request.environment)
    if (!environment.hosts.length) throw new RemoteManagementError(400, 'remote/empty', 'This environment has no hosts')
    const inventory: Inventory = InventorySchema.parse({ version: 1, environments: [{ id: environment.id, label: environment.name,
      aliases: environment.aliases, production: environment.production, servers: environment.hosts.map(host => ({ id: host.id,
        label: host.name, host: host.host, port: host.port, user: host.username, projects: host.projects })) }] })
    const targets = planInspection(inventory, request)
    // Check every selected trust state and command before starting any connection.
    for (const target of targets) {
      const host = environment.hosts.find(item => item.id === target.server.id)!
      if (!host.hostKeyFingerprint || !host.hasPassword) throw new RemoteManagementError(400, 'remote/untrusted', 'Every selected host needs a password and a verified SSH fingerprint')
      diagnosticCommand(target, request)
    }
    return this.runner.inspectInventory(request, inventory, linked, async (target, planned, active, limits) => {
      const credentials = await this.store.credentials(target.environment.id, target.server.id, view.revision)
      const fingerprint = credentials.host.hostKeyFingerprint
      if (!fingerprint) throw new RemoteManagementError(400, 'remote/untrusted', 'SSH host fingerprint is not trusted')
      return this.ssh.run({ host: credentials.host.host, port: credentials.host.port, username: credentials.host.username,
        password: credentials.password, fingerprint }, diagnosticCommand(target, planned), active, limits)
    })
  }
  async stop(): Promise<void> {
    this.stopped.abort(); this.challenges.clear()
    const closing = [...this.logins].map(login => this.closeLogin(login))
    await Promise.all([this.runner.stop(), this.store.close(), ...closing, ...this.closingLogins])
  }
}
