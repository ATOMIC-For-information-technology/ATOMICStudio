import type { ProjectBrain } from './types'
import type { ActionPlan } from './actionplan'

/**
 * App Passport — the offline "know your app" fold. A PURE, no-model reduction of the already-computed
 * projectBrain (stack + entry points + db schema + env vars) into plain-English facts a non-coder can
 * read instantly when they open ANY project (their own, or an AI-generated repo). Mirrors the
 * buildActionPlan fold in ./actionplan.ts: no I/O, no model — recomputed on demand.
 */
export interface AppPassport {
  /** Frameworks + top languages + package manager, deduped, most-meaningful first. */
  builtWith: string[]
  /** The files the app starts from. */
  startsAt: string[]
  /** Names of the data records it stores (DB model names), if any. */
  stores: string[]
}

// The languages map is keyed by file EXTENSION (ts, tsx, py…); map to a friendly name a non-coder
// recognizes and fold duplicates (ts + tsx → one "TypeScript"), so we never print "ts, tsx".
const LANG_NAMES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', php: 'PHP', cs: 'C#',
  swift: 'Swift', kt: 'Kotlin', vue: 'Vue', svelte: 'Svelte', css: 'CSS', scss: 'CSS', sass: 'CSS', less: 'CSS', html: 'HTML'
}
const friendlyLang = (ext: string): string => LANG_NAMES[ext.toLowerCase()] ?? ext

export function buildPassport(brain: ProjectBrain | null): AppPassport {
  if (!brain) return { builtWith: [], startsAt: [], stores: [] }
  const builtWith: string[] = []
  const push = (v: string): void => {
    if (v && !builtWith.some((x) => x.toLowerCase() === v.toLowerCase())) builtWith.push(v)
  }
  for (const f of brain.stack.frameworks) push(f) // frameworks first (most recognizable)
  // Fold extensions to friendly language names, summing weights, then take the top few.
  const langWeights = new Map<string, number>()
  for (const [ext, w] of Object.entries(brain.stack.languages)) {
    const name = friendlyLang(ext)
    langWeights.set(name, (langWeights.get(name) ?? 0) + w)
  }
  ;[...langWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([name]) => push(name))
  push(brain.stack.packageManagers[0] ?? '') // then the package manager
  const startsAt = [...brain.entryPoints]
  // Dedup models across dbSchema sources (case-insensitively) — a Prisma project's migration .sql
  // re-declares the same models, so a naive flatMap would list every record type twice.
  const stores = [...new Map(brain.dbSchema.flatMap((s) => s.models).map((m) => [m.toLowerCase(), m])).values()]
  return { builtWith, startsAt, stores }
}

/**
 * Copy handoff summary — a shareable plain-text brief a non-coder can paste to a developer or another
 * AI: what the app is (Passport facts) + the prioritized "do these next" list (the existing action
 * plan). PURE string assembly. NAMES ONLY — it consumes projectBrain/actionPlan text, never a secret
 * value (Secret Handling Protocol).
 */
export function buildHandoff(passport: AppPassport, plan: ActionPlan): string {
  const lines: string[] = ['# Project handoff', '']
  if (passport.builtWith.length) lines.push('Built with: ' + passport.builtWith.join(', '))
  if (passport.startsAt.length) lines.push('Starts at: ' + passport.startsAt.join(', '))
  if (passport.stores.length) lines.push('Stores: ' + passport.stores.join(', '))
  lines.push('', '## Do these next', plan.summary)
  for (const item of plan.items) lines.push('- [' + item.severity + '] ' + item.title + ' — ' + item.detail)
  return lines.join('\n')
}

/**
 * Settings Checkup — a two-sided env-var inventory (the #1 reason a non-coder's app won't start is a
 * missing/misspelled setting). PURE partition of brain.envVars into what the code NEEDS but isn't set,
 * what's fine, and what you set that the app IGNORES — with a gentle "possible match" typo hint. NAMES
 * ONLY, never values.
 */
