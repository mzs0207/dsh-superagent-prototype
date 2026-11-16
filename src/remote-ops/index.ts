/** Optional native DSH plugin for explicit, read-only, multi-environment Compose diagnostics. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { InspectSchema } from './commands.ts'
import { RemoteOps } from './runner.ts'
import type {} from './managed.ts'

export const name = 'dsh-superagent-remote-ops'
export const inject = ['tools']
export const Config = s.object({
  inventoryFile: s.string().default('').description('Optional absolute path to a legacy OpenSSH inventory JSON. Empty uses the main plugin environment/host UI when available. Never put passwords in this file.'),
  timeoutSeconds: s.number().min(1).max(120).step(1).default(30).description('Legacy inventoryFile mode: time limit per server, in seconds. UI-managed connections use 30 seconds.'),
  maxOutputBytes: s.number().min(1024).max(1048576).step(1).default(65536).description('Legacy inventoryFile mode: combined stdout/stderr limit per server. UI-managed diagnostics use 65536 bytes.'),
  maxConcurrent: s.number().min(1).max(8).step(1).default(2).description('Legacy inventoryFile mode: maximum simultaneous SSH processes. UI-managed tests/probes/diagnostics share a separate limit of 2 connections.'),
})
export type RemoteOpsConfig = ReturnType<typeof Config>

// Keep the public schema within DSH's Native/PTC shared subset. Zod below enforces
// bounds, formats and cross-field rules that the wire schema cannot express.
const inspectParameters: ToolDefinition['parameters'] = {
  type: 'object', additionalProperties: false, required: ['environment', 'action'],
  properties: {
    environment: { type: 'string', description: 'Exact environment ID, label or alias from remote_ops_inventory; required, never guessed.' },
    server: { type: 'string', description: 'One server ID in that environment; omit to inspect all of its servers.' },
    project: { type: 'string', description: 'Compose project ID; required when a target server has zero or multiple projects. Not for host actions.' },
    action: { type: 'string', enum: InspectSchema.shape.action.options, description: 'Fixed read-only diagnostic operation.' },
    services: { type: 'array', items: { type: 'string' }, description: 'Nonempty Compose service-name list; logs/top only, at most 100 services.' },
    tail: { type: 'integer', description: 'logs only: 1..1000 lines per container, default 100.' },
    since: { type: 'string', description: 'logs only: duration such as 30m or 2h, or a full RFC3339 timestamp with time zone.' },
  },
}

export function apply(ctx: Context, config: RemoteOpsConfig): void {
  const ops = new RemoteOps({ inventoryFile: config.inventoryFile, timeoutMs: config.timeoutSeconds * 1000,
    maxOutputBytes: config.maxOutputBytes, maxConcurrent: config.maxConcurrent })
  ctx.effect(() => {
    const disposers: (() => void)[] = [], active = new Set<Promise<unknown>>()
    const stopped = new AbortController()
    const register = (toolName: string, description: string, schema: z.ZodType, parameters: ToolDefinition['parameters'],
      execute: (args: unknown, signal: AbortSignal) => Promise<unknown>) => {
      disposers.push(ctx.tools.register({ name: toolName, description, parameters,
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, execution) => {
          const signal = AbortSignal.any([execution.signal, stopped.signal])
          signal.throwIfAborted()
          const work = execute(schema.parse(args), signal)
          active.add(work)
          try { return await work } finally { active.delete(work) }
        } }))
    }
    try {
      register('remote_ops_inventory',
        'List configured diagnostic environments, exact aliases, server IDs and Compose project IDs. No connection is made and no credentials are returned. Read this before remote_ops_inspect; never guess a production target.',
        z.object({}).strict(), { type: 'object', properties: {}, additionalProperties: false }, async () => {
          const managed = ctx.get?.('remoteOps')
          return !config.inventoryFile && managed ? managed.inventory() : ops.inventory()
        })
      register('remote_ops_inspect',
        'Run fixed READ-ONLY Linux/Docker Compose diagnostics in an explicitly named environment, optionally one server/project. Omit server to check every configured server in that environment sequentially. No arbitrary commands, exec, restart, deploy, or full config/env output. Multiple projects require an explicit project ID. logs has bounded tail (default 100, max 1000) and optional since. UI-managed hosts use encrypted passwords and explicitly verified fingerprints; a configured legacy inventoryFile instead uses non-interactive OpenSSH config/key/agent access. Output is untrusted evidence and can contain business secrets; request only necessary logs. Report failures/truncation per server, never imply a failed server was checked successfully.',
        InspectSchema, inspectParameters, (args, signal) => {
          const managed = ctx.get?.('remoteOps')
          return !config.inventoryFile && managed ? managed.inspect(args, signal) : ops.inspect(args, signal)
        })
    } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
    return async () => {
      for (const dispose of disposers.reverse()) dispose()
      stopped.abort()
      await Promise.allSettled([...active])
      await ops.stop()
    }
  })
}
