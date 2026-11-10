/** Ticket-scoped ZenTao operations with durable verification and release checkpoints. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { latestReport, liveTicket, type Ticket } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import { packagePath } from '../../infra/paths.ts'
import { ticketBranch } from '../../sources/change.ts'
import { GitlabMergeRequestSchema } from '../../sources/gitlab-trigger.ts'
import { ZentaoClient } from '../../sources/zentao-client.ts'
import { ZentaoConfigSchema, zentaoBlockedNotice, zentaoNamespace } from '../../sources/zentao.ts'
import type { SourceContext } from '../../sources/host.ts'
import type { Store } from '../store.ts'
import type { ResourceHost } from '../resources.ts'
import { tool, type Tool } from './tool.ts'

export interface ZentaoWorkflow {
  head?: string; reproduction?: string; tests?: string; cause?: string; changes?: string
  mr?: number; mergeCommit?: string
  testDirectory?: string; testCommit?: string; testBase?: string; testVerification?: string
  receipt?: string; published?: boolean; resolved?: boolean; failureSeen?: string
  deployment?: { at: string; builds: { number: number; service: string; url: string; commit: string }[] }
  liveVerification?: string
}
export interface ZentaoToolsHost {
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly repository: SourceContext
  readonly resources: Pick<ResourceHost, 'store'>
}
const Sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const Proof = z.string().trim().min(1).max(8000)
const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z.object({ action: z.literal('file'), file_id: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('verified'), head: Sha, reproduction: Proof, tests: Proof, cause: Proof, changes: Proof }).strict(),
  z.object({ action: z.literal('merge'), mr: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('sync_test') }).strict(),
  z.object({ action: z.literal('publish_test'), verification: Proof, services: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1).max(30) }).strict(),
  z.object({ action: z.literal('resolve'), resolved_build: z.string().regex(/^[1-9]\d*$/), verification: Proof }).strict(),
])
const MergeRequest = GitlabMergeRequestSchema.extend({ merge_commit_sha: Sha.nullish(), squash_commit_sha: Sha.nullish(),
  draft: z.boolean().optional(), work_in_progress: z.boolean().optional(), blocking_discussions_resolved: z.boolean().optional(),
  head_pipeline: z.looseObject({ status: z.string(), sha: z.string() }).nullish() })

/** Runs inside the report transaction: queue the notification before pausing; failed delivery remains in the durable outbox. */
export function guardZentaoReport(host: ZentaoToolsHost, ticket: Ticket, report: { state: string; summary: string; human_action?: string | null }): string | undefined {
  const trigger = host.resources.store.triggers.get(ticket.origin.triggerId)
  if (trigger?.source !== 'zentao') return undefined
  const previous = latestReport(ticket)
  if (report.state === 'dropped') throw new Error('ZenTao bugs must be notified and paused with state=blocked, not dropped or closed')
  if ((previous?.state === 'blocked' || previous?.state === 'failed') && report.state !== 'blocked' && report.state !== 'failed') throw new Error('This bug is paused; only a manual ticket retry may resume it')
  if (report.state === 'ready' && !host.repository.state.get(KV.zentao.workflow(ticket.id))?.resolved) throw new Error('Complete test deployment, verification and ZenTao resolution before reporting ready')
  if (report.state !== 'blocked' && report.state !== 'failed') return undefined
  const message = zentaoBlockedNotice(ticket, trigger, report.summary)
  host.repository.notify(message)
  return message.id
}

