import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentVariables, writeEnvironment } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
it('gives Git only the selected GitLab account on its HTTP origin and never an ambient account', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gitlab-credentials-')); directories.push(directory)
  const binaryDirectory = join(directory, 'real'); mkdirSync(binaryDirectory)
  const cli = join(binaryDirectory, 'glab-agent')
  writeFileSync(cli, `#!/bin/sh
if [ -n "$GITLAB_TOKEN$GLAB_TOKEN$GITLAB_ACCESS_TOKEN$OAUTH_TOKEN$JOB_TOKEN$CI_JOB_TOKEN" ]; then echo 'ambient credentials leaked' >&2; exit 2; fi
cat >/dev/null
printf 'username=agent.bot\\npassword=fixture-bot-credential\\n'
`); chmodSync(cli, 0o755)
  const origin = 'http://gitlab.internal:8080'
  await writeEnvironment(testDeployment({ stateDir: directory, provider: 'gitlab', origin,
    repository: 'group/subgroup/widgets', cloneUrl: `${origin}/group/subgroup/widgets.git`,
    webUrl: `${origin}/group/subgroup/widgets`, projectId: 42,
    account: { cli, login: 'agent.bot', email: 'bot@example.test' } }), [])
  const env = { ...process.env, HOME: directory, GITLAB_TOKEN: 'personal-token', GLAB_TOKEN: 'personal-token',
    GITLAB_ACCESS_TOKEN: 'personal-token', OAUTH_TOKEN: 'personal-token', JOB_TOKEN: 'personal-token', CI_JOB_TOKEN: 'personal-token', ...agentVariables(directory) }
  const ask = async (host: string, protocol = 'http') => {
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    const child = execFile('git', ['credential', 'fill'], { env }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin!.end(`protocol=${protocol}\nhost=${host}\n\n`)
    return promise
  }
  await expect(ask('outside.example:8080')).rejects.toThrow()
  await expect(ask('gitlab.internal:8080', 'https')).rejects.toThrow()
  const answer = await ask('gitlab.internal:8080')
  expect(answer).toContain('username=agent.bot')
  expect(answer).toContain('password=fixture-bot-credential')
  expect(answer).not.toContain('personal-token')
}, 30_000)
