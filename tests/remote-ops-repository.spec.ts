import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { repositoryMarkdown, scanRepository } from '../src/remote-ops/repository.ts'
import { ManagedRemoteOps } from '../src/remote-ops/managed.ts'
import type { SummaryRuntime } from '../src/remote-ops/project-refresh.ts'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

it('updates only affected repository layers from committed Git content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-repository-'))
  directories.push(directory)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  await mkdir(join(directory, 'server'))
  await mkdir(join(directory, 'client'))
  await writeFile(join(directory, 'server', 'README.md'), '# Server\nHTTP service')
  await writeFile(join(directory, 'client', 'main.ts'), 'export const version = 1')
  await writeFile(join(directory, 'README.md'), '# Root\nProject overview')
  git('add', '.'); git('commit', '-qm', 'initial')
  await writeFile(join(directory, 'server', 'README.md'), 'uncommitted draft')
  const calls: string[] = []
  const summarize = async (evidence: { layer: string; files: { text: string }[] }) => {
    calls.push(evidence.layer)
    return evidence.layer === 'server' ? evidence.files.map(file => file.text).join('\n') : `${evidence.layer} semantics`
  }
  const signal = new AbortController().signal
  const initial = await scanRepository(directory, undefined, summarize, signal)
  expect(initial.commit).toBe(git('rev-parse', 'HEAD'))
  expect(calls).toEqual(['.', 'client', 'server'])
  expect(initial.layers.find(layer => layer.path === 'server')?.semantic).toContain('HTTP service')
  expect(initial.layers.find(layer => layer.path === 'server')?.semantic).not.toContain('uncommitted')
  expect(repositoryMarkdown(initial).overview).toContain('3 tracked files')
  await writeFile(join(directory, 'server', 'README.md'), '# Revised API\nUpdated')
  git('add', 'server'); git('commit', '-qm', 'update server')
  calls.length = 0
  const next = await scanRepository(directory, initial, summarize, signal)
  expect(calls).toEqual(['server'])
  expect(next.commit).not.toEqual(initial.commit)
  expect(repositoryMarkdown(next).detail).toContain('Revised API')
  expect(next.layers.find(layer => layer.path === 'client')).toEqual(initial.layers.find(layer => layer.path === 'client'))
  git('rm', '-qr', 'client'); git('commit', '-qm', 'remove client')
  const removed = await scanRepository(directory, next, summarize, signal)
  expect(removed.layers.map(layer => layer.path)).toEqual(['.', 'server'])
})

it('automatically summarizes opted-in commits without tools and retains the last good commit on model failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-summary-'))
  directories.push(directory)
  const work = join(directory, 'repo')
  await mkdir(work)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: work, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  await writeFile(join(work, 'README.md'), '# Service\nBusiness workflow')
  await writeFile(join(work, '.env'), 'MUST_NOT_SEND_ENV_VALUE')
  await writeFile(join(work, 'main.ts'), 'const apiKey = \"MUST_NOT_SEND_SOURCE_VALUE\"\nexport const version = 1')
  git('add', '.'); git('commit', '-qm', 'initial')
  const first = git('rev-parse', 'HEAD')
  const requests: unknown[] = []
  let fail = false
  const model: SummaryRuntime = {
    resolveCallConfig: async value => value,
    async *stream(request) {
      requests.push({ tools: request.tools, messages: request.messages })
      if (fail) throw new Error('Provider unavailable')
      yield { type: 'text-delta', index: 0, text: 'Implements the order workflow.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const remote = new ManagedRemoteOps(join(directory, 'vault'), undefined, '', () => model)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const { revision, environments } = await remote.store.view()
    const env = environments.find(item => item.shared)!.id
    const config = { type: 'project', name: 'Service', localPath: work, repository: 'https://example.invalid/repo.git' } as const
    const view = await remote.store.saveCatalog(env, undefined, { ...config, revision, model: { provider: 'fixture', model: 'sample' } })
    const id = view.environments[0]!.catalog![0]!.id
    remote.projects.start()
    await vi.waitFor(async () => expect(await remote.projects.view(env, id)).toMatchObject({ status: 'ready',
      summary: { commit: first, overview: expect.stringContaining('order workflow') } }))
    expect(requests).toEqual([expect.objectContaining({ tools: [] })])
    expect(JSON.stringify(requests)).not.toMatch(/MUST_NOT_SEND_/)
    await writeFile(join(work, 'README.md'), '# Changed workflow')
    git('add', '.'); git('commit', '-qm', 'change')
    const second = git('rev-parse', 'HEAD')
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(async () => expect(await remote.projects.view(env, id)).toMatchObject({ status: 'ready', summary: { commit: second } }))
    expect(requests).toHaveLength(2)
    expect(await remote.store.view()).toMatchObject({ revision: view.revision })
    fail = true
    await writeFile(join(work, 'README.md'), '# Failed model workflow')
    git('add', '.'); git('commit', '-qm', 'provider failure')
    await remote.projects.run(env, id)
    expect(await remote.projects.view(env, id)).toMatchObject({ status: 'error', summary: { commit: second } })
    const attempts = requests.length
    await remote.projects.run(env, id, false)
    expect(requests).toHaveLength(attempts)
    expect(await remote.projects.view(env, id)).toMatchObject({ status: 'error', summary: { commit: second } })
  } finally {
    await remote.stop()
    vi.useRealTimers()
  }
})
