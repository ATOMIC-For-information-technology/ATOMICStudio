import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { audit } from './audit'
import { listDecisions } from './decisions'
import * as memfile from './memory-file'
import type { MemoryEntry, MemoryKind, MemoryRetrieval, MemoryStats } from '../shared/types'

/**
 * PROJECT MEMORY — the durable knowledge a project carries between sessions.
 *
 * ── The line that defines this module ──────────────────────────────────────────────────────────
 * The semantic index (`index-service.ts`) holds everything **derivable** from the code: symbols,
 * imports, the architecture map, the house style. It can be thrown away and rebuilt at any time.
 *
 * Memory holds only what **cannot be recovered by re-reading the repo** — why a decision was made,
 * what must never be changed, the business rules, what the user prefers, what is still pending.
 *
 * If a fact can be recomputed from source, it belongs in the index and must not be copied here.
 * That boundary is what stops memory decaying into a slow, stale duplicate of the codebase.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Storage is append-only JSONL per project (the same sharding as `ledger.ts` and `decisions.ts`),
 * with `ATOMIC-MEMORY.md` in the project folder as an optional shared projection. The JSONL is the
 * authority; the Markdown is generated from it and read back, so "kept in sync" never means two
 * competing sources of truth.
 *
 * Retrieval is **budgeted on purpose**. Memory that grows the system prompt without limit makes the
 * agent slower, more expensive and less accurate — the cap is the feature, not a limitation.
 *
 * Nothing here ever throws into a caller: a corrupt line, a hand-mangled Markdown file or a missing
 * directory degrades to "no memory", exactly like `policy.ts` and `decisions.ts`.
 */

// ---------------------------------------------------------------- storage

function memDir(): string {
  const dir = join(app.getPath('userData'), 'memory')
  mkdirSync(dir, { recursive: true })
  return dir
}

function storePath(project: string): string {
  return join(memDir(), createHash('sha1').update(project).digest('hex') + '.jsonl')
}

function syncPath(): string {
  return join(memDir(), 'sync.json')
}

/** Which projects keep an ATOMIC-MEMORY.md. Absent = off; the app never writes into a repo unasked. */
function syncMap(): Record<string, boolean> {
  try {
    const p = syncPath()
    if (!existsSync(p)) return {}
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

export function isSyncing(project: string): boolean {
  return syncMap()[project] === true
}

export function setSync(project: string, on: boolean): void {
  const map = syncMap()
  map[project] = on
  try {
    writeFileSync(syncPath(), JSON.stringify(map, null, 2), 'utf8')
  } catch {
    /* a failed preference write must not lose the memory itself */
  }
  audit('memory.sync', `${project}=${on}`)
  if (on) writeProjectFile(project)
}

function projectFilePath(project: string): string {
  return join(project, 'ATOMIC-MEMORY.md')
}

/** Read the raw log. One corrupt line never discards the rest (the decisions.ts precedent). */
function readLog(project: string): MemoryEntry[] {
  try {
    const p = storePath(project)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as MemoryEntry
        } catch {
          return null
        }
      })
      .filter((e): e is MemoryEntry => !!e && typeof e.id === 'string' && typeof e.text === 'string')
  } catch {
    return []
  }
}

