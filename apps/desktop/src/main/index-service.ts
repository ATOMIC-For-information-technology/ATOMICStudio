import { readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import * as fsService from './fs-service'

/**
 * Lightweight project symbol index for the agent's cross-file awareness (the
 * "blind on large codebases" wedge). Regex-based on purpose: no parser deps,
 * language-tolerant (TS/JS/JSX/Vue/Svelte/Python), fast enough to rebuild on
 * every run, and "good enough" — the agent verifies with read_file anyway.
 */

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|py)$/
export const MAX_FILES = 300
const MAX_FILE_BYTES = 256 * 1024
const MAX_INDEX_CHARS = 4_000

interface SymbolHit {
  name: string
  line: number
}

/** Extract declared/exported top-level names from one file's source. */
export function extractSymbols(source: string, path: string): SymbolHit[] {
  const out: SymbolHit[] = []
  const seen = new Set<string>()
  const push = (name: string | undefined, line: number): void => {
    if (name && !seen.has(name) && /^[A-Za-z_$][\w$]*$/.test(name)) {
      seen.add(name)
      out.push({ name, line })
    }
  }

  const patterns: RegExp[] = path.endsWith('.py')
    ? [/^\s*(?:def|class)\s+([\w]+)/]
    : [
        // export (default) (async) function/class Name · export const Name
        /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s*\*?\s+([\w$]+)/,
        /^\s*export\s+(?:const|let|var)\s+([\w$]+)/,
        // top-level declarations (component files often don't export inline)
        /^(?:async\s+)?function\s*\*?\s+([\w$]+)/,
        /^class\s+([\w$]+)/,
        /^const\s+([\w$]+)\s*(?:=|:)/,
        // CJS: module.exports.name / exports.name
        /^\s*(?:module\.)?exports\.([\w$]+)\s*=/
      ]

  source.split('\n').forEach((lineText, i) => {
    for (const re of patterns) {
      const m = lineText.match(re)
      if (m) {
        push(m[1], i + 1)
        break
      }
    }
  })
  return out
}

/**
 * Compact one-line-per-file index, e.g. `src/App.tsx: App, useThing`.
 * Bounded by MAX_INDEX_CHARS so it never bloats the agent's context.
 */
export function buildSymbolIndex(root: string): string {
  const lines: string[] = []
  let files = 0
  const walk = (rel: string): void => {
    if (files >= MAX_FILES) return
    for (const entry of fsService.listDir(root, rel)) {
      if (files >= MAX_FILES) return
      if (entry.isDir) {
        walk(entry.path)
        continue
      }
      if (!CODE_EXT.test(entry.name)) continue
      files++
      try {
        const abs = join(root, entry.path)
        if (statSync(abs).size > MAX_FILE_BYTES) continue
        const syms = extractSymbols(readFileSync(abs, 'utf8'), entry.path)
        if (syms.length) lines.push(`${entry.path}: ${syms.map((s) => s.name).join(', ')}`)
      } catch {
        /* unreadable — skip */
      }
    }
  }
  walk('')
  let text = lines.join('\n')
  if (text.length > MAX_INDEX_CHARS) text = text.slice(0, MAX_INDEX_CHARS) + '\n… (index truncated)'
  return text
}

/** Locate a symbol by (partial, case-insensitive) name: `file:line name`. */
export function findSymbol(root: string, query: string): string {
  const q = query.toLowerCase()
  const hits: string[] = []
  let files = 0
  const walk = (rel: string): void => {
    if (hits.length >= 20 || files >= MAX_FILES) return
    for (const entry of fsService.listDir(root, rel)) {
      if (hits.length >= 20 || files >= MAX_FILES) return
      if (entry.isDir) {
        walk(entry.path)
        continue
      }
      if (!CODE_EXT.test(entry.name)) continue
      files++
      try {
        const abs = join(root, entry.path)
        if (statSync(abs).size > MAX_FILE_BYTES) continue
        for (const s of extractSymbols(readFileSync(abs, 'utf8'), entry.path)) {
          if (s.name.toLowerCase().includes(q)) hits.push(`${entry.path}:${s.line} ${s.name}`)
        }
      } catch {
        /* skip */
      }
    }
  }
  walk('')
  return hits.length ? hits.join('\n') : `No symbol matching "${query}" found.`
}

// ---------------------------------------------------------------- AI project index v2

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync as fsWrite } from 'node:fs'

export interface IndexedFile {
  path: string
  symbols: SymbolHit[]
  imports: string[]
}

