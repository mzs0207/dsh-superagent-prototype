import { homedir } from 'node:os'
import { z } from 'zod'
import { normalizeName, resolveEnvironment, type Environment, type Inventory, type Project, type Server } from './inventory.ts'

const SelectorSchema = z.string().min(1).max(200)
  .refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), 'Control characters are not allowed')
  .refine(value => value.trim().length > 0, 'A nonempty selector is required')
  .transform(value => value.trim())
const ServiceSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
const TimestampSchema = z.iso.datetime({ offset: true }).refine(value =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'A full RFC3339 timestamp is required')
const DurationSchema = z.string().regex(/^[1-9]\d{0,8}[smh]$/).refine(value => {
  const seconds = Number(value.slice(0, -1)) * (value.endsWith('h') ? 3600 : value.endsWith('m') ? 60 : 1)
  return seconds <= 9_223_372_036 // Docker's Go duration is a signed int64 of nanoseconds.
}, 'The log duration exceeds the supported range')
const SinceSchema = z.union([DurationSchema, TimestampSchema])

export const InspectSchema = z.object({
  environment: SelectorSchema,
  server: SelectorSchema.optional(),
  project: SelectorSchema.optional(),
  action: z.enum(['status', 'logs', 'images', 'top', 'services', 'containers', 'resources', 'docker_version']),
  services: z.array(ServiceSchema).min(1).max(100).optional(),
  // Apply 100 only when building logs; a schema-wide default would invalidate other actions.
  tail: z.number().int().min(1).max(1000).optional(),
  since: SinceSchema.optional(),
}).strict().superRefine((request, ctx) => {
  if (request.action !== 'logs') {
    for (const field of ['tail', 'since'] as const) {
      if (request[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is only allowed for logs` })
    }
  }
  if (request.action !== 'logs' && request.action !== 'top' && request.services !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['services'], message: 'services is only allowed for logs or top' })
  }
  if (hostAction(request.action) && request.project !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['project'], message: 'Host actions do not accept a project' })
  }
})

export type InspectRequest = z.infer<typeof InspectSchema>
export interface InspectionTarget {
  environment: Environment
  server: Server
  project?: Project
}
export interface Invocation { executable: string, args: string[] }

function hostAction(action: InspectRequest['action']): boolean {
  return action === 'containers' || action === 'resources' || action === 'docker_version'
}

/** Resolve the entire batch before a caller is allowed to start its first process. */
export function planInspection(inventory: Inventory, request: InspectRequest): InspectionTarget[] {
  const parsed = InspectSchema.parse(request)
  const environment = resolveEnvironment(inventory, parsed.environment)
  const servers = parsed.server === undefined ? environment.servers : environment.servers.filter(server =>
    normalizeName(server.id) === normalizeName(parsed.server!))
  if (servers.length === 0) throw new Error(`Unknown server in environment ${environment.id}: ${parsed.server}`)
  return servers.map(server => {
    if (hostAction(parsed.action)) return { environment, server }
    let project: Project | undefined
    if (parsed.project !== undefined) {
      project = server.projects.find(item => normalizeName(item.id) === normalizeName(parsed.project!))
      if (!project) throw new Error(`Unknown project on server ${server.id}: ${parsed.project}`)
    } else {
      if (server.projects.length !== 1) {
        throw new Error(`Server ${server.id} requires an explicit project (found ${server.projects.length})`)
      }
      project = server.projects[0]!
    }
    return { environment, server, project }
  })
}

/** POSIX shell data quoting; no user-supplied string is ever remote shell syntax. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
const command = (args: string[]) => args.map(quote).join(' ')

function docker(server: Server): string[] {
  return server.sudo ? ['sudo', '-n', 'docker'] : ['docker']
}

function compose(target: InspectionTarget): string[] {
  const project = target.project
  if (!project) throw new Error('A Compose inspection requires a planned project')
  return [
    ...docker(target.server), 'compose',
    ...(project.files ?? []).flatMap(file => ['-f', file]),
    ...(project.projectName === undefined ? [] : ['--project-name', project.projectName]),
    ...(project.profiles ?? []).flatMap(profile => ['--profile', profile]),
  ]
}

/** Fixed multi-command diagnostics include each exit code and propagate any failure. */
function diagnostic(steps: { label: string, args: string[] }[]): string {
  return ['overall=0', ...steps.map(step => `${command(step.args)}; rc=$?; `
    + `printf ${quote(`\n[remote-ops ${step.label} exit=%s]\n`)} "$rc"; `
    + 'if [ "$rc" -ne 0 ]; then overall=$rc; fi'), 'exit "$overall"'].join('; ')
}

function remoteCommand(target: InspectionTarget, request: InspectRequest): string {
  switch (request.action) {
    case 'containers': return command([...docker(target.server), 'ps', '--all', '--no-trunc'])
    case 'resources': return diagnostic([
      { label: 'uname', args: ['uname', '-a'] },
      { label: 'uptime', args: ['uptime'] },
      { label: 'df', args: ['df', '-h'] },
      { label: 'free', args: ['free', '-m'] },
    ])
    case 'docker_version': return diagnostic([
      { label: 'docker-version', args: [...docker(target.server), 'version'] },
      { label: 'compose-version', args: [...docker(target.server), 'compose', 'version'] },
    ])
    default: {
      const prefix = compose(target)
      let args: string[]
      switch (request.action) {
        case 'status': args = ['ps', '--all', '--format', 'json']; break
        case 'logs': args = ['logs', '--no-color', '--timestamps', '--tail', String(request.tail ?? 100),
          ...(request.since === undefined ? [] : ['--since', request.since]), ...(request.services ?? [])]; break
        case 'images': args = ['images']; break
        case 'top': args = ['top', ...(request.services ?? [])]; break
        case 'services': args = ['config', '--services']; break
        default: throw new Error('Unsupported remote-ops action')
      }
      return `cd ${quote(target.project!.directory)} && ${command([...prefix, ...args])}`
    }
  }
}

/** The caller must spawn executable/args with shell:false (never join them locally). */
export function sshInvocation(target: InspectionTarget, request: InspectRequest): Invocation {
  const parsed = InspectSchema.parse(request)
  // Revalidate at this public boundary too. Build from the environment's canonical
  // entries, never from independently supplied target host/path overrides.
  const planned = planInspection({ version: 1, environments: [target.environment] }, parsed)
  const canonical = planned.find(item => item.server.id === target.server.id && item.project?.id === target.project?.id)
  if (!canonical) throw new Error('The inspection target does not match the validated plan')
  const server = canonical.server
  const options = [
    'BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
    'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'NumberOfPasswordPrompts=0',
    'ForwardAgent=no', 'ForwardX11=no', 'ForwardX11Trusted=no', 'ClearAllForwardings=yes',
    'PermitLocalCommand=no', 'LocalCommand=none', 'RemoteCommand=none',
    'ControlMaster=no', 'ControlPath=none', 'ControlPersist=no',
    'RequestTTY=no', 'SessionType=default', 'ForkAfterAuthentication=no',
    'ConnectionAttempts=1',
  ]
  const identity = server.identityFile?.startsWith('~/')
    ? `${homedir()}/${server.identityFile.slice(2)}` : server.identityFile
  return {
    executable: 'ssh',
    args: ['-T', '-n', ...options.flatMap(option => ['-o', option]),
      ...(server.port === undefined ? [] : ['-p', String(server.port)]),
      ...(server.user === undefined ? [] : ['-l', server.user]),
      ...(identity === undefined ? [] : ['-i', identity]),
      '--', server.host, remoteCommand(canonical, parsed)],
  }
}

/** Password transport uses the identical validated fixed command, never a caller-provided shell fragment. */
export function diagnosticCommand(target: InspectionTarget, request: InspectRequest): string {
  return sshInvocation(target, request).args.at(-1)!
}
