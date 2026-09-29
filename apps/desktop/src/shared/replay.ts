import type { AgentTask, LedgerEntry, ReplayEvent, UndoHistoryEntry } from './types'

/**
 * Development Replay — fold the project's evidence trails into one ordered story:
 * AI edits (ledger, per-project), manual changes (undo history), and finished
 * agent runs. EVERY source is scoped to this project: the ledger is fetched
 * per-project; finished runs filter by projectPath; undo history (a session-global
 * stack) is filtered to files under the project. Session-global Time-Machine
 * checkpoints carry no project and are deliberately EXCLUDED here (they'd leak
 * another project's build-instruction labels) — they live in the History panel,
 * which is honestly session-wide. Pure; newest first.
 */
export function foldReplay(input: {
  ledger: LedgerEntry[]
  history: UndoHistoryEntry[]
  finished: AgentTask[]
  project: string
}): ReplayEvent[] {
  const events: ReplayEvent[] = []
  const underProject = input.project.endsWith('/') ? input.project : input.project + '/'
  const underP = (f: string): boolean => f === input.project || f.startsWith(underProject)
  for (const e of input.ledger) events.push({ ts: e.ts, kind: 'ai-edit', title: e.file, detail: e.why, file: e.file })
  // Iterate with the FULL-array index so stackIndex is the real undo-stack position
  // (undoTo(keep) keeps the first `keep`), even though out-of-project entries are skipped.
  input.history.forEach((h, i) => {
    if (!underP(h.file)) return // scope the session-global stack to this project
    // A revert (undoTo(i)) pops EVERY entry from i to the top of the global stack.
    // Offer it (stackIndex) ONLY if all of those belong to this project — else it
    // would silently clobber another project's newer edits. Show the row regardless.
    const safe = input.history.every((e, k) => k < i || underP(e.file))
    events.push({ ts: h.ts, kind: 'change', title: h.label, detail: h.file, file: h.file, stackIndex: safe ? i : undefined })
  })
  for (const t of input.finished) {
    if (t.projectPath !== input.project) continue
    events.push({ ts: t.endedAt ?? t.startedAt, kind: 'agent-run', title: t.instruction, detail: `${t.status} · ${t.turns} turn${t.turns === 1 ? '' : 's'}` })
  }
  return events.sort((a, b) => b.ts - a.ts)
}
