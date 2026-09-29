/**
 * Work-Safety — the "is my work saved?" fold. A PURE reduction of signals the app already loads
 * (git repo state + last-commit time from git.ts, and the session-only AI-edit / restore-point counts
 * from undo.ts) into a plain-English backup-safety verdict for a non-coder who has never used git.
 * No I/O, no model — recomputed on demand. Also hosts the F2 changed-files formatter.
 */
export interface WorkSafetyInput {
  isRepo: boolean
  /** True only when the project IS the repo root — a subfolder can't be backed up without sweeping in siblings. */
  isRepoRoot: boolean
  /** The project folder is git-IGNORED: it sits inside a repo but git tracks NOTHING in it, so a clean
   *  change list means "invisible to git", never "safely backed up". */
  isIgnored?: boolean
  /** False ⇒ `changedFiles` is a FLOOR, not a count, and the verdict must say "at least". */
  changedFilesExact?: boolean
  changedFiles: number
  /** Last commit time in ms since epoch, 0 if none. */
  lastCommitTs: number
  /** undo.history().length — AI edits this session. */
  sessionEdits: number
  /** undo.checkpoints().length — restore points this session. */
  restorePoints: number
  /** Current time in ms (the app passes Date.now(); keeps this fold pure/testable). */
  now: number
}
export interface WorkSafety {
  band: 'green' | 'amber' | 'red'
  /** COUNT-only plain-English verdict — never a file's contents. */
  verdict: string
  lines: string[]
  /** Whether to offer the one-click "Back up now" (a repo with something to commit). */
  canBackup: boolean
}

const plural = (n: number, s: string): string => `${n} ${s}${n === 1 ? '' : 's'}`

