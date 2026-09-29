import type { GitChange, GitCommitInfo, GitRemote, GitSnapshot } from '../../../../shared/types'

/**
 * Pure event→view folding for the Source Control view, kept out of the components exactly
 * like `agent-panel/derive.ts`. Nothing here touches `window.studio` or the DOM, so the
 * staged/unstaged split, the windowed-list arithmetic and the selection rules — the parts most
 * likely to be subtly wrong — are all checked by `scripts/test-agent.cjs` without a window.
 */

export interface GitFileRow {
  file: string
  /** The porcelain letter to show, already position-aware. */
  code: string
  kind: 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'
  /** For a rename: where it came from. Needed to ask git for the exact staged diff. */
  orig?: string
}

export interface GitView {
  isRepo: boolean
  isRepoRoot: boolean
  isIgnored: boolean
  branch: string
  detached: boolean
  /** No commit yet. */
  initial: boolean
  ahead: number
  behind: number
  upstream?: string
  staged: GitFileRow[]
  unstaged: GitFileRow[]
  conflicts: string[]
  merging: boolean
  rebasing: boolean
  /** Nothing staged, nothing modified, no conflicts. */
  clean: boolean
  /** Rows git reported for this folder; a floor when `truncated`. */
  total: number
  truncated: boolean
  /** Staged rows outside the opened folder — a commit from here includes them. */
  outsideStaged: number
}

const KIND: Record<string, GitFileRow['kind']> = {
  A: 'new',
  '?': 'new',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
  U: 'conflicted'
}

const kindOf = (code: string): GitFileRow['kind'] => KIND[code] ?? 'modified'

/**
 * Split porcelain rows into staged and unstaged.
 *
 * A file can legitimately appear in BOTH lists — `MM` means "staged one edit, then
 * edited it again". That is not a display bug to be deduplicated away; hiding the
 * unstaged half is how someone commits believing they included a change they did
 * not. So each column is read independently.
 *
 * Conflicts (`U` on either side, plus the `AA`/`DD` both-modified pairs) are neither
 * staged nor unstaged — they are their own state, and git will not let them be
 * committed at all, so they are pulled out into `conflicts`.
 */
export function splitChanges(changes: GitChange[]): { staged: GitFileRow[]; unstaged: GitFileRow[]; conflicts: string[] } {
  const staged: GitFileRow[] = []
  const unstaged: GitFileRow[] = []
  const conflicts: string[] = []

  for (const c of changes) {
    const x = c.x ?? ' '
    const y = c.y ?? ' '
    // Unmerged: porcelain v2 says so outright; v1 shape is 'U' in either column or AA/DD.
    if (c.unmerged || x === 'U' || y === 'U' || ((x === 'A' || x === 'D') && x === y)) {
      conflicts.push(c.file)
      continue
    }
    if (x === '?' || y === '?') {
      unstaged.push({ file: c.file, code: '?', kind: 'new' })
      continue
    }
    if (x !== ' ' && x !== '!') {
      const row: GitFileRow = { file: c.file, code: x, kind: kindOf(x) }
      if (c.orig) row.orig = c.orig
      staged.push(row)
    }
    if (y !== ' ' && y !== '!') unstaged.push({ file: c.file, code: y, kind: kindOf(y) })
  }

  return { staged, unstaged, conflicts }
}

const NOT_A_REPO: GitView = {
  isRepo: false, isRepoRoot: false, isIgnored: false, branch: '', detached: false, initial: false,
  ahead: 0, behind: 0, staged: [], unstaged: [], conflicts: [], merging: false, rebasing: false,
  clean: true, total: 0, truncated: false, outsideStaged: 0
}

/** One snapshot in, one view out. Branch divergence and conflicts ride along — no second source. */
export function deriveGitView(snap: GitSnapshot | null): GitView {
  if (!snap?.isRepo) return NOT_A_REPO
  const { staged, unstaged, conflicts } = splitChanges(snap.changes)
  const allConflicts = [...new Set([...snap.conflicts, ...conflicts])]
  return {
    isRepo: true,
    isRepoRoot: snap.isRepoRoot,
    isIgnored: snap.isIgnored,
    branch: snap.branch,
    detached: snap.detached,
    initial: snap.initial,
    ahead: snap.ahead,
    behind: snap.behind,
    upstream: snap.upstream ?? undefined,
    staged,
    unstaged,
    conflicts: allConflicts,
    merging: snap.merging,
    rebasing: snap.rebasing,
    clean: staged.length === 0 && unstaged.length === 0 && allConflicts.length === 0,
    total: snap.total,
    truncated: snap.truncated,
    outsideStaged: snap.outsideStaged
  }
}

