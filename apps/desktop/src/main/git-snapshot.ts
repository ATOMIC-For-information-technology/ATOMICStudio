import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CaptureOpts } from './terminal'
import { git, shellQuote, tail, isSafeRelPath, gitProcessCount, DIFF_CAPTURE } from './git-exec'
import { parsePorcelainV2 } from '../shared/git-porcelain'
import { parseUnifiedDiff } from '../shared/unidiff'
import { parseConflicts } from '../shared/conflicts'
import type { GitDiffMode, GitFileDiff, GitSnapshot } from '../shared/types'

/**
 * The HOT path of the Source Control view, and the cache discipline for the cold one.
 *
 * Before 2026-09-02 an ordinary panel refresh cost TWELVE git processes: `gitInfo` ran
 * `rev-parse` + `status` + `log` + `branch` + `show-prefix` + `check-ignore`, and the renderer
 * asked for branches, conflicts, MERGE_HEAD, the timeline and the remotes beside it — on every
 * keystroke-driven watcher event, every stage click, every save. `gitSnapshot` replaces all of
 * that with ONE `git status --porcelain=v2 --branch -z`, which already carries the branch, the
 * upstream, ahead/behind, renames and unmerged paths. Everything else it needs is a `stat()`:
 * the repo root and prefix come from walking up to `.git`, and merge/rebase state is the
 * existence of `MERGE_HEAD` / `rebase-merge`. Worst case is three processes (a second one when
 * the tree is clean, to tell "clean" from "git-ignored"; a third only when the `.git` walk fails
 * and `rev-parse` has to answer instead).
 *
 * The cold data — branch catalog, history, remotes — is cached behind STAMPS of the files git
 * itself rewrites when that data changes (`HEAD`, `packed-refs`, `refs/**`, `logs/HEAD`, `config`),
 * so a checkout, fetch, commit or `remote add` from ANY process invalidates it, and nothing is
 * ever served stale after a mutation. A stamp that cannot be computed disables the cache for that
 * call rather than risking a wrong hit.
 */

export interface RepoLocation {
  /** The working-tree root — the folder holding `.git`. */
  root: string
  /** Where HEAD, index and MERGE_HEAD live (a worktree's private dir when applicable). */
  gitDir: string
  /** Where refs, packed-refs and config live — same as gitDir except in a linked worktree. */
  commonDir: string
  /** `rev-parse --show-prefix` shape: '' at the root, else `sub/dir/` with the trailing slash. */
  prefix: string
}

/** Walk up from the project to the nearest `.git` (dir, or the `gitdir:` file a worktree/submodule uses). */
export function findRepo(projectPath: string): RepoLocation | null {
  const start = resolve(projectPath)
  let dir = start
  for (let depth = 0; depth < 64; depth++) {
    const dot = join(dir, '.git')
    try {
      const st = statSync(dot)
      let gitDir = dot
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dot, 'utf8'))
        if (!m) return null
        gitDir = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1])
      }
      let commonDir = gitDir
      try {
        const c = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
        if (c) commonDir = isAbsolute(c) ? c : resolve(gitDir, c)
      } catch {
        /* not a linked worktree */
      }
      const rel = relative(dir, start).split(sep).join('/')
      return { root: dir, gitDir, commonDir, prefix: rel ? `${rel}/` : '' }
    } catch {
      /* no .git here — keep walking */
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/* ── stamps and the cold cache ─────────────────────────────────────────────────────────── */

/** mtime (ns) + size of each path, or '-' for a missing one. Deterministic, cheap, no process. */
function stampFiles(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const st = statSync(p, { bigint: true })
        return `${st.mtimeNs}:${st.size}`
      } catch {
        return '-'
      }
    })
    .join('|')
}

/**
 * The newest mtime under a small tree (refs/). A directory's own mtime only changes when an
 * entry is added or removed, not when `refs/heads/main` is rewritten, so every file is stat'ed.
 * `refs/` is a few hundred entries at most in practice; the budget stops a pathological repo from
 * turning a cache check into a crawl — over budget, the stamp is '' and the cache is bypassed.
 */
function stampTree(dir: string, budget = 2000): string {
  let newest = 0n
  let seen = 0
  const walk = (d: string): boolean => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return true
    }
    for (const name of entries) {
      if (++seen > budget) return false
      const p = join(d, name)
      try {
        const st = statSync(p, { bigint: true })
        if (st.isDirectory()) {
          if (!walk(p)) return false
        } else if (st.mtimeNs > newest) newest = st.mtimeNs
      } catch {
        /* vanished mid-walk */
      }
    }
    return true
  }
  if (!existsSync(dir)) return '-'
  return walk(dir) ? `${newest}:${seen}` : ''
}

