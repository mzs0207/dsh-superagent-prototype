/** Native SSH transport: credentials never enter argv, environment, files or tool arguments. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { Client, type ConnectConfig, type ClientChannel } from 'ssh2'
import type { ProcessLimits, ProcessResult } from './runner.ts'
import { FingerprintSchema, RemoteManagementError, type SshSecret } from './managed-types.ts'

export type SshConnection = ProbeAddress & { username: string; fingerprint: string } & SshSecret
export interface ProbeAddress { host: string; port: number }
export const hostFingerprint = (key: Buffer): string => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
const sameFingerprint = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const baseConfig = (address: ProbeAddress, limits: ProcessLimits): ConnectConfig => ({ host: address.host, port: address.port,
  readyTimeout: Math.min(15000, limits.timeoutMs), keepaliveInterval: 5000, keepaliveCountMax: 2, tryKeyboard: false })

/** Performs only the key exchange, rejecting the key before any authentication is sent. */
export async function probeHostKey(address: ProbeAddress, signal: AbortSignal, limits: ProcessLimits): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const client = new Client()
    let fingerprint: string | undefined, timedOut = false, cancelled = false, done = false
    const finish = () => {
      if (done) return
      done = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (cancelled) reject(new RemoteManagementError(400, 'remote/cancelled', 'SSH operation cancelled'))
      else if (timedOut) reject(new RemoteManagementError(400, 'remote/timeout', 'SSH connection timed out'))
      else if (fingerprint) resolve(fingerprint)
      else reject(new RemoteManagementError(400, 'remote/network', 'Could not obtain the SSH host key; check address, port and network access'))
    }
    const abort = () => { cancelled = true; client.destroy() }
    const timer = setTimeout(() => { timedOut = true; client.destroy() }, limits.timeoutMs)
    client.on('error', () => { /* Expected when the verifier rejects; never reflect protocol messages. */ })
    client.on('close', finish)
    client.on('ready', () => { client.destroy() }) // Defensive: the verifier always refuses authentication.
    signal.addEventListener('abort', abort, { once: true })
    try {
      client.connect({ ...baseConfig(address, limits), username: '__dsh_hostkey_probe__', authHandler: [],
        hostVerifier: (key: Buffer) => { fingerprint = hostFingerprint(key); return false } })
      if (signal.aborted) abort()
    } catch { client.destroy(); finish() }
  })
}

/** Connect and optionally execute ONE internally planned read-only command; undefined means authentication test only. */
export async function runManagedSsh(connection: SshConnection, command: string | undefined,
  signal: AbortSignal, limits: ProcessLimits): Promise<ProcessResult> {
  signal.throwIfAborted()
  FingerprintSchema.parse(connection.fingerprint)
  const method = connection.privateKey === undefined ? 'password' : 'publickey'
  const started = Date.now()
  return new Promise(resolve => {
    const client = new Client()
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let saved = 0, truncated = false, timedOut = false, cancelled = false, authenticated = false, finished = false
    let exitCode: number | null = null, exitSignal: string | null = null, error: string | undefined
    let channel: ClientChannel | undefined
    const finish = () => {
      if (finished) return
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      const ok = authenticated && exitCode === 0 && !error && !timedOut && !cancelled
      resolve({ ok, exitCode, signal: exitSignal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        truncated, timedOut, cancelled, durationMs: Date.now() - started,
        ...(!ok ? { error: cancelled ? 'SSH operation cancelled' : timedOut ? 'SSH connection timed out' : error ?? 'SSH connection closed before the operation completed' } : {}) })
    }
    const destroy = () => { channel?.destroy(); client.destroy() }
    const abort = () => { cancelled = true; destroy() }
    const timer = setTimeout(() => { timedOut = true; destroy() }, limits.timeoutMs)
    const collect = (into: Buffer[], data: Buffer | string) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const keep = Math.max(0, Math.min(chunk.length, limits.maxOutputBytes - saved))
      if (keep) { into.push(Buffer.from(chunk.subarray(0, keep))); saved += keep }
      if (keep < chunk.length) truncated = true
    }
    client.on('error', (failure: Error & { level?: string }) => {
      error ??= failure.level === 'client-authentication' ? `SSH ${method === 'password' ? 'password' : 'private key'} authentication failed`
        : 'SSH connection failed; check address, port and network access'
      destroy()
    })
    client.on('close', finish)
    client.on('ready', () => {
      authenticated = true
      if (signal.aborted || timedOut) { destroy(); return }
      if (command === undefined) { exitCode = 0; client.end(); return }
      client.exec(command, { pty: false }, (failure, stream) => {
        if (failure) { error = 'SSH server refused the diagnostic command'; client.end(); return }
        channel = stream
        stream.on('data', (chunk: Buffer) => collect(stdout, chunk))
        stream.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
        stream.on('error', () => { error = 'SSH diagnostic stream failed'; destroy() })
        stream.on('close', (code: number | undefined, kind: string | undefined) => {
          exitCode = typeof code === 'number' ? code : null; exitSignal = kind ?? null; client.end()
        })
        if (signal.aborted || timedOut) destroy()
      })
    })
    signal.addEventListener('abort', abort, { once: true })
    try {
      client.connect({ ...baseConfig(connection, limits), username: connection.username,
        password: connection.password, privateKey: connection.privateKey, passphrase: connection.passphrase || undefined,
        authHandler: [method], hostVerifier: (key: Buffer) => {
          const matches = sameFingerprint(hostFingerprint(key), connection.fingerprint)
          if (!matches) error = 'SSH host key changed or is not trusted; verify the fingerprint in the management page'
          return matches
        } })
      if (signal.aborted) abort()
    } catch { error = 'Could not start the SSH connection'; destroy(); finish() }
  })
}
