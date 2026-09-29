import type {
  ArchitectureMap,
  ContextPack,
  DependencyReport,
  DesignReview,
  DriftReport,
  FileOwnership,
  LedgerEntry,
  MetricSnapshot,
  ProjectBrain,
  ProjectInsight,
  SecurityReport
} from '../../../../shared/types'
import type { Runbook } from '../../../../shared/runbook'
import type { ChangedFile, WorkSafetyInput } from '../../../../shared/worksafety'

/** The four destinations. Twenty sections became four answers; see DESIGN.md. */
export type InsightDest = 'overview' | 'review' | 'codemap' | 'memory'

/**
 * The state of one analysis.
 *
 * `not-run` exists as a first-class value on purpose. The old panel rendered an empty section for
 * "we never looked" and for "we looked and found nothing" identically, so a project that had never
 * been scanned read as a clean bill of health. Anything that renders one of these MUST distinguish
 * `not-run` from `ok`; that is the whole point of the type.
 *
 * `partial` is not a failure — it is a real result over an incomplete read (a capped index, a
 * truncated graph), and it must say so rather than rounding itself up to `ok`.
 */
export type LoadPhase = 'not-run' | 'loading' | 'ok' | 'partial' | 'error'

export interface Loaded<T> {
  phase: LoadPhase
  data: T | null
  /** Why it failed, in words. Only set when `phase === 'error'`. */
  error?: string
  /** Why the result is incomplete. Only set when `phase === 'partial'`. */
  caveat?: string
  /** When this value was committed — drives "last analysed". */
  at?: number
  /**
   * The result was true when it was taken, and the project has changed since. It is still shown —
   * throwing away a real measurement because a file was touched would be worse — but it is
   * labelled, because "passed an hour and forty edits ago" is not "passes".
   */
  stale?: boolean
}

export const EMPTY: Loaded<never> = { phase: 'not-run', data: null }

/** A `Loaded` that has never been asked for. Generic helper so call sites stay typed. */
export function idle<T>(): Loaded<T> {
  return { phase: 'not-run', data: null }
}

/* ── the four slices ─────────────────────────────────────────────────────────────────────── */

/** Overview: the only slice loaded when Insight opens. Five calls, not fourteen. */
export interface OverviewData {
  insight: Loaded<ProjectInsight>
  brain: Loaded<ProjectBrain>
  safety: Loaded<{ input: WorkSafetyInput; changed: ChangedFile[]; total: number }>
  analytics: Loaded<MetricSnapshot[]>
}

/** Review: the five project checks. Each one is independently runnable and independently stateful. */
export interface ReviewData {
  security: Loaded<SecurityReport>
  dependency: Loaded<DependencyReport>
  runbook: Loaded<Runbook>
  design: Loaded<DesignReview>
  debt: Loaded<ProjectInsight>
}

/** Code Map: everything rebuildable by reading code and git history. */
export interface CodeMapData {
  arch: Loaded<ArchitectureMap>
  drift: Loaded<DriftReport>
  owners: Loaded<FileOwnership[]>
  context: Loaded<ContextPack>
}

/** Memory: knowledge that reading the repository could never tell you, plus its history. */
export interface MemoryData {
  ledger: Loaded<LedgerEntry[]>
}

/* ── review checks ───────────────────────────────────────────────────────────────────────── */

export type CheckId = keyof ReviewData

export interface CheckView {
  id: CheckId
  label: string
  /** One line saying what this check actually reads — no check claims more than it looked at. */
  scope: string
  phase: LoadPhase
  /** The state in words, for anyone who cannot use the colour. */
  status: string
  /** How many things need attention. Null when the check has not run. */
  findings: number | null
  caveat?: string
  error?: string
  /** Ran, then the project changed underneath it. Shown, but labelled. */
  stale?: boolean
}

/* ── the unified verdict ─────────────────────────────────────────────────────────────────── */

/** The app's existing band vocabulary (`worksafety.ts`, `actionplan.ts`, and the `band-*` CSS),
 *  plus the one state neither of them could express: we have not looked yet. */
export type VerdictBand = 'green' | 'amber' | 'red' | 'unknown'

/** The one primary action, chosen by the most important unresolved state. */
export type PrimaryActionId = 'backup' | 'blocker' | 'review' | 'fix' | 'none'

export interface Verdict {
  band: VerdictBand
  /** The headline sentence. One verdict, never three competing ones. */
  headline: string
  /** Supporting states beneath the headline — saved / ship / checks, each with its own words. */
  supporting: { label: string; state: string; band: VerdictBand }[]
  /**
   * Plain-English notes about the user's work — `workSafety`'s own lines, carried through.
   *
   * These explain the headline rather than repeat it, and one of them explains the ABSENCE of the
   * primary button: a project nested inside a bigger repository cannot be backed up from here
   * without sweeping the whole parent in, so "Back up now" is withheld. The consolidation to one
   * verdict kept the work-safety sentence and dropped these, which left that case showing a problem
   * ("4 changed files not backed up yet"), no button, and no reason.
   */
  notes: string[]
  action: { id: PrimaryActionId; label: string; why: string } | null
}
