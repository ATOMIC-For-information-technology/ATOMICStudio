import type { DependencyFinding, DependencyReport, DesignReview, DriftReport, ProjectInsight, SecurityReport, StagedEdit } from './types'

/**
 * Fix-First Action Plan — the triage spine. A PURE fold over the signals the app already
 * computes (tech-debt/tests from Insight, the Security Gate, Design Review, Architecture Drift)
 * into ONE ranked "do these next" list, so a non-coder gets a plain-English to-do instead of
 * reading four dashboards and a bare 0-100 score. No I/O, no model — recomputed on demand.
 */
export type ActionSeverity = 'critical' | 'high' | 'medium' | 'low'
/** Which shipped tool fixes this item — the card's "go here" button routes on it. */
export type ActionKind = 'security' | 'tests' | 'drift' | 'design' | 'debt' | 'deps'

export interface ActionItem {
  severity: ActionSeverity
  kind: ActionKind
  title: string
  detail: string
  /**
   * The ONE file this item is about, when it has one (a row clicked in the Fragile-files watchlist).
   * Plan-level items leave it unset. `fixInstruction` narrows the seeded instruction to this file so
   * clicking one row can never seed a project-wide "remove unused/dead files" refactor.
   */
  file?: string
}
export interface ActionPlan {
  summary: string
  items: ActionItem[]
}
export interface ActionSignals {
  insight?: ProjectInsight | null
  security?: SecurityReport | null
  design?: DesignReview | null
  drift?: DriftReport | null
  dependency?: DependencyReport | null
}

/** Dependency findings that can actually break a clean install: a package imported but not declared
 * (phantom), or a wildcard version that can install anything (high-severity unpinned). Pure. */
export function depInstallBreakers(r?: DependencyReport | null): DependencyFinding[] {
  return (r?.findings ?? []).filter((f) => f.kind === 'phantom' || (f.kind === 'unpinned' && f.severity === 'high'))
}

const RANK: Record<ActionSeverity, number> = { critical: 3, high: 2, medium: 1, low: 0 }

// ---------------------------------------------------------------- Fix-Verify (did the fix work?)
export type VerifyStatus = 'fixed' | 'improved' | 'unchanged' | 'worse'
export interface FixVerification {
  kind: ActionKind
  status: VerifyStatus
  before: number
  after: number
  /** COUNT-only plain-English verdict — never any finding text or value (Secret Handling Protocol). */
  headline: string
}
const KIND_NOUN: Record<ActionKind, string> = {
  security: 'security issues',
  design: 'design nits',
  debt: 'debt items',
  tests: 'missing tests',
  drift: 'removed things',
  deps: 'package problems'
}

/** How many problems of a kind exist right now — mirrors buildActionPlan's per-kind counting so
 * the card and the verify verdict never disagree. Pure. */
export function kindProblemCount(kind: ActionKind, s: ActionSignals): number {
  switch (kind) {
    case 'security':
      return s.security?.findings.length ?? 0
    case 'design':
      return s.design ? s.design.hardcodedColors + s.design.nearDuplicates.length : 0
    case 'debt':
      return (s.insight?.debt ?? []).filter((d) => d.kind !== 'untested').length
    case 'tests':
      // 'unknown' contributes 0: a count we never established must not let Fix-Verify report
      // "Fixed — 1 missing test → 0" for something that was never actually missing.
      return s.insight ? (testsClaim(s.insight) === 'no' ? 1 : 0) : 0
    case 'drift': {
      const d = s.drift
      return d?.hasBaseline ? d.modules.removed.length + d.edges.removed.length + d.externalDeps.removed.length : 0
    }
    case 'deps':
      // Count ALL dependency findings (not just install-breakers) so Fix-Verify tracks EVERY deps item —
      // adding a lockfile or removing an unused dep must read as "Fixed", not a spurious "No change".
      return s.dependency?.findings.length ?? 0
    default:
      return 0
  }
}

