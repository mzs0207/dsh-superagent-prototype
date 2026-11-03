import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDeployment, type Probe } from '../src/deployment.ts'
import { testMachine } from './fixtures/deployment.ts'

let directory: string
let cli: string
const host = 'http://gitlab.internal:8080'
const repository = 'team/platform/widgets'
const user = { id: 7, username: 'agent.bot', email: 'agent@example.test', commit_email: 'agent-commits@example.test', is_admin: false }
const project = {
  id: 42, path_with_namespace: repository, http_url_to_repo: `${host}/${repository}.git`,
  web_url: `${host}/${repository}`, default_branch: 'develop', archived: false,
  permissions: { project_access: null, group_access: { access_level: 40 } },
}
function responseProbe(options: { user?: unknown; project?: unknown } = {}): Probe {
  return async argv => {
    const position = argv.indexOf(cli)
    if (position < 0) throw new Error('Unexpected executable')
    const args = argv.slice(position + 1)
    const selected = args.indexOf('--repo')
    if (selected < 0 || args[selected + 1] !== `${host}/${repository}`) throw new Error('Wrong GitLab project origin')
    const endpoint = args[1]
    if (endpoint === 'user') return JSON.stringify(options.user ?? user)
    if (endpoint === `projects/${encodeURIComponent(repository)}`) return JSON.stringify(options.project ?? project)
    throw new Error('Request escaped the selected GitLab project')
  }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gitlab-deployment-'))
  cli = join(directory, 'glab-agent')
  writeFileSync(cli, '#!/bin/sh\nexit 1\n'); chmodSync(cli, 0o755)
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const settings = (extra: Record<string, unknown> = {}) => ({ host, repository, cli, ...extra })
const resolve = (config: Record<string, unknown> = settings(), probe = responseProbe()) =>
  resolveDeployment(testMachine({ stateDir: directory }), config, probe, directory, 'gitlab')

describe('self-managed GitLab deployment', () => {
  it('uses the selected self-managed host and nested project without requiring a GitHub account', async () => {
    const deployment = await resolve()
    expect(deployment).toMatchObject({ provider: 'gitlab', repository, origin: host, projectId: 42,
      cloneUrl: project.http_url_to_repo, webUrl: project.web_url, defaultBranch: 'develop',
      account: { cli, login: 'agent.bot', email: 'agent-commits@example.test' } })
    expect(deployment).not.toHaveProperty('github')
  })
  it('accepts direct project access and rejects read-only memberships or archived repositories', async () => {
    await expect(resolve(settings(), responseProbe({ project: { ...project,
      permissions: { project_access: { access_level: 30 }, group_access: null } } }))).resolves.toMatchObject({ projectId: 42 })
    await expect(resolve(settings(), responseProbe({ project: { ...project,
      permissions: { project_access: { access_level: 20 }, group_access: null } } })))
      .rejects.toMatchObject({ place: 'gitlab', code: 'gitlabRepositoryReadOnly' })
    await expect(resolve(settings(), responseProbe({ project: { ...project, archived: true } })))
      .rejects.toMatchObject({ place: 'gitlab', code: 'gitlabRepositoryReadOnly' })
  })
  it('fails closed when the API returns another project or an off-host clone URL', async () => {
    await expect(resolve(settings(), responseProbe({ project: { ...project, path_with_namespace: 'other/project' } })))
      .rejects.toMatchObject({ place: 'gitlab', code: 'gitlabRepositoryUnreported' })
    await expect(resolve(settings(), responseProbe({ project: { ...project, http_url_to_repo: 'http://outside.test/widgets.git' } })))
      .rejects.toMatchObject({ place: 'gitlab', code: 'gitlabRepositoryUnreported' })
  })
  it.each(['http://name:password@gitlab.internal:8080', 'http://gitlab.internal:8080/path',
    'http://gitlab.internal:8080?other=host', 'ssh://gitlab.internal:8080'])
  ('rejects a credential-bearing or non-origin host %s before running a CLI', async invalidHost => {
    let called = false
    await expect(resolve(settings({ host: invalidHost }), async () => { called = true; return '{}' }))
      .rejects.toMatchObject({ place: 'gitlab', code: 'gitlabHostInvalid' })
    expect(called).toBe(false)
  })
  it('requires an existing explicit CA file rather than disabling certificate verification', async () => {
    await expect(resolve(settings({ caFile: join(directory, 'missing.pem') })))
      .rejects.toMatchObject({ place: 'gitlab', code: 'gitlabCaMissing' })
  })
})