/** Where a file has been optimistically moved while its stage/unstage request is in flight. */
export type PendingMove = 'staged' | 'unstaged'

/**
 * Apply in-flight stage/unstage moves to a view, so a row jumps the moment it is clicked.
 *
 * The panel previously set one global `busy` string per action, which disabled EVERY row until the
 * request came back — clicking one file froze the whole list and nothing indicated which file was
 * actually being worked on. Reported 2026-09-01 as "no feedback while working".
 *
 * Pure and separate from the request on purpose: the caller rolls back by dropping the entry, so a
 * failed stage restores the real view with no second round-trip. Rows that git has already caught
 * up with are filtered out rather than duplicated, which is what makes the transition seamless when
 * the refresh does land.
 */
export function applyPendingMoves(view: GitView, pending: ReadonlyMap<string, PendingMove>): GitView {
  if (pending.size === 0) return view
  const moving = (row: GitFileRow, to: PendingMove): boolean => pending.get(row.file) === to

  // Take each row out of the list it is leaving…
  const staged = view.staged.filter((r) => !moving(r, 'unstaged'))
  const unstaged = view.unstaged.filter((r) => !moving(r, 'staged'))

  // …and put it in the one it is joining, unless it is somehow already there.
  const has = (rows: GitFileRow[], file: string): boolean => rows.some((r) => r.file === file)
  for (const row of view.unstaged) {
    if (moving(row, 'staged') && !has(staged, row.file)) staged.push({ ...row })
  }
  for (const row of view.staged) {
    if (moving(row, 'unstaged') && !has(unstaged, row.file)) unstaged.push({ ...row })
  }

  return { ...view, staged, unstaged, clean: staged.length === 0 && unstaged.length === 0 && view.conflicts.length === 0 }
}

/* ── The list model: one flat sequence of 22px items ───────────────────────────────────── */

export type ScmSectionId = 'staged' | 'unstaged' | 'conflicts' | 'history'
export type ScmList = 'staged' | 'unstaged' | 'conflicts'

export type ScmItem =
  | { kind: 'section'; key: string; id: ScmSectionId; title: string; count: number; collapsed: boolean; countExact: boolean }
  | { kind: 'row'; key: string; list: ScmList; row: GitFileRow }
  | { kind: 'commit'; key: string; commit: GitCommitInfo; open: boolean }
  | { kind: 'commit-file'; key: string; text: string }
  | { kind: 'more'; key: string; loading: boolean }
  | { kind: 'note'; key: string; text: string; tone: 'muted' | 'warn' }

export interface HistoryState {
  loaded: boolean
  loading: boolean
  commits: GitCommitInfo[]
  openCommit: string | null
  commitFiles: Record<string, string[]>
  /** Cursor for the next page, from the last page's `nextSkip`. null means this is all of it. */
  nextSkip: number | null
  /** A page is in flight. Distinct from `loading`, which is the FIRST page. */
  loadingMore: boolean
}

export const rowKey = (list: ScmList, file: string): string => `${list}:${file}`

/**
 * Sections in the order the view reads: Staged (only when something is), Changes (always, so the
 * "nothing to do" state has a home), Conflicts (only when present), History (collapsed until asked).
 * Every entry is exactly one row tall, which is what lets the windowed list address the whole
 * thing by index without measuring anything.
 */