/** Compare a before/after problem count into a calm, COUNT-ONLY verdict. Pure. */
export function verifyFix(kind: ActionKind, before: number, after: number, partial = false): FixVerification {
  const noun = KIND_NOUN[kind] ?? 'issues'
  let status: VerifyStatus
  let headline: string
  if (after <= 0 && before > 0) {
    status = 'fixed'
    headline = partial ? `Looks fixed — ${before} ${noun} → 0 (large project, partial view).` : `Fixed — ${before} ${noun} → 0.`
  } else if (after < before) {
    status = 'improved'
    headline = `Better — ${before} → ${after} ${noun}.`
  } else if (after > before) {
    status = 'worse'
    headline = `Careful — went ${before} → ${after} ${noun}. Undo and try again.`
  } else {
    status = 'unchanged'
    headline = `No change — still ${after} ${noun}.`
  }
  return { kind, status, before, after, headline }
}

// ---------------------------------------------------------------- Apply-time guardrail: Blind-Edit
/** True when the agent OVERWROTE an EXISTING file WITHOUT reading it first — the scariest silent
 * pattern for a non-coder (the AI confidently rewrites a file it never looked at). A brand-new file
 * (isNew) is NEVER a blind edit: there was nothing to read. Pure — the boolean is already computed on
 * every StagedEdit (readBeforeWrite); this just makes it its own unmissable badge at the Apply moment. */
export function isBlindEdit(e: Pick<StagedEdit, 'isNew' | 'readBeforeWrite'>): boolean {
  return !e.isNew && !e.readBeforeWrite
}

/**
 * A plain-English instruction to hand the built-in agent for a "Fix with AI" click. Pure and
 * safe: for a security item it names only the finding's file:line (NEVER the message, which
 * could echo a secret value — Secret Handling Protocol); other kinds use the item's own
 * aggregate title/detail (no sensitive content). Never throws on missing signals.
 */