function appendLog(project: string, entry: MemoryEntry): void {
  try {
    appendFileSync(storePath(project), JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    /* memory must never break the app */
  }
}

// ---------------------------------------------------------------- folding the log

/**
 * Fold the append-only log into the current state.
 *
 * Later records for the same id replace earlier ones (that is how pin/forget/supersede are stored),
 * and `key` collisions are resolved deterministically so two sources can never disagree:
 *   1. a **user** entry beats an **agent** entry — a person's statement outranks an inference;
 *   2. otherwise the newer wins.
 * The loser is kept, marked `supersededBy`, so the history is still there to look at.
 */
function fold(entries: MemoryEntry[]): MemoryEntry[] {
  const byId = new Map<string, MemoryEntry>()
  for (const e of entries) byId.set(e.id, { ...byId.get(e.id), ...e })

  const winners = new Map<string, MemoryEntry>() // key → current holder
  const all = [...byId.values()].sort((a, b) => a.ts - b.ts)
  for (const e of all) {
    if (e.forgotten || !e.key) continue
    const held = winners.get(e.key)
    if (!held) {
      winners.set(e.key, e)
      continue
    }
    const challengerWins = held.source === 'agent' && e.source === 'user' ? true : e.source === 'agent' && held.source === 'user' ? false : e.ts >= held.ts
    const loser = challengerWins ? held : e
    const keeper = challengerWins ? e : held
    loser.supersededBy = keeper.id
    keeper.supersededBy = undefined
    winners.set(e.key, keeper)
  }
  return all
}

/** Mark entries whose named files are gone. Kept and shown, never injected. */
function markStale(project: string, entries: MemoryEntry[]): MemoryEntry[] {
  for (const e of entries) {
    if (!e.files?.length) continue
    e.stale = e.files.some((f) => {
      const abs = isAbsolute(f) ? f : resolve(project, f)
      return !existsSync(abs)
    })
  }
  return entries
}

/**
 * Everything known about a project, newest first.
 *
 * Three sources are merged here, which is what makes memory feel like it was always there:
 *  - the JSONL log (this machine),
 *  - `ATOMIC-MEMORY.md` if present (a teammate's commit, or a fresh clone with no local log),
 *  - the existing Decisions log, absorbed as `kind: 'decision'` so the older feature keeps working
 *    and its content is not stranded outside memory.
 */
export function list(project: string): MemoryEntry[] {
  const log = readLog(project)
  const known = new Set(log.map((e) => e.id))

  const fromFile: MemoryEntry[] = []
  try {
    const p = projectFilePath(project)
    if (existsSync(p)) {
      for (const e of memfile.parse(readFileSync(p, 'utf8'))) {
        if (!known.has(e.id)) {
          fromFile.push(e)
          known.add(e.id)
        }
      }
    }
  } catch {
    /* an unreadable or half-merged file simply contributes nothing */
  }
  // Entries that only exist in the repo file are adopted into this machine's log, so the next
  // read is cheap and the two stay converged.
  for (const e of fromFile) appendLog(project, e)

  const decisions: MemoryEntry[] = listDecisions(project, 50).map((d) => ({
    id: `decision-${createHash('sha1').update(d.title + d.ts).digest('hex').slice(0, 12)}`,
    ts: d.ts,
    kind: 'decision' as const,
    text: d.detail ? `${d.title}: ${d.detail}` : d.title,
    tags: d.tags,
    source: 'user' as const
  }))

  const folded = fold([...log, ...fromFile, ...decisions.filter((d) => !known.has(d.id))])
  return markStale(project, folded).sort((a, b) => b.ts - a.ts)
}

/** What the panel shows; excludes tombstones and superseded history. */
export function active(project: string): MemoryEntry[] {
  return list(project).filter((e) => !e.forgotten && !e.supersededBy)
}

// ---------------------------------------------------------------- writing

const MAX_TEXT = 400

const KINDS: MemoryKind[] = [
  'goal',
  'decision',
  'convention',
  'design-rule',
  'business-rule',
  'bug',
  'debt',
  'file',
  'ai-decision',
  'preference',
  'forbidden',
  'pending',
  'idea'
]

export function isKind(v: string): v is MemoryKind {
  return (KINDS as string[]).includes(v)
}

export function remember(
  project: string,
  input: { kind: MemoryKind; text: string; key?: string; files?: string[]; tags?: string[]; source?: 'user' | 'agent'; runId?: number }
): MemoryEntry | null {
  const text = (input.text || '').trim().slice(0, MAX_TEXT)
  if (!text) return null // a memory with no content is noise
  const entry: MemoryEntry = {
    id: randomUUID(),
    ts: Date.now(),
    kind: isKind(input.kind) ? input.kind : 'idea',
    text,
    key: input.key?.trim().slice(0, 80) || undefined,
    files: input.files?.slice(0, 8),
    tags: input.tags?.slice(0, 8),
    source: input.source ?? 'user',
    runId: input.runId
  }
  appendLog(project, entry)
  audit('memory.add', `${entry.kind} (${entry.source}): ${text.slice(0, 80)}`)
  writeProjectFile(project)
  return entry
}

/** Tombstone, not deletion — the store is append-only and nothing the user wrote is destroyed. */
export function forget(project: string, id: string): void {
  appendLog(project, { id, ts: Date.now(), kind: 'idea', text: '', source: 'user', forgotten: true } as MemoryEntry)
  audit('memory.forget', id)
  writeProjectFile(project)
}

export function setPinned(project: string, id: string, pinned: boolean): void {
  const current = list(project).find((e) => e.id === id)
  if (!current) return
  appendLog(project, { ...current, pinned, ts: current.ts })
  writeProjectFile(project)
}

/** Regenerate the shared file, but only for projects where the user turned it on. */
export function writeProjectFile(project: string): void {
  if (!isSyncing(project)) return
  try {
    writeFileSync(projectFilePath(project), memfile.render(active(project)), 'utf8')
  } catch {
    /* a read-only or missing project folder must not break remembering */
  }
}

// ---------------------------------------------------------------- retrieval

/** Always injected — the things that must never be missed, whatever the task says. */
const ALWAYS: MemoryKind[] = ['forbidden', 'business-rule']

/** Relative pull of each kind when scoring. Not a ranking of importance — a ranking of usefulness
 *  to an agent about to change code. */
const KIND_WEIGHT: Record<MemoryKind, number> = {
  forbidden: 10,
  'business-rule': 8,
  goal: 6,
  decision: 6,
  convention: 5,
  'design-rule': 5,
  pending: 4,
  file: 4,
  bug: 4,
  preference: 3,
  debt: 2,
  'ai-decision': 2,
  idea: 1
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'are', 'was', 'from', 'into', 'add', 'use'])

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
  )
}

