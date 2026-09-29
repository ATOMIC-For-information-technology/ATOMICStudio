import {
  readdirSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  existsSync
} from 'node:fs'
import { join, resolve, relative, sep, basename, extname } from 'node:path'
import { shell } from 'electron'
import { snapshot, snapshotDeleted, checkpoint } from './undo'
import { errMessage } from './util'
import type { DirEntry, FsResult, ReadFileResult } from '../shared/types'

/**
 * Generic, safety-confined filesystem access for the IDE shell (file tree +
 * code editor). Every path is resolved against the opened project root and
 * rejected if it escapes it, so the renderer can never read or write outside
 * the project the user opened.
 */

/**
 * Directories the app's own SCANS never walk: indexing, security and design scans, delete
 * previews, AI context gathering. Generated output and dependency trees are not user code, and
 * walking them is what turns a scan into a crawl.
 *
 * This is deliberately NOT the Explorer's list — see `EXPLORER_EXCLUDED` below. Before
 * 2026-09-02 the two were one set, so the file tree hid `node_modules`, `dist` and `out`
 * entirely: safe for a scanner, wrong for an explorer, because a folder you cannot see is a
 * folder you cannot open, and every other IDE shows them.
 */
export const HIDDEN_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  '.cache',
  '.loop-test',
  '.expo',
  'coverage',
  '.DS_Store'
])

/**
 * What the EXPLORER hides, matching VS Code's default `files.exclude`: version-control
 * metadata and OS droppings, and nothing else. `node_modules`, `dist`, `build`, `.next` and
 * `out` are listed like any other folder — collapsed, and their contents read only when opened,
 * so nothing enumerates a dependency tree on startup.
 */
export const EXPLORER_EXCLUDED = new Set(['.git', '.svn', '.hg', '.DS_Store', 'Thumbs.db'])

/** Which exclusion list a listing should apply. */
export type ListScope = 'scan' | 'explorer'

const MAX_EDIT_BYTES = 2 * 1024 * 1024 // 2 MB — larger files open read-only-ish

// Extensions we treat as binary (don't open in the text editor).
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.rar', '.7z', '.mp4', '.mov', '.webm', '.mp3',
  '.wav', '.ogg', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.wasm', '.node',
  '.class', '.jar', '.exe', '.dll', '.so', '.dylib', '.bin'
])

/** Resolve `relPath` under `root`, throwing if it escapes the project root. */
function safeResolve(root: string, relPath: string): string {
  const abs = resolve(root, relPath || '.')
  const rootResolved = resolve(root)
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new Error('Path is outside the project folder.')
  }
  return abs
}

/** List the immediate children of a directory (lazy — the tree expands on demand). */
export function listDir(root: string, relPath = '', scope: ListScope = 'scan'): DirEntry[] {
  let abs: string
  try {
    abs = safeResolve(root, relPath)
  } catch {
    return []
  }
  let names: string[]
  try {
    names = readdirSync(abs)
  } catch {
    return []
  }
  const excluded = scope === 'explorer' ? EXPLORER_EXCLUDED : HIDDEN_DIRS
  const entries: DirEntry[] = []
  for (const name of names) {
    if (name === '.DS_Store' || name === 'Thumbs.db') continue
    const childAbs = join(abs, name)
    let isDir = false
    let isSymlink = false
    try {
      // lstat FIRST: a symlink to a directory must be reported as a link, not silently followed.
      // Following one is how an explorer walks into a loop (`a -> ..`) and never returns.
      const st = lstatSync(childAbs)
      isSymlink = st.isSymbolicLink()
      isDir = isSymlink ? statSync(childAbs).isDirectory() : st.isDirectory()
    } catch {
      // A broken symlink still EXISTS and should be listed; it just has no target to stat.
      if (!isSymlink) continue
    }
    if (isDir && excluded.has(name)) continue
    const entry: DirEntry = {
      name,
      // Path is always relative to the project root, forward-slashed for the UI.
      path: relative(resolve(root), childAbs).split(sep).join('/'),
      isDir
    }
    if (isSymlink) entry.isSymlink = true
    entries.push(entry)
  }
  // Folders first, then files, each alphabetical (case-insensitive).
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
  return entries
}

