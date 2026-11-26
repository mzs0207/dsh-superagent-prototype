/** These SSH servers bind only an ephemeral loopback port; no user host or credential is read. */
import { Server, utils, type Connection } from 'ssh2'
import { createServer } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ManagedRemoteOps } from '../src/remote-ops/managed.ts'
import { ManagedStore } from '../src/remote-ops/managed-store.ts'
import { hostFingerprint, probeHostKey, runManagedSsh } from '../src/remote-ops/managed-ssh.ts'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(disposals.splice(0).map(stop => stop())) })
const limits = { timeoutMs: 2500, maxOutputBytes: 128 }
const signal = () => new AbortController().signal
const secret = '  local-test-password-only $;&\'  '
async function sshServer(options: { failAuth?: boolean; hang?: boolean; output?: string; code?: number; publicKey?: string } = {}) {
  // ssh2's Ed25519 generator can strip leading zero bytes from its own public key.
  const key = utils.generateKeyPairSync('ecdsa', { bits: 256 }), parsed = utils.parseKey(key.private)
  if (parsed instanceof Error) throw parsed
  const identity = options.publicKey ? utils.parseKey(options.publicKey) : undefined
  if (identity instanceof Error) throw identity
  const connections = new Set<Connection>(), passwords: string[] = [], commands: string[] = []
  const server = new Server({ hostKeys: [key.private] }, client => {
    connections.add(client)
    client.on('error', () => {})
    client.on('close', () => connections.delete(client))
    client.on('authentication', context => {
      if (context.method === 'password') passwords.push(context.password)
      if (!options.failAuth && context.method === 'password' && context.username === 'diagnostics' && context.password === secret) context.accept()
      else if (identity && context.method === 'publickey' && context.username === 'diagnostics'
        && identity.getPublicSSH().equals(context.key.data)
        && (!context.signature || (context.blob && identity.verify(context.blob, context.signature, context.hashAlgo)))) context.accept()
      else context.reject([options.publicKey ? 'publickey' : 'password'])
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('exec', (acceptCommand, _reject, info) => {
        commands.push(info.command)
        const stream = acceptCommand()
        if (options.hang) return
        stream.write(options.output ?? 'healthy\n')
        stream.stderr.write('fixture stderr\n')
        stream.exit(options.code ?? 0); stream.end()
      })
    }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  disposals.push(async () => { for (const client of connections) client.end(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local test address')
  return { host: '127.0.0.1', port: address.port, username: 'diagnostics', password: secret,
    fingerprint: hostFingerprint(parsed.getPublicSSH()), passwords, commands, connections }
}

it('obtains a host fingerprint without sending any password or authenticating', async () => {
  const local = await sshServer()
  expect(await probeHostKey(local, signal(), limits)).toBe(local.fingerprint)
  expect(local.passwords).toEqual([]); expect(local.commands).toEqual([])
})
it('authenticates only by password and executes no command for a connection test', async () => {
  const local = await sshServer()
  expect(await runManagedSsh(local, undefined, signal(), limits)).toMatchObject({ ok: true, exitCode: 0 })
  expect(local.passwords).toEqual([secret]); expect(local.commands).toEqual([])
})
it('rejects a changed host key before sending the password', async () => {
  const local = await sshServer()
  const value = await runManagedSsh({ ...local, fingerprint: `SHA256:${'A'.repeat(43)}` }, undefined, signal(), limits)
  expect(value).toMatchObject({ ok: false }); expect(value.error).toContain('host key')
  expect(local.passwords).toEqual([])
})
it('authenticates with a saved encrypted private key only after a verified host fingerprint', async () => {
  const passphrase = ' fixture private key passphrase '
  const key = utils.generateKeyPairSync('ecdsa', { bits: 256, passphrase, cipher: 'aes256-ctr', rounds: 16 })
  const local = await sshServer({ publicKey: key.public })
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-key-'))
  const remote = new ManagedRemoteOps(directory)
  disposals.push(async () => { await remote.stop(); await rm(directory, { recursive: true, force: true }) })
  const initial = await remote.store.createEnvironment({ revision: 0, name: 'Fixture' })
  const environment = initial.environments[0]!.id
  const fields = { revision: initial.revision, name: 'Key host', host: local.host, port: local.port, username: local.username,
    auth: 'private-key', privateKey: key.private, passphrase } as const
  await expect(remote.store.createHost(environment, { ...fields, passphrase: 'wrong' })).rejects.toMatchObject({ code: 'invalid_private_key' })
  const saved = await remote.store.createHost(environment, fields)
  const host = saved.environments[0]!.hosts[0]!
  expect(host).toMatchObject({ auth: 'private-key', hasPassword: false })
  expect(JSON.stringify(saved)).not.toMatch(/BEGIN OPENSSH|fixture private key passphrase|ciphertext/)
  expect(await readFile(join(directory, 'state.json'), 'utf8')).not.toMatch(/BEGIN OPENSSH|fixture private key passphrase/)
  await expect(remote.test(environment, host.id, { revision: saved.revision }, signal())).rejects.toMatchObject({ code: 'remote/untrusted' })
  const probe = await remote.probe(environment, host.id, { revision: saved.revision }, signal())
  const trusted = await remote.trust(environment, host.id, { revision: saved.revision, token: probe.token })
  expect(await remote.test(environment, host.id, { revision: trusted.revision }, signal())).toMatchObject({ ok: true })
  expect(local.commands).toEqual([])
  expect(await remote.inspect({ environment, server: host.id, action: 'containers' }, signal())).toMatchObject({ ok: true })
  expect(local.commands).toHaveLength(1)
  expect(local.passwords).toEqual([])
  const exported = await remote.store.exportCatalog()
  expect(exported.environments[0]!.hosts[0]).toMatchObject({ auth: 'private-key' })
  expect(JSON.stringify(exported)).not.toMatch(/privateKey|passphrase|hostKeyFingerprint|ciphertext/)
  const imported = new ManagedStore(join(directory, 'imported'))
  const preview = await imported.previewImport(JSON.parse(JSON.stringify(exported)))
  expect(preview).toMatchObject({ passwords: [], privateKeys: [{ id: host.id }] })
  await expect(imported.importCatalog(exported, preview.revision, {})).rejects.toMatchObject({ code: 'private_key_required' })
  const restored = await imported.importCatalog(exported, preview.revision, {}, { [host.id]: { privateKey: key.private, passphrase } })
  expect(restored.environments.find(item => item.id === environment)?.hosts[0])
    .toMatchObject({ id: host.id, auth: 'private-key', hostKeyFingerprint: null })
  const destination = trusted.environments.find(item => item.shared)!.id
  const copied = await remote.store.transferRecord(environment, host.id, { revision: trusted.revision, destination, mode: 'copy' })
  const duplicate = copied.environments.find(item => item.shared)!.hosts[0]!
  expect(duplicate.id).not.toBe(host.id)
  expect(await remote.test(destination, duplicate.id, { revision: copied.revision }, signal())).toMatchObject({ ok: true })
})
it('returns fixed authentication failure text without the secret or server protocol details', async () => {
  const local = await sshServer({ failAuth: true })
  const value = await runManagedSsh(local, undefined, signal(), limits)
  expect(value).toMatchObject({ ok: false, error: 'SSH password authentication failed' })
  expect(JSON.stringify(value)).not.toContain(secret)
})
it('preserves remote exit status and bounds combined output while draining', async () => {
  const local = await sshServer({ output: 'x'.repeat(4096), code: 7 })
  const value = await runManagedSsh(local, "'docker' 'compose' 'ps'", signal(), limits)
  expect(value).toMatchObject({ ok: false, exitCode: 7, truncated: true })
  expect(Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr)).toBe(128)
  expect(local.commands).toEqual(["'docker' 'compose' 'ps'"])
})
it('terminates timed-out commands and fully closes the connection', async () => {
  const local = await sshServer({ hang: true })
  const value = await runManagedSsh(local, "'docker' 'compose' 'ps'", signal(), { ...limits, timeoutMs: 300 })
  expect(value).toMatchObject({ ok: false, timedOut: true })
  expect(value.durationMs).toBeLessThan(2000)
})
it('cancels an active SSH connection and refuses already cancelled work', async () => {
  const local = await sshServer({ hang: true }), controller = new AbortController()
  const work = runManagedSsh(local, 'fixture-only', controller.signal, limits)
  controller.abort()
  expect(await work).toMatchObject({ ok: false, cancelled: true })
  await expect(runManagedSsh(local, undefined, controller.signal, limits)).rejects.toThrow()
  await expect(probeHostKey(local, controller.signal, limits)).rejects.toThrow()
})
it('times out fingerprint acquisition on a non-SSH loopback socket', async () => {
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  disposals.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local test address')
  await expect(probeHostKey({ host: '127.0.0.1', port: address.port }, signal(), { ...limits, timeoutMs: 80 })).rejects.toThrow('timed out')
})
