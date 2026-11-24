/** Shared public management contract. Browser code must import types only: never bundle vault/SSH code. */
import { z } from 'zod'
import { isIP } from 'node:net'
import { ProjectSchema } from './inventory.ts'
import { isWebsiteAddress, WEBSITE_SYSTEMS } from './api.ts'

const clean = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), 'Control characters are not allowed')
export const RevisionSchema = z.number().int().nonnegative()
export const EnvironmentWriteSchema = z.object({ revision: RevisionSchema, name: clean(100),
  aliases: z.array(clean(100)).max(20).default([]), production: z.boolean().default(false) }).strict()
const AddressSchema = clean(253).refine(value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || isIP(value) !== 0,
  'Use a hostname or IP address, not an SSH alias with options or a URL')
const PasswordSchema = z.string().max(4096).refine(value => !value.includes('\u0000'), 'NUL is not supported in passwords').optional()
const NotesSchema = z.string().trim().max(2000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)).default('')
const shared = { name: clean(100), notes: NotesSchema, allowWorker: z.boolean().default(false) }
export const PostgresResourceSchema = z.object({ ...shared, type: z.literal('postgresql'), host: AddressSchema,
  port: z.number().int().min(1).max(65535).default(5432), database: clean(100), username: clean(100),
  ca: z.string().trim().max(32768).default('') }).strict()
const ReadPath = z.string().max(1024).refine(value => {
  const path = value.split('?', 1)[0]!
  // Canonical root-relative path only: no second authority, escaped separators or dot segments.
  return /^\/[A-Za-z0-9._~/-]*$/.test(path) && !path.includes('//')
    && !path.split('/').some(segment => segment === '.' || segment === '..')
    && !/[\s#\\\u0000-\u001f\u007f]/u.test(value)
}, 'Use a root-relative path with an optional query string')
export const WebsiteResourceSchema = z.object({ ...shared, type: z.literal('website-account'),
  system: z.enum(WEBSITE_SYSTEMS).default('oms'),
  origin: z.string().max(250).transform(value => value.replace(/([^/])\/$/, '$1')),
  username: clean(254), communityTermsAccepted: z.literal(true).optional(),
}).strict().superRefine((value, ctx) => {
  if (!isWebsiteAddress(value.origin, value.system)) ctx.addIssue({ code: 'custom', path: ['origin'], message: 'Invalid website address' })
  if (value.system !== 'zentao' && !z.email().safeParse(value.username).success) {
    ctx.addIssue({ code: 'custom', path: ['username'], message: 'An email address is required' })
  }
  if (value.communityTermsAccepted && value.system !== 'community') {
    ctx.addIssue({ code: 'custom', path: ['communityTermsAccepted'], message: 'Only community accounts support terms confirmation' })
  }
})
export const ResourceWriteSchema = z.discriminatedUnion('type', [
  PostgresResourceSchema.extend({ revision: RevisionSchema, password: PasswordSchema }),
  WebsiteResourceSchema.safeExtend({ revision: RevisionSchema, password: PasswordSchema }),
])
export const ResourceTypeSchema = z.enum(['linux-host', 'postgresql', 'website-account'])
export const ResourceSearchSchema = z.object({ environment: clean(100), type: ResourceTypeSchema.optional(),
  keyword: clean(100).optional(), resource: z.uuid().optional() }).strict()
export const ResourceActionSchema = z.object({ environment: clean(100), resource: z.uuid(),
  action: z.enum(['database', 'api', 'web']) }).strict()
export const ResourceLoginSchema = z.object({ environment: clean(100), resource: z.uuid(), mode: z.enum(['api', 'web']) }).strict()
export const ResourceSessionReadSchema = ResourceLoginSchema.extend({ path: ReadPath })
export type WebsiteMode = z.infer<typeof ResourceLoginSchema>['mode']
export const HostWriteSchema = z.object({ revision: RevisionSchema, name: clean(100), host: AddressSchema,
  port: z.number().int().min(1).max(65535).default(22), username: clean(100).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/),
  // Passwords are opaque: do not trim, reflect in errors, or put in snapshots returned to the UI.
  password: PasswordSchema, notes: NotesSchema,
  projects: z.array(ProjectSchema).max(50).default([]) }).strict()
export const DeleteSchema = z.object({ revision: RevisionSchema }).strict()
export const FingerprintSchema = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
export const TrustSchema = z.object({ revision: RevisionSchema, token: z.string().uuid() }).strict()
export const ProbeSchema = z.object({ revision: RevisionSchema }).strict()
export type EnvironmentWrite = z.input<typeof EnvironmentWriteSchema>
export type HostWrite = z.input<typeof HostWriteSchema>
export type ResourceWrite = z.input<typeof ResourceWriteSchema>
export type ManagedResource = (z.output<typeof PostgresResourceSchema> | z.output<typeof WebsiteResourceSchema>) & { id: string; hasPassword: true }
export type ResourceAction = z.infer<typeof ResourceActionSchema>['action']
export type ManagedProject = z.infer<typeof ProjectSchema>
export interface ManagedHost {
  id: string
  type?: 'linux-host'
  notes?: string
  name: string
  host: string
  port: number
  username: string
  auth: 'password'
  hasPassword: boolean
  hostKeyFingerprint: string | null
  projects: ManagedProject[]
}
export interface ManagedEnvironment { id: string; name: string; aliases: string[]; production: boolean; hosts: ManagedHost[]; resources?: ManagedResource[] }
export interface ManagedView { revision: number; environments: ManagedEnvironment[] }
export interface HostKeyProbe { fingerprint: string; token: string; expiresAt: string }
export interface ConnectionTest { ok: boolean; message: string; durationMs: number }
/** Internal-only connection material; no HTTP response or tool output may serialize this type. */
export interface HostCredentials { revision: number; host: ManagedHost; password: string }
/** Stable, non-sensitive management failures; never include request bodies or crypto/SSH internals. */
export class RemoteManagementError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 500, readonly code: string, message: string) { super(message) }
}
