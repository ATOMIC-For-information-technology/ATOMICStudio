/**
 * Delete-safety fold — the "tell me what I'm about to lose" step. Deleting from the file tree used to be
 * instant and permanent: two clicks erased a folder and everything inside it, with no size, no contents,
 * and no way back (the undo stack only knows about files the app WROTE). This turns the second click
 * into an informed one. PURE: interface in, plain English out, no I/O — same shape as worksafety.ts.
 *
 * Honesty rules this fold exists to enforce:
 *  - a count we couldn't finish is never printed as if it were exact
 *  - "nothing unsaved here" is only ever said when git actually told us so
 *  - if the Trash isn't available, the button must say the deletion is permanent
 */
export interface DeletePreviewInput {
  /** Project-relative path being deleted. */
  relPath: string
  isDir: boolean
  files: number
  dirs: number
  bytes: number
  /** The walk hit its cap — `files`/`dirs`/`bytes` are lower bounds, not totals. */
  countCapped: boolean
  /**
   * WHY the count is incomplete, so the sentence can be true. 'too-big' = we stopped counting;
   * 'skipped-noise' = we counted what you can see but not build/dependency folders; 'unreadable' = part
   * of it could not be opened. Saying "it's big enough that I stopped counting" about a 3-file folder
   * that merely contains node_modules is false.
   */
  capReason?: 'too-big' | 'skipped-noise' | 'unreadable'
  /** Did we actually get an answer from git? False ⇒ we know NOTHING about backup state. */
  gitKnown: boolean
  /** Not a git project at all (vs. tracked-but-this-path-is-ignored) — different sentences. */
  noRepo?: boolean
  /** This exact path is on the ignore list: it has NEVER been backed up, which is not the same as unknown. */
  pathIgnored?: boolean
  /** The backup numbers below are a FLOOR (git's output was cut off, or more rows exist than we hold). */
  backupCountsCapped?: boolean
  /** Files under this path that git has never seen (kind 'new'). */
  neverBackedUp: number
  /** Files under this path changed since the last backup (kind 'modified'). */
  changedNotBackedUp: number
  /** A single small text file we snapshot first, so the app's own ↩ Undo can bring it back. */
  canRestoreWithUndo: boolean
  /** Does this volume support the Trash? False ⇒ the delete really is permanent. */
  trashAvailable: boolean
  /** What the OS calls it: "Trash" on macOS/Linux, "Recycle Bin" on Windows. */
  trashName?: string
}

export interface DeletePreview {
  headline: string
  lines: string[]
  band: 'amber' | 'red'
  /** The exact words on the confirm button — it must never say "Trash" when the delete is permanent. */
  confirmLabel: string
}

const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`

function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

export function describeDeletion(i: DeletePreviewInput): DeletePreview {
  const name = i.relPath.split('/').filter(Boolean).pop() || i.relPath
  const lines: string[] = []

  // --- what is about to go ---
  if (!i.isDir) {
    lines.push(`This is one file (${sizeText(i.bytes)}).`)
  } else if (i.countCapped) {
    // NEVER print a capped count as an exact total — and say the TRUE reason it is incomplete.
    if (i.capReason === 'unreadable') {
      lines.push(`I couldn't look inside part of this folder, so there is more here than I can show you.`)
    } else if (i.capReason === 'skipped-noise') {
      lines.push(`This folder holds ${plural(i.files, 'file')} you can see (${sizeText(i.bytes)}), plus build and dependency folders I didn't count — those go too.`)
    } else {
      lines.push(`This folder holds at least ${plural(i.files, 'file')} — it's big enough that I stopped counting.`)
    }
  } else if (i.files === 0 && i.dirs === 0) {
    lines.push('This folder is empty.')
  } else {
    const parts = [plural(i.files, 'file')]
    if (i.dirs > 0) parts.push(plural(i.dirs, 'folder'))
    lines.push(`This folder holds ${parts.join(' and ')} (${sizeText(i.bytes)}).`)
  }

  // --- is any of it unbacked-up work? ---
  let unsaved = 0
  if (i.pathIgnored) {
    // Different from "unknown": we know FOR CERTAIN it was never backed up.
    lines.push('This is on the project’s ignore list, so it has never been backed up — this is the only copy.')
  } else if (!i.gitKnown) {
    // We genuinely do not know. Say exactly that — never render a reassuring "0 never backed up".
    lines.push(
      i.noRepo
        ? "I can't tell whether any of this is backed up — this project isn't set up for backups."
        : "I can't tell whether any of this is backed up."
    )
  } else {
    unsaved = i.neverBackedUp + i.changedNotBackedUp
    if (unsaved === 0) {
      lines.push('All of it is already backed up, so it can be recovered later.')
    } else {
      const atLeast = i.backupCountsCapped ? 'at least ' : ''
      const bits: string[] = []
      if (i.neverBackedUp > 0) bits.push(`${atLeast}${plural(i.neverBackedUp, 'file')} never backed up`)
      if (i.changedNotBackedUp > 0) bits.push(`${atLeast}${plural(i.changedNotBackedUp, 'file')} changed since the last backup`)
      lines.push(`${bits.join(' and ')} — that work exists ONLY here.`)
    }
  }

  // --- how (and whether) it can be undone ---
  const bin = i.trashName || 'Trash'
  if (!i.trashAvailable) {
    lines.push(`The ${bin} is not available for this location, so deleting here is permanent.`)
  } else if (i.canRestoreWithUndo) {
    lines.push(
      i.isDir
        ? `It goes to the ${bin}, and the ↩ Undo button in this app puts the whole folder back.`
        : `It goes to the ${bin}, and the ↩ Undo button in this app brings it straight back.`
    )
  } else {
    // Too big / binary for the undo stack — still recoverable, just not by us. Name the real route.
    lines.push(`It goes to the ${bin} — too much to undo inside the app, so restore it from there.`)
  }

  // Red when it is genuinely unrecoverable-by-this-app: no Trash, or real unbacked-up work is at stake,
  // or we're deleting blind (unknown backup state on a folder). Amber otherwise.
  const blind = (!i.gitKnown || i.pathIgnored === true) && i.isDir
  const band: 'amber' | 'red' = !i.trashAvailable || unsaved > 0 || blind || i.pathIgnored === true ? 'red' : 'amber'

  const what = i.isDir ? `the folder “${name}”` : `“${name}”`
  const headline = !i.trashAvailable
    ? `Permanently delete ${what}?`
    : unsaved > 0
      ? `Delete ${what}? ${plural(unsaved, 'file')} here ${unsaved === 1 ? 'is' : 'are'} not backed up.`
      : `Delete ${what}?`

  return { headline, lines, band, confirmLabel: i.trashAvailable ? `Move to ${bin}` : 'Delete permanently' }
}