export type ColdKind = 'branches' | 'timeline' | 'remotes'

/** What each cold dataset depends on. An empty string means "could not stamp — do not cache". */
export function coldStamp(loc: RepoLocation, kind: ColdKind): string {
  const g = loc.gitDir
  const c = loc.commonDir
  if (kind === 'remotes') return stampFiles([join(c, 'config')])
  if (kind === 'timeline') {
    // logs/HEAD is appended on every commit, checkout, reset, merge and pull, so with HEAD and
    // packed-refs it catches every way the current branch's history can move.
    return stampFiles([join(g, 'HEAD'), join(g, 'logs', 'HEAD'), join(c, 'packed-refs')])
  }
  const tree = stampTree(join(c, 'refs'))
  if (!tree) return ''
  return `${stampFiles([join(g, 'HEAD'), join(c, 'packed-refs'), join(c, 'config'), join(g, 'logs', 'HEAD')])}|${tree}`
}

const cold = new Map<string, { stamp: string; value: unknown }>()

/** Serve `load()`'s last answer while `stamp` is unchanged and non-empty. */
export async function cached<T>(key: string, stamp: string, load: () => Promise<T>): Promise<T> {
  if (stamp) {
    const hit = cold.get(key)
    if (hit && hit.stamp === stamp) return hit.value as T
  }
  const value = await load()
  if (stamp) cold.set(key, { stamp, value })
  return value
}

/** Drop every cached answer for one repo (project switch, or a mutation we know about). */
export function dropColdCache(projectPath?: string): void {
  if (!projectPath) return cold.clear()
  for (const k of [...cold.keys()]) if (k.endsWith(`|${projectPath}`)) cold.delete(k)
}

/* ── the hot snapshot ──────────────────────────────────────────────────────────────────── */

/**
 * Head-kept capture with real headroom: a 1,000-file tree is ~80 KB of porcelain, and a
 * tail-kept capture would silently keep the LAST rows and drop the first, which is the worse
 * kind of wrong — same class of bug the numstat scans fixed in Wave 20.
 */
const STATUS_CAPTURE: CaptureOpts = { keep: 'head', max: 8_000_000 }

const EMPTY: Omit<GitSnapshot, 'perf'> = {
  isRepo: false, isRepoRoot: false, isIgnored: false, branch: '', detached: false, initial: false,
  headOid: '', upstream: null, ahead: 0, behind: 0, merging: false, rebasing: false,
  changes: [], total: 0, truncated: false, outsideStaged: 0, conflicts: []
}

