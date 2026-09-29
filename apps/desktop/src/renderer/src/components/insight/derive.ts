import type { ActionPlan, ActionItem } from '../../../../shared/actionplan'
import type { ArchitectureMap, ProjectInsight, SecurityReport } from '../../../../shared/types'
import type { WorkSafety } from '../../../../shared/worksafety'
import type { ShipReadiness } from '../../../../shared/actionplan'
import { testsClaim } from '../../../../shared/actionplan'
import type { CheckId, CheckView, InsightDest, Loaded, ReviewData, Verdict, VerdictBand } from './types'

/**
 * Pure view-model folds for the Insight view. Nothing here calls IPC, touches `window`, or holds
 * state — the same rule `agent-panel/derive.ts` follows, and for the same reason: these are the
 * parts worth testing without an Electron window around them.
 *
 * Nothing is invented. Every number traces to a real analysis result, and a signal we did not
 * measure is reported as unmeasured rather than defaulted to a reassuring value.
 */

/* ── architecture ────────────────────────────────────────────────────────────────────────── */

export interface ArchView {
  entries: ArchitectureMap['nodes']
  modules: (ArchitectureMap['nodes'][number] & { refs: number })[]
  deps: ArchitectureMap['externalDeps']
  fileCount: number
  edgeCount: number
  partial: boolean
}

/** Entry points, the most-depended-on modules (fan-in), and external deps — folded from the graph. */
export function deriveArchView(arch: ArchitectureMap | null): ArchView | null {
  if (!arch) return null
  const fanIn = new Map<string, number>()
  for (const e of arch.edges) fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1)
  const modules = arch.nodes
    .map((n) => ({ ...n, refs: fanIn.get(n.path) ?? 0 }))
    .sort((a, b) => b.refs - a.refs || b.symbols - a.symbols)
    .slice(0, 12)
  return {
    entries: arch.nodes.filter((n) => n.isEntry),
    modules,
    deps: arch.externalDeps,
    fileCount: arch.nodes.length,
    edgeCount: arch.edges.length,
    partial: !!arch.partial
  }
}

/* ── health ──────────────────────────────────────────────────────────────────────────────── */

export interface Health {
  score: number
  files: number
  definitions: number
  debtCount: number
  hasTests: boolean
  testsKnown: ReturnType<typeof testsClaim>
  deps: number
  /** null = never scanned. NOT zero — "no secrets found" and "never looked" are different facts. */
  secrets: number | null
}

/**
 * The supporting scorecard. Unchanged arithmetic, deliberately: the trend stored in
 * `analytics.json` is this exact number, and changing the formula would silently redraw history.
 * What changed is its RANK — it is a tile beside the other measurements now, never the headline,
 * because a single number cannot outrank a concrete blocker.
 */
export function deriveHealth(
  insight: ProjectInsight | null,
  security: SecurityReport | null,
  arch: ArchView | null
): Health | null {
  if (!insight) return null
  const secrets = security ? security.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length : null
  // Penalise REAL debt only — the synthetic "(project)" untested row is already covered by the
  // -15 no-tests penalty, and counting it twice was wrong.
  const realDebt = insight.debt.filter((d) => d.path !== '(project)').length
  let score = 100
  score -= Math.min(45, realDebt * 3)
  // Only penalise a project we actually read to the end — docking 15 points for tests we never
  // looked for made a big project's score both wrong AND unfixable.
  if (testsClaim(insight) === 'no') score -= 15
  if (secrets !== null) score -= Math.min(40, secrets * 20)
  score = Math.max(0, Math.min(100, score))
  return {
    score,
    files: insight.fileCount,
    definitions: insight.totalSymbols,
    debtCount: insight.debt.length,
    hasTests: insight.hasTests,
    testsKnown: testsClaim(insight),
    deps: arch?.deps.length ?? 0,
    secrets
  }
}

/* ── review checks ───────────────────────────────────────────────────────────────────────── */