export function buildItems(view: GitView, collapsed: Record<ScmSectionId, boolean>, history: HistoryState): ScmItem[] {
  const items: ScmItem[] = []
  const section = (id: ScmSectionId, title: string, count: number, countExact = true): void => {
    items.push({ kind: 'section', key: `section:${id}`, id, title, count, collapsed: collapsed[id], countExact })
  }
  const rows = (list: ScmList, list_rows: GitFileRow[]): void => {
    for (const row of list_rows) items.push({ kind: 'row', key: rowKey(list, row.file), list, row })
  }

  if (view.staged.length > 0) {
    section('staged', 'Staged Changes', view.staged.length)
    if (!collapsed.staged) rows('staged', view.staged)
  }

  section('unstaged', 'Changes', view.unstaged.length, !view.truncated)
  if (!collapsed.unstaged) {
    if (view.unstaged.length === 0) {
      items.push({ kind: 'note', key: 'note:clean', text: view.clean ? 'No changes — everything is committed.' : 'Nothing unstaged.', tone: 'muted' })
    } else rows('unstaged', view.unstaged)
    if (view.truncated) {
      items.push({ kind: 'note', key: 'note:truncated', text: 'git’s output was cut off — the list and counts are a floor, not a total.', tone: 'warn' })
    }
  }

  if (view.conflicts.length > 0) {
    section('conflicts', 'Merge Conflicts', view.conflicts.length)
    if (!collapsed.conflicts) rows('conflicts', view.conflicts.map((file) => ({ file, code: 'U', kind: 'conflicted' as const })))
  }

  // The count is EXACT only when the whole history has been read. With a page still to come, the
  // number is a floor, and the section marks it as one rather than claiming a repository has 50
  // commits because that is how many we happen to have fetched.
  section('history', 'History', history.loaded ? history.commits.length : 0, history.loaded && history.nextSkip === null)
  if (!collapsed.history) {
    if (!history.loaded) items.push({ kind: 'note', key: 'note:history', text: history.loading ? 'Reading history…' : 'No history yet.', tone: 'muted' })
    else if (history.commits.length === 0) items.push({ kind: 'note', key: 'note:history-empty', text: 'No commits yet.', tone: 'muted' })
    for (const c of history.commits) {
      const open = history.openCommit === c.hash
      items.push({ kind: 'commit', key: `commit:${c.hash}`, commit: c, open })
      if (open) {
        const files = history.commitFiles[c.hash]
        if (!files) items.push({ kind: 'commit-file', key: `cf:${c.hash}:…`, text: 'loading…' })
        else for (const f of files) items.push({ kind: 'commit-file', key: `cf:${c.hash}:${f}`, text: f })
      }
    }
    // One more row, not an infinite scroll: paging on scroll fights the windowed list's focus and
    // scroll-ownership rules, and a history is one of the few lists where a user genuinely wants to
    // stop rather than keep falling.
    if (history.nextSkip !== null) items.push({ kind: 'more', key: 'more:history', loading: history.loadingMore })
  }
  return items
}

/* ── Windowing: which items are on screen ───────────────────────────────────────────────── */

export interface WindowRange {
  /** First rendered index. */
  start: number
  /** One past the last rendered index. */
  end: number
  padTop: number
  padBottom: number
}

/**
 * Fixed-height windowing. With 22px rows and a 300px panel that is ~14 visible rows plus the
 * overscan on each side — about 30 mounted nodes for a 1,000-file tree instead of 1,000. No
 * measurement, no library: every item is one row tall by construction (see `buildItems`).
 */
export function windowRange(scrollTop: number, viewportH: number, rowH: number, count: number, overscan = 8): WindowRange {
  if (count <= 0 || rowH <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rowH)
  const visible = Math.ceil(Math.max(0, viewportH) / rowH) + 1
  const start = Math.max(0, first - overscan)
  const end = Math.min(count, first + visible + overscan)
  return { start, end, padTop: start * rowH, padBottom: (count - end) * rowH }
}

/* ── Selection and keyboard focus ───────────────────────────────────────────────────────── */

/**
 * Keys rather than indexes: a row that moves from Changes to Staged keeps its identity, and a
 * refresh that inserts rows above the focus must not silently move the focus onto a neighbour.
 */
export interface ListSelection {
  focusKey: string | null
  anchorKey: string | null
  selected: ReadonlySet<string>
}

export const EMPTY_SELECTION: ListSelection = { focusKey: null, anchorKey: null, selected: new Set() }

export const indexOfKey = (items: readonly ScmItem[], key: string | null): number =>
  key === null ? -1 : items.findIndex((it) => it.key === key)

const rowsBetween = (items: readonly ScmItem[], a: number, b: number): string[] => {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const keys: string[] = []
  for (let i = lo; i <= hi; i++) {
    const it = items[i]
    if (it?.kind === 'row') keys.push(it.key)
  }
  return keys
}

