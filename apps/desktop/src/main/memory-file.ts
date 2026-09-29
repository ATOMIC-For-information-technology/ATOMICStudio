import type { MemoryEntry, MemoryKind } from '../shared/types'

/**
 * `ATOMIC-MEMORY.md` — the shareable projection of Project Memory.
 *
 * The JSONL store in userData is the authority; this file is generated from it and read back on
 * load, which is what makes "kept in sync" sound rather than two competing sources of truth.
 *
 * Two properties matter more than prettiness, because this file lives in the user's git repo:
 *
 *  - **Stable order.** Entries are sorted by kind, then key, then id — never by time. A file that
 *    reorders itself on every write produces a merge conflict on every pull.
 *  - **Line-oriented blocks.** One entry is a heading plus `- field: value` lines, so git resolves
 *    two people adding different memories as an ordinary non-overlapping merge.
 *
 * Parsing is total: anything it cannot understand is skipped, never guessed at. A human editing this
 * file by hand (which is the point of it being Markdown) can't corrupt the store.
 */

const HEADER = `<!-- ATOMIC Studio Project Memory. Generated file — safe to commit, safe to hand-edit.
     Studio reads this back, so anything you add here becomes part of what the AI knows. -->`

const KIND_TITLES: Record<MemoryKind, string> = {
  goal: 'Goals',
  decision: 'Decisions',
  convention: 'Conventions',
  'design-rule': 'Design rules',
  'business-rule': 'Business rules',
  bug: 'Known bugs',
  debt: 'Technical debt',
  file: 'Important files',
  'ai-decision': 'Previous AI decisions',
  preference: 'Preferences',
  forbidden: 'Forbidden changes',
  pending: 'Pending work',
  idea: 'Ideas'
}

const KIND_ORDER: MemoryKind[] = [
  'goal',
  'forbidden',
  'business-rule',
  'decision',
  'convention',
  'design-rule',
  'file',
  'bug',
  'debt',
  'pending',
  'preference',
  'idea',
  'ai-decision'
]

const esc = (v: string): string => v.replace(/\r?\n/g, ' ').trim()

/** Deterministic: the same entries always produce byte-identical output. */
export function render(entries: MemoryEntry[]): string {
  const live = entries.filter((e) => !e.forgotten && !e.supersededBy)
  const out: string[] = [HEADER, '', '# Project Memory', '']
  for (const kind of KIND_ORDER) {
    const group = live
      .filter((e) => e.kind === kind)
      .sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '') || a.id.localeCompare(b.id))
    if (!group.length) continue
    out.push(`## ${KIND_TITLES[kind]}`, '')
    for (const e of group) {
      out.push(`### ${esc(e.text)}`)
      out.push(`- id: ${e.id}`)
      out.push(`- ts: ${e.ts}`)
      out.push(`- source: ${e.source}`)
      if (e.key) out.push(`- key: ${esc(e.key)}`)
      if (e.files?.length) out.push(`- files: ${e.files.map(esc).join(', ')}`)
      if (e.tags?.length) out.push(`- tags: ${e.tags.map(esc).join(', ')}`)
      if (e.pinned) out.push(`- pinned: true`)
      if (e.runId != null) out.push(`- run: ${e.runId}`)
      out.push('')
    }
  }
  return out.join('\n')
}

const TITLE_TO_KIND = new Map<string, MemoryKind>(
  (Object.entries(KIND_TITLES) as [MemoryKind, string][]).map(([k, title]) => [title.toLowerCase(), k])
)

/**
 * Read entries back. Anything malformed is skipped — a half-merged file must yield the memories it
 * can still be read for, not an exception and not a guess.
 */
export function parse(text: string): MemoryEntry[] {
  const out: MemoryEntry[] = []
  let kind: MemoryKind | null = null
  let current: Partial<MemoryEntry> | null = null

  const flush = (): void => {
    if (!current || !kind || !current.text || !current.id) {
      current = null
      return
    }
    out.push({
      id: current.id,
      ts: typeof current.ts === 'number' && current.ts > 0 ? current.ts : Date.now(),
      kind,
      text: current.text,
      key: current.key,
      files: current.files,
      tags: current.tags,
      source: current.source === 'agent' ? 'agent' : 'user',
      runId: current.runId,
      pinned: current.pinned
    })
    current = null
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      flush()
      kind = TITLE_TO_KIND.get(line.slice(3).trim().toLowerCase()) ?? null
      continue
    }
    if (line.startsWith('### ')) {
      flush()
      current = { text: line.slice(4).trim() }
      continue
    }
    if (!current || !line.startsWith('- ')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const field = line.slice(2, sep).trim().toLowerCase()
    const value = line.slice(sep + 1).trim()
    if (!value) continue
    if (field === 'id') current.id = value
    else if (field === 'ts') current.ts = Number(value) || undefined
    else if (field === 'source') current.source = value === 'agent' ? 'agent' : 'user'
    else if (field === 'key') current.key = value
    else if (field === 'files') current.files = value.split(',').map((v) => v.trim()).filter(Boolean)
    else if (field === 'tags') current.tags = value.split(',').map((v) => v.trim()).filter(Boolean)
    else if (field === 'pinned') current.pinned = value === 'true'
    else if (field === 'run') current.runId = Number(value) || undefined
  }
  flush()
  return out
}
