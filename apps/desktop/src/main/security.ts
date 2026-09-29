import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as fsService from './fs-service'
import { audit } from './audit'
import { qualifyClean, type CapReason, type Coverage } from '../shared/coverage'
import type { SecurityFinding, SecurityReport } from '../shared/types'

/**
 * Pre-Ship Security Gate — a non-coder-readable "is this safe to launch?" check.
 * Scans the project for the mistakes AI app-builders ship silently: hardcoded
 * secrets/keys, committed .env files, private keys, and world-open access. Every
 * finding is phrased as a plain-English "fix this before you go live". This is a
 * heuristic gate, not a full audit — it catches the CVE-2025-48757 class.
 */

const SCAN_EXT = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|py|rb|php|go|rs|java|json|ya?ml|env|txt|html|sh)$/i
const MAX_FILE = 512 * 1024
const MAX_FILES = 600

interface Rule {
  id: string
  re: RegExp
  severity: SecurityFinding['severity']
  message: string
}

const RULES: Rule[] = [
  { id: 'aws-key', re: /AKIA[0-9A-Z]{16}/, severity: 'critical', message: 'An AWS access key is written in the code — move it to a secret and rotate this key.' },
  { id: 'private-key', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/, severity: 'critical', message: 'A private key is committed in the project — remove it and generate a new one.' },
  { id: 'google-key', re: /AIza[0-9A-Za-z_-]{35}/, severity: 'high', message: 'A Google API key is hardcoded — move it to a secret.' },
  // \b before sk- (so it can't match inside ta**sk-**, di**sk-**, ri**sk-** …) and
  // a no-hyphen tail (so a real key's high-entropy run matches but kebab-case
  // words like task-management-controller do not). Optional proj- catches new keys.
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_]{20,}/, severity: 'high', message: 'An OpenAI-style API key is hardcoded — move it to a secret and rotate it.' },
  { id: 'slack-token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/, severity: 'high', message: 'A Slack token is hardcoded — move it to a secret.' },
  { id: 'generic-secret', re: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i, severity: 'medium', message: 'A password or secret looks hardcoded here — use a workspace secret instead.' },
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, severity: 'medium', message: 'A token (JWT) is written into the code — it should not be committed.' }
]

// Placeholders that should NOT be flagged. Tested against the MATCHED secret
// itself (not the whole line) so an innocuous token elsewhere on the line — a
// TS generic, `example.com`, a comment — can never suppress a real key.
const PLACEHOLDER = /(your[_-]?key|example|placeholder|xxx+|changeme|dummy|test[_-]?key|not-needed|redacted|\*{3,})/i

const MAX_VISITED = 20_000 // hard bound on directory entries traversed (huge asset trees)

// ---- Upload-Safety: which present secret/junk files would go to GitHub because .gitignore misses them ----
// Files that must NEVER be pushed (excluding .env — scanProject's committed-.env rule already covers it).
// Covers modern OpenSSH private keys (ed25519/ecdsa/dsa, incl. FIDO _sk) — not just id_rsa.
const LEAK_SENSITIVE = /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.[A-Za-z0-9]+)?|[^/]+\.pem|[^/]+\.key|[^/]+\.p12|[^/]+\.pfx|credentials\.json|service-account\.json)$/i

// Glob → regex: ** crosses directories (.*), * stays within a segment ([^/]*), ? is one non-slash char.
const globToRegex = (g: string): string =>
  g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')

/** Conservative gitignore match: does `pattern` ignore `path`? Handles trailing-slash dirs, leading-slash
 * anchors, *.ext / ? globs, `**` cross-directory globs, and per-segment basename matching. NOT a full
 * gitignore engine — but it errs toward matching (a MISS would falsely warn), so a leading double-star
 * and bare names both resolve a file at any depth. */
