/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_REPOSITORY_PROVIDER', description: { zh: '代码托管平台：github 或 gitlab', en: 'Repository hosting platform: github or gitlab' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY_HOST', description: { zh: '所选代码托管主机的 HTTP(S) 源地址', en: 'HTTP(S) origin of the selected repository host' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY', description: { zh: '所选仓库的完整命名空间路径', en: 'Full namespace path of the selected repository' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY_URL', description: { zh: '所选仓库的网页地址', en: 'Web URL of the selected repository' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY_CLONE_URL', description: { zh: '经部署检查的 HTTP(S) Git 地址；准备工作区时使用', en: 'Validated HTTP(S) Git URL to use when preparing a checkout' } },
  { key: 'DSH_SUPERAGENT_ACCOUNT', description: { zh: '所选代码托管平台上的智能体账号', en: 'Agent account on the selected repository host' } },
  { key: 'DSH_SUPERAGENT_COMMIT_EMAIL', description: { zh: '智能体提交邮箱；提示词没有另指定作者时使用', en: 'Agent commit email, used unless team instructions specify another author' } },
  { key: 'DSH_SUPERAGENT_HEAD_REF', ticket: true, description: { zh: '源 PR/MR 的 head 引用；其他任务为 HEAD', en: 'Head ref of the source PR/MR; HEAD for other work' } },
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const number = trigger?.source === deployment.provider && trigger.meta.isPr === true ? Number(trigger.meta.number) : 0
  const head = number > 0 ? deployment.provider === 'gitlab' ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head` : 'HEAD'
  const executor: Record<string, string> = { DSH_SUPERAGENT_REPOSITORY_PROVIDER: deployment.provider,
    DSH_SUPERAGENT_REPOSITORY_HOST: deployment.origin, DSH_SUPERAGENT_REPOSITORY: deployment.repository,
    DSH_SUPERAGENT_REPOSITORY_URL: deployment.webUrl, DSH_SUPERAGENT_REPOSITORY_CLONE_URL: deployment.cloneUrl,
    DSH_SUPERAGENT_ACCOUNT: deployment.account.login, DSH_SUPERAGENT_COMMIT_EMAIL: deployment.account.email,
    DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '),
    ...ticket ? { DSH_SUPERAGENT_HEAD_REF: head, DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { kind, environment, config } of sources.environments(settings)) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
