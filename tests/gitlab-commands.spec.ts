import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'

const deployment = () => testDeployment({ provider: 'gitlab', origin: 'http://gitlab.internal:8080',
  repository: 'group/subgroup/widgets', projectId: 42,
  account: { cli: '/agent-glab', login: 'agent.bot', email: 'bot@example.test' } })
const note = z.object({ id: z.number(), body: z.string() })
describe('GitLab project-scoped API', () => {
  it('reads only the resolved project and validates returned data', async () => {
    const commands = new Commands(deployment, {}, new AbortController().signal)
    vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
      if (args[1] !== 'projects/42/issues/3') throw new Error('Request escaped the project')
      return JSON.stringify({ id: 17, body: 'approved request' })
    })
    expect(await commands.api(note, 'issues/3')).toEqual({ id: 17, body: 'approved request' })
    vi.spyOn(commands, 'run').mockResolvedValue('{"id":"not-an-id","body":"invalid"}')
    await expect(commands.api(note, 'issues/3')).rejects.toThrow()
  })
  it.each(['../user', '/user', 'https://outside.test/user', 'issues/%2e%2e/%2e%2e/user', 'issues/%2fuser'])
  ('rejects an escaping project path %s without invoking the CLI', async path => {
    const commands = new Commands(deployment, {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run')
    await expect(commands.api(z.unknown(), path)).rejects.toThrow(/restricted/i)
    expect(run).not.toHaveBeenCalled()
  })
  it('collects later pages without dropping notes after a full first page', async () => {
    const commands = new Commands(deployment, {}, new AbortController().signal)
    const first = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `note ${index + 1}` }))
    vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
      const page = new URL(`http://local/${args[1]}`).searchParams.get('page')
      return JSON.stringify(page === '1' ? first : [{ id: 101, body: 'last note' }])
    })
    expect((await commands.pages(note, 'issues/3/notes')).map(item => item.id))
      .toEqual(Array.from({ length: 101 }, (_, index) => index + 1))
  })
  it('refuses a non-advancing page instead of looping or silently losing history', async () => {
    const commands = new Commands(deployment, {}, new AbortController().signal)
    const page = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: 'note' }))
    vi.spyOn(commands, 'run').mockResolvedValue(JSON.stringify(page))
    await expect(commands.pages(note, 'issues/3/notes')).rejects.toThrow(/pagination/i)
  })
})