export function readFile(root: string, relPath: string): ReadFileResult {
  try {
    const abs = safeResolve(root, relPath)
    if (!existsSync(abs)) return { ok: false, error: 'File not found.' }
    const ext = extname(abs).toLowerCase()
    const size = statSync(abs).size
    if (BINARY_EXT.has(ext)) return { ok: false, error: 'binary', binary: true }
    if (size > MAX_EDIT_BYTES) return { ok: false, error: 'too-large', tooLarge: true }
    return { ok: true, content: readFileSync(abs, 'utf8') }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

/**
 * Write a file, snapshotting the previous content first so Undo can restore it. This is the ONE path
 * every save/apply in the app funnels through (manual saves, agent-applied edits, token apply) — so a
 * write to a file whose folder doesn't exist yet (an agent building a brand-new project from scratch,
 * e.g. `src/Calculator.java` before `src/` exists) must create that folder, not throw ENOENT.
 */
export function writeFile(root: string, relPath: string, content: string): FsResult {
  try {
    const abs = safeResolve(root, relPath)
    snapshot(abs, `edit ${basename(abs)}`)
    mkdirSync(resolve(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

export function createFile(root: string, relPath: string): FsResult {
  try {
    const abs = safeResolve(root, relPath)
    if (existsSync(abs)) return { ok: false, error: 'A file with that name already exists.' }
    mkdirSync(resolve(abs, '..'), { recursive: true })
    writeFileSync(abs, '', 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

export function createDir(root: string, relPath: string): FsResult {
  try {
    const abs = safeResolve(root, relPath)
    if (existsSync(abs)) return { ok: false, error: 'A folder with that name already exists.' }
    mkdirSync(abs, { recursive: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

export function renamePath(root: string, relPath: string, newRelPath: string): FsResult {
  try {
    const from = safeResolve(root, relPath)
    const to = safeResolve(root, newRelPath)
    if (!existsSync(from)) return { ok: false, error: 'Source no longer exists.' }
    if (existsSync(to)) return { ok: false, error: 'Target name already exists.' }
    mkdirSync(resolve(to, '..'), { recursive: true })
    renameSync(from, to)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

const MAX_PREVIEW_ENTRIES = 500
const MAX_PREVIEW_DEPTH = 6
// A folder delete is recoverable IN-APP when we can hold all of its text files in the undo stack.
// Past these bounds we stop promising it and fall back to the system Trash (still recoverable, just
// not by our ↩ Undo) — the confirm message says which one applies.
const MAX_RESTORE_FILES = 300
const MAX_RESTORE_BYTES = 8 * 1024 * 1024

/**
 * Volumes where shell.trashItem has actually FAILED. There is no API to ask "does this volume have a
 * Trash?" without trying, so we stay optimistic until proven otherwise and then remember: on a network
 * share the second delete must not repeat the false "It goes to the Trash" promise.
 */
const noTrashRoots = new Set<string>()

/** What the OS calls its undelete bin — used verbatim in every message the user reads. */
export const TRASH_NAME = process.platform === 'win32' ? 'Recycle Bin' : 'Trash'

/**
 * Can a delete of this exact path be taken back by the app's OWN ↩ Undo? True only for a single text
 * file we can snapshot. This is the SINGLE source of truth: `previewPath` reports it so the confirm
 * message can promise Undo, and `trashPath` obeys it when snapshotting. If these two ever diverged, the
 * app would promise "Undo brings it straight back" for a file it never snapshotted — e.g. any image.
 */
function canSnapshot(abs: string, st: { isDirectory(): boolean; size: number }): boolean {
  return !st.isDirectory() && st.size <= MAX_EDIT_BYTES && !BINARY_EXT.has(extname(abs).toLowerCase())
}

/**
 * Count what a delete would actually destroy, so the confirm step can SAY it. Bounded hard (500 entries,
 * 6 levels) so the first click on a huge folder is still instant; `capped` is reported the moment we stop
 * so the UI never prints a partial count as if it were the total. Hidden dirs are counted (node_modules
 * inside a doomed folder is still going), but never walked into — that would blow the budget on noise.
 */
export function previewPath(
  root: string,
  relPath: string
): { isDir: boolean; files: number; dirs: number; bytes: number; capped: boolean; restorable: boolean; capReason?: 'too-big' | 'skipped-noise' | 'unreadable'; trashAvailable: boolean; trashName: string } {
  const out: { isDir: boolean; files: number; dirs: number; bytes: number; capped: boolean; restorable: boolean; capReason?: 'too-big' | 'skipped-noise' | 'unreadable'; trashAvailable: boolean; trashName: string } =
    { isDir: false, files: 0, dirs: 0, bytes: 0, capped: false, restorable: false, trashAvailable: !noTrashRoots.has(resolve(root)), trashName: TRASH_NAME }
  try {
    const abs = safeResolve(root, relPath)
    if (!existsSync(abs)) return out
    const st = statSync(abs)
    out.isDir = st.isDirectory()
    if (!out.isDir) {
      out.files = 1
      out.bytes = st.size
      out.restorable = canSnapshot(abs, st) // exactly what trashPath will do — never a false promise
      return out
    }
    // Can the whole folder come back with one click? Same bounds the delete will use, so the promise in
    // the confirm message and what actually happens can never disagree.
    out.restorable = readRestorableTree(abs) !== null
    let seen = 0
    const walk = (dir: string, depth: number): void => {
      if (out.capped) return
      let entries: { name: string; isDirectory(): boolean }[]
      try {
        entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        // Unreadable folder. We did NOT look inside, so the count is a lower bound — say so rather than
        // let a permissions error collapse into a confident "this folder is empty".
        out.capped = true
        out.capReason = out.capReason ?? 'unreadable'
        return
      }
      for (const e of entries) {
        if (++seen > MAX_PREVIEW_ENTRIES) {
          out.capped = true
          out.capReason = 'too-big' // genuinely large wins over the other reasons
          return
        }
        const child = join(dir, e.name)
        if (e.isDirectory()) {
          out.dirs++
          // Count the folder, but don't descend into noise or past the depth budget. EITHER skip means
          // the totals are lower bounds: a folder holding node_modules would otherwise report a tiny
          // file count and size while the delete removes tens of thousands of files.
          if (depth < MAX_PREVIEW_DEPTH && !HIDDEN_DIRS.has(e.name)) walk(child, depth + 1)
          else {
            out.capped = true
            out.capReason = out.capReason ?? 'skipped-noise'
          }
        } else {
          out.files++
          try {
            out.bytes += statSync(child).size
          } catch {
            /* vanished mid-walk — ignore */
          }
        }
      }
    }
    walk(abs, 1)
  } catch {
    /* unreadable — return what we have, with capped left as-is */
  }
  return out
}

/**
 * Every text file under `abs` that we could restore, read into memory. Returns null when the tree is
 * too big to hold — the caller then does NOT promise an in-app restore. Binary files are skipped (they
 * are still recoverable from the system Trash, just not through the undo stack).
 */
function readRestorableTree(abs: string): { file: string; previous: string }[] | null {
  const out: { file: string; previous: string }[] = []
  let bytes = 0
  let overflow = false
  const walk = (dir: string, depth: number): void => {
    if (overflow || depth > MAX_PREVIEW_DEPTH) return
    let entries: { name: string; isDirectory(): boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const e of entries) {
      if (overflow) return
      const child = join(dir, e.name)
      if (e.isDirectory()) {
        if (!HIDDEN_DIRS.has(e.name)) walk(child, depth + 1)
        continue
      }
      try {
        const st = statSync(child)
        if (!canSnapshot(child, st)) continue // binary / oversized — Trash-only, by design
        if (out.length >= MAX_RESTORE_FILES || bytes + st.size > MAX_RESTORE_BYTES) {
          overflow = true
          return
        }
        out.push({ file: child, previous: readFileSync(child, 'utf8') })
        bytes += st.size
      } catch {
        /* vanished or unreadable mid-walk — skip it */
      }
    }
  }
  walk(abs, 1)
  return overflow ? null : out
}

/**
 * Move a file or folder to the system Trash instead of erasing it. For a single small text file we also
 * snapshot it first, so the app's OWN ↩ Undo restores it (undo.ts already handles the existed=true path).
 *
 * If the Trash is unavailable (network share, some external volumes) this returns an error and
 * `trashed: false` — it must NEVER silently fall through to a permanent delete. The renderer re-asks with
 * an explicitly permanent confirm, which then calls `deletePath`.
 */
export async function trashPath(root: string, relPath: string): Promise<FsResult & { trashed: boolean; checkpointId?: string; restoredFiles?: number }> {
  try {
    const abs = safeResolve(root, relPath)
    if (abs === resolve(root)) return { ok: false, trashed: false, error: 'Cannot delete the project root.' }
    if (!existsSync(abs)) return { ok: true, trashed: false }
    const st = statSync(abs)
    // Read the content FIRST, trash SECOND, and only then push the undo entry. Snapshotting before the
    // trash left an orphan entry when trashItem rejected — a later ↩ Undo would then overwrite the file
    // the user still had (with older content) as if it had been deleted.
    if (st.isDirectory()) {
      // Read the whole tree FIRST (it is about to disappear), trash it, then record one checkpoint so a
      // single click restores the entire folder — recovery no longer means "go dig in the Trash".
      const tree = readRestorableTree(abs)
      await shell.trashItem(abs)
      if (tree && tree.length) {
        const id = checkpoint(`delete folder ${basename(abs)}`)
        for (const f of tree) snapshotDeleted(f.file, f.previous, `delete ${basename(f.file)}`)
        return { ok: true, trashed: true, checkpointId: id, restoredFiles: tree.length }
      }
      return { ok: true, trashed: true }
    }
    const restorable = canSnapshot(abs, st)
    const previous = restorable ? readFileSync(abs, 'utf8') : null
    await shell.trashItem(abs)
    if (previous !== null) snapshotDeleted(abs, previous, `delete ${basename(abs)}`)
    return { ok: true, trashed: true }
  } catch (e) {
    // Remember this volume can't Trash, so the NEXT confirm says "Delete permanently" up front instead
    // of promising a Trash copy that will never exist.
    noTrashRoots.add(resolve(root))
    return { ok: false, trashed: false, error: errMessage(e) }
  }
}

/** Delete a file or folder. Caller (renderer) must confirm first — this is destructive. */
export function deletePath(root: string, relPath: string): FsResult {
  try {
    const abs = safeResolve(root, relPath)
    if (abs === resolve(root)) return { ok: false, error: 'Cannot delete the project root.' }
    if (!existsSync(abs)) return { ok: true }
    rmSync(abs, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}