export interface ProjectIndex {
  root: string
  builtAt: number
  files: IndexedFile[]
}

const memCache = new Map<string, ProjectIndex>()

function cachePath(root: string): string {
  const dir = join(app.getPath('userData'), 'index')
  mkdirSync(dir, { recursive: true })
  return join(dir, createHash('sha1').update(root).digest('hex') + '.json')
}

// Four ways a file can depend on another, ALL of which must become graph edges — the Unused-File Finder
// calls a file "safe to remove" when nothing imports it, so a missed form = a false "delete me":
//   static   `import x from './a'`        lazy      `const m = await import('./a')`
//   require  `require('./a')`             re-export `export * from './a'`  (barrel files)
// Every class is LINE-BOUNDED except the multi-line `import { … } from` form, which legitimately wraps:
// a `[^'"]*` that eats newlines lets `import os` (Python) or `import.meta.x` swallow the file's NEXT
// string literal as a fake module path. The dynamic form must also sit at a real call site — `[^\w$.]`
// before it — and its magic comment may not span lines, or `import(/* c */ url)` captures a later string.
const IMPORT_RE =
  /(?:^[ \t]*(?:import|export)\b[^'"]*\bfrom|^[ \t]*import|(?:^|[^\w$.])(?:require|import)[ \t]*\([ \t]*(?:\/\*[^\n]*?\*\/[ \t]*)?)[ \t]*['"]([^'"\n]+)['"]/gm

/** Drop whole-line comments before scanning: a commented-out `// await import('./x')` must NOT create a
 *  graph edge (it would hide a genuinely dead file from the Unused-File Finder). Only lines that START
 *  as a comment are removed, so a URL like 'http://x' inside real code is never touched. */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .map((l) => (/^[ \t]*(\/\/|\/\*|\*)/.test(l) ? '' : l))
    .join('\n')
}

export function extractImports(source: string): string[] {
  const out = new Set<string>()
  for (const m of stripCommentLines(source).matchAll(IMPORT_RE)) out.add(m[1])
  // SORT before capping so the surviving set is STABLE under an import reorder
  // (an auto-sorter must not flip which edges the graph sees → no phantom drift);
  // a high cap so realistic barrel/entry files aren't truncated.
  return [...out].sort().slice(0, 200)
}

function indexOneFile(root: string, rel: string): IndexedFile | null {
  try {
    const abs = join(root, rel)
    if (statSync(abs).size > MAX_FILE_BYTES) return null
    const src = readFileSync(abs, 'utf8')
    return { path: rel, symbols: extractSymbols(src, rel), imports: extractImports(src) }
  } catch {
    return null
  }
}

/**
 * Background AI project index: symbols + imports for every code file, cached
 * in memory AND on disk (userData/index/<hash>.json) so big projects open with
 * their index warm. Rebuilt in the background on project open; single files
 * refresh on save. Agents and future semantic search read from here.
 */
export function buildProjectIndex(root: string): ProjectIndex {
  const files: IndexedFile[] = []
  let count = 0
  const walk = (rel: string): void => {
    if (count >= MAX_FILES) return
    for (const entry of fsService.listDir(root, rel)) {
      if (count >= MAX_FILES) return
      if (entry.isDir) {
        walk(entry.path)
        continue
      }
      if (!CODE_EXT.test(entry.name)) continue
      count++
      const f = indexOneFile(root, entry.path)
      if (f && (f.symbols.length || f.imports.length)) files.push(f)
    }
  }
  walk('')
  const idx: ProjectIndex = { root, builtAt: Date.now(), files }
  memCache.set(root, idx)
  try {
    fsWrite(cachePath(root), JSON.stringify(idx), 'utf8')
  } catch {
    /* cache write is best-effort */
  }
  return idx
}

/** Cached index (memory → disk → fresh build). */
export function getProjectIndex(root: string): ProjectIndex {
  const mem = memCache.get(root)
  if (mem) return mem
  try {
    const p = cachePath(root)
    if (existsSync(p)) {
      const idx = JSON.parse(readFileSync(p, 'utf8')) as ProjectIndex
      memCache.set(root, idx)
      return idx
    }
  } catch {
    /* fall through to a fresh build */
  }
  return buildProjectIndex(root)
}

/** Save-time incremental refresh of a single file's index entry. */
export function refreshIndexedFile(root: string, rel: string): void {
  const idx = memCache.get(root)
  if (!idx) return
  const next = indexOneFile(root, rel)
  idx.files = idx.files.filter((f) => f.path !== rel)
  if (next && (next.symbols.length || next.imports.length)) idx.files.push(next)
  idx.builtAt = Date.now()
  try {
    fsWrite(cachePath(root), JSON.stringify(idx), 'utf8')
  } catch {
    /* best-effort */
  }
}