/**
 * A click. Plain: this row alone. ⌘/Ctrl: toggle it in. Shift: everything from the anchor to
 * here — rows only, never the section headers in between, which is what makes a shift-range
 * across a header stage exactly the files the reader can see selected.
 */
export function selectByClick(items: readonly ScmItem[], sel: ListSelection, index: number, mods: { shift?: boolean; toggle?: boolean }): ListSelection {
  const it = items[index]
  if (!it) return sel
  if (it.kind !== 'row') return { ...sel, focusKey: it.key }
  if (mods.shift) {
    const anchor = indexOfKey(items, sel.anchorKey ?? sel.focusKey)
    const keys = rowsBetween(items, anchor < 0 ? index : anchor, index)
    return { focusKey: it.key, anchorKey: sel.anchorKey ?? it.key, selected: new Set(keys) }
  }
  if (mods.toggle) {
    const next = new Set(sel.selected)
    if (next.has(it.key)) next.delete(it.key)
    else next.add(it.key)
    return { focusKey: it.key, anchorKey: it.key, selected: next }
  }
  return { focusKey: it.key, anchorKey: it.key, selected: new Set([it.key]) }
}

/**
 * Arrow-key movement. Without Shift the focused row becomes the selection (VS Code's rule);
 * with Shift the range grows from the anchor. Headers and notes take focus but never selection.
 */
export function moveFocus(items: readonly ScmItem[], sel: ListSelection, to: number, shift: boolean): ListSelection {
  if (items.length === 0) return sel
  const index = Math.max(0, Math.min(items.length - 1, to))
  const it = items[index]
  if (it.kind !== 'row') return { ...sel, focusKey: it.key }
  if (shift) {
    const anchor = indexOfKey(items, sel.anchorKey ?? sel.focusKey)
    return { focusKey: it.key, anchorKey: sel.anchorKey ?? it.key, selected: new Set(rowsBetween(items, anchor < 0 ? index : anchor, index)) }
  }
  return { focusKey: it.key, anchorKey: it.key, selected: new Set([it.key]) }
}

/** After the items change, forget keys that no longer exist. Focus survives by key when it can. */
export function reconcileSelection(items: readonly ScmItem[], sel: ListSelection): ListSelection {
  const present = new Set(items.map((it) => it.key))
  const selected = new Set([...sel.selected].filter((k) => present.has(k)))
  const focusKey = sel.focusKey && present.has(sel.focusKey) ? sel.focusKey : null
  const anchorKey = sel.anchorKey && present.has(sel.anchorKey) ? sel.anchorKey : focusKey
  if (selected.size === sel.selected.size && focusKey === sel.focusKey && anchorKey === sel.anchorKey) return sel
  return { focusKey, anchorKey, selected }
}

/**
 * The rows a bulk action applies to: the selection when the focused row is part of it, else the
 * focused row alone. Restricted to one list, because "stage" means nothing for a staged row.
 */
export function actionTargets(items: readonly ScmItem[], sel: ListSelection, list: ScmList): GitFileRow[] {
  const focus = items[indexOfKey(items, sel.focusKey)]
  if (!focus || focus.kind !== 'row') return []
  if (focus.list !== list) return []
  if (!sel.selected.has(focus.key)) return [focus.row]
  const out: GitFileRow[] = []
  for (const it of items) if (it.kind === 'row' && it.list === list && sel.selected.has(it.key)) out.push(it.row)
  return out
}

/* ── The row's own presentation, folded here rather than in the component ───────────────── */

/**
 * The icon a changed row gets, from its extension.
 *
 * Deliberately a SUBSET of `IconName` declared locally instead of imported: `derive.ts` is
 * transpiled on its own by `scripts/test-agent.cjs` with no renderer resolution, so a reach into
 * `../Icon` — even a type-only one — is a resolution failure waiting to happen. Every member here
 * is a real `IconName`, so `<Icon name={fileGlyph(f)} />` still typechecks.
 */
export type GitGlyph =
  | 'braces' | 'file-code' | 'file-text' | 'image' | 'palette'
  | 'settings' | 'terminal' | 'lock' | 'archive' | 'globe' | 'file'