const CHECK_META: Record<CheckId, { label: string; scope: string }> = {
  security: { label: 'Security', scope: 'Secrets, unsafe patterns and risky configuration in your source files.' },
  dependency: { label: 'Dependencies', scope: 'Your package manifest and lockfile — consistency, not the npm registry.' },
  runbook: { label: 'Run Doctor', scope: 'Whether someone else could start this project from a clean checkout.' },
  design: { label: 'Design consistency', scope: 'Hardcoded colours, near-duplicate palette entries, spacing and font scales.' },
  debt: { label: 'Tests and debt', scope: 'Debt signals from the project index, and whether tests were found at all.' }
}

/** How many findings a completed check reported. Null whenever the check has not produced one. */
function findingCount(id: CheckId, r: ReviewData): number | null {
  switch (id) {
    case 'security': return r.security.data ? r.security.data.findings.length : null
    case 'dependency': return r.dependency.data ? r.dependency.data.findings.length : null
    case 'runbook': return r.runbook.data ? r.runbook.data.steps.filter((s) => s.severity !== 'info').length : null
    case 'design': return r.design.data ? r.design.data.hardcodedColors + r.design.data.nearDuplicates.length : null
    case 'debt': return r.debt.data ? r.debt.data.debt.length : null
  }
}

/** The words for each phase. "Not checked" is never allowed to read like "Passed". */
function statusWords(phase: Loaded<unknown>['phase'], findings: number | null): string {
  if (phase === 'not-run') return 'Not checked'
  if (phase === 'loading') return 'Checking…'
  if (phase === 'error') return 'Failed to run'
  if (findings === null) return phase === 'partial' ? 'Partial result' : 'Passed'
  if (findings === 0) return phase === 'partial' ? 'Nothing found so far' : 'Passed'
  return `${findings} need${findings === 1 ? 's' : ''} attention`
}

export function deriveChecks(r: ReviewData): CheckView[] {
  return (Object.keys(CHECK_META) as CheckId[]).map((id) => {
    const slot = r[id] as Loaded<unknown>
    const findings = findingCount(id, r)
    return {
      id,
      label: CHECK_META[id].label,
      scope: CHECK_META[id].scope,
      phase: slot.phase,
      status: statusWords(slot.phase, findings),
      findings,
      caveat: slot.caveat,
      error: slot.error,
      stale: slot.stale
    }
  })
}

/** True once at least one check has produced a result — gates the compliance export. */
export function hasReviewResults(r: ReviewData): boolean {
  return (Object.keys(CHECK_META) as CheckId[]).some((id) => {
    const p = (r[id] as Loaded<unknown>).phase
    return p === 'ok' || p === 'partial'
  })
}

/* ── the one verdict ─────────────────────────────────────────────────────────────────────── */

const WORST: Record<VerdictBand, number> = { green: 0, unknown: 1, amber: 2, red: 3 }

/**
 * ONE headline, with the others demoted to supporting lines beneath it.
 *
 * The panel this replaces showed Work Safety, Ship Readiness and a /100 Health score as three
 * equally-loud verdicts stacked on top of each other, which forced the user to arbitrate between
 * them — and they answer three different questions, so they routinely disagreed. The questions are
 * ordered here instead, by what is irreversible:
 *
 *   1. unsaved work      — the only state where waiting can LOSE something
 *   2. a critical finding — real, already measured, and blocking
 *   3. never reviewed     — unknown, and unknown is not the same as fine
 *   4. an actionable improvement
 *   5. nothing outstanding — and then NO call to action, because inventing one teaches the user
 *      that the primary button is decoration
 */
