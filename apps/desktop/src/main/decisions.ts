import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Decision } from '../shared/types'

/**
 * Project Decisions log — the project's memory of the choices that shaped it
 * ("we use JWT, not sessions"; "prices are records, never charges"). One JSONL
 * per project in userData, mirroring the What-Changed ledger. The agent reads a
 * summary of these (decisionsPrompt) so it respects past decisions instead of
 * re-litigating them; users add/view them in the Insight tab.
 */

function decisionsPath(project: string): string {
  const dir = join(app.getPath('userData'), 'decisions')
  mkdirSync(dir, { recursive: true })
  return join(dir, createHash('sha1').update(project).digest('hex') + '.jsonl')
}

export function addDecision(project: string, entry: { title: string; detail: string; tags?: string[] }): void {
  try {
    const full: Decision = {
      ts: Date.now(),
      title: (entry.title || '').slice(0, 120),
      detail: (entry.detail || '').slice(0, 400),
      tags: entry.tags?.slice(0, 8)
    }
    if (!full.title.trim()) return // a titleless decision is noise
    appendFileSync(decisionsPath(project), JSON.stringify(full) + '\n', 'utf8')
  } catch {
    /* the decisions log must never break the app */
  }
}

export function listDecisions(project: string, limit = 100): Decision[] {
  try {
    const p = decisionsPath(project)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as Decision
        } catch {
          return null // one corrupt/half-written line must not discard the rest
        }
      })
      .filter((d): d is Decision => d !== null)
      .reverse() // newest first
  } catch {
    return []
  }
}

/**
 * A short "respect these decisions" block for the agent system prompt, or '' when
 * there are none (so `.filter(Boolean)` drops it, like houseStylePrompt). Bounded.
 */
export function decisionsPrompt(project: string): string {
  const recent = listDecisions(project, 8)
  if (!recent.length) return ''
  const lines = recent.map((d) => `- ${d.title}${d.detail ? `: ${d.detail}` : ''}`)
  return `PROJECT DECISIONS — respect these established choices; don't undo them without being asked:\n${lines.join('\n')}`
}
