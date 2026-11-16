import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InspectSchema, planInspection, sshInvocation, type InspectRequest } from '../src/remote-ops/commands.ts'
import { InventorySchema, inventoryView, readInventory, resolveEnvironment, type Inventory } from '../src/remote-ops/inventory.ts'

const project = (id = 'app', directory = '/srv/app') => ({ id, directory })
const server = (id = 'node-1', projects = [project()]) => ({ id, host: `${id}.example.invalid`, projects })
const inventory = (): Inventory => InventorySchema.parse({ version: 1, environments: [
  { id: 'development', label: '开发环境', aliases: ['研发', 'ＤＥＶ'], servers: [server('node-1'), server('node-2')] },
  { id: 'acceptance-apac', label: '验收环境', aliases: ['亚太验收'], production: false, servers: [server('acceptance-1')] },
  { id: 'live', label: '生产环境', aliases: ['线上'], production: true, servers: [server('live-1')] },
] })
const request = (overrides: Partial<InspectRequest> = {}): InspectRequest => ({ environment: '开发环境', action: 'status', ...overrides })
const invoke = (data: Inventory, inspection = request()) => sshInvocation(planInspection(data, inspection)[0]!, inspection)
const remote = (data: Inventory, inspection = request()) => invoke(data, inspection).args.at(-1)!
const directories: string[] = []
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'remote-ops-model-'))
  directories.push(directory)
  return directory
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('remote-ops inventory', () => {
  it('resolves arbitrary environments and Chinese aliases by normalized exact match without a default', () => {
    const data = inventory()
    for (const selector of ['development', ' 开发环境 ', '研发', 'dev', 'ＤＥＶ']) {
      expect(resolveEnvironment(data, selector).id).toBe('development')
    }
    expect(resolveEnvironment(data, '亚太验收').id).toBe('acceptance-apac')
    expect(resolveEnvironment(data, '线上').production).toBe(true)
    for (const selector of ['', ' ', '开发', 'missing', 'live; uname -a']) {
      expect(() => resolveEnvironment(data, selector)).toThrow()
    }
  })

  it('rejects globally duplicate normalized ids, labels and aliases, even within an environment', () => {
    const mutations = [
      (data: Inventory) => { data.environments[1]!.id = 'ＤＥＶＥＬＯＰＭＥＮＴ' },
      (data: Inventory) => { data.environments[1]!.label = ' 研发 ' },
      (data: Inventory) => { data.environments[1]!.aliases = ['开发环境'] },
      (data: Inventory) => { data.environments[0]!.aliases!.push('dev') },
      (data: Inventory) => { data.environments[0]!.label = 'development' },
    ]
    for (const mutate of mutations) {
      const data = inventory(); mutate(data)
      expect(InventorySchema.safeParse(data).success).toBe(false)
      expect(() => resolveEnvironment(data, 'development')).toThrow()
    }
  })

  it('rejects duplicate server/project ids only within their own collection', () => {
    const data = inventory()
    data.environments[0]!.servers.push(server(' ＮＯＤＥ-1 '))
    expect(InventorySchema.safeParse(data).success).toBe(false)
    const other = inventory()
    other.environments[0]!.servers[0]!.projects.push(project('ＡＰＰ'))
    expect(InventorySchema.safeParse(other).success).toBe(false)
    // The same project id on several servers is a valid batch target.
    expect(InventorySchema.safeParse(inventory()).success).toBe(true)
  })

  it('publishes identifiers and labels but omits addresses and every operational/authentication path', () => {
    const data = inventory()
    const node = data.environments[0]!.servers[0]!
    Object.assign(node, { user: 'diagnostic', port: 2222, identityFile: '/secret/key', sudo: true, label: '应用节点' })
    Object.assign(node.projects[0]!, { label: '社区', files: ['compose.prod.yml'], profiles: ['ops'], projectName: 'community' })
    const view = inventoryView(data)
    expect(view.environments[0]).toMatchObject({ id: 'development', label: '开发环境', aliases: ['研发', 'ＤＥＶ'],
      production: false, servers: [{ id: 'node-1', label: '应用节点', projects: [{ id: 'app', label: '社区' }] },
        { id: 'node-2', projects: [{ id: 'app' }] }] })
    expect(view.environments[2]!.production).toBe(true)
    const json = JSON.stringify(view)
    for (const secret of ['example.invalid', 'diagnostic', '2222', '/secret/key', '/srv/app', 'compose.prod.yml', 'community',
      'identityFile', 'sudo', 'profiles', 'projectName', 'directory', 'host', 'user', 'port']) {
      expect(json).not.toContain(secret)
    }
  })

  it('strictly rejects unknown/password/command fields at every level', () => {
    for (const location of ['root', 'environment', 'server', 'project']) {
      for (const field of ['password', 'command', 'sshOptions', 'unexpected']) {
        const data = inventory()
        const container = location === 'root' ? data : location === 'environment' ? data.environments[0]!
          : location === 'server' ? data.environments[0]!.servers[0]! : data.environments[0]!.servers[0]!.projects[0]!
        Object.assign(container, { [field]: 'never accepted' })
        expect(InventorySchema.safeParse(data).success).toBe(false)
      }
    }
  })

  it('validates required fields, limits, paths, SSH hosts/users, Compose names and control characters', () => {
    for (const host of ['-oProxyCommand=bad', 'user@host', 'ssh://host', 'host name', 'host\nname', 'host;id', '$(id)', '']) {
      const data = inventory(); data.environments[0]!.servers[0]!.host = host
      expect(InventorySchema.safeParse(data).success, host).toBe(false)
    }
    for (const host of ['alias', '10.1.2.3', '::1', '2001:db8::1', '[2001:db8::1]', 'a-b.example.invalid']) {
      const data = inventory(); data.environments[0]!.servers[0]!.host = host
      expect(InventorySchema.safeParse(data).success, host).toBe(true)
    }
    const invalidServerFields = [{ port: 0 }, { port: 65536 }, { port: 22.5 }, { port: '22' }, { user: '-root' },
      { user: 'root@host' }, { user: 'root\n' }, { identityFile: 'relative/key' }, { identityFile: '/key\u0000' }, { sudo: 'yes' }]
    for (const fields of invalidServerFields) {
      const data = inventory(); Object.assign(data.environments[0]!.servers[0]!, fields)
      expect(InventorySchema.safeParse(data).success).toBe(false)
    }
    const invalidProjectFields = [{ directory: 'relative/app' }, { directory: '~/app' }, { directory: '/srv/\napp' },
      { files: ['compose\u0000.yml'] }, { files: ['-'] }, { files: [''] }, { files: ['https://example.invalid/compose.yml'] },
      { files: ['oci://example.invalid/compose'] }, { files: ['git@example.invalid:repo.git'] },
      { projectName: '-evil' }, { projectName: 'BadName' },
      { profiles: ['--profile'] }, { profiles: ['a;id'] }]
    for (const fields of invalidProjectFields) {
      const data = inventory(); Object.assign(data.environments[0]!.servers[0]!.projects[0]!, fields)
      expect(InventorySchema.safeParse(data).success).toBe(false)
    }
    const data = inventory(); data.environments[0]!.aliases = ['bad\nname']
    expect(InventorySchema.safeParse(data).success).toBe(false)
    expect(InventorySchema.safeParse({ version: 2, environments: [] }).success).toBe(false)
    expect(InventorySchema.safeParse({ version: 1, environments: [{ id: 'empty', servers: [] }] }).success).toBe(false)
  })

  it('rereads JSON on every call rather than caching or modifying the inventory', async () => {
    const path = join(await temporaryDirectory(), 'inventory.json')
    const first = JSON.stringify(inventory())
    await writeFile(path, first)
    expect((await readInventory(path)).environments[0]!.id).toBe('development')
    const second = inventory(); second.environments[0]!.id = 'new-environment'
    await writeFile(path, JSON.stringify(second))
    expect((await readInventory(path)).environments[0]!.id).toBe('new-environment')
  })

  it('rejects missing, non-file, oversized, invalid UTF-8/JSON and schema-invalid inventories locally', async () => {
    const directory = await temporaryDirectory()
    await expect(readInventory('inventory.json')).rejects.toThrow('absolute local path')
    await expect(readInventory('../inventory.json')).rejects.toThrow('absolute local path')
    await expect(readInventory(join(directory, 'missing.json'))).rejects.toThrow()
    await expect(readInventory(directory)).rejects.toThrow('regular JSON file')
    const path = join(directory, 'inventory.json')
    await writeFile(path, ' '.repeat(1024 * 1024 + 1))
    await expect(readInventory(path)).rejects.toThrow('exceeds 1 MiB')
    await writeFile(path, '{')
    await expect(readInventory(path)).rejects.toThrow()
    await writeFile(path, Buffer.from([0xff]))
    await expect(readInventory(path)).rejects.toThrow()
    await writeFile(path, '{"version":1,"environments":[],"password":"no"}')
    await expect(readInventory(path)).rejects.toThrow()
  })
})

