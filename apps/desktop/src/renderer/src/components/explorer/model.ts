import type { DirEntry } from '../../../../shared/types'

/**
 * The Explorer's tree, as data.
 *
 * The old tree was a recursive component where every folder held its own `useState` for "am I
 * open" and "what are my children". That shape has no answer to any of the questions this view
 * actually has to answer — how many rows are visible, which row is row 400, what does ↓ focus
 * next, which folder does a watcher event invalidate — so it could not be windowed, could not
 * keep expansion across a refresh, and re-mounted the whole tree whenever the shell re-rendered.
 *
 * Here the state is one normalised record and the view is a pure projection of it:
 *
 *   children   relPath → that folder's listing ('' is the root). Cached; a folder is read once.
 *   expanded   the set of open folders. Survives refreshes, because it is keyed by path.
 *   loading    folders with a read in flight, so a row can say so without a second source.
 *
 * `flatten()` turns that into the exact list of visible rows, which the component windows. Pure
 * and IO-free: `scripts/test-agent.cjs` drives all of it without an Electron window.
 */

export interface TreeData {
  children: ReadonlyMap<string, DirEntry[]>
  expanded: ReadonlySet<string>
  loading: ReadonlySet<string>
}

export interface VisibleRow {
  /** Stable identity for React and for focus. */
  key: string
  path: string
  /** What to draw. For a compacted chain this is the whole run: `com/example/app`. */
  label: string
  /** The leaf that owns the icon and the git decoration — the last segment of `label`. */
  name: string
  /** Each segment of a compacted chain with the path it stands for, so any part can be clicked. */
  segments: { name: string; path: string }[]
  isDir: boolean
  isSymlink: boolean
  depth: number
  expanded: boolean
  loading: boolean
  /** The containing folder's leaf name, for the icon theme's parent-qualified rules. */
  parentName: string
}

export interface FlattenOptions {
  /** VS Code's default: a folder whose only child is a folder is drawn as one row. */
  compactFolders?: boolean
  /** 'type' = folders first (the default); 'name' = one alphabetical run. */
  sort?: 'type' | 'name'
}

export const leafOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? path : path.slice(cut + 1)
}

const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/**
 * Sort one listing.
 *
 * Case-INSENSITIVE compare with a case-sensitive tiebreak, via `localeCompare` with `numeric`:
 * `file2` sorts before `file10`, `Apple` sorts beside `apple` rather than in a separate uppercase
 * block, and two names differing only in case still have a stable order instead of flipping
 * between reads. This is what the platform file managers and VS Code both do.
 */
