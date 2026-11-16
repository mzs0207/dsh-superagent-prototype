/** Shared management service: UI-only writes and password-free agent discovery/diagnostics. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { ManagedStore } from './managed-store.ts'
import { InventorySchema, normalizeName, type Inventory } from './inventory.ts'
import { diagnosticCommand, InspectSchema, planInspection } from './commands.ts'
import { RemoteOps, type ProcessLimits, type ProcessResult } from './runner.ts'
import { probeHostKey, runPasswordSsh, type PasswordConnection, type ProbeAddress } from './password-ssh.ts'
import { RemoteManagementError, ProbeSchema, TrustSchema, type ConnectionTest, type HostKeyProbe, type ManagedHost, type ManagedView } from './managed-types.ts'

declare module '@deepseek-ai/cordis' { interface Context { remoteOps: ManagedRemoteOps } }
interface PasswordTransport {
  probe(address: ProbeAddress, signal: AbortSignal, limits: ProcessLimits): Promise<string>
  run(connection: PasswordConnection, command: string | undefined, signal: AbortSignal, limits: ProcessLimits): Promise<ProcessResult>
}
interface Challenge { environment: string; host: string; address: string; port: number; revision: number; fingerprint: string; expires: number }
const LIMITS = { timeoutMs: 30000, maxOutputBytes: 65536 }

/** Owns an encrypted host store, UI trust challenges, and the common bounded diagnostic connection lifecycle. */
export class ManagedRemoteOps extends Service {
  readonly store: ManagedStore
  private readonly runner = new RemoteOps({ inventoryFile: '', maxConcurrent: 2, ...LIMITS })
  private readonly challenges = new Map<string, Challenge>()
  private readonly stopped = new AbortController()
  constructor(ctx: Context, directory: string, private readonly lifetime: AbortSignal,
    private readonly ssh: PasswordTransport = { probe: probeHostKey, run: runPasswordSsh }) {
    super(ctx, 'remoteOps')
    this.store = new ManagedStore(directory)
  }
  private signal(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, this.lifetime, this.stopped.signal]) }
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
  async inspect(input: unknown, signal: AbortSignal): Promise<unknown> {
    const linked = this.signal(signal), request = InspectSchema.parse(input), view = await this.store.view()
    linked.throwIfAborted()
    const environment = view.environments.find(item => [item.id, item.name, ...item.aliases].some(value => normalizeName(value) === normalizeName(request.environment)))
    if (!environment) throw new RemoteManagementError(404, 'remote/not-found', 'Remote environment not found; create it in the environment management page')
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
    await Promise.all([this.runner.stop(), this.store.close()])
  }
}
