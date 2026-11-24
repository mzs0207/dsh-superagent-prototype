import type { IncomingMessage, ServerResponse } from 'node:http'

/** A management request failed routing or input parsing before it could run an operation. */
export class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }

export async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}

export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number | undefined): boolean {
  if (port === undefined) return false
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}

export function match<T>(table: Record<string, T>, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    if (verb !== method) continue
    const pattern = path.split('/')
    if (pattern.length !== segments.length || !pattern.every((part, index) => part.startsWith(':') || part === segments[index])) continue
    const params: Record<string, string> = {}
    try { pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segments[index]!) }) }
    catch { throw new RouteError(400, 'A path segment has a malformed escape') }
    return { run, params }
  }
  return undefined
}