const MAX_ENTRIES = 12
const MAX_CHARS = 2000
const MONTH = 30 * 24 * 60 * 60 * 1000

/**
 * Pick what this task needs. Pure and deterministic: same store + same task ⇒ same result, which is
 * what makes agent behaviour reproducible and this module testable without a model.
 *
 * Deliberately lexical rather than embedding-based. At a few hundred entries an explainable score
 * beats a dependency, and `retrieve` is the only thing a future vector store would have to replace.
 */
export function retrieve(project: string, task: string, limit = MAX_ENTRIES): MemoryRetrieval {
  const pool = active(project).filter((e) => !e.stale)
  const q = tokens(task || '')

  const scored = pool.map((e) => {
    const overlap = [...tokens(e.text + ' ' + (e.key ?? '') + ' ' + (e.tags ?? []).join(' '))].filter((t) => q.has(t)).length
    const ageMonths = (Date.now() - e.ts) / MONTH
    const recency = Math.max(0, 3 - ageMonths / 2)
    // An agent's own inference starts a notch below a person's statement of the same strength.
    const trust = e.source === 'agent' ? -1 : 0
    return { e, score: overlap * 4 + KIND_WEIGHT[e.kind] + recency + (e.pinned ? 20 : 0) + trust }
  })

  const always = scored.filter(({ e }) => ALWAYS.includes(e.kind) || e.pinned)
  const rest = scored.filter(({ e }) => !ALWAYS.includes(e.kind) && !e.pinned).sort((a, b) => b.score - a.score)

  const chosen: MemoryEntry[] = []
  let chars = 0
  let omitted = 0
  for (const { e } of [...always.sort((a, b) => b.score - a.score), ...rest]) {
    if (chosen.length >= limit || chars + e.text.length > MAX_CHARS) {
      omitted++
      continue
    }
    chosen.push(e)
    chars += e.text.length
  }
  return { entries: chosen, omitted }
}

const KIND_LABEL: Record<MemoryKind, string> = {
  goal: 'Goal',
  decision: 'Decision',
  convention: 'Convention',
  'design-rule': 'Design rule',
  'business-rule': 'Business rule',
  bug: 'Known bug',
  debt: 'Tech debt',
  file: 'Important file',
  'ai-decision': 'You previously decided',
  preference: 'User preference',
  forbidden: 'NEVER DO THIS',
  pending: 'Pending',
  idea: 'Idea'
}

/**
 * The block that goes into the agent's system prompt, or `''` when there is nothing worth saying —
 * so `.filter(Boolean)` drops it exactly like `houseStylePrompt` and `decisionsPrompt`.
 */
export function memoryPrompt(project: string, task: string): string {
  const { entries, omitted } = retrieve(project, task)
  if (!entries.length) return ''
  const lines = entries.map((e) => `- [${KIND_LABEL[e.kind]}] ${e.text}`)
  const tail = omitted > 0 ? `\n(${omitted} more remembered items were not included; ask if you need them.)` : ''
  return [
    "PROJECT MEMORY — what this project has already established. Treat it as true unless the user says otherwise, and never undo a 'NEVER DO THIS' item:",
    ...lines,
    tail
  ]
    .filter(Boolean)
    .join('\n')
}

export function stats(project: string): MemoryStats {
  const all = active(project)
  const byKind: Partial<Record<MemoryKind, number>> = {}
  for (const e of all) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
  return {
    total: all.length,
    byKind,
    stale: all.filter((e) => e.stale).length,
    syncToProject: isSyncing(project)
  }
}
