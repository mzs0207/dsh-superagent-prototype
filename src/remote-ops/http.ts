import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { json, match, readBody, RouteError, sameOrigin } from '../infra/management-http.ts'
import { REMOTE_API, REMOTE_PAGE, type RemoteApi, type RemoteParams } from './api.ts'
import type { ManagedRemoteOps } from './managed.ts'
import { DeleteSchema, EnvironmentWriteSchema, HostWriteSchema, RemoteManagementError, ResourceActionSchema, ResourceWriteSchema,
  RevisionSchema } from './managed-types.ts'
import { CatalogWriteSchema } from './catalog-types.ts'
import { MAX_IMPORT_BYTES } from './portable.ts'

const clientPath = `${REMOTE_PAGE}/client.js`
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Environments &amp; hosts</title><script defer src="${clientPath}"></script></head><body><div id="environment-resources"></div></body></html>`
const csp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

type Routes = { [K in keyof RemoteApi]: (input: { params: RemoteParams<K>; body: () => Promise<unknown>; signal: AbortSignal })
  => RemoteApi[K]['response'] | Promise<RemoteApi[K]['response']> }

/** Registers the vault admin page and API on the existing local DSH web server, independent of orchestration. */
export function registerRemoteHttp(web: Context['webServer'], remote: ManagedRemoteOps, stopped: AbortSignal): () => void {
  if (web.host !== '127.0.0.1') throw new Error('Environment management requires a loopback Web server')
  const { store } = remote
  const routes: Routes = {
    'GET remote': () => store.view(),
    'POST remote/environments': async ({ body }) => store.createEnvironment(EnvironmentWriteSchema.parse(await body())),
    'PUT remote/environments/:environment': async ({ params, body }) => store.updateEnvironment(params.environment, EnvironmentWriteSchema.parse(await body())),
    'DELETE remote/environments/:environment': async ({ params, body }) => {
      const updated = await store.deleteEnvironment(params.environment, DeleteSchema.parse(await body()).revision)
      remote.projects.cancelEnvironment(params.environment)
      return updated
    },
    'POST remote/environments/:environment/hosts': async ({ params, body }) => store.createHost(params.environment, HostWriteSchema.parse(await body())),
    'PUT remote/environments/:environment/hosts/:host': async ({ params, body }) => store.updateHost(params.environment, params.host, HostWriteSchema.parse(await body())),
    'DELETE remote/environments/:environment/hosts/:host': async ({ params, body }) => store.deleteHost(params.environment, params.host, DeleteSchema.parse(await body()).revision),
    'POST remote/environments/:environment/hosts/:host/probe': async ({ params, body, signal }) => remote.probe(params.environment, params.host, await body(), signal),
    'POST remote/environments/:environment/hosts/:host/trust': async ({ params, body }) => remote.trust(params.environment, params.host, await body()),
    'POST remote/environments/:environment/hosts/:host/test': async ({ params, body, signal }) => remote.test(params.environment, params.host, await body(), signal),
    'POST remote/environments/:environment/resources': async ({ params, body }) =>
      store.saveResource(params.environment, undefined, ResourceWriteSchema.parse(await body())),
    'PUT remote/environments/:environment/resources/:resource': async ({ params, body }) =>
      store.saveResource(params.environment, params.resource, ResourceWriteSchema.parse(await body())),
    'DELETE remote/environments/:environment/resources/:resource': async ({ params, body }) =>
      store.deleteResource(params.environment, params.resource, DeleteSchema.parse(await body()).revision),
    'POST remote/environments/:environment/resources/:resource/check': async ({ params, body, signal }) => {
      const { revision, action } = z.object({ revision: RevisionSchema, action: ResourceActionSchema.shape.action }).strict().parse(await body())
      return remote.check({ ...params, action }, signal, false, revision)
    },
    'POST remote/environments/:environment/catalog': async ({ params, body }) => {
      const input = CatalogWriteSchema.parse(await body())
      const updated = await store.saveCatalog(params.environment, undefined, input)
      if (input.type === 'project') {
        const id = updated.environments.find(env => env.id === params.environment)?.catalog?.at(-1)?.id
        remote.projects.queue(id)
      }
      return updated
    },
    'PUT remote/environments/:environment/catalog/:resource': async ({ params, body }) => {
      const input = CatalogWriteSchema.parse(await body())
      const updated = await store.saveCatalog(params.environment, params.resource, input)
      if (input.type === 'project') remote.projects.queue(params.resource)
      return updated
    },
    'DELETE remote/environments/:environment/catalog/:resource': async ({ params, body }) => {
      const updated = await store.deleteCatalog(params.environment, params.resource, DeleteSchema.parse(await body()).revision)
      remote.projects.queue(params.resource)
      return updated
    },
    'GET remote/environments/:environment/projects/:resource/summary': ({ params }) => remote.projects.view(params.environment, params.resource),
    'POST remote/environments/:environment/projects/:resource/summary': async ({ params }) => {
      await remote.projects.run(params.environment, params.resource)
      return remote.projects.view(params.environment, params.resource)
    },
    'GET remote/export': () => store.exportCatalog(),
    'POST remote/import/preview': async ({ body }) => store.previewImport(z.object({ bundle: z.unknown() }).strict().parse(await body()).bundle),
    'POST remote/import': async ({ body }) => {
      const { revision, bundle, passwords } = z.object({ revision: RevisionSchema, bundle: z.unknown(), passwords: z.unknown() }).strict().parse(await body())
      return store.importCatalog(bundle, revision, passwords)
    },
  }
  return web.register({ kind: 'prefix', path: REMOTE_PAGE, handler: async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    if (method === 'GET' && (pathname === REMOTE_PAGE || pathname === `${REMOTE_PAGE}/` || pathname === clientPath)) {
      const script = pathname === clientPath
      const content = script ? await readFile(new URL('./environment-resources-client.js', import.meta.url)).catch(() => undefined) : page
      if (content === undefined) { json(res, 503, { error: 'Environment management client build is unavailable' }); return }
      res.writeHead(200, { 'content-type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': csp })
      res.end(content)
      return
    }
    if (!pathname.startsWith(REMOTE_API)) { res.writeHead(404); res.end(); return }
    if (!sameOrigin(req, web.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
    const request = new AbortController(), signal = AbortSignal.any([request.signal, stopped])
    const disconnect = () => request.abort()
    req.once?.('aborted', disconnect)
    res.once?.('close', disconnect)
    try {
      const route = match(routes, method, pathname.slice(REMOTE_API.length).split('/'))
      if (!route) throw new RouteError(404, 'Unknown operation')
      const data = await route.run({ params: route.params as never, body: async () => {
        const value = await readBody(req, pathname === `${REMOTE_API}remote/import` || pathname === `${REMOTE_API}remote/import/preview` ? MAX_IMPORT_BYTES : undefined)
        signal.throwIfAborted()
        return value
      }, signal })
      if (!request.signal.aborted) json(res, 200, data)
    } catch (error) {
      if (request.signal.aborted) return
      if (error instanceof RemoteManagementError) json(res, error.status, { error: error.message, code: error.code })
      else if (error instanceof RouteError) json(res, error.status, { error: error.message })
      else if (error instanceof z.ZodError) json(res, 400, { error: 'Invalid environment management input' })
      else json(res, 500, { error: 'Environment management request failed' })
    } finally { req.removeListener?.('aborted', disconnect); res.removeListener?.('close', disconnect) }
  } })
}
