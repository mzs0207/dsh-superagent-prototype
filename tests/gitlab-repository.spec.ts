import { describe, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { readGithub } from '../src/sources/github-read.ts'
import { readRepositoryPath } from '../src/sources/repository.ts'
import { readGitlab } from '../src/sources/gitlab-read.ts'
import { testDeployment } from './fixtures/deployment.ts'

const commands = () => new Commands(() => testDeployment({ provider: 'gitlab', origin: 'http://gitlab.internal:8080', projectId: 42 }), {}, new AbortController().signal)
describe('selected repository reads', () => {
  it('reads a nested file with a space from GitLab, not a GitHub contents endpoint', async () => {
    const api = commands()
    vi.spyOn(api, 'run').mockImplementation(async (_program, args) => {
      if (args[1] !== 'projects/42/repository/files/src%2Fhello%20world.ts/raw?ref=HEAD') throw new Error('Wrong repository file endpoint')
      return 'export const greeting = "hello"\n'
    })
    expect(await readRepositoryPath(api, 'src/hello world.ts', 'file')).toBe('export const greeting = "hello"\n')
  })
  it('keeps later directory pages and hides non-source entries', async () => {
    const api = commands()
    vi.spyOn(api, 'run').mockImplementation(async (_program, args) => {
      const url = new URL(`http://local/${args[1]}`)
      if (url.pathname !== '/projects/42/repository/tree' || url.searchParams.get('path') !== 'src') throw new Error('Wrong tree endpoint')
      return JSON.stringify(url.searchParams.get('page') === '1'
        ? Array.from({ length: 100 }, (_, n) => ({ name: `file-${n}.ts` }))
        : [{ name: 'last.ts' }, { name: '.env' }, { name: 'node_modules' }])
    })
    const names = (await readRepositoryPath(api, 'src', 'directory')).split('\n')
    expect(names).toContain('last.ts')
    expect(names).toContain('file-99.ts')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('node_modules')
  })
  it.each(['../secrets', '.env', 'src/../secrets', 'node_modules/pkg', 'src\\escape'])('rejects %s before reading the host', async path => {
    const api = commands(); const run = vi.spyOn(api, 'run')
    await expect(readRepositoryPath(api, path, 'file')).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
  it('does not interpret the wrong provider resource grammar', async () => {
    const api = commands(); const run = vi.spyOn(api, 'run')
    await expect(readGithub(api, 'github/issues/7')).rejects.toThrow(/GitHub/)
    const github = new Commands(() => testDeployment(), {}, new AbortController().signal)
    await expect(readGitlab(github, 'gitlab/pipelines/7/jobs')).rejects.toThrow(/GitLab/)
    expect(run).not.toHaveBeenCalled()
  })
})
