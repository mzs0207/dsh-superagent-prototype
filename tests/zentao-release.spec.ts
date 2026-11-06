import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

let root: string, repo: string, remote: string, baseline: string, fix: string
const helper = resolve('skills/dsh-superagent-zentao/release.py')
function git(args: string[], cwd = repo) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zentao-release-')); repo = join(root, 'repo'); remote = join(root, 'remote.git')
  git(['init', '--bare', remote], root); git(['clone', remote, repo], root)
  git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
  writeFileSync(join(repo, 'bug.txt'), 'broken\n'); writeFileSync(join(repo, 'feature.txt'), 'old\n')
  git(['add', '.']); git(['commit', '-m', 'baseline']); baseline = git(['rev-parse', 'HEAD'])
  git(['branch', '-M', 'develop']); git(['branch', 'test']); git(['push', 'origin', 'develop', 'test'])
  writeFileSync(join(repo, 'feature.txt'), 'unrelated unpublished feature\n'); git(['commit', '-am', 'unrelated feature'])
  writeFileSync(join(repo, 'bug.txt'), 'fixed\n'); git(['commit', '-am', 'fix bug']); fix = git(['rev-parse', 'HEAD']); git(['push', 'origin', 'develop'])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
it('creates a test worktree with only the fix, without publishing until test verification', () => {
  const directory = join(root, 'test-work')
  const output = execFileSync('python3', [helper, 'sync', '--repository', repo, '--commit', fix, '--directory', directory], { encoding: 'utf8' })
  const result = JSON.parse(output)
  expect(readFileSync(join(directory, 'bug.txt'), 'utf8')).toBe('fixed\n')
  expect(readFileSync(join(directory, 'feature.txt'), 'utf8')).toBe('old\n')
  expect(git(['rev-parse', 'test'], remote)).toBe(baseline)
  expect(result.testCommit).toBe(git(['rev-parse', 'HEAD'], directory))
  expect(git(['log', '-1', '--format=%B'], directory)).toContain(fix)
})
it('leaves a conflict for diagnosis and never changes the remote test branch', () => {
  git(['checkout', 'test']); writeFileSync(join(repo, 'bug.txt'), 'independent change\n'); git(['commit', '-am', 'test diverged']); git(['push', 'origin', 'test'])
  const remoteBefore = git(['rev-parse', 'test'], remote); git(['checkout', 'develop'])
  expect(() => execFileSync('python3', [helper, 'sync', '--repository', repo, '--commit', fix, '--directory', join(root, 'test-work')], { stdio: 'pipe' })).toThrow()
  expect(git(['rev-parse', 'test'], remote)).toBe(remoteBefore)
})
it('refuses a commit outside develop instead of publishing arbitrary input', () => {
  git(['checkout', '-b', 'unmerged', baseline]); writeFileSync(join(repo, 'bug.txt'), 'unreviewed\n'); git(['commit', '-am', 'unmerged fix'])
  const unmerged = git(['rev-parse', 'HEAD'])
  expect(() => execFileSync('python3', [helper, 'sync', '--repository', repo, '--commit', unmerged, '--directory', join(root, 'test-work')], { stdio: 'pipe' })).toThrow()
  expect(git(['rev-parse', 'test'], remote)).toBe(baseline)
})

it('rejects an amended test worktree instead of adopting additional changes on a repeated sync', () => {
  const directory = join(root, 'test-work')
  const args = [helper, 'sync', '--repository', repo, '--commit', fix, '--directory', directory]
  const initial = JSON.parse(execFileSync('python3', args, { encoding: 'utf8' }))
  expect(JSON.parse(execFileSync('python3', args, { encoding: 'utf8' }))).toEqual(initial)
  writeFileSync(join(directory, 'feature.txt'), 'unrelated change added during testing\n')
  git(['commit', '-am', 'temporary'], directory)
  git(['reset', '--soft', 'HEAD^'], directory)
  git(['commit', '--amend', '--no-edit'], directory)
  expect(() => execFileSync('python3', args, { stdio: 'pipe' })).toThrow()
  expect(git(['rev-parse', 'test'], remote)).toBe(baseline)
})

it.each([
  { branch: 'develop', deploy: true, sha: 'a'.repeat(40), result: 'SUCCESS' },
  { branch: 'test', deploy: false, sha: 'a'.repeat(40), result: 'SUCCESS' },
  { branch: 'test', deploy: true, sha: 'b'.repeat(40), result: 'SUCCESS' },
  { branch: 'test', deploy: true, sha: 'a'.repeat(40), result: 'FAILURE' },
])('refuses unrelated or unsuccessful Jenkins evidence: %j', ({ branch, deploy, sha, result }) => {
  const build = { number: 7, building: false, result, url: 'http://jenkins.invalid/job/web-community-backend-pipeline/7/',
    actions: [{ parameters: [{ name: 'GIT_BRANCH', value: branch }, { name: 'SERVICE_NAME', value: 'resource-service' }, { name: 'DEPLOY', value: deploy }] },
      { lastBuiltRevision: { SHA1: sha } }] }
  const code = `import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('release', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
client = types.SimpleNamespace(request=lambda *args: (200, sys.argv[2], {}))
module.verify_build(client, {'base_url':'', 'username':'', 'api_token':''}, 7, 'resource-service', 'a'*40)
`
  expect(() => execFileSync('python3', ['-c', code, helper, JSON.stringify(build)], { stdio: 'pipe' })).toThrow()
})

it('preserves existing Jenkins trigger records when publication is reconciled after a restart', () => {
  const directory = join(root, 'test-work'), receipt = join(root, 'release.json')
  const copied = JSON.parse(execFileSync('python3', [helper, 'sync', '--repository', repo, '--commit', fix, '--directory', directory], { encoding: 'utf8' }))
  const code = `import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('release', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.check = lambda *args: None
module.publish(Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4]), sys.argv[5], Path(sys.argv[6]), ['resource-service'])
`
  const args = ['-c', code, helper, repo, fix, directory, copied.testCommit, receipt]
  execFileSync('python3', args, { stdio: 'pipe' })
  const saved = JSON.parse(readFileSync(receipt, 'utf8'))
  saved.builds = { 'resource-service': { starting: true, queue: 73 } }
  writeFileSync(receipt, JSON.stringify(saved))
  execFileSync('python3', args, { stdio: 'pipe' })
  expect(JSON.parse(readFileSync(receipt, 'utf8')).builds).toEqual(saved.builds)
  expect(git(['rev-parse', 'test'], remote)).toBe(copied.testCommit)
})
