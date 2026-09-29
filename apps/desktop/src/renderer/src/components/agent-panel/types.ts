import type { DiffLine } from '../../../../shared/types'
import type { IconName } from '../Icon'

/**
 * Shared view-models for the redesigned Agent Panel. These are derived in the
 * container (AgentPanel) via derive.ts and passed down as plain props so every
 * child stays presentational, independent, and reusable.
 */

/**
 * One prose entry in the chat conversation (tool noise lives in the timeline,
 * never here). Roles map 1:1 onto the legacy msg-* DOM hooks the UI tests use.
 */
export type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; text: string }
  | { id: number; role: 'done'; text: string }
  | { id: number; role: 'error'; text: string }
  | { id: number; role: 'blocked'; command: string }

/** One step in the live execution timeline. */
export interface TimelineStep {
  id: number
  tool: string
  detail: string
  ok: boolean
  /** True while this is the most-recent (in-flight) step. */
  active: boolean
  /** Wall-clock ms when this step (or, if grouped, its last occurrence) landed. */
  ts: number
  /** >1 when this step represents that many consecutive same-tool calls, collapsed into one row. */
  count?: number
}

/** Section 1 view-model — everything here is derived from real agent data. */
export interface MissionData {
  objective: string
  currentTask: string | null
  currentFile: string | null
  /** 0..1 overall progress, or null when indeterminate. */
  progress: number | null
  /** Always null today — the agent events carry no honest ETA signal. */
  etaSeconds: number | null
}

/**
 * The mission's honest lifecycle phase, derived from run/edit/verify facts —
 * never invented. `Planning` is the plan-mode label for a running run that
 * would otherwise read `Working`.
 */
export type MissionPhase = 'Idle' | 'Planning' | 'Working' | 'Building' | 'Verifying' | 'Done'

/** One line in the attention strip — something that needs the user's eyes now. */
export interface AttentionItem {
  kind: 'review' | 'secret' | 'blocked' | 'failed'
  icon: IconName
  text: string
}

/** A health row in the pinned Workspace Health section. */
export interface StatusRow {
  label: string
  state: 'ok' | 'running' | 'idle' | 'error' | 'warning'
  /** Short value shown next to the state icon (e.g. "Running", "Ready"). */
  value: string
}

/** A reusable artifact card (replaces giant AI messages). */
export interface Artifact {
  id: string
  title: string
  /** Short subtitle / preview line. */
  summary: string
  /** The full body, revealed in the side sheet. */
  body: string
  icon: IconName
  /** PNG data URL — the proof-of-work screenshot on a run receipt. */
  image?: string
}

/** One staged file in the Diff Preview, with its confidence signals folded in. */
export interface DiffFile {
  id: string
  path: string
  isNew: boolean
  added: number
  removed: number
  diff: DiffLine[]
  confidence: number
  /** Maps onto the existing conf-high/mid/low chip styles. */
  confidenceClass: 'conf-high' | 'conf-mid' | 'conf-low'
  /** The plain-English "why this score" (e.g. "read first · surgical change"). */
  confidenceBasis: string
  /** True when the agent overwrote an existing file without reading it first. */
  blind: boolean
}

/** A recently-applied edit with its post-apply verify badge and guardrail signals. */
export interface AppliedFile {
  key: string
  path: string
  added: number
  removed: number
  /** The UNCHANGED pre-apply confidence — shown beside the verify label. */
  confidence: number
  /** True when the agent overwrote an existing file without reading it first. */
  blind: boolean
  verify: 'verified' | 'failed' | 'unchecked'
}

/** One row in the Activity Feed — an achievement ("what has it achieved"), not a raw tool echo. */
export interface ActivityItem {
  id: string
  icon: IconName
  text: string
  ok: boolean
}

/** Section 3 view-model — where the agent currently lives in the project. */
export interface ContextData {
  /** The project's folder name. */
  workspace: string
  /** The current file's containing folder, relative to the project root — null at the root. */
  folder: string | null
  currentFile: string | null
  /** Files that directly import the current file, from the real blast-radius graph — null when unknown. */
  dependents: number | null
}