export function fixInstruction(item: ActionItem, s: ActionSignals = {}): string {
  switch (item.kind) {
    case 'security': {
      const locs = (s.security?.findings ?? []).slice(0, 5).map((f) => `${f.file}${f.line ? ':' + f.line : ''}`).filter(Boolean)
      const where = locs.length ? ` (e.g. ${locs.join(', ')})` : ''
      return `Fix the security issues the Pre-Ship Security Gate flagged${where}: move any hardcoded secret, key or token out of the source and load it from an environment variable instead. Do not print the secret value.`
    }
    case 'debt':
      // A row about ONE file must stay about that file: seeding a whole-project "remove unused/dead
      // files" instruction from a single click is how a non-coder ends up with a sweeping refactor
      // (and a delete) they never asked for.
      if (item.file)
        return `Clean up the single file ${item.file} (${item.detail}) — tidy it in place: split it up if it is too long and resolve its TODOs, keeping behavior identical. Do not change or delete any other file.`
      return `Reduce the project's code debt (${item.detail}) — split oversized files into smaller modules and remove unused/dead files, keeping behavior identical.`
    case 'design':
      return `Improve the design-system consistency (${item.detail}) — replace hardcoded colors with the project's design tokens and merge near-duplicate colors.`
    case 'tests':
      return "Add unit tests for the project's main modules using its existing test runner."
    case 'deps':
      // The deps kind has three variants — seed the instruction that matches THIS item, so a lockfile /
      // tidy item never gets a missing-packages instruction that describes work that doesn't exist.
      if (/lockfile/i.test(item.title)) return "Generate a lockfile: run the project's package manager install once (e.g. npm install) and commit the resulting lockfile so the installed versions stay consistent."
      if (/tidy/i.test(item.title)) return 'Tidy the dependencies: remove packages that are installed but never imported, replace any heavyweight library with a lighter alternative, and de-duplicate.'
      return "Fix the dependency problems: add any packages the code imports that are missing from package.json, and pin any wildcard (*) versions to a specific version so an install can't silently change them."
    default:
      return `${item.title}. ${item.detail}`
  }
}
const plural = (n: number, s: string): string => `${n} ${s}${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------- Ship-Readiness (one traffic light)
export interface ShipReadiness {
  band: 'green' | 'amber' | 'red'
  /** One plain-English line — count/kind only, never a leaked value. */
  verdict: string
  topBlocker: ActionItem | null
  /** True when a key check hasn't run or the picture is capped — we then never claim GREEN. */
  incomplete: boolean
}

/**
 * A single honest traffic light over the already-ranked action plan: "is it safe to ship, and if not,
 * what's the ONE thing stopping me?". PURE — a fold over folds, no scanning, no I/O. RED only for a
 * real ship-blocker (a critical/high security leak or a dependency install-breaker); AMBER for tidy-ups
 * or when checks are incomplete; GREEN only when the plan is empty AND nothing is unchecked/partial.
 */
/**
 * Do we KNOW whether this project has tests?
 *  - 'yes'     we saw a test file
 *  - 'no'      we read the whole project and there were none
 *  - 'unknown' we only read a sample and saw none — the tests folder may be past where we stopped
 * Fails to 'unknown' on missing data: honest beats reassuring, and beats accusing.
 */
export function testsClaim(insight?: { hasTests?: boolean; coverage?: { capped?: boolean } } | null): 'yes' | 'no' | 'unknown' {
  if (!insight || typeof insight.hasTests !== 'boolean') return 'unknown'
  if (insight.hasTests) return 'yes'
  return insight.coverage?.capped ? 'unknown' : 'no'
}

export function buildShipReadiness(plan: ActionPlan, s: ActionSignals = {}): ShipReadiness {
  const topBlocker = plan.items[0] ?? null
  const hasSecurityBlocker = plan.items.some((it) => it.kind === 'security' && (it.severity === 'critical' || it.severity === 'high'))
  const hasDepBlocker = depInstallBreakers(s.dependency).length > 0
  const red = hasSecurityBlocker || hasDepBlocker
  // Can't honestly say GREEN if the Security Gate never ran or the index is a partial sample.
  // A scan that stopped early is not a scan: it can be clean about the part it read and blind to the
  // rest, so it can never license a GREEN "safe to ship".
  const notScanned = s.security == null || s.security.coverage?.capped === true
  const partial = (s.insight?.fileCount ?? 0) >= 300 || (s.drift?.partial ?? false)
  const incomplete = notScanned || partial
  if (red) {
    return { band: 'red', verdict: topBlocker ? `Not safe to ship yet — first: ${topBlocker.title.toLowerCase()}.` : 'Not safe to ship yet — a blocker needs fixing.', topBlocker, incomplete }
  }
  if (plan.items.length === 0 && !incomplete) {
    return { band: 'green', verdict: 'Looks safe to ship — nothing urgent to fix.', topBlocker: null, incomplete: false }
  }
  if (incomplete && plan.items.length === 0) {
    return { band: 'amber', verdict: 'Almost — run the pre-ship checks (Security Gate + dependencies) to be sure.', topBlocker, incomplete }
  }
  return { band: 'amber', verdict: topBlocker ? `A few tidy-ups first — top of the list: ${topBlocker.title.toLowerCase()}.` : 'A few tidy-ups before you ship.', topBlocker, incomplete }
}

export function buildActionPlan(s: ActionSignals): ActionPlan {
  const items: ActionItem[] = []

  // 1. Security Gate — the ship-blocker. One item, severity = the worst finding.
  const findings = s.security?.findings ?? []
  if (findings.length) {
    const worst = findings.reduce<ActionSeverity>((a, f) => (RANK[f.severity] > RANK[a] ? f.severity : a), 'medium')
    const crit = findings.filter((f) => f.severity === 'critical').length
    items.push({
      severity: worst,
      kind: 'security',
      title: `Fix ${plural(findings.length, 'security issue')} before shipping`,
      detail: crit ? `${crit} critical (a hardcoded secret/key). Open the Security Gate.` : 'Open the Security Gate to review.'
    })
  }

  // 1b. Dependencies — missing/loose packages that can break a clean install. ONE item; an
  // install-breaker (phantom / wildcard) ranks high (just below a security leak). A null report
  // (audit not yet run) adds NOTHING — never a false "0 problems".
  const dep = s.dependency
  if (dep && dep.findings.length) {
    const breakers = depInstallBreakers(dep)
    const noLock = dep.findings.some((f) => f.kind === 'no-lockfile')
    if (breakers.length)
      items.push({ severity: 'high', kind: 'deps', title: 'Fix missing or loose packages', detail: `${plural(breakers.length, 'package')} could stop a clean install (missing, or unpinned to any version).` })
    else if (noLock) items.push({ severity: 'medium', kind: 'deps', title: 'Add a lockfile', detail: 'No lockfile — the installed versions can drift over time.' })
    else items.push({ severity: 'low', kind: 'deps', title: 'Tidy the dependencies', detail: `${plural(dep.findings.length, 'dependency note')} (unused, heavyweight, or duplicate).` })
  }

  // 2. Missing tests — the synthetic "(project)" untested row OR no tests at all → ONE item.
  // 'unknown' (we only read a sample and saw none) is a QUESTION, not a high-severity accusation.
  const untested = (s.insight?.debt ?? []).filter((d) => d.kind === 'untested')
  const claim = testsClaim(s.insight)
  if (s.insight && claim === 'unknown') {
    items.push({
      severity: 'medium',
      kind: 'tests',
      title: 'Check whether this project has tests',
      detail: `I only read ${s.insight.coverage?.read ?? 0} files and didn't see any tests — I can't be sure there are none.`
    })
  } else if (s.insight && (claim === 'no' || untested.length > 0)) {
    items.push({
      severity: 'high',
      kind: 'tests',
      title: 'Add tests',
      detail: claim === 'no' ? 'This project has no tests yet.' : `${plural(untested.length, 'file')} without a test.`
    })
  }

  // 3. Architecture drift — only when a baseline exists AND something was REMOVED (a real regression risk).
  const d = s.drift
  if (d?.hasBaseline) {
    const removed = d.modules.removed.length + d.edges.removed.length + d.externalDeps.removed.length
    if (removed > 0)
      items.push({
        severity: 'medium',
        kind: 'drift',
        title: 'Review architecture drift',
        detail: `${plural(removed, 'thing')} removed since your baseline${d.partial ? ' (may be partial)' : ''}.`
      })
  }

  // 4. Code debt — oversized/dead/todo (untested already folded into the tests item).
  const debt = (s.insight?.debt ?? []).filter((x) => x.kind !== 'untested')
  const oversized = debt.filter((x) => x.kind === 'oversized').length
  const dead = debt.filter((x) => x.kind === 'dead').length
  const todos = debt.filter((x) => x.kind === 'todo').length
  if (oversized || dead)
    items.push({
      severity: 'medium',
      kind: 'debt',
      title: 'Clean up code debt',
      detail: [oversized ? `${plural(oversized, 'oversized file')}` : '', dead ? `${plural(dead, 'unused file')}` : ''].filter(Boolean).join(', ') + '.'
    })
  if (todos) items.push({ severity: 'low', kind: 'debt', title: 'Resolve TODOs', detail: `${plural(todos, 'TODO')} left in the code.` })

  // 5. Design system — hardcoded colors / near-duplicates → a low-priority tidy-up.
  const dz = s.design
  if (dz && (dz.hardcodedColors > 0 || dz.nearDuplicates.length > 0)) {
    // Each clause is conditional so a fully-tokenized project with near-dup TOKENS never reads
    // the nonsensical "0 hardcoded colors".
    const parts = [
      dz.hardcodedColors > 0 ? plural(dz.hardcodedColors, 'hardcoded color') : '',
      dz.nearDuplicates.length > 0 ? plural(dz.nearDuplicates.length, 'near-duplicate') : ''
    ].filter(Boolean)
    items.push({ severity: 'low', kind: 'design', title: 'Tidy the design system', detail: parts.join(', ') + '.' })
  }

  // Stable severity sort (equal ranks keep the order above), then cap.
  const ranked = items.map((it, i) => ({ it, i })).sort((a, b) => RANK[b.it.severity] - RANK[a.it.severity] || a.i - b.i)
  const capped = ranked.slice(0, 12).map((x) => x.it)
  const summary = capped.length
    ? `${plural(capped.length, 'thing')} to do${capped.some((x) => x.severity === 'critical') ? ' — including something critical' : ''}.`
    : 'All clear — nothing urgent to fix right now.'
  return { summary, items: capped }
}
