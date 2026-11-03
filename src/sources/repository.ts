/** Read non-hidden source files and directory listings from the selected repository's default branch. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'

const EntrySchema = z.looseObject({ name: z.string() })
export async function readRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (path.includes('\\') || parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  let entries: { name: string }[]
  if (commands.deployment.provider === 'gitlab') {
    const name = parts.join('/')
    if (kind === 'file') return commands.api(`repository/files/${encodeURIComponent(name)}/raw?ref=HEAD`)
    entries = await commands.pages(EntrySchema, `repository/tree?path=${encodeURIComponent(name)}&ref=HEAD`)
  } else {
    const resource = `contents/${parts.map(encodeURIComponent).join('/')}`
    if (kind === 'file') return commands.api(resource, '-H', 'Accept: application/vnd.github.raw')
    const result = await commands.api(z.union([z.array(EntrySchema), z.looseObject({})]), resource)
    if (!Array.isArray(result)) throw new Error(`${path} is not a directory`)
    entries = result
  }
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}
