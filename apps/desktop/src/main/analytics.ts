import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { MetricSnapshot } from '../shared/types'

/**
 * Analytics-over-time — a per-project time series of the health metrics, so the
 * Insight tab can show a trend (is the project getting healthier?). One JSONL per
 * project in userData, oldest→newest (a time axis). The renderer owns the numbers
 * (the health useMemo); this module only persists what it's handed. Same-day
 * writes REPLACE the day's row, so the baseline (secrets=null) is upgraded once a
 * security scan fills it in, and a tab that's opened repeatedly doesn't stack rows.
 */

function analyticsPath(project: string): string {
  const dir = join(app.getPath('userData'), 'analytics')
  mkdirSync(dir, { recursive: true })
  return join(dir, createHash('sha1').update(project).digest('hex') + '.jsonl')
}

export function analyticsRecord(project: string, snap: Omit<MetricSnapshot, 'ts'>): void {
  try {
    const full: MetricSnapshot = { ts: Date.now(), ...snap }
    const p = analyticsPath(project)
    const rows: MetricSnapshot[] = analyticsList(project, 10_000)
    const last = rows[rows.length - 1]
    if (last && new Date(last.ts).toDateString() === new Date(full.ts).toDateString()) {
      rows[rows.length - 1] = full // same day → upgrade, don't stack
      writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    } else {
      appendFileSync(p, JSON.stringify(full) + '\n', 'utf8')
    }
  } catch {
    /* analytics must never break the app */
  }
}

export function analyticsList(project: string, limit = 90): MetricSnapshot[] {
  try {
    const p = analyticsPath(project)
    if (!existsSync(p)) return []
    // Oldest → newest (NOT reversed) for a left-to-right time-axis sparkline.
    return readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as MetricSnapshot
        } catch {
          return null // skip a corrupt line rather than losing the whole series
        }
      })
      .filter((s): s is MetricSnapshot => s !== null)
  } catch {
    return []
  }
}