export async function gitSnapshot(projectPath: string): Promise<GitSnapshot> {
  const t0 = Date.now()
  const p0 = gitProcessCount()
  const perf = (): GitSnapshot['perf'] => ({ processes: gitProcessCount() - p0, ms: Date.now() - t0 })

  // One process. `status` itself fails outside a work tree (exit 128), which is the isRepo answer —
  // no separate `rev-parse --is-inside-work-tree` needed. `--untracked-files=all` lists files rather
  // than collapsing a new folder into one row, so counts and per-file staging stay exact.
  const st = await git(projectPath, 'status --porcelain=v2 --branch -z --untracked-files=all', false, STATUS_CAPTURE)
  if (st.code !== 0) return { ...EMPTY, perf: perf() }

  const loc = findRepo(projectPath)
  let prefix = loc?.prefix ?? ''
  let gitDir = loc?.gitDir ?? ''
  if (!loc) {
    // Exotic layouts (GIT_DIR in the environment, core.worktree) where the .git walk finds nothing
    // although git itself is happy. One extra process answers both questions at once.
    const rp = await git(projectPath, 'rev-parse --show-prefix --absolute-git-dir')
    const [pre, gd] = rp.output.split('\n').map((l) => l.trim())
    prefix = pre ?? ''
    gitDir = gd ?? ''
  }

  const parsed = parsePorcelainV2(st.output, prefix)

  // Is the folder itself git-IGNORED? Only worth a process when the list is empty: with rows
  // present, git plainly sees the folder. An ignored folder reports nothing forever, and "nothing
  // changed" must never read as "everything is backed up" there.
  let isIgnored = false
  if (parsed.changes.length === 0 && !parsed.initial) {
    const ig = await git(projectPath, 'check-ignore -q .')
    isIgnored = ig.code === 0
  }

  const merging = Boolean(gitDir) && existsSync(join(gitDir, 'MERGE_HEAD'))
  const rebasing = Boolean(gitDir) && (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply')))

  return {
    isRepo: true,
    isRepoRoot: prefix === '',
    isIgnored,
    branch: parsed.branch,
    detached: parsed.detached,
    initial: parsed.initial,
    headOid: parsed.headOid,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    merging,
    rebasing,
    changes: parsed.changes,
    total: parsed.changes.length,
    truncated: st.truncated,
    outsideStaged: parsed.outsideStaged,
    conflicts: parsed.conflicts,
    perf: perf()
  }
}

/* ── exact per-row diffs ───────────────────────────────────────────────────────────────── */

/** Line cap for the panel's diff pane; beyond it the pane says so and offers the editor. */
const MAX_DIFF_LINES = 4000

/**
 * The diff for ONE row, in the mode its list implies — never guessed in the renderer.
 *
 * This is the fix for the panel's oldest inaccuracy: `gitCompareHead` compared the WORKING file
 * with HEAD, so a file staged and then edited again (`MM`) showed both edits under either row.
 * Here the staged row is `diff --cached` (index ↔ HEAD) and the unstaged row is plain `diff`
 * (working tree ↔ index), which is what each row's letter has always claimed.
 *
 * Untracked files have no index entry and no HEAD entry, so git has nothing to diff; the whole
 * file is read from disk as additions, with the same path validation `fs-service` applies.
 * Conflicts are not a patch at all: the pane reports how many hunks remain and the editor — which
 * already carries conflict decorations — is the place to resolve them.
 */
export async function gitDiffFile(projectPath: string, relPath: string, mode: GitDiffMode, orig?: string): Promise<GitFileDiff> {
  const bad = (error: string): GitFileDiff => ({ mode, lines: [], added: 0, removed: 0, binary: false, truncated: false, error })
  if (!isSafeRelPath(relPath) || (orig !== undefined && !isSafeRelPath(orig))) return bad('Invalid path.')

  if (mode === 'untracked' || mode === 'conflict') {
    const root = resolve(projectPath)
    const abs = resolve(root, relPath)
    if (abs !== root && !abs.startsWith(root + sep)) return bad('Invalid path.')
    let buf: Buffer
    try {
      buf = readFileSync(abs)
    } catch {
      return bad('Could not read the file.')
    }
    const binary = buf.subarray(0, 8192).includes(0)
    if (mode === 'conflict') {
      const hunks = binary ? 0 : parseConflicts(buf.toString('utf8')).length
      return { mode, lines: [], added: 0, removed: 0, binary, truncated: false, conflictHunks: hunks }
    }
    if (binary) return { mode, lines: [], added: 0, removed: 0, binary: true, truncated: false }
    const all = buf.toString('utf8').split('\n')
    if (all.length && all[all.length - 1] === '') all.pop()
    const lines = all.slice(0, MAX_DIFF_LINES).map((text) => ({ kind: 'add' as const, text }))
    return { mode, lines, added: all.length, removed: 0, binary: false, truncated: all.length > MAX_DIFF_LINES }
  }

  // `--find-renames` with BOTH paths in the pathspec lets git pair a staged rename; with only the
  // new path it would print the whole file as an addition. `--` ends option parsing, so a file
  // literally named `-U0` is still a file. `-c core.quotePath=false` keeps non-ASCII headers
  // readable; the pathspec itself is shell-quoted like every other call site.
  const spec = orig ? `${shellQuote(relPath)} ${shellQuote(orig)}` : shellQuote(relPath)
  const verb = mode === 'staged' ? 'diff --cached' : 'diff'
  const res = await git(projectPath, `-c core.quotePath=false ${verb} --no-color --no-ext-diff --find-renames -U3 -- ${spec}`, false, DIFF_CAPTURE)
  if (res.code !== 0) return bad(tail(res.output) || 'git diff failed.')
  const parsed = parseUnifiedDiff(res.output, MAX_DIFF_LINES)
  return { mode, lines: parsed.lines, added: parsed.added, removed: parsed.removed, binary: parsed.binary, truncated: parsed.truncated || res.truncated }
}