function ago(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${plural(m, 'minute')} ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${plural(h, 'hour')} ago`
  return `${plural(Math.floor(h / 24), 'day')} ago`
}

export function workSafety(i: WorkSafetyInput): WorkSafety {
  const lines: string[] = []
  let band: WorkSafety['band']
  let verdict: string
  if (!i.isRepo) {
    // Not a git project → no version history to recover from. AMBER (a nudge), NOT red: the files are
    // still on disk (they persist when the app closes); only the session's undo history is temporary.
    band = 'amber'
    verdict = "Backups aren't set up yet (this isn't a git project)."
  } else if (i.isIgnored) {
    // Inside a repo, but this folder is EXCLUDED from it. git will report "nothing changed" forever,
    // which must never be shown as green — none of this work is being backed up.
    band = 'amber'
    verdict = 'This folder is excluded from backups, so nothing here is being saved.'
  } else if (i.changedFiles > 0) {
    band = 'amber'
    // A floor is not a new emergency — same band, honest words.
    verdict =
      i.changedFilesExact === false
        ? `At least ${plural(i.changedFiles, 'changed file')} not backed up yet.`
        : `${plural(i.changedFiles, 'changed file')} not backed up yet.`
  } else {
    band = 'green'
    verdict = 'All your work is backed up.'
  }
  if (i.isRepo && !i.isIgnored && i.lastCommitTs > 0) lines.push(`Last backup ${ago(i.now - i.lastCommitTs)}.`)
  // A project that's a SUBFOLDER of a bigger repo can't be one-click backed up here — backing up would
  // sweep in the whole surrounding project. Say so plainly instead of offering a surprising giant commit.
  if (i.isRepo && !i.isIgnored && !i.isRepoRoot && i.changedFiles > 0)
    lines.push('This project lives inside a bigger project — back it up from that project’s main folder.')
  if (i.sessionEdits + i.restorePoints > 0) {
    const what = `${plural(i.sessionEdits, 'AI edit')} and ${plural(i.restorePoints, 'restore point')} can only be undone this session`
    // Telling someone to "back up" a folder that CANNOT be backed up here (it's on the ignore list) is
    // advice with no button and no possible effect. Give the honest alternative instead.
    lines.push(
      i.isIgnored
        ? `${what}. Nothing in this folder can be backed up here — copy anything you need to keep somewhere outside it.`
        : `${what} — back up to keep a permanent record.`
    )
  }
  return { band, verdict, lines, canBackup: i.isRepo && !i.isIgnored && i.isRepoRoot && i.changedFiles > 0 }
}

// ---------------------------------------------------------------- F2: What's Changed Since My Last Backup
/** One working-tree change: a file modified/added/deleted since the last commit, with line counts. */
/**
 * The changed-file list plus how trustworthy its COUNT is. `total` is every row git reported; `files` is
 * the bounded slice we render. `exact` is false when git's own output was cut off before we finished
 * reading it — then every number here is a floor, and the UI must say "at least".
 */
export interface ChangedFileList {
  files: ChangedFile[]
  total: number
  /** More rows exist than `files` carries. */
  capped: boolean
  /** `total` is a true count (nothing was cut off). */
  exact: boolean
}

export interface ChangedFile {
  file: string
  kind: 'modified' | 'new' | 'deleted'
  added: number
  removed: number
}

/** Turn one changed-file row into a plain-English sentence a non-coder can read. NAMES ONLY. */
export function formatChangedFiles(c: ChangedFile): string {
  const label = c.kind === 'new' ? 'Brand-new' : c.kind === 'deleted' ? 'Deleted' : 'Modified'
  if (c.kind === 'deleted') return `${label}: ${c.file}`
  if (c.kind === 'new') return `${label}: ${c.file} (+${c.added})`
  return `${label}: ${c.file} (+${c.added} / −${c.removed})`
}

// ---------------------------------------------------------------- unsaved-work seatbelt (Wave 21)

/**
 * Why we're about to throw away an editor buffer that never reached disk.
 * Nothing recovers this content if we get it wrong: the undo stack only snapshots inside writeFile, so
 * text that was typed but never saved has no on-disk history to restore from.
 */
export type UnsavedReason = 'close-tab' | 'switch-project' | 'delete-path' | 'ai-changed-file' | 'disk-changed-file'

export interface UnsavedGuardInput {
  reason: UnsavedReason
  /** Paths of every tab with unsaved typing. */
  dirtyPaths: string[]
  /** The single tab/file this action is about (close-tab, ai-changed-file). */
  targetPath?: string
  /** A company-server tab — saving goes straight over SSH and this app's Undo cannot reach it. */
  isRemote?: boolean
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel' | 'keep-mine' | 'take-theirs'

export interface UnsavedGuard {
  /** False ⇒ do exactly what the app did before, in one click. The common case MUST stay uninterrupted. */
  block: boolean
  headline: string
  lines: string[]
  choices: UnsavedChoice[]
}

const fileName = (p: string): string => p.split('/').filter(Boolean).pop() || p

/**
 * Decide whether an action would silently destroy typing, and say so in the user's words.
 * ALL of the policy lives here (pure, headless-testable); the renderer only renders it.
 */
export function unsavedGuard(i: UnsavedGuardInput): UnsavedGuard {
  const none: UnsavedGuard = { block: false, headline: '', lines: [], choices: [] }
  const dirty = (i.dirtyPaths ?? []).filter(Boolean)

  if (i.reason === 'ai-changed-file' || i.reason === 'disk-changed-file') {
    // 'disk-changed-file' = the USER asked for it (Undo, Get-this-file-back). Naming the AI there would
    // be a plain lie about who changed the file.
    const actor = i.reason === 'ai-changed-file' ? 'the AI just changed that same file' : 'that file was just restored on disk'
    // The AI rewrote a file you are typing in. Reloading it from disk (what the app did before) throws
    // your typing away with no trace. Only interrupt when THAT tab actually has unsaved typing.
    if (!i.targetPath || !dirty.includes(i.targetPath)) return none
    return {
      block: true,
      headline: `You have unsaved typing in ${fileName(i.targetPath)}, and ${actor}.`,
      lines: [
        `Keep mine — your typing stays in the editor. The other version is on disk, so saving will replace it with yours.`,
        `Take theirs — the version on disk loads into the editor and your typing is gone.`
      ],
      choices: ['keep-mine', 'take-theirs']
    }
  }

  if (i.reason === 'close-tab') {
    if (!i.targetPath || !dirty.includes(i.targetPath)) return none // clean tab → one click, as before
    const lines = ['This was typed but never saved, so nothing can bring it back.']
    if (i.isRemote) lines.push('This file lives on a company server — saving sends it straight there, and the ↩ Undo button in this app cannot take it back.')
    return {
      block: true,
      headline: `Close ${fileName(i.targetPath)} without saving?`,
      lines,
      choices: ['save', 'discard', 'cancel']
    }
  }

  // switch-project / delete-path: several open buffers are about to be dropped at once. Each reason owns
  // its OWN sentence — telling someone deleting a file that they are "opening another project" is simply
  // false, and patching the text at the call site is how that happened.
  if (!dirty.length) return none
  const names = dirty.map(fileName)
  const shown = names.slice(0, 3).join(', ')
  const more = names.length > 3 ? `, and ${names.length - 3} more` : ''
  const head = `${dirty.length === 1 ? '1 file has' : `${dirty.length} files have`} unsaved typing: ${shown}${more}.`
  if (i.reason === 'delete-path') {
    const what = i.targetPath ? `“${fileName(i.targetPath)}”` : 'this'
    return {
      block: true,
      headline: head,
      lines: [
        `Deleting ${what} also closes ${dirty.length === 1 ? 'that file' : 'those files'}.`,
        'Typing that was never saved is not in the Trash and cannot be undone — it only exists in the editor.'
      ],
      choices: ['save', 'discard', 'cancel']
    }
  }
  return {
    block: true,
    headline: head,
    lines: ['Opening another project closes these, and typing that was never saved cannot be recovered.'],
    choices: ['save', 'discard', 'cancel']
  }
}
