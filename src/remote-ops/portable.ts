import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { PortableCatalogSchema, SHARED_ENVIRONMENT } from './catalog-types.ts'
import { EnvironmentWriteSchema, HostWriteSchema, PostgresResourceSchema, PrivateKeySecretSchema,
  RemoteManagementError, WebsiteResourceSchema } from './managed-types.ts'

const id = { id: z.uuid() }
const PortableHost = HostWriteSchema.omit({ revision: true, password: true, privateKey: true, passphrase: true }).extend({
  ...id, auth: z.literal('private-key').optional(),
})
const PortableResource = z.discriminatedUnion('type', [PostgresResourceSchema.omit({ allowWorker: true }).extend(id),
  z.object(WebsiteResourceSchema.shape).omit({ allowWorker: true, communityTermsAccepted: true }).extend(id).strict()
    .refine(({ id: _, ...fields }) => WebsiteResourceSchema.safeParse(fields).success),
])
const PortableEnvironment = EnvironmentWriteSchema.omit({ revision: true }).extend({ ...id,
  hosts: z.array(PortableHost).max(1000), resources: z.array(PortableResource).max(1000), catalog: z.array(PortableCatalogSchema).max(1000),
})
export const PortableBundleSchema = z.object({ format: z.literal('dsh-environment-resources'), version: z.literal(1),
  environments: z.array(PortableEnvironment).max(1001) }).strict()
export type PortableBundle = z.output<typeof PortableBundleSchema>
export type PortableEnvironment = z.output<typeof PortableEnvironment>
interface CredentialRequest { id: string; name: string; environment: string }
export interface ImportPreview {
  revision: number
  added: number
  unchanged: number
  passwords: CredentialRequest[]
  privateKeys?: CredentialRequest[]
}
export const ImportPasswordsSchema = z.record(z.uuid(), HostWriteSchema.shape.password.unwrap().refine(value => value.length > 0))
export const ImportPrivateKeysSchema = z.record(z.uuid(), PrivateKeySecretSchema)
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024

/** Merge by stable IDs only. Any non-identical existing record is a conflict, not an overwrite. */
export function planImport(current: PortableBundle, incoming: PortableBundle, revision: number) {
  const passwords: CredentialRequest[] = [], privateKeys: CredentialRequest[] = []
  let added = 0, unchanged = 0
  const environments = new Map(current.environments.map(environment => [environment.id, environment]))
  const existingIds = new Set(current.environments.flatMap(env => [...env.hosts, ...env.resources, ...env.catalog].map(item => item.id)))
  const included = new Set<string>()
  const conflict = () => new RemoteManagementError(409, 'import_conflict', 'Import conflicts with an existing record or repeats an ID. Nothing was changed.')
  for (const { hosts, resources, catalog, ...header } of incoming.environments) {
    if (included.has(header.id)) throw conflict()
    included.add(header.id)
    const env = environments.get(header.id)
    if (header.id === SHARED_ENVIRONMENT) {
      if (!env || header.production || header.aliases.length) throw conflict()
    } else if (env && !isDeepStrictEqual(header, { id: env.id, name: env.name, aliases: env.aliases, production: env.production })) throw conflict()
    if (env) unchanged++; else added++
    const merge = <T extends { id: string; name: string }>(prior: T[], next: T[], request?: (item: T) => CredentialRequest[]) => {
      const records = new Map(prior.map(record => [record.id, record]))
      for (const item of next) {
        if (included.has(item.id)) throw conflict()
        included.add(item.id)
        const saved = records.get(item.id)
        if (saved) {
          // A portable snapshot is never allowed to replace a live project's checkpoint.
          const { snapshot: _before, ...before } = saved as T & { snapshot?: unknown }
          const { snapshot: _after, ...after } = item as T & { snapshot?: unknown }
          if (!isDeepStrictEqual(before, after)) throw conflict()
          unchanged++
          continue
        }
        if (existingIds.has(item.id)) throw conflict()
        existingIds.add(item.id)
        records.set(item.id, item)
        request?.(item).push({ id: item.id, name: item.name, environment: env?.name ?? header.name })
        added++
      }
      return [...records.values()]
    }
    environments.set(header.id, { ...(env ?? header),
      hosts: merge(env?.hosts ?? [], hosts, item => item.auth === 'private-key' ? privateKeys : passwords),
      resources: merge(env?.resources ?? [], resources, () => passwords), catalog: merge(env?.catalog ?? [], catalog) })
  }
  const result = PortableBundleSchema.safeParse({ ...current, environments: [...environments.values()] })
  if (!result.success) throw new RemoteManagementError(400, 'invalid_import', 'The merged import exceeds configuration limits or is invalid.')
  return { bundle: result.data, preview: { revision, added, unchanged, passwords, ...(privateKeys.length && { privateKeys }) } satisfies ImportPreview }
}