export function deriveVerdict(input: {
  ws: WorkSafety | null
  ship: ShipReadiness
  plan: ActionPlan
  checks: CheckView[]
}): Verdict {
  const { ws, ship, plan, checks } = input
  const supporting: Verdict['supporting'] = []
  // Every `return` below spreads this, so a new exit cannot silently drop the explanations again.
  const notes = ws?.lines ?? []

  supporting.push({
    label: 'Your work',
    state: ws ? ws.verdict : 'Not checked yet',
    band: ws ? ws.band : 'unknown'
  })
  supporting.push({ label: 'Ready to ship', state: ship.verdict, band: ship.band })

  const ran = checks.filter((c) => c.phase === 'ok' || c.phase === 'partial').length
  supporting.push({
    label: 'Project review',
    state: ran === 0 ? 'Not run yet' : ran === checks.length ? 'All checks run' : `${ran} of ${checks.length} checks run`,
    band: ran === 0 ? 'unknown' : ran === checks.length ? 'green' : 'amber'
  })

  const band = supporting.reduce<VerdictBand>((w, s) => (WORST[s.band] > WORST[w] ? s.band : w), 'green')

  // 1. Unsaved work wins outright: it is the only row where doing nothing can destroy something.
  if (ws && ws.canBackup && ws.band !== 'green') {
    return {
      band: ws.band,
      headline: ws.verdict,
      supporting,
      notes,
      action: { id: 'backup', label: 'Back up now', why: 'Saves a local snapshot you can come back to. Nothing is uploaded.' }
    }
  }

  /* 2. A measured BLOCKER — and only a blocker.
        "High" is not the bar on its own: the plan rates a missing test suite `high`, and treating
        that as a blocker painted the whole verdict red under the sentence "a few tidy-ups first",
        which is both alarming and self-contradicting. A blocker is something critical, or a
        high-severity SECURITY finding — the two cases where shipping is genuinely unsafe. */
  const blocker = plan.items.find((i) => i.severity === 'critical' || (i.severity === 'high' && i.kind === 'security'))
  if (blocker) {
    return {
      band: 'red',
      headline: ship.band === 'red' ? ship.verdict : `Not safe to ship yet — ${blocker.title.toLowerCase()}.`,
      supporting,
      notes,
      action: { id: 'blocker', label: 'Review blocker', why: blocker.detail }
    }
  }

  // 3. Never reviewed. Unknown is its own answer, and it is not "fine".
  if (ran === 0) {
    return {
      band: 'unknown',
      headline: 'This project has not been reviewed yet.',
      supporting,
      notes,
      action: { id: 'review', label: 'Check before shipping', why: 'Runs the security, dependency, run, design and debt checks.' }
    }
  }

  // 4. Something worth doing, but nothing urgent.
  if (plan.items.length > 0) {
    return {
      band,
      headline: ship.verdict,
      supporting,
      notes,
      action: { id: 'fix', label: 'Fix with AI', why: plan.items[0].title }
    }
  }

  // 5. Nothing outstanding — and therefore no button.
  return { band, headline: ship.verdict, supporting, notes, action: null }
}

/** The top three, and no more: a list of everything is the thing the user could not read. */
export function topActions(plan: ActionPlan, limit = 3): ActionItem[] {
  return plan.items.slice(0, limit)
}

/* ── where an action row can take you ────────────────────────────────────────────────────── */

/**
 * The destination behind the "Go" button on an action row: the EVIDENCE for the item, not a fix.
 *
 * "Go" and "Fix with AI" are two different offers and always were. "Fix with AI" seeds the agent
 * with an instruction; "Go" is for the reader who does not want an agent yet and wants to see what
 * the claim is based on. The four-destination rebuild dropped "Go" and kept "Fix with AI", which
 * left no way to inspect a finding without asking a model to act on it first.
 *
 * Not every item has one, and that is why this returns null rather than a default:
 *   file  — the item is about ONE file (a Fragile-files row), so the file itself is the evidence.
 *   dest  — the item came out of a review check or the drift fold; go to the screen that ran it.
 *   null  — "Add tests" is a statement about an ABSENCE. There is nothing to open, so no button
 *           is rendered; a Go that lands nowhere is worse than no Go.
 *
 * `drift` points at Code Map rather than Review because that is where the drift fold is displayed —
 * this maps to where the reader can SEE the finding, which is not always where it was computed.
 */
export function goTarget(item: ActionItem): { file: string } | { dest: InsightDest } | null {
  if (item.file) return { file: item.file }
  if (item.kind === 'drift') return { dest: 'codemap' }
  if (item.kind === 'security' || item.kind === 'design' || item.kind === 'debt' || item.kind === 'deps') return { dest: 'review' }
  return null
}