/** Everything-search over the index: symbols, file names, imports. */
export function indexSearch(root: string, query: string): { kind: 'symbol' | 'file' | 'import'; path: string; detail: string }[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const idx = getProjectIndex(root)
  const out: { kind: 'symbol' | 'file' | 'import'; path: string; detail: string }[] = []
  for (const f of idx.files) {
    if (out.length >= 40) break
    if (f.path.toLowerCase().includes(q)) out.push({ kind: 'file', path: f.path, detail: f.path })
    for (const s of f.symbols) {
      if (out.length >= 40) break
      if (s.name.toLowerCase().includes(q)) out.push({ kind: 'symbol', path: f.path, detail: `${s.name} · line ${s.line}` })
    }
    for (const im of f.imports) {
      if (out.length >= 40) break
      if (im.toLowerCase().includes(q)) out.push({ kind: 'import', path: f.path, detail: `imports ${im}` })
    }
  }
  return out
}

// ---------------------------------------------------------------- project insight (Wave 1)

export interface DebtItem {
  kind: 'oversized' | 'dead' | 'untested' | 'todo'
  path: string
  detail: string
}

export interface ProjectInsight {
  fileCount: number
  totalSymbols: number
  languages: Record<string, number>
  topImports: { name: string; count: number }[]
  entryPoints: string[]
  debt: DebtItem[]
  /** True when a test file was actually SEEN. False means "not in what we read" — check `coverage`
   *  before turning that into "this project has no tests". */
  hasTests: boolean
  /** How much of the project the index actually holds. The index stops at MAX_FILES. */
  coverage: import('../shared/coverage').Coverage
}

/**
 * Tech-Debt Radar + Project Explainer facts, computed over the background
 * index (no model call, instant). The agent turns these facts into the
 * plain-English "Explain this project" narrative; the panel shows the radar.
 */
export function projectInsight(root: string): ProjectInsight {
  const idx = getProjectIndex(root)
  const languages: Record<string, number> = {}
  const importCounts = new Map<string, number>()
  const debt: DebtItem[] = []
  let totalSymbols = 0
  let hasTests = false

  for (const f of idx.files) {
    const ext = f.path.slice(f.path.lastIndexOf('.') + 1).toLowerCase()
    languages[ext] = (languages[ext] ?? 0) + 1
    totalSymbols += f.symbols.length
    if (/\.(test|spec)\.|(^|\/)(__tests__|tests?)\//.test(f.path)) hasTests = true
    for (const im of f.imports) if (!im.startsWith('.')) importCounts.set(im, (importCounts.get(im) ?? 0) + 1)

    // Oversized: a lot of symbols in one file (god-object smell).
    if (f.symbols.length > 40) debt.push({ kind: 'oversized', path: f.path, detail: `${f.symbols.length} top-level definitions — consider splitting` })
    // Dead: a code file that exports nothing and imports nothing meaningful.
    if (f.symbols.length === 0 && f.imports.length === 0 && CODE_EXT.test(f.path))
      debt.push({ kind: 'dead', path: f.path, detail: 'no exports and no imports — possibly unused' })
  }

  // Untested: only claim this when we actually read the WHOLE project. On a capped index the tests
  // folder may simply be past where the walk stopped, and a confident "no tests" would be a guess.
  const indexCapped = idx.files.length >= MAX_FILES
  if (!hasTests && !indexCapped && idx.files.some((f) => CODE_EXT.test(f.path))) {
    debt.push({ kind: 'untested', path: '(project)', detail: 'no test files found in the project' })
  }

  // TODO/FIXME density — scan a bounded set of indexed files.
  let todoScanned = 0
  for (const f of idx.files) {
    if (todoScanned >= 200 || debt.filter((d) => d.kind === 'todo').length >= 20) break
    todoScanned++
    try {
      const src = readFileSync(join(root, f.path), 'utf8')
      const n = (src.match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length
      if (n > 0) debt.push({ kind: 'todo', path: f.path, detail: `${n} TODO/FIXME marker${n === 1 ? '' : 's'}` })
    } catch {
      /* skip */
    }
  }

  const topImports = [...importCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }))

  // Entry points: common app roots present in the index.
  const entryPoints = idx.files
    .map((f) => f.path)
    .filter((p) => /(^|\/)(src\/)?(main|index|app|server)\.[jt]sx?$/.test(p))
    .slice(0, 8)

  return {
    fileCount: idx.files.length,
    totalSymbols,
    languages,
    topImports,
    entryPoints,
    debt: debt.slice(0, 60),
    hasTests,
    coverage: {
      read: idx.files.length,
      capped: indexCapped || debt.length > 60,
      reasons: [...(indexCapped ? (['file-cap'] as const) : []), ...(debt.length > 60 ? (['finding-cap'] as const) : [])],
      shown: Math.min(debt.length, 60),
      total: debt.length
    }
  }
}

