import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { SettingsSchema, policyVersion, selectRepositoryProvider } from '../src/policy.ts'
import { Setup, setupChanged } from '../src/app/setup.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { testMachine } from './fixtures/deployment.ts'

const gitlabSource: SourceKind = { kind: 'gitlab', title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: 'GitLab', en: 'GitLab' }, schema: z.object({}), fields: [], health: [],
  defaultEnabled: false, repositoryProvider: 'gitlab' }
const githubSource: SourceKind = { kind: 'github', title: { zh: 'GitHub', en: 'GitHub' },
  description: { zh: 'GitHub', en: 'GitHub' }, schema: z.object({}), fields: [], health: [], repositoryProvider: 'github' }

describe('repository hosting selection', () => {
  it('defaults to automatic selection and preserves an explicit hosting choice', () => {
    expect(SettingsSchema.parse({}).executor.repositoryProvider).toBe('auto')
    expect(SettingsSchema.parse({ executor: { repositoryProvider: 'github' } }).executor.repositoryProvider).toBe('github')
    expect(SettingsSchema.parse({ executor: { repositoryProvider: 'gitlab' } }).executor.repositoryProvider).toBe('gitlab')
  })
  it('reruns setup and invalidates authorization when the target provider changes', () => {
    const before = SettingsSchema.parse({})
    const after = { ...before, executor: { ...before.executor, repositoryProvider: 'gitlab' as const } }
    expect(setupChanged(before, after)).toBe(true)
    expect(policyVersion(before)).not.toBe(policyVersion(after))
  })
  it('does not activate a hosting source for a different target provider', () => {
    const settings = SettingsSchema.parse({ executor: { repositoryProvider: 'github' }, sources: { github: { enabled: true }, gitlab: { enabled: true } } })
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

const githubConfig = { repository: 'team/widgets', cli: '/agent-gh' }
const gitlabConfig = { host: 'https://gitlab.internal:8443', repository: 'team/subgroup/widgets', cli: '/agent-glab' }
const automatic = (github: Record<string, unknown> = {}, gitlab: Record<string, unknown> = {}) => SettingsSchema.parse({
  executor: { repositoryProvider: 'auto' }, sources: {
    github: { enabled: true, config: github }, gitlab: { enabled: true, config: gitlab },
  },
})
describe('automatic repository selection', () => {
  it('requires either platform without choosing GitHub merely because it is the legacy default', () => {
    expect(selectRepositoryProvider(automatic())).toEqual({ problem: 'repositoryChoiceUnset' })
  })
  it('selects GitHub when it alone has a repository and CLI', () => {
    expect(selectRepositoryProvider(automatic(githubConfig))).toEqual({ provider: 'github' })
  })
  it('selects GitLab when it alone has a host, nested project and CLI', () => {
    const settings = automatic({}, gitlabConfig)
    expect(selectRepositoryProvider(settings)).toEqual({ provider: 'gitlab' })
    const sources = new SourceRegistry(() => settings)
    sources.register(githubSource); sources.register(gitlabSource)
    expect(sources.instance('gitlab')?.enabled).toBe(true)
    expect(sources.instance('github')?.enabled).toBe(false)
  })
  it('ignores an incomplete alternative rather than requiring both platforms', () => {
    expect(selectRepositoryProvider(automatic({ repository: 'team/unfinished' }, gitlabConfig))).toEqual({ provider: 'gitlab' })
    expect(selectRepositoryProvider(automatic(githubConfig, { host: 'https://gitlab.internal', repository: 'team/unfinished' })))
      .toEqual({ provider: 'github' })
  })
  it('requires an explicit target when both platforms are configured and starts neither source', () => {
    const settings = automatic(githubConfig, gitlabConfig)
    expect(selectRepositoryProvider(settings)).toEqual({ problem: 'repositoryChoiceAmbiguous' })
    const sources = new SourceRegistry(() => settings)
    sources.register(githubSource); sources.register(gitlabSource)
    expect(sources.instance('github')?.enabled).toBe(false)
    expect(sources.instance('gitlab')?.enabled).toBe(false)
  })
  it('never replaces an explicit target with the other configured repository', () => {
    const settings = automatic({}, gitlabConfig)
    settings.executor.repositoryProvider = 'github'
    expect(selectRepositoryProvider(settings)).toEqual({ provider: 'github' })
  })
  it('changes authorization when automatic selection changes the actual repository host', () => {
    const github = automatic(githubConfig)
    const gitlab = automatic({}, gitlabConfig)
    expect(policyVersion(github)).not.toBe(policyVersion(gitlab))
    expect(setupChanged(github, gitlab)).toBe(true)
  })
  it.each([
    ['repositoryChoiceUnset', {}, {}],
    ['repositoryChoiceAmbiguous', githubConfig, gitlabConfig],
  ] as const)('reports %s on the hosting settings instead of demanding GitHub', async (code, github, gitlab) => {
    const setup = new Setup({ context: new Context(), machine: testMachine(),
      lifetime: new AbortController().signal, restart: () => {} })
    expect(await setup.run(automatic(github, gitlab))).toBe(false)
    expect(setup.problem).toMatchObject({ place: 'executor', code })
  })
})
