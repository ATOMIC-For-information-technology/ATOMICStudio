/**
 * Git merge-conflict markers → structured hunks, and back again.
 *
 * Lives in `shared` because BOTH sides need it and must never disagree: the
 * renderer parses a file to decorate the conflict regions and offer per-hunk
 * actions, while the main process calls `hasConflictMarkers` to REFUSE a commit
 * that would write `<<<<<<<` into history. Two parsers would eventually drift,
 * and the drift would show up as a commit the editor swore was resolved.
 *
 * Pure and IO-free on purpose — no `electron`, no DOM, no Node — so it typechecks
 * under tsconfig.node.json AND tsconfig.web.json, and so the agent suite can
 * exercise it headlessly.
 *
 * ## The diff3 trap
 *
 * With `merge.conflictStyle = diff3` (or `zdiff3`) git writes a THIRD section:
 *
 *     <<<<<<< HEAD          ← ours
 *     const timeout = 5000
 *     ||||||| merged common ancestors   ← the BASE, only in diff3 style
 *     const timeout = 1000
 *     =======
 *     const timeout = 30000
 *     >>>>>>> feature/slow-net          ← theirs
 *
 * A parser that assumes the two-section form treats the base block as part of
 * "current" and happily leaves `||||||| merged common ancestors` sitting in the
 * resolved file. That does not fail loudly — it produces code that still parses
 * and is silently wrong. Both styles are handled here from the first commit.
 */

export interface ConflictHunk {
  /** 1-based line of the `<<<<<<<` marker. */
  startLine: number
  /** Text after `<<<<<<< ` — usually `HEAD`. */
  currentLabel: string
  /** Text after `>>>>>>> ` — the incoming branch/commit. */
  incomingLabel: string
  /** 1-based inclusive body range. `end < start` means the section is empty. */
  currentStart: number
  currentEnd: number
  /** Present only in diff3/zdiff3 style. */
  baseStart?: number
  baseEnd?: number
  incomingStart: number
  incomingEnd: number
  /** 1-based line of the `>>>>>>>` marker. */
  endLine: number
}

export type ConflictChoice = 'current' | 'incoming' | 'both'

const OPEN = /^<{7}(?:\s(.*))?$/
const BASE = /^\|{7}(?:\s(.*))?$/
const SPLIT = /^={7}\s*$/
const CLOSE = /^>{7}(?:\s(.*))?$/

/**
 * Every well-formed conflict in `text`, in file order.
 *
 * Malformed regions are DROPPED rather than guessed at: a `<<<<<<<` with no
 * matching `>>>>>>>` yields no hunk, so the UI offers no button for it and the
 * user is left with the raw markers they can see. Inventing a hunk boundary here
 * would mean a one-click "resolve" that deletes real code.
 */
export function parseConflicts(text: string): ConflictHunk[] {
  const lines = text.split('\n')
  const out: ConflictHunk[] = []

  let i = 0
  while (i < lines.length) {
    const open = OPEN.exec(lines[i])
    if (!open) {
      i++
      continue
    }

    const startLine = i + 1
    const currentLabel = (open[1] ?? '').trim()
    let baseAt = -1
    let splitAt = -1
    let closeAt = -1
    let incomingLabel = ''

    // Scan forward for this hunk's remaining markers. A second `<<<<<<<` before we
    // close means the first one was never a real hunk — abandon it and restart there.
    let j = i + 1
    for (; j < lines.length; j++) {
      const line = lines[j]
      if (OPEN.test(line)) break
      if (splitAt === -1 && baseAt === -1 && BASE.test(line)) {
        baseAt = j
        continue
      }
      if (splitAt === -1 && SPLIT.test(line)) {
        splitAt = j
        continue
      }
      const close = CLOSE.exec(line)
      if (close && splitAt !== -1) {
        closeAt = j
        incomingLabel = (close[1] ?? '').trim()
        break
      }
    }

    if (closeAt === -1) {
      // Unterminated (or interrupted by another `<<<<<<<`). Skip this marker only —
      // resuming at `i + 1` lets the inner one be found on the next pass.
      i++
      continue
    }

    const currentEndIdx = (baseAt === -1 ? splitAt : baseAt) - 1
    out.push({
      startLine,
      currentLabel,
      incomingLabel,
      currentStart: i + 2,
      currentEnd: currentEndIdx + 1,
      ...(baseAt === -1 ? {} : { baseStart: baseAt + 2, baseEnd: splitAt }),
      incomingStart: splitAt + 2,
      incomingEnd: closeAt,
      endLine: closeAt + 1
    })
    i = closeAt + 1
  }

  return out
}

/**
 * Cheap guard for the commit path. Deliberately looser than `parseConflicts`:
 * a STRAY marker (the half of a conflict someone hand-edited into nonsense) is
 * not a parseable hunk but is absolutely still something that must not reach a
 * commit, so this tests for any marker line rather than for a complete hunk.
 */
export function hasConflictMarkers(text: string): boolean {
  return text.split('\n').some((l) => OPEN.test(l) || BASE.test(l) || SPLIT.test(l) || CLOSE.test(l))
}

/**
 * Replace one hunk with the chosen side, returning the whole file.
 *
 * Ranges are 1-based inclusive, so a section that git wrote as empty (end < start)
 * slices to nothing rather than to a stray line. Splitting and re-joining on '\n'
 * preserves the file's trailing newline exactly: the final '' element survives in
 * `after`.
 */
export function resolveHunk(text: string, h: ConflictHunk, choice: ConflictChoice): string {
  const lines = text.split('\n')
  const before = lines.slice(0, h.startLine - 1)
  const after = lines.slice(h.endLine)
  const current = lines.slice(h.currentStart - 1, h.currentEnd)
  const incoming = lines.slice(h.incomingStart - 1, h.incomingEnd)

  // ── POLICY ──────────────────────────────────────────────────────────────────
  // Two judgement calls live here and nowhere else. Both decide whether a bad
  // merge fails loudly or quietly, so they are isolated to stay easy to flip.
  //
  //  1. 'both' ordering. Git has no opinion. Current-first matches VS Code and
  //     matches reading order (the <<<<<<< side is above the ======= side), so a
  //     user who picks "both" gets the file in the order they were just looking at.
  //  2. A diff3 base section is DROPPED, never emitted. Keeping it would leave
  //     ancestor code in the resolved file that compiles and is silently wrong —
  //     the exact failure this module exists to prevent.
  const chosen = choice === 'current' ? current : choice === 'incoming' ? incoming : [...current, ...incoming]
  // ────────────────────────────────────────────────────────────────────────────

  return [...before, ...chosen, ...after].join('\n')
}

/** Resolve every hunk in a file the same way — the "accept all incoming" button. */
export function resolveAll(text: string, choice: ConflictChoice): string {
  // Re-parse after each edit rather than applying cached ranges: resolving a hunk
  // shifts every line number below it, so batch-applying stale offsets would cut
  // the file in the wrong places.
  let out = text
  for (;;) {
    const [next] = parseConflicts(out)
    if (!next) return out
    out = resolveHunk(out, next, choice)
  }
}
