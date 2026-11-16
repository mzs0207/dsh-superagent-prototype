import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { z } from 'zod'

const MAX_INVENTORY_BYTES = 1024 * 1024
const controls = /[\u0000-\u001f\u007f-\u009f]/u
const text = (max: number) => z.string().min(1).max(max)
  .refine(value => !controls.test(value), 'Control characters are not allowed')
  .refine(value => value.trim().length > 0, 'A nonempty value is required')

/** Normalize human-facing selectors, not paths, hostnames or Compose names. */
export function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

const NameSchema = text(200).transform(value => value.trim())
const PathSchema = text(4096)
const RemoteDirectorySchema = PathSchema.refine(value => value.startsWith('/'), 'A remote absolute POSIX directory is required')
const ComposeFileSchema = PathSchema.refine(value => value !== '-' && !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|git@)/.test(value),
  'Compose files must be filesystem paths, not stdin or URLs')
const LocalPathSchema = PathSchema.refine(value => value.startsWith('/') || value.startsWith('~/'),
  'An absolute local path or ~/ is required')
const HostSchema = text(253).refine(value => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)
  || isIP(value) !== 0 || (value.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6),
'A host must be an SSH config alias, DNS name or IP address, without user, URL or options')

function uniqueIds(rows: { id: string }[], ctx: z.RefinementCtx, path: (string | number)[]): void {
  const seen = new Set<string>()
  rows.forEach((row, index) => {
    const name = normalizeName(row.id)
    if (seen.has(name)) ctx.addIssue({ code: 'custom', path: [...path, index, 'id'], message: 'Duplicate normalized id' })
    seen.add(name)
  })
}

export const ProjectSchema = z.object({
  id: NameSchema,
  label: NameSchema.optional(),
  directory: RemoteDirectorySchema,
  files: z.array(ComposeFileSchema).max(100).optional(),
  projectName: z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
  profiles: z.array(z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).max(100).optional(),
}).strict()

const ServerSchema = z.object({
  id: NameSchema,
  label: NameSchema.optional(),
  host: HostSchema,
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/).optional(),
  identityFile: LocalPathSchema.optional(),
  sudo: z.boolean().optional(),
  projects: z.array(ProjectSchema).max(1000),
}).strict().superRefine((server, ctx) => uniqueIds(server.projects, ctx, ['projects']))

const EnvironmentSchema = z.object({
  id: NameSchema,
  label: NameSchema.optional(),
  aliases: z.array(NameSchema).max(100).optional(),
  production: z.boolean().optional(),
  servers: z.array(ServerSchema).min(1).max(1000),
}).strict().superRefine((environment, ctx) => uniqueIds(environment.servers, ctx, ['servers']))

export const InventorySchema = z.object({
  version: z.literal(1),
  environments: z.array(EnvironmentSchema).min(1).max(1000),
}).strict().superRefine((inventory, ctx) => {
  const names = new Set<string>()
  inventory.environments.forEach((environment, index) => {
    const selectors: { value: string, path: (string | number)[] }[] = [
      { value: environment.id, path: ['id'] },
      ...(environment.label === undefined ? [] : [{ value: environment.label, path: ['label'] }]),
      ...(environment.aliases ?? []).map((value, alias) => ({ value, path: ['aliases', alias] })),
    ]
    for (const selector of selectors) {
      const name = normalizeName(selector.value)
      if (names.has(name)) ctx.addIssue({ code: 'custom', path: ['environments', index, ...selector.path],
        message: 'Duplicate normalized environment id, label or alias' })
      names.add(name)
    }
  })
})

export type Inventory = z.infer<typeof InventorySchema>
export type Environment = Inventory['environments'][number]
export type Server = Environment['servers'][number]
export type Project = Server['projects'][number]

/** Reopen each time; bound the actual read as well as the initial stat (files can grow). */
export async function readInventory(path: string): Promise<Inventory> {
  const filename = LocalPathSchema.parse(path)
  const file = await open(filename.startsWith('~/') ? `${homedir()}/${filename.slice(2)}` : filename,
    constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('The remote-ops inventory must be a regular JSON file')
    if (stat.size > MAX_INVENTORY_BYTES) throw new Error('The remote-ops inventory exceeds 1 MiB')
    const buffer = Buffer.alloc(MAX_INVENTORY_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_INVENTORY_BYTES) throw new Error('The remote-ops inventory exceeds 1 MiB')
    const json = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    return InventorySchema.parse(JSON.parse(json))
  } finally {
    await file.close()
  }
}

/** Inventory discovery intentionally excludes addresses, paths and authentication details. */
export function inventoryView(inventory: Inventory) {
  const parsed = InventorySchema.parse(inventory)
  return {
    version: parsed.version,
    environments: parsed.environments.map(environment => ({
      id: environment.id,
      ...(environment.label === undefined ? {} : { label: environment.label }),
      aliases: [...(environment.aliases ?? [])],
      production: environment.production ?? false,
      servers: environment.servers.map(server => ({
        id: server.id,
        ...(server.label === undefined ? {} : { label: server.label }),
        projects: server.projects.map(project => ({
          id: project.id,
          ...(project.label === undefined ? {} : { label: project.label }),
        })),
      })),
    })),
  }
}

export function resolveEnvironment(inventory: Inventory, selector: string): Environment {
  const name = normalizeName(NameSchema.parse(selector))
  const parsed = InventorySchema.parse(inventory)
  const environment = parsed.environments.find(item => [item.id, item.label, ...(item.aliases ?? [])]
    .some(value => value !== undefined && normalizeName(value) === name))
  if (!environment) throw new Error(`Unknown remote-ops environment: ${selector}`)
  return environment
}