export function sortEntries(entries: readonly DirEntry[], sort: 'type' | 'name' = 'type'): DirEntry[] {
  const cmp = (a: DirEntry, b: DirEntry): number => {
    if (sort === 'type' && a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    return byName !== 0 ? byName : a.name.localeCompare(b.name)
  }
  return [...entries].sort(cmp)
}

/**
 * The chain of folders a row stands for when compact folders are on.
 *
 * A folder is absorbed into its parent's row when it is that parent's ONLY child and is itself a
 * folder — `com` → `example` → `app` becomes one `com/example/app` row, as in VS Code. The chain
 * stops at a folder that is not yet loaded (its single-child-ness is unknown, and guessing would
 * make the row change shape once the listing arrives).
 *
 * A symlinked folder always ends a chain: following one is how a compactor walks into a loop.
 */
function compactChain(path: string, data: TreeData): { name: string; path: string }[] {
  const chain: { name: string; path: string }[] = [{ name: leafOf(path), path }]
  let cur = path
  for (let guard = 0; guard < 64; guard++) {
    const kids = data.children.get(cur)
    if (!kids || kids.length !== 1) break
    const only = kids[0]
    if (!only.isDir || only.isSymlink) break
    chain.push({ name: only.name, path: only.path })
    cur = only.path
  }
  return chain
}

/**
 * Project the tree into the rows that are actually on screen, in order.
 *
 * Only expanded folders contribute children, and only loaded folders contribute anything — so
 * the cost is proportional to what is VISIBLE, never to the repository. Opening `node_modules`
 * reads one directory; it does not walk it.
 */
export function flatten(data: TreeData, opts: FlattenOptions = {}): VisibleRow[] {
  const compact = opts.compactFolders !== false
  const rows: VisibleRow[] = []

  const walk = (parentPath: string, depth: number): void => {
    const kids = data.children.get(parentPath)
    if (!kids) return
    const parentName = leafOf(parentPath)
    for (const entry of sortEntries(kids, opts.sort)) {
      if (!entry.isDir) {
        rows.push({
          key: entry.path,
          path: entry.path,
          label: entry.name,
          name: entry.name,
          segments: [{ name: entry.name, path: entry.path }],
          isDir: false,
          isSymlink: entry.isSymlink === true,
          depth,
          expanded: false,
          loading: false,
          parentName
        })
        continue
      }

      // A folder row may stand for a whole single-child chain. The row's identity, expansion and
      // children all belong to the LAST link, because that is the folder whose contents show.
      const chain =
        compact && data.expanded.has(entry.path)
          ? compactChain(entry.path, data)
          : [{ name: entry.name, path: entry.path }]
      const tail = chain[chain.length - 1]
      const expanded = data.expanded.has(tail.path)
      rows.push({
        key: entry.path,
        path: tail.path,
        label: chain.map((c) => c.name).join('/'),
        name: tail.name,
        segments: chain,
        isDir: true,
        isSymlink: entry.isSymlink === true,
        depth,
        expanded,
        loading: data.loading.has(tail.path),
        parentName: chain.length > 1 ? leafOf(parentOf(tail.path)) : parentName
      })
      if (expanded) walk(tail.path, depth + 1)
    }
  }

  walk('', 0)
  return rows
}

/* ── mutations, as pure folds ───────────────────────────────────────────────────────────── */

/** Expand or collapse one folder. Collapsing KEEPS the cached listing — reopening is instant. */
export function toggleExpanded(expanded: ReadonlySet<string>, path: string, open?: boolean): Set<string> {
  const next = new Set(expanded)
  const want = open ?? !next.has(path)
  if (want) next.add(path)
  else next.delete(path)
  return next
}

/**
 * Collapse everything, without dropping a single cached listing.
 *
 * "Collapse All" must not reload the project: the listings are still valid, only the disclosure
 * state changes, so expanding a folder again after a Collapse All is instant.
 */
export function collapseAll(): Set<string> {
  return new Set()
}

/**
 * Every ancestor folder of `path`, outside-in — what Reveal Active File has to expand (and load)
 * to bring a row that is inside three closed folders onto the screen.
 */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  parts.pop()
  const out: string[] = []
  let acc = ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    out.push(acc)
  }
  return out
}

/**
 * Drop a folder's cached listing so it is re-read on next need — the targeted invalidation a
 * watcher event should cause. Everything else stays cached, so one file changing in `src` does
 * not cost a re-read of the whole tree.
 */
export function invalidate(
  children: ReadonlyMap<string, DirEntry[]>,
  paths: readonly string[]
): Map<string, DirEntry[]> {
  const next = new Map(children)
  for (const p of paths) next.delete(p)
  return next
}

/**
 * Which folders a set of changed paths invalidates: each changed path's PARENT, because that is
 * the listing whose membership can differ. A change to `src/app.ts` re-reads `src`, not the root
 * and not `src/components`.
 */
export function foldersToInvalidate(changedPaths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const p of changedPaths) {
    // An empty path is the platform saying "something changed, I can't say what" — the only case
    // where the whole tree has to be re-read.
    if (!p) return ['']
    out.add(parentOf(p))
  }
  return [...out]
}

/* ── type-ahead ─────────────────────────────────────────────────────────────────────────── */

/**
 * VS Code's list type-navigation: typing jumps to the next row whose label starts with what was
 * typed, wrapping, and starting the search AFTER the current row so repeating a letter cycles
 * through the matches rather than sticking on the first.
 */
export function typeAheadTarget(rows: readonly VisibleRow[], from: number, query: string): number {
  if (!query || rows.length === 0) return -1
  const q = query.toLowerCase()
  for (let i = 1; i <= rows.length; i++) {
    const idx = (from + i) % rows.length
    if (rows[idx].label.toLowerCase().startsWith(q)) return idx
  }
  return -1
}
