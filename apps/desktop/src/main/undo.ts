import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { diffLines, foldContext } from './diff'
import type { DiffLine } from '../shared/types'

/**
 * Simple one-click undo: before every AI edit we snapshot the file's previous
 * content onto a stack. Undo pops the last snapshot and restores it. This keeps
 * the user's own git history untouched (we never commit to their repo).
 */
interface Snapshot {
  file: string
  previous: string
  label: string
  ts: number
  /** Did the file exist BEFORE this change? If not, undo REMOVES it (never leaves it empty). */
  existed: boolean
}

const stack: Snapshot[] = []

// Time-Machine checkpoints (defined here so undo()/undoTo() can prune them).
interface Checkpoint {
  id: string
  label: string
  ts: number
  depth: number
}
const marks: Checkpoint[] = []
let markSeq = 0

export function snapshot(file: string, label: string): void {
  const existed = existsSync(file)
  const previous = existed ? readFileSync(file, 'utf8') : ''
  stack.push({ file, previous, label, ts: Date.now(), existed })
}

/**
 * Record an undo entry for a file that is ALREADY gone, using content captured before it went. Used by
 * the delete-to-Trash path: it must read first and trash second, so a rejected trash can never leave an
 * undo entry that would later overwrite a file the user still has.
 */
export function snapshotDeleted(file: string, previous: string, label: string): void {
  stack.push({ file, previous, label, ts: Date.now(), existed: true })
}

/** The full change history, oldest first (index = position in the stack). */
export function history(): { label: string; file: string; ts: number }[] {
  return stack.map(({ label, file, ts }) => ({ label, file, ts }))
}

/**
 * Rewind to a point in the timeline: restore snapshots LIFO until only
 * `keep` remain (undoTo(0) = revert everything). Returns the restored files.
 */
export function undoTo(keep: number): string[] {
  const restored: string[] = []
  while (stack.length > Math.max(0, keep)) {
    const file = undo()
    if (!file) break
    restored.push(file)
  }
  return restored
}

// ---------------------------------------------------------------- Time-Machine checkpoints

/**
 * A named restore point = a labelled position in the undo stack. The agent
 * drops one before every build run ("Before: <goal>") so a whole run — however
 * many files it touched — reverts in one click. Independent of the user's git.
 * A mark is invalidated (pruned) the moment a plain undo drains past it, so a
 * later unrelated edit can never resurrect it.
 */
export function checkpoint(label: string): string {
  const id = `cp${++markSeq}`
  marks.push({ id, label, ts: Date.now(), depth: stack.length })
  return id
}

export function checkpoints(): { id: string; label: string; ts: number }[] {
  // pruneMarks() keeps `marks` free of drained checkpoints, so every entry here
  // still points at the exact snapshots it was taken at.
  return marks.map(({ id, label, ts }) => ({ id, label, ts }))
}

/** Restore the workspace to a named checkpoint. Returns the files restored. */
export function restoreToCheckpoint(id: string): string[] {
  const m = marks.find((c) => c.id === id)
  if (!m || m.depth > stack.length) return []
  return undoTo(m.depth) // undo() prunes marks above the new depth as it pops
}

export function canUndo(): boolean {
  return stack.length > 0
}

export function lastLabel(): string | null {
  return stack.length ? stack[stack.length - 1].label : null
}

/** Restore the most recent snapshot. Returns the file that was restored, or null. */
export function undo(): string | null {
  const snap = stack.pop()
  if (!snap) return null
  // A file that did NOT exist before this change is removed (force: no throw if already gone),
  // never left as a confusing empty file. Only the FILE is removed — not any parent dir a
  // create may have made (that could delete a pre-existing user folder).
  if (snap.existed) {
    // The file's folder may be GONE (its whole directory was deleted). Recreate the path before
    // writing, or restoring a deleted folder would fail file-by-file with ENOENT.
    mkdirSync(dirname(snap.file), { recursive: true })
    writeFileSync(snap.file, snap.previous, 'utf8')
  } else rmSync(snap.file, { force: true })
  pruneMarks()
  return snap.file
}

/**
 * The before→after diff of ONE change (the snapshot at stackIndex), for the
 * Replay diff-viewer. before = that snapshot's captured content; after = the
 * next snapshot of the SAME file (its "previous" is this change's result), or the
 * file's current on-disk content if there was no later change to it. Read-only —
 * never mutates the stack.
 */
export function undoDiff(stackIndex: number): DiffLine[] {
  const snap = stack[stackIndex]
  if (!snap) return []
  const before = snap.previous
  let after: string | null = null
  for (let k = stackIndex + 1; k < stack.length; k++) {
    if (stack[k].file === snap.file) {
      after = stack[k].previous
      break
    }
  }
  if (after === null) after = existsSync(snap.file) ? readFileSync(snap.file, 'utf8') : ''
  return foldContext(diffLines(before, after))
}

/**
 * Drop any checkpoint whose snapshots have been popped off the stack. Without
 * this, a plain undo past a checkpoint leaves a stale mark that a later,
 * unrelated edit would "resurrect" — restoring to the wrong state. Once a
 * checkpoint's depth is above the current stack it is gone for good.
 */
function pruneMarks(): void {
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i].depth > stack.length) marks.splice(i, 1)
}
