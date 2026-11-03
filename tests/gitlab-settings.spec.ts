import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SettingsSchema, policyVersion } from '../src/policy.ts'
import { setupChanged } from '../src/app/setup.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'

const gitlabSource: SourceKind = { kind: 'gitlab', title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: 'GitLab', en: 'GitLab' }, schema: z.object({}), fields: [], health: [],
  defaultEnabled: false, repositoryProvider: 'gitlab' }
const githubSource: SourceKind = { kind: 'github', title: { zh: 'GitHub', en: 'GitHub' },
  description: { zh: 'GitHub', en: 'GitHub' }, schema: z.object({}), fields: [], health: [], repositoryProvider: 'github' }

describe('repository hosting selection', () => {
  it('keeps legacy settings on GitHub and stores an explicit GitLab selection', () => {
    expect(SettingsSchema.parse({}).executor.repositoryProvider).toBe('github')
    expect(SettingsSchema.parse({ executor: { repositoryProvider: 'gitlab' } }).executor.repositoryProvider).toBe('gitlab')
  })
  it('reruns setup and invalidates authorization when the target provider changes', () => {
    const before = SettingsSchema.parse({})
    const after = { ...before, executor: { ...before.executor, repositoryProvider: 'gitlab' as const } }
    expect(setupChanged(before, after)).toBe(true)
    expect(policyVersion(before)).not.toBe(policyVersion(after))
  })
  it('does not activate a hosting source for a different target provider', () => {
    const settings = SettingsSchema.parse({ sources: { github: { enabled: true }, gitlab: { enabled: true } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(githubSource); sources.register(gitlabSource)
    expect(sources.instance('github')?.enabled).toBe(true)
    expect(sources.instance('gitlab')?.enabled).toBe(false)
    settings.executor.repositoryProvider = 'gitlab'
    expect(sources.instance('github')?.enabled).toBe(false)
    expect(sources.instance('gitlab')?.enabled).toBe(true)
    expect(sources.scope({ source: 'github', meta: {} })).toMatchObject({ listened: false })
  })
  it('keeps a newly installed GitLab source off until explicitly enabled', () => {
    const settings = SettingsSchema.parse({ executor: { repositoryProvider: 'gitlab' } })
    const sources = new SourceRegistry(() => settings); sources.register(gitlabSource)
    expect(sources.instance('gitlab')?.enabled).toBe(false)
  })
})
