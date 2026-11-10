/** Explicit setup/start commands for the private mobile gateway; never changes the DSH profile. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { hashPassword, loopbackOrigin, privateAddress, startGateway } from './gateway.ts'

const Config = z.object({ host: z.string().refine(privateAddress), port: z.number().int().min(1).max(65535),
  upstream: z.string().transform(loopbackOrigin), password: z.object({ salt: z.string().regex(/^[a-f0-9]{32}$/), hash: z.string().regex(/^[a-f0-9]{64}$/) }) }).strict()
const help = `Superagent Android tasks and conversations (trusted LAN HTTP)
  pnpm mobile setup --host <LAN-IPv4> [--port 3083] [--upstream http://127.0.0.1:3082]
  pnpm mobile start        Run the mobile gateway in the foreground
  pnpm mobile password     Change the access password; restart the viewer afterwards
All commands accept --state-dir <private-directory> (default ~/.dsh/state/superagent-mobile).
Setup/password ask for a hidden password, or read it from stdin when piped.
HTTP sends passwords, tasks and conversation content in plaintext: use only a trusted LAN.
No listener or DSH profile changes occur until start.`
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let value = ''
    for await (const chunk of process.stdin) {
      value += chunk.toString()
      if (value.length > 1024) throw new Error('Password input is too long')
    }
    return value.replace(/\r?\n$/, '')
  }
  process.stdout.write('Access password (8–256 characters, hidden): ')
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      process.stdin.removeListener('data', input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n')
      if (error) reject(error); else resolve(value)
    }
    const input = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') { finish(new Error('Cancelled')); return }
        if (char === '\r' || char === '\n') { finish(); return }
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('')
        else if (char >= ' ' && value.length < 257) value += char
      }
    }
    process.stdin.on('data', input)
  })
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    host: { type: 'string' }, port: { type: 'string' }, upstream: { type: 'string' },
    'state-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } })
  const command = positionals[0]
  if (values.help || !command) { console.log(help); return }
  if (positionals.length !== 1 || !['setup', 'start', 'password'].includes(command)) throw new Error(help)
  if (command !== 'setup' && (values.host || values.port || values.upstream)) throw new Error('Address options belong to setup; start uses the saved configuration')
  const directory = values['state-dir'] ?? join(homedir(), '.dsh', 'state', 'superagent-mobile'), path = join(directory, 'connection.json')
  if (command === 'setup') {
    if (!values.host || !privateAddress(values.host)) throw new Error('Specify --host with this computer’s private LAN IPv4 address')
    if (existsSync(path)) throw new Error('Configuration already exists. Use start or password')
    const config = Config.parse({ host: values.host, port: Number(values.port ?? 3083), upstream: values.upstream ?? 'http://127.0.0.1:3082',
      password: await hashPassword(await readPassword()) })
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700)
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' })
    console.log(`Saved private configuration. Run start, then enter http://${config.host}:${config.port} in the Android app.`)
    return
  }
  const config = Config.parse(JSON.parse(readFileSync(path, 'utf8')))
  if (command === 'password') {
    config.password = await hashPassword(await readPassword())
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path)
    console.log('Password changed. Stop and restart the viewer to invalidate existing logins.')
    return
  }
  const gateway = await startGateway(config)
  console.log(`Mobile tasks and conversations: ${gateway.origin}\nTrusted LAN HTTP only. Press Ctrl+C to stop.`)
  let closing = false
  const close = () => { if (!closing) { closing = true; void gateway.close().catch(() => { process.exitCode = 1 }) } }
  process.once('SIGINT', close); process.once('SIGTERM', close)
}
void main().catch(error => { console.error(error instanceof z.ZodError ? 'Invalid mobile configuration or address' : error instanceof Error ? error.message : 'Mobile viewer failed'); process.exitCode = 1 })
