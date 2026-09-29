import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditEntry, FraudReportResult } from '../shared/types'

/**
 * Tamper-evident-enough local audit trail for company (protected) workspaces:
 * one JSONL line per event in userData/audit.log. Companies can wire a fraud
 * webhook — violations and manual reports POST there with the recent tail.
 */

function logPath(): string {
  return join(app.getPath('userData'), 'audit.log')
}

export function audit(event: string, detail: string): void {
  try {
    appendFileSync(logPath(), JSON.stringify({ ts: Date.now(), event, detail }) + '\n', 'utf8')
  } catch {
    /* audit must never crash the app */
  }
}

export function auditTail(count = 50): AuditEntry[] {
  try {
    if (!existsSync(logPath())) return []
    return readFileSync(logPath(), 'utf8')
      .trim()
      .split('\n')
      .slice(-count)
      .map((l) => JSON.parse(l) as AuditEntry)
  } catch {
    return []
  }
}

/**
 * Send a fraud/violation report to the company's webhook (if configured) with
 * the recent audit tail. Manual (🚩 button) and automatic (policy violations).
 */
export async function reportFraud(webhook: string | undefined, reason: string): Promise<FraudReportResult> {
  audit('fraud-report', reason)
  if (!webhook) return { ok: true, delivered: false }
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'atomic-studio',
        reason,
        ts: Date.now(),
        recentAudit: auditTail(30)
      })
    })
    return { ok: res.ok, delivered: res.ok, error: res.ok ? undefined : `Webhook responded ${res.status}` }
  } catch (e) {
    return { ok: false, delivered: false, error: e instanceof Error ? e.message : 'Webhook unreachable' }
  }
}