describe('remote-ops inspection planning', () => {
  it('plans all servers in the explicitly chosen environment, or one explicitly selected server', () => {
    const targets = planInspection(inventory(), request())
    expect(targets.map(target => [target.environment.id, target.server.id, target.project?.id])).toEqual([
      ['development', 'node-1', 'app'], ['development', 'node-2', 'app'],
    ])
    expect(planInspection(inventory(), request({ server: ' ＮＯＤＥ-2 ', project: 'ＡＰＰ' }))).toHaveLength(1)
    expect(planInspection(inventory(), request({ environment: '验收环境' }))[0]!.server.id).toBe('acceptance-1')
    for (const fields of [{ environment: 'unknown' }, { server: 'unknown' }, { project: 'unknown' }]) {
      expect(() => planInspection(inventory(), request(fields))).toThrow()
    }
  })

  it('rejects the complete batch if any target is missing or ambiguous rather than guessing a project', () => {
    for (const projects of [[], [project(), project('other')]]) {
      const data = inventory(); data.environments[0]!.servers[1]!.projects = projects
      expect(() => planInspection(data, request())).toThrow('node-2 requires an explicit project')
    }
    const data = inventory(); data.environments[0]!.servers[1]!.projects = [project('other')]
    expect(() => planInspection(data, request({ project: 'app' }))).toThrow('Unknown project on server node-2')
    expect(planInspection(data, request({ server: 'node-1', project: 'app' }))).toHaveLength(1)
  })

  it('requires no project for host actions, even on zero/multi-project servers', () => {
    const data = inventory(); data.environments[0]!.servers[0]!.projects = []
    data.environments[0]!.servers[1]!.projects.push(project('other'))
    for (const action of ['containers', 'resources', 'docker_version'] as const) {
      const targets = planInspection(data, request({ action }))
      expect(targets).toHaveLength(2)
      expect(targets.every(target => target.project === undefined)).toBe(true)
    }
  })

  it('validates request fields and rejects unsupported actions or arbitrary command options', () => {
    for (const action of ['exec', 'restart', 'up', 'down', 'pull', 'config', 'shell']) {
      expect(InspectSchema.safeParse(request({ action } as unknown as InspectRequest)).success).toBe(false)
    }
    for (const extras of [{ command: 'id' }, { password: 'bad' }, { follow: true }, { service: 'api' }, { sudo: true }]) {
      expect(() => planInspection(inventory(), { ...request(), ...extras })).toThrow()
    }
    for (const overrides of [{ environment: '' }, { server: 'x\n' }, { project: 'x\u0000' }]) {
      expect(InspectSchema.safeParse(request(overrides)).success).toBe(false)
    }
  })

  it('allows service filtering only for logs/top and log parameters only for logs, without a default-tail false positive', () => {
    for (const action of ['status', 'logs', 'images', 'top', 'services', 'containers', 'resources', 'docker_version'] as const) {
      expect(InspectSchema.safeParse(request({ action })).success, action).toBe(true)
      expect(InspectSchema.parse(request({ action })).tail).toBeUndefined()
      expect(InspectSchema.safeParse(request({ action, services: ['api'] })).success).toBe(action === 'logs' || action === 'top')
      expect(InspectSchema.safeParse(request({ action, tail: 10 })).success).toBe(action === 'logs')
      expect(InspectSchema.safeParse(request({ action, since: '30m' })).success).toBe(action === 'logs')
      expect(InspectSchema.safeParse(request({ action, project: 'app' })).success)
        .toBe(!['containers', 'resources', 'docker_version'].includes(action))
    }
    for (const tail of [0, 1001, 1.5, '100']) {
      expect(InspectSchema.safeParse({ ...request({ action: 'logs' }), tail }).success).toBe(false)
    }
    for (const services of [[], ['--follow'], ['api;id'], ['$(id)'], ['api\nworker'], ['api worker']]) {
      expect(InspectSchema.safeParse(request({ action: 'logs', services })).success).toBe(false)
    }
  })

  it('accepts bounded log durations or full RFC3339 timestamps, never free shell text or local dates', () => {
    for (const since of ['30m', '2h', '60s', '2026-11-13T01:02:03Z', '2026-11-13T09:02:03+08:00', '2026-11-13T01:02:03.123Z']) {
      expect(InspectSchema.safeParse(request({ action: 'logs', since })).success, since).toBe(true)
    }
    for (const since of ['', 'yesterday', '2026-11-13', '2026-11-13T01:02:03', '2026-11-13T01:02Z',
      '2026-02-30T01:02:03Z', '2026-11-13T01:02:03+99:00', '0m', '-2h', '999999999h', '2h;id', '$(id)', '30m\n', '--follow']) {
      expect(InspectSchema.safeParse(request({ action: 'logs', since })).success, since).toBe(false)
    }
  })
})

