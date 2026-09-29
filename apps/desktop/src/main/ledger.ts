import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { LedgerEntry } from '../shared/types'

/**
 * "What Changed & Why" ledger — a plain-English, searchable record of every AI
 * edit: which file, why (the instruction that caused it), which model, and when.
 * One JSONL per project in userData; non-coders get a running map of their app.
 */

function ledgerPath(project: string): string {
  const dir = join(app.getPath('userData'), 'ledger')
  mkdirSync(dir, { recursive: true })
  return join(dir, createHash('sha1').update(project).digest('hex') + '.jsonl')
}

export function ledgerAppend(project: string, entry: Omit<LedgerEntry, 'ts'> & { ts?: number }): void {
  try {
    const full: LedgerEntry = { ts: entry.ts ?? Date.now(), file: entry.file, why: entry.why.slice(0, 240), model: entry.model }
    appendFileSync(ledgerPath(project), JSON.stringify(full) + '\n', 'utf8')
  } catch {
    /* the ledger must never break an edit */
  }
}

export function ledgerList(project: string, limit = 100): LedgerEntry[] {
  try {
    const p = ledgerPath(project)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as LedgerEntry
        } catch {
          return null // one corrupt line must not discard the whole ledger
        }
      })
      .filter((e): e is LedgerEntry => e !== null)
      .reverse()
  } catch {
    return []
  }
}

export function ledgerSearch(project: string, query: string): LedgerEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return ledgerList(project)
  return ledgerList(project, 1000).filter((e) => e.file.toLowerCase().includes(q) || e.why.toLowerCase().includes(q))
}