export interface SettingsCheckup {
  /** Referenced by the code but not declared anywhere — the app needs these. */
  needed: string[]
  /** Referenced AND declared — fine. */
  ok: string[]
  /** Declared but never referenced — a typo or a dead setting; hint points at a likely intended var. */
  unused: { name: string; hint: string | null }[]
}

export function settingsCheckup(envVars: { name: string; referenced: boolean; declared: boolean }[]): SettingsCheckup {
  const needed = envVars.filter((v) => v.referenced && !v.declared).map((v) => v.name)
  const ok = envVars.filter((v) => v.referenced && v.declared).map((v) => v.name)
  const unused = envVars
    .filter((v) => v.declared && !v.referenced)
    .map((v) => ({ name: v.name, hint: nearMatch(v.name, needed) }))
  return { needed, ok, unused }
}

// Tail words that mean the SAME thing (host==server, url==dsn, …). The "same family" hint fires ONLY
// when two same-prefix names differ by SYNONYM tails — so distinct siblings (SMTP_HOST vs SMTP_PORT,
// DATABASE_URL vs DATABASE_POOL) never get a misleading "possible match".
const SYNONYM_TAILS: string[][] = [
  ['host', 'hostname', 'server', 'addr', 'address', 'endpoint'],
  ['url', 'uri', 'dsn', 'conn', 'connection', 'connectionstring'],
  ['pass', 'passwd', 'password', 'pwd'],
  ['user', 'username', 'usr'],
  ['key', 'apikey', 'token', 'secret']
]
const tailOf = (s: string): string => {
  const i = s.lastIndexOf('_')
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase()
}
const sameMeaning = (a: string, b: string): boolean => a === b || SYNONYM_TAILS.some((g) => g.includes(a) && g.includes(b))

/**
 * A gentle "did you mean X?" for an unused setting name against the names the app actually needs.
 * PURE and conservative — returns null unless it's confident. Two signals: (1) same setting FAMILY (a
 * shared prefix before the last underscore, ≥4 chars) AND the differing tails are genuine SYNONYMS
 * (SMTP_SERVER vs SMTP_HOST — a wrong name for the same thing, NOT two distinct settings), or (2) a
 * close TYPO (bounded edit distance ≤ 2). Advisory only — never auto-renames.
 */
export function nearMatch(name: string, candidates: string[]): string | null {
  const n = name.toUpperCase()
  const stem = (s: string): string => {
    const i = s.lastIndexOf('_')
    return i > 0 ? s.slice(0, i) : s
  }
  const nStem = stem(n)
  const nTail = tailOf(n)
  // (1) same family AND synonym tails — a wrong-name mistake, not two distinct settings.
  if (nStem.length >= 4) {
    const fam = candidates.find((c) => {
      const cu = c.toUpperCase()
      return cu !== n && stem(cu) === nStem && sameMeaning(nTail, tailOf(cu))
    })
    if (fam) return fam
  }
  // (2) a close typo overall — ONLY a single edit. A 2-edit bound is unsafe for short tails: distinct
  // settings like SMTP_PORT vs SMTP_HOST are 2 edits apart and would be falsely "matched".
  let best: string | null = null
  let bestD = 2
  for (const c of candidates) {
    const cu = c.toUpperCase()
    if (cu === n || Math.abs(cu.length - n.length) > 1) continue
    const d = editDistance(n, cu, 1)
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return bestD <= 1 ? best : null
}

/** Bounded Levenshtein (rolling row, early-exits once the whole row exceeds `cap`). Small inputs. */
function editDistance(a: string, b: string, cap: number): number {
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > cap) return cap + 1
  const row = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    let diag = row[0]
    row[0] = i
    let rowMin = row[0]
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]
      row[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(row[j], row[j - 1], diag)
      diag = tmp
      if (row[j] < rowMin) rowMin = row[j]
    }
    if (rowMin > cap) return cap + 1
  }
  return row[n]
}