/** Compact facts string the agent narrates into a project explanation. */
export function insightSummary(root: string): string {
  const i = projectInsight(root)
  const langs = Object.entries(i.languages).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}:${n}`).join(', ')
  return [
    `Files indexed: ${i.fileCount}${i.coverage.capped ? ' (this is a partial sample of the project, not all of it)' : ''}, definitions: ${i.totalSymbols}.`,
    `Languages: ${langs}.`,
    `Top dependencies: ${i.topImports.map((t) => t.name).join(', ') || '(none)'}.`,
    `Entry points: ${i.entryPoints.join(', ') || '(unknown)'}.`,
    // Never hand the model a confident "no" we did not establish — it would repeat it to the user
    // as fact in the Explain narrative.
    `Tests present: ${i.hasTests ? 'yes' : i.coverage.capped ? 'unknown (only part of the project was read)' : 'no'}.`,
    `Tech-debt signals: ${i.debt.length} (${i.debt.filter((d) => d.kind === 'oversized').length} oversized, ${i.debt.filter((d) => d.kind === 'dead').length} possibly-dead, ${i.debt.filter((d) => d.kind === 'todo').length} TODO files).`
  ].join('\n')
}

// ---------------------------------------------------------------- project brain (Wave 3)

import { gitHotspots } from './git'
import type { ArchitectureMap, ContextPack, ContextPackEntry, HouseStyle, ProjectBrain } from '../shared/types'

const ENTRY_RE = /(^|\/)(src\/)?(main|index|app|server)\.[jt]sx?$/
const RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py']

/** Resolve a RELATIVE import spec from `fromPath` to an indexed file path, or null. */
function resolveRelImport(fromPath: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const parts = (fromDir ? fromDir.split('/') : []).concat(spec.split('/'))
  const stack: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  const base = stack.join('/')
  for (const e of RESOLVE_EXT) if (fileSet.has(base + e)) return base + e
  for (const e of RESOLVE_EXT.slice(1)) if (fileSet.has(base + '/index' + e)) return base + '/index' + e
  return null
}

/** Bare package name from an import spec: 'react-dom/client'→'react-dom', '@a/b/c'→'@a/b'. */
function packageOf(spec: string): string {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}

/**
 * Resolve a project-root ALIAS import ('@/lib/db', '~/lib/db' — the canonical
 * Vite/Next/Vue alias for the project's own src) to an indexed file. Tries the
 * path as-is and under src/. These are NOT npm packages and must never land in
 * externalDeps.
 */
function resolveAliasImport(rest: string, fileSet: Set<string>): string | null {
  for (const base of [rest, `src/${rest}`]) {
    for (const e of RESOLVE_EXT) if (fileSet.has(base + e)) return base + e
    for (const e of RESOLVE_EXT.slice(1)) if (fileSet.has(base + '/index' + e)) return base + '/index' + e
  }
  return null
}

/**
 * Fold the background index into a module/import dependency graph — instant, no
 * model. Nodes = code files, edges = resolved in-project relative imports,
 * externalDeps = the packages the project leans on. Reused by projectBrain and
 * rendered as the Live Architecture Map.
 */
/**
 * Last-resort resolution for a NON-relative, non-'@/' spec — a custom alias ('@renderer/src/App',
 * '~utils/log') or a workspace package. Matches the spec's tail against indexed paths and accepts it
 * ONLY when exactly one file matches, so we never invent an ambiguous edge. This is what keeps an
 * alias-heavy project (this app itself uses '@renderer/*') from showing false "nobody imports it".
 */
function resolveSuffixImport(spec: string, files: { path: string }[]): string | null {
  // Only an ALIAS-shaped spec ('@renderer/src/App', '~utils/log') may be suffix-matched, and only on a
  // MULTI-segment tail. A single-segment tail is where this turns dangerous: 'react-dom/client' would
  // match a local `src/client.ts`, inventing an edge AND swallowing the react-dom dependency (which then
  // reads as "installed but never imported" in Dependency Health). Package sub-paths stay packages.
  if (!/^[@~]/.test(spec)) return null
  const tail = spec.replace(/^[@~]/, '').split('/').slice(1).join('/')
  if (!tail || tail.length < 3 || !tail.includes('/')) return null
  const hits: string[] = []
  for (const f of files) {
    const noExt = f.path.replace(/\.[cm]?[jt]sx?$|\.(vue|svelte|py)$/, '')
    if (noExt === tail || noExt.endsWith('/' + tail) || noExt.endsWith('/' + tail + '/index') || noExt === tail + '/index') {
      hits.push(f.path)
      if (hits.length > 1) return null // ambiguous → no edge, and the caller flags the graph partial
    }
  }
  return hits[0] ?? null
}

/**
 * Specs that are KNOWN not to be in-project aliases: a node builtin ('fs', 'node:path'). Without this
 * every ordinary Node project would be permanently "partial" — `fs` is in nobody's package.json — and
 * every X-ray card would carry a caveat it hasn't earned.
 */
const NODE_BUILTINS = new Set(builtinModules)
function isBuiltin(name: string): boolean {
  return NODE_BUILTINS.has(name.replace(/^node:/, ''))
}

/** Declared dependencies, so an unknown non-relative spec can be told apart from a real npm package. */
function declaredDeps(root: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string>>
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])
  } catch {
    return new Set<string>()
  }
}

export function architectureMap(root: string, opts?: { full?: boolean }): ArchitectureMap {
  const idx = getProjectIndex(root)
  const fileSet = new Set(idx.files.map((f) => f.path))
  const deps = declaredDeps(root)
  let unresolved = false
  const nodes = idx.files.map((f) => ({
    path: f.path,
    symbols: f.symbols.length,
    language: f.path.slice(f.path.lastIndexOf('.') + 1).toLowerCase(),
    isEntry: ENTRY_RE.test(f.path)
  }))
  const edges: { from: string; to: string }[] = []
  const external = new Map<string, number>()
  // full=true (Architecture Drift only) lifts the display caps so drift is exact:
  // ALL edges and ALL external deps, not the top-20. The Live Map keeps the caps.
  const edgeOk = (): boolean => opts?.full === true || edges.length < 2000
  for (const f of idx.files) {
    for (const im of f.imports) {
      const alias = im.startsWith('@/') ? im.slice(2) : im.startsWith('~/') ? im.slice(2) : null
      if (im.startsWith('.')) {
        const to = resolveRelImport(f.path, im, fileSet)
        if (to && to !== f.path && edgeOk()) edges.push({ from: f.path, to })
      } else if (alias !== null) {
        // Project-root alias, not a package: resolve to an in-project edge, and
        // never count it as an external dependency.
        const to = resolveAliasImport(alias, fileSet)
        if (to && to !== f.path && edgeOk()) edges.push({ from: f.path, to })
      } else {
        // A non-relative spec that is neither a DECLARED dependency nor a node builtin is usually a
        // custom alias (tsconfig `paths`, '@renderer/*', a workspace package) whose edge we can't
        // resolve. Try a unique suffix match against the index; if that fails, the graph is knowingly
        // incomplete — flag it so nothing downstream calls a file "safe to remove" on missing evidence.
        // A declared package or a builtin is NEVER suffix-matched and NEVER makes the graph partial:
        // otherwise 'react-dom/client' would become an edge to a local client.ts (and react-dom would
        // vanish from Dependency Health), and a plain `import 'fs'` would caveat every card forever.
        const name = packageOf(im)
        const known = deps.has(name) || isBuiltin(name)
        const to = known ? null : resolveSuffixImport(im, idx.files)
        if (to && to !== f.path) {
          if (edgeOk()) edges.push({ from: f.path, to })
        } else {
          if (name) external.set(name, (external.get(name) ?? 0) + 1)
          // Only an alias-SHAPED miss ('@x/y', 'utils/log') means a lost in-project edge. A bare
          // undeclared package name is a phantom dependency — Dependency Health's job, not a graph gap.
          if (name && !known && im.includes('/')) unresolved = true
        }
      }
    }
  }
  const sortedDeps = [...external.entries()].sort((a, b) => b[1] - a[1])
  const externalDeps = (opts?.full === true ? sortedDeps : sortedDeps.slice(0, 20)).map(([name, count]) => ({ name, count }))
  // The graph is incomplete if the file index was capped, the edge cap was hit, or any import could not
  // be resolved. Downstream "safe to remove" / "no tangles" claims must soften when this is true.
  const partial = idx.files.length >= MAX_FILES || (opts?.full !== true && edges.length >= 2000) || unresolved
  return { nodes, edges, externalDeps, partial }
}

/**
 * Auto-Context Pack — the files most relevant to a task, assembled instantly
 * from the graph + index (no model). If `seed` is a project file, the pack is
 * that file + what it imports (out-edges) + what imports IT (in-edges). If `seed`
 * is free text, it degrades to a symbol/file-name search. Ranked, deduped.
 */
export function contextPack(root: string, seed: string): ContextPack {
  const map = architectureMap(root)
  const idx = getProjectIndex(root)
  const symbolsOf = (path: string): string[] => idx.files.find((f) => f.path === path)?.symbols.map((s) => s.name) ?? []
  const fileSet = new Set(idx.files.map((f) => f.path))
  // Normalize an absolute seed to a project-relative path so file-seeds match.
  let s = seed.trim()
  if (s.startsWith(root)) s = s.slice(root.length).replace(/^[/\\]+/, '')
  const seedKind: 'file' | 'query' = fileSet.has(s) ? 'file' : 'query'

  const best = new Map<string, ContextPackEntry>()
  const add = (path: string, reason: ContextPackEntry['reason'], score: number): void => {
    const cur = best.get(path)
    if (!cur || score > cur.score) best.set(path, { path, reason, score, symbols: symbolsOf(path) })
  }
  if (seedKind === 'file') {
    add(s, 'seed', 100)
    for (const e of map.edges) {
      if (e.from === s) add(e.to, 'import', 60)
      if (e.to === s) add(e.from, 'importer', 40)
    }
  } else {
    // Free-text seed → scan the index directly for file-name or symbol matches.
    // (Not indexSearch: its 40-result cap can be starved by import-only hits,
    // which we don't want anyway — a common package name would return nothing.)
    const q = s.toLowerCase()
    for (const f of idx.files) {
      if (best.size >= 40) break
      const nameHit = f.path.toLowerCase().includes(q)
      const symHit = f.symbols.some((sym) => sym.name.toLowerCase().includes(q))
      if (nameHit || symHit) add(f.path, 'symbol', symHit ? 25 : 20)
    }
  }
  const files = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 20)
  return { root, seed: s, seedKind, files }
}

/** Read a project file that is NOT in the code index (package.json, .env, .sql). */
function readIfExists(root: string, rel: string): string | null {
  try {
    const abs = join(root, rel)
    if (statSync(abs).size > MAX_FILE_BYTES) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

// package.json dep → human framework label.
const FRAMEWORK_DEPS: Record<string, string> = {
  next: 'Next.js', react: 'React', 'react-native': 'React Native', vue: 'Vue', nuxt: 'Nuxt',
  svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', '@angular/core': 'Angular', express: 'Express',
  '@nestjs/core': 'NestJS', fastify: 'Fastify', koa: 'Koa', electron: 'Electron', vite: 'Vite',
  webpack: 'Webpack', tailwindcss: 'Tailwind', prisma: 'Prisma', '@prisma/client': 'Prisma',
  mongoose: 'Mongoose', sequelize: 'Sequelize', typeorm: 'TypeORM', 'drizzle-orm': 'Drizzle',
  '@reduxjs/toolkit': 'Redux', redux: 'Redux', graphql: 'GraphQL', 'socket.io': 'Socket.IO',
  jest: 'Jest', vitest: 'Vitest', capacitor: 'Capacitor', expo: 'Expo'
}

function detectStack(root: string, languages: Record<string, number>): ProjectBrain['stack'] {
  const frameworks = new Set<string>()
  const packageManagers = new Set<string>()
  const pkgRaw = readIfExists(root, 'package.json')
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      for (const d of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }))
        if (FRAMEWORK_DEPS[d]) frameworks.add(FRAMEWORK_DEPS[d])
    } catch {
      /* malformed package.json — no frameworks from it */
    }
  }
  if (existsSync(join(root, 'package-lock.json'))) packageManagers.add('npm')
  if (existsSync(join(root, 'yarn.lock'))) packageManagers.add('yarn')
  if (existsSync(join(root, 'pnpm-lock.yaml'))) packageManagers.add('pnpm')
  if (existsSync(join(root, 'bun.lockb'))) packageManagers.add('bun')
  const req = readIfExists(root, 'requirements.txt')
  const pyproject = readIfExists(root, 'pyproject.toml')
  const pyText = `${req ?? ''}\n${pyproject ?? ''}`.toLowerCase()
  if (req) packageManagers.add('pip')
  if (pyproject && /\[tool\.poetry\]/.test(pyproject)) packageManagers.add('poetry')
  if (/\bflask\b/.test(pyText)) frameworks.add('Flask')
  if (/\bdjango\b/.test(pyText)) frameworks.add('Django')
  if (/\bfastapi\b/.test(pyText)) frameworks.add('FastAPI')
  return { frameworks: [...frameworks], languages, packageManagers: [...packageManagers] }
}

function detectDbSchema(root: string): ProjectBrain['dbSchema'] {
  const out: ProjectBrain['dbSchema'] = []
  // Prisma schema
  const prisma = readIfExists(root, 'prisma/schema.prisma') ?? readIfExists(root, 'schema.prisma')
  if (prisma) {
    const models = [...prisma.matchAll(/^\s*model\s+(\w+)\s*\{/gm)].map((m) => m[1])
    if (models.length) out.push({ source: 'prisma/schema.prisma', models: models.slice(0, 60) })
  }
  // .sql CREATE TABLE (shallow, bounded walk — .sql is not in the code index)
  const sqlTables: string[] = []
  let sqlSeen = 0
  const walk = (rel: string): void => {
    if (sqlSeen >= 30 || sqlTables.length >= 100) return
    for (const entry of fsService.listDir(root, rel)) {
      if (sqlSeen >= 30 || sqlTables.length >= 100) return
      if (entry.isDir) {
        walk(entry.path)
        continue
      }
      if (!/\.sql$/i.test(entry.name)) continue
      sqlSeen++
      const src = readIfExists(root, entry.path)
      if (!src) continue
      for (const m of src.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+[`"']?([A-Za-z_]\w*)/gi)) sqlTables.push(m[1])
    }
  }
  walk('')
  if (sqlTables.length) out.push({ source: '*.sql', models: [...new Set(sqlTables)].slice(0, 60) })
  // ORM model definitions — only re-read files that import a known ORM (lean).
  const idx = getProjectIndex(root)
  const orm = new Set<string>()
  for (const f of idx.files) {
    if (orm.size >= 60) break
    if (!f.imports.some((im) => im === 'mongoose' || im === 'sequelize' || im.startsWith('sequelize'))) continue
    const src = readIfExists(root, f.path)
    if (!src) continue
    for (const m of src.matchAll(/(?:mongoose\.model|sequelize\.define|\.define)\(\s*['"](\w+)['"]/g)) orm.add(m[1])
  }
  if (orm.size) out.push({ source: 'ORM models', models: [...orm] })
  return out
}

function detectEnvVars(root: string): ProjectBrain['envVars'] {
  const declared = new Set<string>()
  for (const ex of ['.env.example', '.env.sample', '.env.template']) {
    const raw = readIfExists(root, ex)
    if (raw) for (const m of raw.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)) declared.add(m[1])
  }
  const referenced = new Set<string>()
  const idx = getProjectIndex(root)
  let scanned = 0
  for (const f of idx.files) {
    if (scanned >= 200 || referenced.size >= 100) break
    scanned++
    const src = readIfExists(root, f.path)
    if (!src) continue
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) referenced.add(m[1])
    for (const m of src.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g)) referenced.add(m[1])
    for (const m of src.matchAll(/os\.environ(?:\.get)?\(?\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) referenced.add(m[1])
  }
  const names = [...new Set([...declared, ...referenced])].slice(0, 100)
  return names.map((name) => ({ name, declared: declared.has(name), referenced: referenced.has(name) }))
}

/**
 * Team Brain — detect the project's coding conventions from a sample of its
 * files, so the agent can be told to MATCH the house style instead of imposing
 * its own. One vote per file per signal; ties or thin samples → 'mixed'. Pure,
 * reuses the index + readIfExists.
 */
export function detectHouseStyle(root: string): HouseStyle {
  const files = getProjectIndex(root).files.filter((f) => CODE_EXT.test(f.path)).slice(0, 40)
  let tab = 0
  let sp2 = 0
  let sp4 = 0
  let single = 0
  let dbl = 0
  let semiFiles = 0
  let expDefault = 0
  let expNamed = 0
  let sampled = 0
  const naming: Record<string, number> = { kebab: 0, camel: 0, pascal: 0, snake: 0 }
  for (const f of files) {
    const src = readIfExists(root, f.path)
    if (src == null) continue
    sampled++
    // Indent: one vote per file — tabs, else the smallest first-level space indent.
    // Skip JSDoc/comment-continuation lines (" * …", 1 lead space) and ignore
    // 1-space indents, which would otherwise defeat the 2-vs-4 classification.
    if (/^\t/m.test(src)) tab++
    else {
      let min = Infinity
      for (const m of src.matchAll(/^( +)(\S)/gm)) {
        if (m[2] === '*') continue
        const n = m[1].length
        if (n >= 2) min = Math.min(min, n)
      }
      if (min === 2) sp2++
      else if (min === 4) sp4++
    }
    // Quotes: dominant string-literal quote in this file.
    const sq = (src.match(/'[^'\n]*'/g) ?? []).length
    const dq = (src.match(/"[^"\n]*"/g) ?? []).length
    if (sq > dq) single++
    else if (dq > sq) dbl++
    // Semicolons: does a meaningful share of lines end with ';'?
    const semi = (src.match(/;\s*$/gm) ?? []).length
    const nl = (src.match(/\n/g) ?? []).length + 1
    if (semi >= Math.max(3, nl * 0.25)) semiFiles++
    // Export style.
    if (/^export\s+default/m.test(src)) expDefault++
    else if (/^export\s+(?:const|function|class|let|var)/m.test(src)) expNamed++
    // File naming, from the basename.
    const base = (f.path.split('/').pop() ?? '').replace(/\.\w+$/, '')
    if (/[a-z0-9]-[a-z0-9]/i.test(base)) naming.kebab++
    else if (/_/.test(base)) naming.snake++
    else if (/^[A-Z]/.test(base)) naming.pascal++
    else if (/^[a-z][a-z0-9]*[A-Z]/.test(base)) naming.camel++
  }
  const pick = (votes: [string, number][], mixed: string): string => {
    const sorted = votes.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    if (!sorted.length) return mixed
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return mixed
    return sorted[0][0]
  }
  return {
    indent: pick([['tabs', tab], ['2-spaces', sp2], ['4-spaces', sp4]], 'mixed') as HouseStyle['indent'],
    quotes: pick([['single', single], ['double', dbl]], 'mixed') as HouseStyle['quotes'],
    semicolons: semiFiles > sampled / 2,
    fileNaming: pick([['kebab', naming.kebab], ['camel', naming.camel], ['pascal', naming.pascal], ['snake', naming.snake]], 'mixed') as HouseStyle['fileNaming'],
    exportStyle: pick([['default', expDefault], ['named', expNamed]], 'mixed') as HouseStyle['exportStyle'],
    sampledFiles: sampled
  }
}

/**
 * A short "match the house style" block for the agent system prompt, or '' when
 * the signal is too thin/mixed to be worth spending context on.
 */
export function houseStylePrompt(root: string): string {
  const s = detectHouseStyle(root)
  if (s.sampledFiles < 3) return ''
  const parts: string[] = []
  if (s.indent !== 'mixed') parts.push(`indent with ${s.indent}`)
  if (s.quotes !== 'mixed') parts.push(`${s.quotes} quotes`)
  parts.push(s.semicolons ? 'use semicolons' : 'omit semicolons')
  if (s.exportStyle !== 'mixed') parts.push(`prefer ${s.exportStyle} exports`)
  if (s.fileNaming !== 'mixed') parts.push(`${s.fileNaming}-case file names`)
  if (parts.length < 2) return ''
  return `HOUSE STYLE — match this project's existing conventions: ${parts.join(', ')}.`
}

const brainCache = new Map<string, ProjectBrain>()

/**
 * The Project Brain: a deep, no-model understanding of a project — stack &
 * frameworks, entry points, the dependency graph, database schema, required
 * env vars, and change hotspots. Cached until the background index rebuilds.
 * Async only because git hotspots shell out; everything else is pure.
 */
export async function projectBrain(root: string): Promise<ProjectBrain> {
  const idx = getProjectIndex(root)
  const cached = brainCache.get(root)
  if (cached && cached.generatedAt >= idx.builtAt) return cached

  const insight = projectInsight(root)
  const brain: ProjectBrain = {
    stack: detectStack(root, insight.languages),
    entryPoints: insight.entryPoints,
    graph: architectureMap(root),
    dbSchema: detectDbSchema(root),
    envVars: detectEnvVars(root),
    hotspots: await gitHotspots(root),
    houseStyle: detectHouseStyle(root),
    generatedAt: Date.now(),
    partial: idx.files.length >= MAX_FILES
  }
  brainCache.set(root, brain)
  return brain
}
