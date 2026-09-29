import type { DiffLine } from './types'

/**
 * Turn a unified diff (as `git diff` prints it) into the `DiffLine[]` the shared `DiffLines`
 * renderer already draws, so the Git panel shows git's OWN patch instead of re-deriving one.
 *
 * Why not `diffLines()` in `main/diff.ts`: that is an O(n·m) LCS over two whole files, written for
 * the agent's small staged edits. For the Source Control view git has already computed the exact
 * hunks — including for the staged half, which no HEAD-vs-worktree comparison can produce — and
 * parsing them is linear.
 *
 * The one real trap in this format is a content line that starts with `--- ` or `+++ `: a deleted
 * line whose text begins with `-- ` prints as `--- `, indistinguishable from a file header by
 * prefix alone. So the parser tracks hunk line counts from the `@@ -a,b +c,d @@` header and only
 * treats `---`/`+++` as headers OUTSIDE a hunk.
 *
 * Pure, IO-free, and typechecked under both tsconfigs — `shared/` rules.
 */

export interface ParsedDiff {
  lines: DiffLine[]
  added: number
  removed: number
  /** git printed "Binary files … differ" — there is no text patch to show. */
  binary: boolean
  /** Stopped at `maxLines`; what is shown is the HEAD of the patch, never a random middle. */
  truncated: boolean
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseUnifiedDiff(text: string, maxLines = 4000): ParsedDiff {
  const out: ParsedDiff = { lines: [], added: 0, removed: 0, binary: false, truncated: false }
  let oldLeft = 0
  let newLeft = 0
  const inHunk = (): boolean => oldLeft > 0 || newLeft > 0

  const raw = text.split('\n')
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i]
    if (out.lines.length >= maxLines) {
      out.truncated = true
      break
    }
    if (l.startsWith('\\')) {
      // "\ No newline at end of file" applies to the line above. It arrives AFTER the hunk's
      // counted lines are spent, so it must be recognised in either state and never counted.
      if (out.lines.length) out.lines.push({ kind: 'fold', text: '(no newline at end of file)' })
      continue
    }
    if (!inHunk()) {
      const h = HUNK.exec(l)
      if (h) {
        oldLeft = h[2] === undefined ? 1 : parseInt(h[2], 10)
        newLeft = h[4] === undefined ? 1 : parseInt(h[4], 10)
        // Rendered as a fold so the reader sees where in the file the hunk sits, in the same
        // muted register the LCS path uses for "… N unchanged lines …".
        out.lines.push({ kind: 'fold', text: l })
        continue
      }
      if (/^Binary files .* differ$/.test(l) || l.startsWith('GIT binary patch')) {
        out.binary = true
        continue
      }
      // diff --git / index / --- / +++ / mode / rename / similarity headers: nothing to draw.
      continue
    }
    const c = l[0]
    if (c === '+') {
      out.lines.push({ kind: 'add', text: l.slice(1) })
      out.added++
      newLeft--
    } else if (c === '-') {
      out.lines.push({ kind: 'del', text: l.slice(1) })
      out.removed++
      oldLeft--
    } else if (c === ' ') {
      out.lines.push({ kind: 'ctx', text: l.slice(1) })
      oldLeft--
      newLeft--
    } else if (l === '') {
      // A blank context line whose leading space was stripped somewhere upstream. Counting it as
      // context keeps the hunk arithmetic honest instead of ending the hunk one line early.
      out.lines.push({ kind: 'ctx', text: '' })
      oldLeft--
      newLeft--
    } else {
      // Malformed input inside a hunk: stop trusting the counts rather than mislabel content as a
      // header, and re-read this line in header state.
      oldLeft = 0
      newLeft = 0
      i--
    }
    if (oldLeft < 0) oldLeft = 0
    if (newLeft < 0) newLeft = 0
  }
  return out
}
