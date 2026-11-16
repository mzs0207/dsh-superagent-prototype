/** Shared public management contract. Browser code must import types only: never bundle vault/SSH code. */
import { z } from 'zod'
import { isIP } from 'node:net'
import { ProjectSchema } from './inventory.ts'

const clean = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), 'Control characters are not allowed')
export const RevisionSchema = z.number().int().nonnegative()
export const EnvironmentWriteSchema = z.object({ revision: RevisionSchema, name: clean(100),
  aliases: z.array(clean(100)).max(20).default([]), production: z.boolean().default(false) }).strict()
const AddressSchema = clean(253).refine(value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || isIP(value) !== 0,
  'Use a hostname or IP address, not an SSH alias with options or a URL')
export const HostWriteSchema = z.object({ revision: RevisionSchema, name: clean(100), host: AddressSchema,
  port: z.number().int().min(1).max(65535).default(22), username: clean(100).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/),
  // Passwords are opaque: do not trim, reflect in errors, or put in snapshots returned to the UI.
  password: z.string().max(4096).refine(value => !value.includes('\u0000'), 'NUL is not supported in passwords').optional(),
  projects: z.array(ProjectSchema).max(50).default([]) }).strict()
export const DeleteSchema = z.object({ revision: RevisionSchema }).strict()
export const FingerprintSchema = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
export const TrustSchema = z.object({ revision: RevisionSchema, token: z.string().uuid() }).strict()
export const ProbeSchema = z.object({ revision: RevisionSchema }).strict()
export type EnvironmentWrite = z.input<typeof EnvironmentWriteSchema>
export type HostWrite = z.input<typeof HostWriteSchema>
export type ManagedProject = z.infer<typeof ProjectSchema>
export interface ManagedHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: 'password'
  hasPassword: boolean
  hostKeyFingerprint: string | null
  projects: ManagedProject[]
}
export interface ManagedEnvironment { id: string; name: string; aliases: string[]; production: boolean; hosts: ManagedHost[] }
export interface ManagedView { revision: number; environments: ManagedEnvironment[] }
export interface HostKeyProbe { fingerprint: string; token: string; expiresAt: string }
export interface ConnectionTest { ok: boolean; message: string; durationMs: number }
/** Internal-only connection material; no HTTP response or tool output may serialize this type. */
export interface HostCredentials { revision: number; host: ManagedHost; password: string }
/** Stable, non-sensitive management failures; never include request bodies or crypto/SSH internals. */
export class RemoteManagementError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 500, readonly code: string, message: string) { super(message) }
}
