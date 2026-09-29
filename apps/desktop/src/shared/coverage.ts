/**
 * Coverage vocabulary — how much of the project a check actually READ, and the words for saying so.
 *
 * Several verdicts in this app are computed from a deliberately bounded sample (the security gate stops
 * at 600 files, the index at 300) and then stated as fact: "Looks safe to ship", "This project has no
 * tests". On a small project that is true. On a big one it is a clean bill of health issued for a part
 * of the project that was never opened.
 *
 * Every sentence here is COUNT-ONLY: never a file name, never a matched value, because these strings
 * reach the compliance report a client may read.
 *
 * The anti-nagware rule lives INSIDE the fold: when nothing was hidden, every function returns '' and
 * the UI renders nothing at all. A caveat that shows up on a 4-file project teaches the user to ignore
 * caveats, which would cost more than it buys.
 */
export type CapReason =
  /** The walk stopped after N files. */
  | 'file-cap'
  /** The walk stopped after visiting N directory entries. */
  | 'entry-cap'
  /** We stopped collecting once there were N findings. */
  | 'finding-cap'
  /** Individual files were skipped for being too large to read. */
  | 'too-big'
  /** Files or folders could not be opened at all. */
  | 'unreadable'
  /** A command's output was cut off before we finished reading it. */
  | 'output-truncated'

export interface Coverage {
  /** How many units (usually files) were actually read. */
  read: number
  /** True when ANYTHING was skipped, stopped or cut short. */
  capped: boolean
  /** Why — so the sentence can name the real reason instead of hedging vaguely. */
  reasons: CapReason[]
  /** For a list that renders fewer rows than it found. */
  shown?: number
  total?: number
}

/** A fresh, nothing-hidden coverage record. */
export function fullCoverage(read: number): Coverage {
  return { read, capped: false, reasons: [] }
}

const REASON_TEXT: Record<CapReason, (c: Coverage, unit: string) => string> = {
  'file-cap': (c, unit) => `I read the first ${c.read} ${unit} — that's part of this project, not all of it.`,
  'entry-cap': (c, unit) => `I stopped after ${c.read} ${unit} — that's part of this project, not all of it.`,
  // Only ever emitted when collection genuinely stopped — showing fewer rows than were found is not a
  // coverage gap and is covered by moreLine(), so this must never read as "I stopped" in that case.
  'finding-cap': () => 'I stopped after the first 100 problems — there are more than I can list.',
  'too-big': () => 'Some files were too large to read.',
  unreadable: () => "Some files couldn't be opened.",
  'output-truncated': () => 'The full answer was too long to read to the end.'
}

/**
 * A plain-English note about what was NOT read, or '' when everything was. `unit` is the plural noun the
 * counts refer to, e.g. 'files'.
 */
export function coverageNote(c: Coverage | null | undefined, unit = 'files'): string {
  if (!c || !c.capped || !c.reasons.length) return ''
  // Most specific reason first; one sentence is enough for a non-coder.
  const order: CapReason[] = ['file-cap', 'entry-cap', 'finding-cap', 'too-big', 'unreadable', 'output-truncated']
  const parts: string[] = []
  for (const r of order) {
    if (c.reasons.includes(r)) parts.push(REASON_TEXT[r](c, unit))
  }
  return parts.slice(0, 2).join(' ')
}

/**
 * Qualify a CLEAN verdict so it can never claim more than was looked at. An unbounded read returns the
 * original sentence untouched — the small-project case must stay byte-identical.
 */
export function qualifyClean(clean: string, c: Coverage | null | undefined, unit = 'files'): string {
  const note = coverageNote(c, unit)
  if (!note) return clean
  // Two clean sentences. Splicing the note into the middle of the caller's sentence produced things
  // like "…found — but i read the first 600 files", which is both ungrammatical and still leads with
  // an unqualified all-clear.
  return `${clean.replace(/\s*$/, '')} ${note}`
}

/** "…and 170 more" for a list that renders fewer rows than it found, or '' when it shows everything. */
export function moreLine(shown: number, total: number): string {
  if (!Number.isFinite(shown) || !Number.isFinite(total) || total <= shown) return ''
  return `…and ${total - shown} more`
}
