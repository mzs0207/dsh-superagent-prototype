import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { RepositorySnapshotSchema } from './repository.ts'

export const SHARED_ENVIRONMENT = '00000000-0000-4000-8000-000000000001'
export const CATALOG_TYPES = ['project', 'project-relationship', 'person', 'team'] as const
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value))
const prose = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
const base = { name: text(100), notes: prose(2000).default('') }
const RemoteAddress = text(2048).refine(value => {
  if (/^git@[A-Za-z0-9][A-Za-z0-9.-]*:[\w./-]+$/.test(value)) return true
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) && !!url.hostname && !url.password
      && (!url.username || (url.protocol === 'ssh:' && url.username === 'git')) && !url.search && !url.hash
  } catch { return false }
}, 'Use a Git URL without credentials or query parameters')
export const SummaryModelSchema = z.object({ provider: text(120), model: text(160) }).strict()
const Project = z.object({ ...base, type: z.literal('project'), localPath: text(4096).refine(isAbsolute), repository: RemoteAddress,
  model: SummaryModelSchema.optional() }).strict()
const Relationship = z.object({ ...base, type: z.literal('project-relationship'), source: z.uuid(), target: z.uuid(),
  description: prose(2000).refine(Boolean) }).strict()
const Person = z.object({ ...base, type: z.literal('person'), position: text(200), responsibility: prose(3000).refine(Boolean) }).strict()
const Member = z.object({ name: text(100), email: z.string().trim().max(254).pipe(z.email()) }).strict()
const Team = z.object({ ...base, type: z.literal('team'), members: z.array(Member).min(1).max(100)
  .refine(members => new Set(members.map(member => member.email.toLowerCase())).size === members.length) }).strict()
const id = { id: z.uuid() }
const revision = { revision: z.number().int().nonnegative() }
export const CatalogWriteSchema = z.discriminatedUnion('type', [Project.extend(revision), Relationship.extend(revision), Person.extend(revision), Team.extend(revision)])
export const StoredCatalogSchema = z.discriminatedUnion('type', [
  Project.extend({ ...id, scanEnabled: z.boolean(), snapshot: RepositorySnapshotSchema.optional(), refreshRequired: z.boolean().default(false) }),
  Relationship.extend(id), Person.extend(id), Team.extend(id),
])
export const PortableCatalogSchema = z.discriminatedUnion('type', [
  Project.omit({ model: true }).extend({ ...id, snapshot: RepositorySnapshotSchema.optional() }),
  Relationship.extend(id), Person.extend(id), Team.extend(id),
])
export type CatalogWrite = z.input<typeof CatalogWriteSchema>
export type StoredCatalog = z.output<typeof StoredCatalogSchema>
export type StoredProject = Extract<StoredCatalog, { type: 'project' }>
export type CatalogResource = Exclude<StoredCatalog, StoredProject>
  | (Omit<StoredProject, 'snapshot' | 'refreshRequired'> & { commit?: string })
export type SummaryModel = z.output<typeof SummaryModelSchema>
export interface ProjectSummary { commit: string; overview: string; detail: string }