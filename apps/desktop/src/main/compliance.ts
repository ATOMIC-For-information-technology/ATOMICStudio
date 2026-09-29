import type { AuditEntry, LedgerEntry, SecurityReport } from '../shared/types'
import { coverageNote } from '../shared/coverage'

/**
 * Compliance export — a single shareable Markdown report bundling the three
 * trust surfaces a non-coder can hand to a client or auditor: the Pre-Ship
 * Security Gate result, the What-Changed & Why ledger, and the local audit
 * trail. Pure formatter: it collects nothing and does no I/O — the caller
 * passes in exactly what scanProject / ledgerList / auditTail already return,
 * so every section degrades gracefully to "none" when a reader came back empty.
 */

const iso = (ts: number): string => {
  try {
    return new Date(ts).toISOString()
  } catch {
    return String(ts)
  }
}

// Escape a value for a GFM table cell: backslashes first (so an escaped pipe
// can't be mis-read), then pipes, then collapse ALL line breaks (\r and \n) to a
// space so a pasted multi-line/CRLF value can never split the row.
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

export function buildComplianceReport(
  projectName: string,
  generatedAt: number,
  security: SecurityReport,
  ledger: LedgerEntry[],
  audit: AuditEntry[]
): string {
  const lines: string[] = []
  lines.push(`# Compliance Report — ${projectName || 'project'}`)
  lines.push('')
  lines.push(`Generated: ${iso(generatedAt)} · by ATOMIC Studio`)
  lines.push('')

  // --- Security ---
  lines.push('## 1. Pre-Ship Security Gate')
  lines.push('')
  lines.push(`Verdict: **${security.verdict || 'not run'}**`)
  lines.push('')
  lines.push(`Files scanned: ${security.filesScanned} · Findings: ${security.findingsTotal ?? security.findings.length}`)
  lines.push('')
  // An auditor reading this must be able to see how much of the project was actually examined —
  // a clean section computed from a partial read would be the most expensive lie in the document.
  const note = coverageNote(security.coverage)
  if (note) {
    lines.push(`> **Coverage:** ${note}`)
    lines.push('')
  }
  if (security.findings.length) {
    lines.push('| Severity | File | Line | Issue |')
    lines.push('| --- | --- | --- | --- |')
    for (const f of security.findings) {
      lines.push(`| ${f.severity} | ${esc(f.file)} | ${f.line || ''} | ${esc(f.message)} |`)
    }
  } else {
    lines.push(
      note
        ? `_No hardcoded secrets or private keys found in the part of the project that was scanned._`
        : '_No hardcoded secrets or private keys found._'
    )
  }
  lines.push('')

  // --- What changed & why ---
  lines.push('## 2. What the AI Changed & Why')
  lines.push('')
  if (ledger.length) {
    lines.push('| When | File | Why | Model |')
    lines.push('| --- | --- | --- | --- |')
    for (const e of ledger) {
      lines.push(`| ${iso(e.ts)} | ${esc(e.file)} | ${esc(e.why)} | ${esc(e.model)} |`)
    }
  } else {
    lines.push('_No AI edits recorded for this project yet._')
  }
  lines.push('')

  // --- Audit trail ---
  lines.push('## 3. Audit Trail')
  lines.push('')
  lines.push('_Note: the audit trail is machine-wide (all projects on this install), newest last._')
  lines.push('')
  if (audit.length) {
    lines.push('| When | Event | Detail |')
    lines.push('| --- | --- | --- |')
    for (const a of audit) {
      lines.push(`| ${iso(a.ts)} | ${esc(a.event)} | ${esc(a.detail)} |`)
    }
  } else {
    lines.push('_No audited events recorded._')
  }
  lines.push('')

  return lines.join('\n')
}