const GLYPH: Record<string, GitGlyph> = {
  ts: 'file-code', tsx: 'file-code', js: 'file-code', jsx: 'file-code', mjs: 'file-code',
  cjs: 'file-code', py: 'file-code', go: 'file-code', rs: 'file-code', java: 'file-code',
  rb: 'file-code', php: 'file-code', swift: 'file-code', kt: 'file-code', c: 'file-code',
  h: 'file-code', cpp: 'file-code', cs: 'file-code',
  json: 'braces', jsonc: 'braces', lock: 'lock',
  css: 'palette', scss: 'palette', less: 'palette',
  html: 'globe', htm: 'globe', svg: 'image', vue: 'globe', svelte: 'globe',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image',
  md: 'file-text', txt: 'file-text', mdx: 'file-text',
  sh: 'terminal', bash: 'terminal', zsh: 'terminal',
  yml: 'settings', yaml: 'settings', toml: 'settings', ini: 'settings', env: 'settings',
  zip: 'archive', tar: 'archive', gz: 'archive'
}

export function fileGlyph(file: string): GitGlyph {
  const name = file.replace(/\/+$/, '').split('/').pop() ?? ''
  // A dotfile with no second dot ('.gitignore') has no extension in the usual sense; its whole
  // name after the dot is the meaningful part, which is why the slice starts at 1 and not 0.
  const dot = name.lastIndexOf('.')
  const ext = dot <= 0 ? name.slice(1).toLowerCase() : name.slice(dot + 1).toLowerCase()
  return GLYPH[ext] ?? 'file'
}

/**
 * Leaf name and the folder shown next to it, the way VS Code's Source Control list reads.
 *
 * The full path stays on `title`; this is only what is drawn. Showing `src/main/index.ts` in one
 * grey run makes every row the same shape and the eye has to parse each one — the leaf carries
 * the identity, so it gets the weight and the directory recedes.
 */
export function splitRow(file: string): { name: string; dir: string } {
  const cut = file.lastIndexOf('/')
  return cut < 0 ? { name: file, dir: '' } : { name: file.slice(cut + 1), dir: file.slice(0, cut) }
}

/** Why the Commit button is disabled, in words — or null when it is enabled. */
export function commitBlocker(view: GitView, message: string, busy: boolean): string | null {
  if (busy) return 'Working…'
  if (!view.isRepo) return 'Not a git repository'
  if (view.conflicts.length > 0) return `Resolve ${view.conflicts.length} conflict${view.conflicts.length === 1 ? '' : 's'} first`
  if (view.rebasing) return 'A rebase is in progress — finish or abort it in the terminal'
  if (view.staged.length === 0 && view.outsideStaged === 0) return 'Nothing staged — stage a file, or use Commit all'
  if (!message.trim()) return 'Write a commit message first'
  return null
}

/* ── Where this project pushes ─────────────────────────────────────────────────────────── */

/**
 * `no-remote` — nothing configured, so Push has nowhere to go.
 * `no-upstream` — a remote exists but this branch has never been pushed; plain `git push` FAILS
 *                 here, which is why the panel offers Publish and asks for `push -u`.
 * `connected`  — ordinary Push/Pull work.
 */
export type PublishState = 'no-remote' | 'no-upstream' | 'connected'

export interface RemoteView {
  state: PublishState
  /** The remote a push would use: `origin` when present, else whatever the only one is. */
  name: string
  url: string
  /** Host as a person reads it — `203.0.113.10`, `github.com` — or '' when there is no remote. */
  host: string
}

/** Pull the host out of any git URL shape: ssh://, https://, scp-style `git@host:path`, or a path. */
export function remoteHost(url: string): string {
  const u = (url ?? '').trim()
  if (!u) return ''
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(u)
  if (scheme) return scheme[1]
  const scp = /^[^@\s]+@([^:\s]+):/.exec(u)
  if (scp) return scp[1]
  return u.startsWith('/') || u.startsWith('file:') ? 'this machine' : ''
}

export function deriveRemote(remotes: GitRemote[], upstream?: string): RemoteView {
  const pick = remotes.find((r) => r.name === 'origin') ?? remotes[0]
  if (!pick) return { state: 'no-remote', name: '', url: '', host: '' }
  const url = pick.pushUrl || pick.fetchUrl
  return { state: upstream ? 'connected' : 'no-upstream', name: pick.name, url, host: remoteHost(url) }
}
