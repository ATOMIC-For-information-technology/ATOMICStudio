import type { GitChange } from './types'

/**
 * Parser for `git status --porcelain=v2 --branch -z`.
 *
 * Pure and IO-free on purpose: it lives in `shared/` so the headless suite can feed it hand-built
 * records, and so nothing here can ever depend on Node or the DOM. The main process runs git and
 * hands the bytes in; this file turns them into the one status shape the panel folds.
 *
 * Why v2 and why `-z` (2026-09-02). The old reader used `--porcelain` (v1) and `l.slice(3).trim()`
 * per line, which is wrong in three ways that all showed up on real trees:
 *   - a rename is one line, `R  old -> new`, so the row's "file" became `old -> new`;
 *   - v1 QUOTES any path with a space, a quote or a non-ASCII byte, so those rows came back as
 *     `"src/caf\303\251.ts"` and could never be staged, diffed or opened;
 *   - `.trim()` ate leading/trailing spaces that are part of the filename.
 * With `-z` every record is NUL-terminated and paths are raw bytes, a rename carries its original
 * path in a second NUL-separated field, and `--branch` adds the head, upstream and ahead/behind
 * lines — so branch state comes from the SAME process as the file list, not from four more.
 *
 * Record shapes (from git-status(1)):
 *   # branch.oid <oid|(initial)>        # branch.head <name|(detached)>
 *   # branch.upstream <name>            # branch.ab +<ahead> -<behind>
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>NUL<origPath>
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 *   ? <path>          ! <path>
 */

export interface PorcelainStatus {
  /** '' when detached or when git printed no head line. */
  branch: string
  detached: boolean
  /** `git init` with no commit yet: there is no HEAD to diff against and nothing to unstage from. */
  initial: boolean
  headOid: string
  upstream: string | null
  ahead: number
  behind: number
  /** Rows INSIDE the opened folder, with the repo-root prefix stripped so paths are project-relative. */
  changes: GitChange[]
  /** Unmerged paths inside the folder — the authoritative conflict list, no second process needed. */
  conflicts: string[]
  /** Rows outside the folder whose index column is set: `git commit` will include them. */
  outsideStaged: number
  /** Every row git printed for the whole repo, inside or out. */
  repoTotal: number
}

/**
 * A porcelain row is "staged" when its index column carries a change. `?` and `!` rows have no
 * index column at all; unmerged rows are their own state and are never counted as staged.
 */
function indexTouched(x: string): boolean {
  return x !== ' ' && x !== '?' && x !== '!' && x !== '.'
}

/**
 * @param raw     stdout of `git status --porcelain=v2 --branch -z [--untracked-files=all]`
 * @param prefix  `rev-parse --show-prefix` — '' at the repo root, else `sub/dir/` WITH the trailing slash
 */
export function parsePorcelainV2(raw: string, prefix: string): PorcelainStatus {
  const out: PorcelainStatus = {
    branch: '', detached: false, initial: false, headOid: '', upstream: null, ahead: 0, behind: 0,
    changes: [], conflicts: [], outsideStaged: 0, repoTotal: 0
  }
  const inside = (p: string): boolean => !prefix || p.startsWith(prefix)
  const strip = (p: string): string => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p)

  // NUL-terminated, so the final split element is the empty string after the last terminator.
  const recs = raw.split('\0')
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (!rec) continue

    if (rec.startsWith('# ')) {
      const sp = rec.indexOf(' ', 2)
      const key = sp < 0 ? rec.slice(2) : rec.slice(2, sp)
      const val = sp < 0 ? '' : rec.slice(sp + 1)
      if (key === 'branch.oid') {
        if (val === '(initial)') out.initial = true
        else out.headOid = val
      } else if (key === 'branch.head') {
        if (val === '(detached)') out.detached = true
        else out.branch = val
      } else if (key === 'branch.upstream') {
        out.upstream = val || null
      } else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val)
        if (m) {
          out.ahead = parseInt(m[1], 10)
          out.behind = parseInt(m[2], 10)
        }
      }
      continue
    }

    const type = rec[0]
    let x = ' '
    let y = ' '
    let file = ''
    let orig: string | undefined
    let unmerged = false

    if (type === '?' || type === '!') {
      // `? <path>` — the path is everything after the two-character tag, spaces included.
      file = rec.slice(2)
      x = type
      y = type
    } else if (type === '1' || type === '2' || type === 'u') {
      // Fixed-width fields separated by single spaces; the path is the rest after N of them.
      const fields = type === '1' ? 8 : type === '2' ? 9 : 10
      let pos = 0
      for (let f = 0; f < fields; f++) {
        const nx = rec.indexOf(' ', pos)
        if (nx < 0) { pos = -1; break }
        pos = nx + 1
      }
      if (pos < 0) continue // malformed record — never guess a path
      file = rec.slice(pos)
      x = rec[2] ?? ' '
      y = rec[3] ?? ' '
      if (type === '2') {
        // The original path is the NEXT NUL-separated record, by definition of `-z`.
        orig = recs[i + 1] ?? ''
        i++
      }
      if (type === 'u') unmerged = true
    } else {
      continue
    }

    out.repoTotal++
    if (!inside(file)) {
      if (!unmerged && indexTouched(x)) out.outsideStaged++
      continue
    }
    // v2 prints '.' for "unchanged" where v1 printed ' '; the panel's fold reads v1 letters.
    const nx = x === '.' ? ' ' : x
    const ny = y === '.' ? ' ' : y
    const rel = strip(file)
    const change: GitChange = { status: `${nx}${ny}`.trim() || '??', x: nx, y: ny, file: rel }
    if (orig !== undefined) change.orig = strip(orig)
    if (unmerged) {
      change.unmerged = true
      out.conflicts.push(rel)
    }
    out.changes.push(change)
  }
  return out
}