export function zentaoTools(host: ZentaoToolsHost, initial: Ticket): Tool[] {
  if (host.resources.store.triggers.get(initial.origin.triggerId)?.source !== 'zentao') return []
  const operation = tool({
    name: 'orchestrator_zentao',
    description: 'Read the current assigned bug/images, record reproduction and tested HEAD, merge its verified MR to develop, cherry-pick only that change into a separate test worktree, publish after testing, then resolve only after Jenkins and live verification. Load dsh-superagent-zentao. On failure report blocked with evidence; never retry a paused assignment yourself.',
    schema: Action,
    execute: async (args, signal) => {
      const ticket = host.store.tickets.get(initial.id)
      if (!ticket || !liveTicket(ticket)) throw new Error('Ticket ended; do not resume it')
      const trigger = host.resources.store.triggers.get(ticket.origin.triggerId)!
      const source = host.resources.store.settings().sources.zentao
      if (!source?.enabled) throw new Error('ZenTao source is disabled')
      const config = ZentaoConfigSchema.parse(source.config)
      if (trigger.meta.namespace !== zentaoNamespace(config) || config.repository !== host.repository.deployment.webUrl) throw new Error('ZenTao source or bound repository changed; stop this bug')
      const state = host.repository.state.get(KV.zentao.workflow(ticket.id)) ?? {}
      const client = new ZentaoClient(config, signal), bugId = Number(trigger.meta.bugId)
      const helper = packagePath('skills', 'dsh-superagent-zentao', 'release.py')
      if (args.action === 'read') return { ...state.resolved ? { resolution_confirmed: true } : { bug: await client.bug(bugId) },
        workflow: state, test_api: config.testApi, release_helper: helper }
      const latest = latestReport(ticket)
      if (latest?.state === 'blocked' || latest?.state === 'failed') throw new Error('This bug is paused; wait for a panel Retry or an authorized notification-topic resume')
      const directory = ticket.execution?.directory
      if (!directory) throw new Error('The ticket has no prepared worktree')
      const commands = host.repository.commands.withSignal(signal)
      const persist = () => host.repository.state.set(KV.zentao.workflow(ticket.id), state)
      if (args.action === 'file') {
        const bug = await client.bug(bugId)
        const ids = [...bug.steps.matchAll(/(?:fileID=|file-read-)(\d+)/gi)].map(match => Number(match[1]))
        const files = z.union([z.array(z.looseObject({ id: z.coerce.number() })), z.record(z.string(), z.unknown())]).safeParse(bug.files)
        if (files.success) ids.push(...(Array.isArray(files.data) ? files.data.map(file => file.id) : Object.keys(files.data).map(Number)))
        if (!ids.includes(args.file_id)) throw new Error('Choose a file attached to this bug')
        const { bytes } = await client.file(args.file_id)
        const extension = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'jpg'
          : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
          : bytes.subarray(0, 3).toString() === 'GIF' ? 'gif'
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'webp' : undefined
        if (!extension) throw new Error('Attachment is not a supported image; do not treat an HTML login page as screenshot evidence')
        const folder = join(dirname(directory), '.zentao-files', ticket.id)
        await mkdir(folder, { recursive: true, mode: 0o700 })
        const path = join(folder, `${args.file_id}.${extension}`)
        await writeFile(path, bytes, { mode: 0o600 })
        return { path, instruction: 'Read this image with the file/image tool before drawing conclusions.' }
      }
      if (args.action !== 'resolve' && (await client.bug(bugId)).status !== 'active') throw new Error('Bug is no longer active; stop work')
      if (args.action === 'verified') {
        if (state.mergeCommit) throw new Error('Already merged; do not replace the verified revision')
        const head = (await commands.git(['rev-parse', 'HEAD'], directory)).trim()
        if (head !== args.head || (await commands.git(['status', '--porcelain'], directory)).trim()) throw new Error('Verification must name the clean current HEAD')
        // Fail before merging when the actual release path or credentials are unavailable.
        await commands.run('python3', [helper, 'check', '--repository', directory], directory)
        Object.assign(state, { head, reproduction: args.reproduction, tests: args.tests, cause: args.cause, changes: args.changes }); persist()
        return { verified: true, head }
      }
      if (!state.head || !state.reproduction || !state.tests) throw new Error('Reproduce the bug, test the fix and record verified HEAD first')
      if (host.repository.deployment.provider !== 'gitlab') throw new Error('This release workflow requires the configured GitLab repository')
      const deployment = host.repository.deployment
      if (args.action === 'merge') {
        let mr = await commands.api(MergeRequest, `merge_requests/${args.mr}`)
        if (!ticketBranch(ticket, mr.source_branch) || mr.author.username !== deployment.account.login || mr.source_project_id !== deployment.projectId
          || mr.target_project_id !== deployment.projectId || mr.target_branch !== 'develop' || mr.sha !== state.head) throw new Error('MR is not this ticket’s verified develop change')
        if (mr.state !== 'merged') {
          if (mr.state !== 'opened' || mr.draft || mr.work_in_progress || mr.blocking_discussions_resolved === false) throw new Error('MR is not mergeable; resolve reviews or pause')
          if (mr.head_pipeline && (mr.head_pipeline.status !== 'success' || mr.head_pipeline.sha !== state.head)) throw new Error('The verified MR HEAD has no successful finished pipeline')
          await commands.run(deployment.account.cli, ['mr', 'merge', String(args.mr), '--repo', deployment.webUrl, '--sha', state.head, '--auto-merge=false', '--squash', '--yes'], directory)
          mr = await commands.api(MergeRequest, `merge_requests/${args.mr}`)
        }
        const commit = mr.squash_commit_sha || mr.merge_commit_sha
        if (mr.state !== 'merged' || !commit) throw new Error('GitLab did not confirm a merged fix commit')
        Object.assign(state, { mr: args.mr, mergeCommit: commit }); persist()
        return { merged: true, mr: args.mr, commit, next: 'sync_test; test that separate worktree before publish_test' }
      }
      if (!state.mergeCommit || !state.mr) throw new Error('Merge this verified fix into develop first')
      if (args.action === 'sync_test') {
        const result = z.object({ testDirectory: z.string(), testCommit: Sha, testBase: Sha }).parse(JSON.parse(await commands.run('python3',
          [helper, 'sync', '--repository', directory, '--commit', state.mergeCommit, '--directory', `${directory}-test`], directory,
          { DSH_SUPERAGENT_ACCOUNT: deployment.account.login, DSH_SUPERAGENT_COMMIT_EMAIL: deployment.account.email })))
        Object.assign(state, result); persist()
        return { ...result, published: false, next: 'Run targeted tests in testDirectory; then publish_test with their output and affected services.' }
      }
      if (!state.testCommit || !state.testDirectory || !state.testBase) throw new Error('Create and verify the isolated cherry-picked test worktree first')
      if (args.action === 'publish_test') {
        const receipt = `${directory}-zentao-release.json`
        await commands.run('python3', [helper, 'publish', '--repository', directory, '--commit', state.mergeCommit,
          '--directory', state.testDirectory, '--test-commit', state.testCommit, '--receipt', receipt, '--services', ...args.services], directory)
        Object.assign(state, { receipt, published: true, testVerification: args.verification }); persist()
        return { published: true, testCommit: state.testCommit, receipt, deploy: ['python3', helper, 'deploy', '--receipt', receipt],
          instruction: 'Run deploy with the shell/job tool and wait for exit 0. On failure report blocked; do not retrigger. Then verify the original bug against the test API.' }
      }
      if (!state.published || !state.receipt || !state.testVerification) throw new Error('Publish and deploy the verified test commit first')
      if (state.resolved) return { resolved: true, next: 'Report ready' }
      const receipt = z.looseObject({ repository: z.string(), mergeCommit: Sha, testCommit: Sha }).parse(JSON.parse(await readFile(state.receipt, 'utf8')))
      if (receipt.repository !== directory || receipt.mergeCommit !== state.mergeCommit || receipt.testCommit !== state.testCommit) throw new Error('Release receipt does not match this verified ticket')
      const release = z.object({ testCommit: Sha, builds: z.array(z.object({ number: z.number(), service: z.string(), url: z.string(), commit: Sha })).min(1) })
        .parse(JSON.parse(await commands.run('python3', [helper, 'verify', '--receipt', state.receipt], directory)))
      if (release.testCommit !== state.testCommit || release.builds.some(build => build.commit !== state.testCommit)) throw new Error('Jenkins deployed another commit')
      // Keep proven deployment and live verification even if writing the ZenTao resolution fails.
      Object.assign(state, { deployment: { at: new Date().toISOString(), builds: release.builds }, liveVerification: args.verification }); persist()
      const summary = `已修复并完成测试环境验证。\n复现：${state.reproduction}\n修复测试：${state.tests}\nMR: ${deployment.webUrl}/-/merge_requests/${state.mr}\ndevelop: ${state.mergeCommit}\ntest: ${state.testCommit}\n测试分支验证：${state.testVerification}\n部署：${release.builds.map(build => `${build.service} ${build.url}`).join('\n')}\n发布后复验：${args.verification}`
      await client.resolve(bugId, args.resolved_build, `resolved-${ticket.id}`, summary)
      state.resolved = true; persist()
      return { resolved: true, testCommit: state.testCommit, builds: release.builds, next: 'Report ready with this result. Do not close the bug.' }
    },
  })
  return [{ ...operation, execute: async (args, signal) => {
    const input = Action.parse(args)
    try { return await operation.execute(input, signal) }
    catch (error) {
      const current = host.store.tickets.get(initial.id)
      if (current && liveTicket(current) && input.action !== 'read' && input.action !== 'file') {
        host.store.atomic(() => {
          const summary = `自动处理在 ${input.action} 阶段停止：${error instanceof Error ? error.message : String(error)}`
          guardZentaoReport(host, current, { state: 'blocked', summary })
          host.repository.tickets.block(current.id, summary)
        })
      }
      throw error
    }
  } }]
}