function matchGitignore(pattern: string, path: string): boolean {
  let pat = pattern
  const anchored = pat.startsWith('/')
  if (anchored) pat = pat.replace(/^\/+/, '')
  const dirOnly = pat.endsWith('/')
  if (dirOnly) pat = pat.replace(/\/+$/, '')
  if (pat.startsWith('**/')) pat = pat.slice(3) // "**/name" ignores name at ANY depth (incl. root)
  if (!pat) return false
  const parts = path.split('/')
  if (!pat.includes('/') && !anchored) {
    // basename pattern → matches ANY path segment. A directory-only pattern (name/) matches only a
    // DIRECTORY, so it must land on a non-leaf segment — never a same-named FILE.
    const rx = new RegExp('^' + globToRegex(pat) + '$')
    return (dirOnly ? parts.slice(0, -1) : parts).some((s) => rx.test(s))
  }
  // anchored or contains a slash → match from the project root. A dir-only pattern must be FOLLOWED by
  // a slash (i.e. the path is under that directory); otherwise allow an optional "everything under it" tail.
  const body = globToRegex(pat)
  return new RegExp('^' + body + (dirOnly ? '/' : '(/.*)?$')).test(path)
}

/** Did `pattern` ignore `path` by excluding one of its PARENT DIRECTORIES (vs matching the leaf file)?
 * Git can't re-include a file whose parent dir is excluded, so a `!` negation must not override this. */
function isDirExclusion(pattern: string, path: string): boolean {
  let pat = pattern
  if (pat.startsWith('/')) pat = pat.replace(/^\/+/, '')
  if (pat.endsWith('/')) return true // an explicit directory pattern
  if (pat.startsWith('**/')) pat = pat.slice(3)
  const parts = path.split('/')
  if (!pat.includes('/')) {
    const rx = new RegExp('^' + globToRegex(pat) + '$')
    return parts.slice(0, -1).some((s) => rx.test(s)) // matched a non-leaf segment → a parent dir
  }
  return new RegExp('^' + globToRegex(pat) + '/').test(path) // matched a strict prefix → a parent dir
}

/** PURE: of the PRESENT sensitive/junk paths, which are NOT protected by .gitignore. Later rules and
 * `!negation` override earlier ones (gitignore semantics). `sensitive` = a secret file (vs bulky junk). */
export function scanIgnore(gitignoreText: string, presentPaths: string[]): { path: string; sensitive: boolean }[] {
  const rules = gitignoreText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const isIgnored = (p: string): boolean => {
    let ig = false
    let byDir = false // whether the current ignore came from excluding a PARENT DIRECTORY
    for (const raw of rules) {
      const neg = raw.startsWith('!')
      const pat = neg ? raw.slice(1) : raw
      if (!matchGitignore(pat, p)) continue
      if (neg) {
        // Git rule: a file whose parent directory is excluded cannot be re-included by `!`. So a
        // negation only un-ignores when the ignore was a direct file match, never a parent-dir exclusion.
        if (!byDir) ig = false
      } else {
        ig = true
        byDir = isDirExclusion(pat, p)
      }
    }
    return ig
  }
  const out: { path: string; sensitive: boolean }[] = []
  for (const p of presentPaths) if (!isIgnored(p)) out.push({ path: p, sensitive: LEAK_SENSITIVE.test(p) })
  return out
}

/**
 * Per-line secret/key scan — the SINGLE matching loop shared by the whole-project gate (scanProject)
 * AND the staged-edit guard (scanStagedSecrets), so the two can never drift on rules or placeholders.
 * Returns one finding per matching line (first matching rule wins), with a 1-based line number RELATIVE
 * to the passed array; the caller supplies the file path. Placeholder tokens are suppressed. Pure.
 */
export function scanLines(lines: string[]): { severity: SecurityFinding['severity']; line: number; message: string }[] {
  const out: { severity: SecurityFinding['severity']; line: number; message: string }[] = []
  lines.forEach((line, i) => {
    if (out.length >= 100) return
    if (line.length > 4000) return
    for (const rule of RULES) {
      const m = rule.re.exec(line)
      // Test the placeholder filter against the MATCHED secret, not the whole line.
      if (m && !PLACEHOLDER.test(m[0])) {
        out.push({ severity: rule.severity, line: i + 1, message: rule.message })
        break
      }
    }
  })
  return out
}

