import type { ManagedView, EnvironmentWrite, HostWrite, HostKeyProbe, ConnectionTest, ResourceAction, ResourceWrite } from './managed-types.ts'

export const REMOTE_PAGE = '/environment-resources'
export const REMOTE_API = `${REMOTE_PAGE}/api/`

export const WEBSITE_SYSTEMS = ['oms', 'community', 'zentao'] as const
export type WebsiteSystem = typeof WEBSITE_SYSTEMS[number]

/** HTTPS or literal private IPv4 HTTP. ZenTao can additionally live under an installation path. */
export function isWebsiteAddress(value: string, system: WebsiteSystem): boolean {
  try {
    const url = new URL(value)
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    if (path && (system !== 'zentao' || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path))) return false
    const base = url.origin + path
    if (value !== base && value !== `${base}/`) return false
    // URL canonicalizes IPv4 before the origin comparison above.
    return url.protocol === 'https:' || (url.protocol === 'http:'
      && /^(?:10\.\d+|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+$/.test(url.hostname))
  } catch { return false }
}

export interface RemoteApi {
  'GET remote': { response: ManagedView }
  'POST remote/environments': { body: EnvironmentWrite; response: ManagedView }
  'PUT remote/environments/:environment': { body: EnvironmentWrite; response: ManagedView }
  'DELETE remote/environments/:environment': { body: { revision: number }; response: ManagedView }
  'POST remote/environments/:environment/hosts': { body: HostWrite; response: ManagedView }
  'PUT remote/environments/:environment/hosts/:host': { body: HostWrite; response: ManagedView }
  'DELETE remote/environments/:environment/hosts/:host': { body: { revision: number }; response: ManagedView }
  'POST remote/environments/:environment/hosts/:host/probe': { body: { revision: number }; response: HostKeyProbe }
  'POST remote/environments/:environment/hosts/:host/trust': { body: { revision: number; token: string }; response: ManagedView }
  'POST remote/environments/:environment/hosts/:host/test': { body: { revision: number }; response: ConnectionTest }
  'POST remote/environments/:environment/resources': { body: ResourceWrite; response: ManagedView }
  'PUT remote/environments/:environment/resources/:resource': { body: ResourceWrite; response: ManagedView }
  'DELETE remote/environments/:environment/resources/:resource': { body: { revision: number }; response: ManagedView }
  'POST remote/environments/:environment/resources/:resource/check': { body: { revision: number; action: ResourceAction }; response: ConnectionTest }
}

type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RemoteParams<K extends keyof RemoteApi> = Params<Path<K>>
export type RemoteRequest<K extends keyof RemoteApi> = RemoteParams<K> & Omit<RemoteApi[K], 'response'>
