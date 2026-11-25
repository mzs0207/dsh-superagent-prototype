import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const exec = promisify(execFile)
const Commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const MAX_LAYERS = 128
const MAX_BLOB_BYTES = 16 * 1024
const Manifest = /^(?:readme(?:\.[^.]+)?|package\.json|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|composer\.json|gemfile|dockerfile)$/i
const Source = /\.(?:tsx?|jsx?|py|go|rs|java|kt|cs|rb|php|swift|scala|c|cpp|h|vue|svelte)$/i
const Sensitive = /(?:^|\/)(?:\.[^/]+|[^/]*(?:secret|credential|password|token|private[_-]?key|\.pem|\.p12)[^/]*)(?:\/|$)/i
const CredentialLine = /(?:-----BEGIN .*PRIVATE KEY-----|\b(?:password|passwd|token|secret|api[_-]?key|authorization)\b\s*["']?\s*[:=]|[a-z]+:\/\/[^\s/@]+:[^\s/@]+@)/i
const Layer = z.object({ path: z.string().min(1).max(1024), files: z.number().int().positive(), structural: z.string().max(3500), semantic: z.string().max(2000).optional() }).strict()
export const RepositorySnapshotSchema = z.object({ commit: Commit, layers: z.array(Layer).max(MAX_LAYERS) }).strict()
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>
export type RepositoryEvidence = { layer: string; structural: string; files: { path: string; text: string }[] }
export type SummarizeLayer = (evidence: RepositoryEvidence, signal: AbortSignal) => Promise<string>
type Entry = { path: string; oid: string; size: number; regular: boolean }

const layerOf = (path: string) => path.includes('/') ? path.slice(0, path.indexOf('/')) : '.'
const inline = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/([\\`*_\[\]<>])/g, '\\$1')
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/** Reads one immutable local Git tree; no checkout, hooks, filters, remotes or untracked files. */
export async function scanRepository(directory: string, previous: RepositorySnapshot | undefined, summarize: SummarizeLayer | undefined,
  parent: AbortSignal, beforeScan?: (commit: string) => void): Promise<RepositorySnapshot> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(120_000)])
  if (!isAbsolute(directory)) throw new Error('Select an absolute local repository directory')
  const cwd = await realpath(directory)
  const git = async (args: string[], maxBuffer = 8 * 1024 * 1024) => {
    const { stdout } = await exec('git', ['--no-replace-objects', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args], { cwd, signal, encoding: 'buffer', maxBuffer,
      env: { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } })
    return new TextDecoder('utf-8', { fatal: args[0] !== 'cat-file' }).decode(stdout)
  }
  const root = await git(['rev-parse', '--show-prefix'])
  if (root !== '\n') throw new Error('Select the repository root, not a subdirectory')
  const commit = Commit.parse((await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim())
  beforeScan?.(commit)
  if (previous?.commit === commit) return previous

  let changed: Set<string> | undefined
  if (previous && Commit.safeParse(previous.commit).success) {
    try {
      await git(['merge-base', '--is-ancestor', previous.commit, commit])
      const paths = await git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', previous.commit, commit, '--'])
      changed = new Set(paths.split('\0').filter(Boolean).map(layerOf))
    } catch (error) {
      // Divergent/pruned history is a new baseline; real command failures must not look like an empty diff.
      if (!error || typeof error !== 'object' || !('code' in error) || (error.code !== 1 && error.code !== 128)) throw error
      signal.throwIfAborted()
    }
  }

  const layers = new Map<string, z.infer<typeof Layer>>()
  if (changed && previous) for (const layer of previous.layers) if (!changed.has(layer.path)) layers.set(layer.path, layer)
  const groups = new Map<string, Entry[]>()
  const collect = (text: string, only?: string) => {
    for (const row of text.split('\0')) {
      if (!row) continue
      const tab = row.indexOf('\t'), path = row.slice(tab + 1)
      const [mode, type, oid, size] = row.slice(0, tab).split(/ +/)
      if (type === 'tree') continue
      if (!mode || !oid || !path || !Commit.safeParse(oid).success || (type !== 'blob' && type !== 'commit')) throw new Error('Unexpected Git tree entry')
      const key = layerOf(path)
      if (only !== undefined && key !== only) continue
      let files = groups.get(key)
      if (!files) { files = []; groups.set(key, files) }
      files.push({ path, oid, size: Number(size), regular: mode === '100644' || mode === '100755' })
    }
  }
  if (!changed) collect(await git(['ls-tree', '-rlz', '--full-tree', commit]))
  else for (const layer of changed) {
    collect(await git(layer === '.' ? ['ls-tree', '-lz', '--full-tree', commit] : ['ls-tree', '-rlz', '--full-tree', commit, '--', layer]), layer)
  }
  if (layers.size + groups.size > MAX_LAYERS) throw new Error('Repository exceeds the supported number of top-level layers')
  for (const [layer, files] of [...groups].sort(([a], [b]) => compare(a, b))) {
    const extensions = new Map<string, number>()
    const folders = new Set<string>()
    for (const { path, regular } of files) {
      const file = nameOf(path), ext = /\.[a-z0-9]{1,12}$/i.exec(file)?.[0]?.toLowerCase() ?? 'other'
      const kind = regular ? ext : 'link or submodule'
      extensions.set(kind, (extensions.get(kind) ?? 0) + 1)
      const dir = path.slice(0, path.lastIndexOf('/'))
      if (dir && dir !== layer) folders.add(dir.split('/').slice(0, 2).join('/'))
    }
    const kinds = [...extensions].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).slice(0, 8)
    const structural = [`- File types: ${kinds.map(([kind, count]) => `${inline(kind)} (${count})`).join(', ')}`]
    if (folders.size) structural.push(`- Subdirectories: ${[...folders].slice(0, 12).map(inline).join(', ').slice(0, 1000)}`)
    const definitions = files.filter(file => file.regular && Manifest.test(nameOf(file.path)) && !Sensitive.test(file.path))
    if (definitions.length) structural.push(`- Docs and manifests: ${definitions.slice(0, 8).map(file => inline(file.path)).join(', ').slice(0, 800)}`)
    const input: RepositoryEvidence['files'] = []
    const candidates = [...definitions.slice(0, 3), ...(summarize ? files.filter(file => file.regular && Source.test(file.path) && !Sensitive.test(file.path)).slice(0, 3) : [])]
    for (const file of candidates) {
      if (!(file.size >= 0 && file.size <= MAX_BLOB_BYTES)) continue
      const text = await git(['cat-file', 'blob', file.oid], MAX_BLOB_BYTES)
      if (/[\u0000\ufffd]|-----BEGIN .*PRIVATE KEY-----/.test(text)) continue
      const lines = text.split(/\r?\n/).filter(line => !CredentialLine.test(line))
      if (/^readme/i.test(nameOf(file.path))) {
        const headings = lines.filter(line => /^#{1,4}\s+/.test(line)).slice(0, 3).map(line => inline(line.replace(/^#+\s+/, '').slice(0, 100)))
        if (headings.length) structural.push(`- README: ${headings.join(' / ')}`)
      } else if (nameOf(file.path).toLowerCase() === 'package.json') {
        try {
          const manifest = JSON.parse(text) as { name?: unknown; dependencies?: unknown }
          if (typeof manifest.name === 'string') structural.push(`- Package: ${inline(manifest.name.slice(0, 100))}`)
          if (manifest.dependencies && typeof manifest.dependencies === 'object') {
            const dependencies = Object.keys(manifest.dependencies).slice(0, 8)
            if (dependencies.length) structural.push(`- Dependencies: ${dependencies.map(name => inline(name.slice(0, 100))).join(', ')}`)
          }
        } catch { /* Incomplete or non-JSON manifests still contribute to the file inventory. */ }
      }
      if (summarize) input.push({ path: file.path, text: lines.join('\n').slice(0, 2200) })
    }
    const report = structural.join('\n').slice(0, 3500)
    const semantic = summarize ? (await summarize({ layer, structural: report, files: input }, signal)).trim() : undefined
    if (summarize && !semantic) throw new Error('Model returned an empty project summary')
    layers.set(layer, Layer.parse({ path: layer, files: files.length, structural: report, semantic }))
  }
  signal.throwIfAborted()
  return { commit, layers: [...layers.values()].sort((a, b) => compare(a.path, b.path)) }
}

/** Derives the two Markdown views from the same commit-pinned layer set. */
export function repositoryMarkdown(snapshot: RepositorySnapshot): { overview: string; detail: string } {
  const files = snapshot.layers.reduce((sum, layer) => sum + layer.files, 0)
  const header = `Commit: \`${snapshot.commit}\`\n\n${files} tracked files across ${snapshot.layers.length} layers.`
  return {
    overview: `# Repository overview\n\n${header}\n\n${snapshot.layers.map(layer => `- ${inline(layer.path)}: ${layer.files}${layer.semantic ? ` — ${layer.semantic.split('\n', 1)[0]!.slice(0, 150)}` : ''}`).join('\n')}`,
    detail: `# Repository layers\n\n${header}\n\n${snapshot.layers.map(layer => `## ${inline(layer.path)} (${layer.files} files)\n\n${layer.structural}${layer.semantic ? `\n\n${layer.semantic}` : ''}`).join('\n\n')}`,
  }
}