export function scanProject(root: string): SecurityReport {
  const findings: SecurityFinding[] = []
  let files = 0
  let visited = 0
  // Every branch below that silently gives up is recorded here, so a clean verdict can never be stated
  // about a part of the project this scan never opened.
  const reasons = new Set<CapReason>()
  let findingsTotal = 0
  const leakFiles: string[] = [] // present sensitive files (id_rsa/*.pem/*.key/credentials…) collected during the walk

  const noteCaps = (): void => {
    if (files >= MAX_FILES) reasons.add('file-cap')
    if (visited >= MAX_VISITED) reasons.add('entry-cap')
    if (findings.length >= 100) reasons.add('finding-cap')
  }
  const walk = (rel: string): void => {
    if (files >= MAX_FILES || visited >= MAX_VISITED || findings.length >= 100) {
      noteCaps()
      return
    }
    for (const entry of fsService.listDir(root, rel)) {
      if (files >= MAX_FILES || visited >= MAX_VISITED || findings.length >= 100) {
        noteCaps()
        return
      }
      visited++ // count EVERY entry so a huge non-code tree can't run unbounded
      if (entry.isDir) {
        walk(entry.path)
        continue
      }
      // A committed .env is itself a finding (should be gitignored). Real env
      // files only — .example/.sample/.template/.dist are meant to be committed.
      if (/(^|\/)\.env(\.|$)/.test(entry.path) && !/\.(example|sample|template|dist)$/.test(entry.path)) {
        findings.push({ severity: 'high', file: entry.path, line: 0, message: 'A .env file with secrets is in the project — make sure it is never uploaded (add it to .gitignore).' })
      }
      // Upload-Safety: remember a present secret file (a private key, credentials…) so we can later
      // check whether .gitignore actually shields it from a GitHub push.
      if (LEAK_SENSITIVE.test(entry.path)) leakFiles.push(entry.path)
      if (!SCAN_EXT.test(entry.name)) continue
      files++
      try {
        const abs = join(root, entry.path)
        if (statSync(abs).size > MAX_FILE) {
          reasons.add('too-big') // counted as scanned, but its contents were never read
          continue
        }
        const lines = readFileSync(abs, 'utf8').split('\n')
        for (const f of scanLines(lines)) {
          findingsTotal++ // the TRUE number found, even past the collection cap
          if (findings.length >= 100) {
            reasons.add('finding-cap')
            continue
          }
          findings.push({ severity: f.severity, file: entry.path, line: f.line, message: f.message })
        }
      } catch {
        reasons.add('unreadable')
      }
    }
  }
  walk('')

  // Upload-Safety: which present SECRET files would go to GitHub because .gitignore misses them —
  // directly enforcing "never upload secrets". .env is deliberately NOT re-checked here (the committed-.env
  // finding above already covers it: dedup, never double-reported). Absent .gitignore → nothing protected.
  if (leakFiles.length && findings.length < 100) {
    let gitignore = ''
    try {
      gitignore = readFileSync(join(root, '.gitignore'), 'utf8')
    } catch {
      /* no .gitignore → every secret file is unprotected */
    }
    for (const leak of scanIgnore(gitignore, leakFiles)) {
      findingsTotal++
      if (findings.length >= 100) {
        reasons.add('finding-cap')
        continue
      }
      findings.push({ severity: 'high', file: leak.path, line: 0, message: `${leak.path} would be uploaded to GitHub if you pushed — move it out of the project or add it to .gitignore.` })
    }
  }

  const rank = { critical: 3, high: 2, medium: 1 }
  findings.sort((a, b) => rank[b.severity] - rank[a.severity])
  const worst = findings[0]?.severity
  // NOTE: rendering fewer rows than we found is NOT a coverage gap — `moreLine` says "…and N more".
  // 'finding-cap' means we genuinely STOPPED COLLECTING, i.e. more problems exist than we hold.
  const coverage: Coverage = { read: files, capped: reasons.size > 0, reasons: [...reasons], shown: Math.min(findings.length, 60), total: Math.max(findingsTotal, findings.length) }
  const verdict = !findings.length
    ? // NEVER an unqualified all-clear about a project we only partly read: on a partial scan the
      // confident "Looks safe to ship" lead is DROPPED entirely, not merely footnoted.
      qualifyClean(
        coverage.capped
          ? 'No hardcoded secrets or private keys found in the part of the project I could read.'
          : 'Looks safe to ship — no hardcoded secrets or private keys found.',
        coverage
      )
    : worst === 'critical'
      ? `Do NOT ship yet — ${findings.length} thing${findings.length === 1 ? '' : 's'} to fix, including a critical secret leak.`
      : `Fix ${findings.length} thing${findings.length === 1 ? '' : 's'} before you go live.`

  audit('security-scan', `${findings.length} findings in ${files} files`)
  return { ok: findings.length === 0, verdict, findings: findings.slice(0, 60), filesScanned: files, coverage, findingsTotal: coverage.total ?? findings.length }
}