describe('remote-ops SSH invocation', () => {
  it('returns local argv, forces host verification/noninteractive SSH and disables forwarding, local commands and multiplexing', () => {
    const data = inventory()
    Object.assign(data.environments[0]!.servers[0]!, { user: 'diagnostic', port: 2222, identityFile: '~/keys/diagnostic key' })
    const invocation = invoke(data)
    expect(invocation.executable).toBe('ssh')
    expect(invocation.args.slice(0, 2)).toEqual(['-T', '-n'])
    expect(invocation.args).toEqual(expect.arrayContaining(['BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
      'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'ForwardAgent=no', 'ForwardX11=no',
      'ForwardX11Trusted=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'LocalCommand=none', 'RemoteCommand=none',
      'ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', 'RequestTTY=no', 'SessionType=default', 'ForkAfterAuthentication=no']))
    expect(invocation.args.slice(-9, -1)).toEqual(['-p', '2222', '-l', 'diagnostic', '-i', join(homedir(), 'keys/diagnostic key'),
      '--', 'node-1.example.invalid'])
    expect(invocation.args.at(-1)).toBe("cd '/srv/app' && 'docker' 'compose' 'ps' '--all' '--format' 'json'")
    expect(invocation).not.toHaveProperty('shell')
  })

  it('builds only fixed read-only Compose commands, with bounded non-follow logs and service filtering', () => {
    const data = inventory()
    const cases: [InspectRequest, string][] = [
      [request({ action: 'status' }), "'ps' '--all' '--format' 'json'"],
      [request({ action: 'images' }), "'images'"],
      [request({ action: 'services' }), "'config' '--services'"],
      [request({ action: 'top', services: ['api', 'worker'] }), "'top' 'api' 'worker'"],
      [request({ action: 'logs' }), "'logs' '--no-color' '--timestamps' '--tail' '100'"],
      [request({ action: 'logs', services: ['api'], tail: 50, since: '30m' }),
        "'logs' '--no-color' '--timestamps' '--tail' '50' '--since' '30m' 'api'"],
    ]
    for (const [inspection, suffix] of cases) {
      expect(remote(data, inspection)).toBe(`cd '/srv/app' && 'docker' 'compose' ${suffix}`)
      expect(remote(data, inspection)).not.toContain('--follow')
    }
  })

  it('preserves Compose override order and profiles and uses only noninteractive sudo for Docker', () => {
    const data = inventory()
    const node = data.environments[0]!.servers[0]!; node.sudo = true
    Object.assign(node.projects[0]!, { files: ['compose.yml', 'compose.override.yml', '/config/compose.prod.yml'],
      projectName: 'community', profiles: ['web', 'ops'] })
    expect(remote(data)).toBe("cd '/srv/app' && 'sudo' '-n' 'docker' 'compose' '-f' 'compose.yml' '-f' 'compose.override.yml' "
      + "'-f' '/config/compose.prod.yml' '--project-name' 'community' '--profile' 'web' '--profile' 'ops' 'ps' '--all' '--format' 'json'")
    expect(remote(data, request({ action: 'containers' }))).toBe("'sudo' '-n' 'docker' 'ps' '--all' '--no-trunc'")
    expect(remote(data, request({ action: 'resources' }))).not.toContain('sudo')
  })

  it('quotes remote directory and Compose file metacharacters as literal data (local fake Docker; no SSH)', async () => {
    const directory = await temporaryDirectory()
    const docker = join(directory, 'docker')
    await writeFile(docker, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n`)
    await chmod(docker, 0o700)
    const data = inventory()
    const files = ["compose 'quoted';$(echo INJECTED).yml", 'space name.yml', '/tmp/`id`.yml', '--not-an-option']
    Object.assign(data.environments[0]!.servers[0]!.projects[0]!, { directory, files })
    // Emulate only the remote POSIX shell, using a temporary fake docker executable.
    const output = execFileSync('/bin/sh', ['-c', remote(data)], { env: { ...process.env, PATH: directory }, encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual(['compose', '-f', files[0], '-f', files[1], '-f', files[2], '-f', files[3],
      'ps', '--all', '--format', 'json'])
    data.environments[0]!.servers[0]!.projects[0]!.directory = "/srv/it's $(id); `uname`"
    expect(remote(data)).toContain("cd '/srv/it'\\''s $(id); `uname`' &&")
  })

  it('marks each multi-command exit status, runs every diagnostic, and retains overall failure', async () => {
    const directory = await temporaryDirectory()
    for (const name of ['uname', 'uptime', 'df', 'free', 'docker']) {
      await writeFile(join(directory, name), `#!${process.execPath}\nconsole.log(${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' '));\n`
        + `process.exit(${name === 'uptime' || name === 'docker' ? 7 : 0})\n`)
      await chmod(join(directory, name), 0o700)
    }
    const data = inventory()
    for (const action of ['resources', 'docker_version'] as const) {
      let failure: { status: number, stdout: string } | undefined
      try { execFileSync('/bin/sh', ['-c', remote(data, request({ action }))],
        { env: { ...process.env, PATH: directory }, encoding: 'utf8' }) }
      catch (error) { failure = error as { status: number, stdout: string } }
      expect(failure?.status).toBe(7)
      if (action === 'resources') {
        for (const label of ['uname', 'uptime', 'df', 'free']) expect(failure?.stdout).toContain(`[remote-ops ${label} exit=`)
        expect(failure?.stdout).toContain('[remote-ops uptime exit=7]')
        expect(failure?.stdout).toContain('[remote-ops free exit=0]')
      } else {
        expect(failure?.stdout).toContain('[remote-ops docker-version exit=7]')
        expect(failure?.stdout).toContain('[remote-ops compose-version exit=7]')
        expect(failure?.stdout).toContain('docker compose version')
      }
    }
  })

  it('revalidates public calls and refuses a target inconsistent with its plan', () => {
    const inspection = request()
    const target = planInspection(inventory(), inspection)[0]!
    expect(() => sshInvocation({ ...target, server: server('unknown') }, inspection)).toThrow('validated plan')
    expect(() => sshInvocation({ ...target, project: project('unknown') }, inspection)).toThrow('validated plan')
    expect(() => sshInvocation(target, { ...inspection, tail: 100 })).toThrow()
    const canonical = sshInvocation(target, inspection)
    const forgedHost = { ...target, server: { ...target.server, host: 'evil.example.invalid' } }
    expect(sshInvocation(forgedHost, inspection)).toEqual(canonical)
  })
})
