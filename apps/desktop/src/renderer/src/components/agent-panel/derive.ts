import type { AgentMode, BlastRadius, DevServerState, GitInfo, StagedEdit, StagedSecretGuard, VerifyResult } from '../../../../shared/types'
import { isBlindEdit } from '../../../../shared/actionplan'
import type { ActivityItem, AppliedFile, Artifact, AttentionItem, ContextData, DiffFile, MissionData, MissionPhase, Msg, StatusRow, TimelineStep } from './types'

/**
 * Pure view-model derivations for the redesigned Agent Panel. Every function
 * maps REAL agent data (events, staged edits, verify results, dev-server state)
 * onto the props the presentational components expect — nothing is invented
 * here: no fake ETAs, no fake health signals, no fake artifacts.
 */

/** Assistant prose longer than this becomes an artifact card instead of a chat wall. */
const ARTIFACT_MIN_CHARS = 400

/**
 * Cut a string to `max` USER-VISIBLE characters. A plain `.slice()` counts UTF-16 code
 * units, so cutting mid-emoji splits its surrogate pair and renders a lone � — real for
 * any agent summary or user request containing an emoji. Intl.Segmenter also keeps ZWJ
 * sequences and skin-tone modifiers whole, which a bare spread would still break.
 */
function cutGraphemes(s: string, max: number): string {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const out: string[] = []
  for (const { segment } of seg.segment(s)) {
    if (out.length >= max) break
    out.push(segment)
  }
  return out.join('')
}

/** True length in user-visible characters (an emoji counts as 1, not 2). */
function graphemeLength(s: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length
}

/** Trim text to a one-line card title (first line, markdown heading marks stripped). */
export function truncateTitle(text: string, max = 60): string {
  const first = text.split('\n')[0].trim().replace(/^#+\s*/, '')
  if (!first) return 'Untitled'
  if (graphemeLength(first) <= max) return first
  return cutGraphemes(first, max - 1).trimEnd() + '…'
}

/** The container's thread entry — a superset of what each section consumes. */
export type ConversationSource =
  | { id: number; kind: 'user' | 'ai' | 'done' | 'err'; text: string }
  | { id: number; kind: 'tool'; tool: string; detail: string; ok: boolean }
  | { id: number; kind: 'warn'; command: string }

/** The chat stream keeps only prose: requests, explanations, summaries, errors, warnings. */
export function deriveConversation(items: ConversationSource[]): Msg[] {
  const out: Msg[] = []
  for (const it of items) {
    switch (it.kind) {
      case 'user': out.push({ id: it.id, role: 'user', text: it.text }); break
      case 'ai': out.push({ id: it.id, role: 'assistant', text: it.text }); break
      case 'done': out.push({ id: it.id, role: 'done', text: it.text }); break
      case 'err': out.push({ id: it.id, role: 'error', text: it.text }); break
      case 'warn': out.push({ id: it.id, role: 'blocked', command: it.command }); break
      default: break // tool noise belongs to the timeline, not the chat
    }
  }
  return out
}

/** A raw tool event, as recorded by the container. */
export interface ToolEventItem {
  id: number
  tool: string
  detail: string
  ok: boolean
  ts: number
}

/**
 * Tool events → timeline steps. Consecutive calls to the same tool (with the
 * same outcome) collapse into one row with a count, so a burst of reads
 * reads as "Read 4 files" rather than four near-identical lines. The most
 * recent row is "active" while a run is busy.
 */
export function buildTimeline(items: ToolEventItem[], running: boolean): TimelineStep[] {
  const groups: { first: ToolEventItem; last: ToolEventItem; details: string[] }[] = []
  for (const it of items) {
    const g = groups[groups.length - 1]
    if (g && g.last.tool === it.tool && g.last.ok === it.ok) {
      g.last = it
      g.details.push(it.detail)
    } else {
      groups.push({ first: it, last: it, details: [it.detail] })
    }
  }
  return groups.map((g, i) => ({
    id: g.first.id,
    tool: g.last.tool,
    detail: g.details.length > 1 ? g.details.join(', ') : g.last.detail,
    ok: g.last.ok,
    active: running && i === groups.length - 1,
    ts: g.last.ts,
    count: g.details.length
  }))
}

/**
 * Section 1 view-model. Progress is an honest proxy — applied / (applied +
 * staged) — shown only once edits exist; before that it is null (indeterminate).
 * ETA is always null: no event carries a time estimate.
 */
export function deriveMission(input: {
  objective: string
  currentTask: string | null
  currentFile: string | null
  stagedCount: number
  appliedCount: number
}): MissionData {
  const total = input.stagedCount + input.appliedCount
  return {
    objective: input.objective,
    currentTask: input.currentTask,
    currentFile: input.currentFile,
    progress: total > 0 ? input.appliedCount / total : null,
    etaSeconds: null
  }
}

/**
 * Hero phase — the mission's lifecycle state, read off real run facts only:
 * a run with no edits yet is Working (Planning in plan mode), the first
 * staged/applied edit makes it Building, the first verify result makes it
 * Verifying, and a finished run with edits is Done. No run + no edits = Idle.
 */
export function derivePhase(input: {
  running: boolean
  mode: AgentMode
  stagedCount: number
  appliedCount: number
  hasVerify: boolean
}): MissionPhase {
  const edits = input.stagedCount + input.appliedCount
  if (!input.running) return edits === 0 ? 'Idle' : 'Done'
  if (edits === 0) return input.mode === 'plan' ? 'Planning' : 'Working'
  return input.hasVerify ? 'Verifying' : 'Building'
}

/**
 * Attention strip view-model — the "needs my eyes now" list, in priority
 * order: staged approvals, a held-back secret, a blocked command, a failed
 * post-apply check. Empty when nothing needs the user (the strip then renders
 * nothing at all). A secret counts when its guard reports count > 0 — the
 * guard carries only count/severity/message, never the value.
 */
export function deriveAttention(input: {
  stagedCount: number
  secrets: Record<string, StagedSecretGuard>
  hasBlockedCommand: boolean
  latestVerify: VerifyResult | null
}): AttentionItem[] {
  const items: AttentionItem[] = []
  if (input.stagedCount > 0) {
    items.push({
      kind: 'review',
      icon: 'alert',
      text: `${input.stagedCount} change${input.stagedCount === 1 ? '' : 's'} awaiting review`
    })
  }
  if (Object.values(input.secrets).some((s) => s.count > 0)) {
    items.push({ kind: 'secret', icon: 'lock', text: 'Secret held back' })
  }
  if (input.hasBlockedCommand) {
    items.push({ kind: 'blocked', icon: 'ban', text: 'Command blocked' })
  }
  if (input.latestVerify && !input.latestVerify.ok) {
    // ✕ (U+2715), the app's single failure glyph — this used to be ✗ (U+2717), so the
    // attention strip and the Workspace Health row directly below it showed two different
    // X marks for the very same failed verify.
    items.push({ kind: 'failed', icon: 'close', text: 'Check failed' })
  }
  return items
}

/** Unique touched files (staged first, then applied); "current" is the last one touched. */
export function deriveActiveFiles(
  staged: StagedEdit[],
  applied: { edit: StagedEdit }[]
): { files: string[]; current?: string } {
  const files: string[] = []
  const seen = new Set<string>()
  for (const e of staged) {
    if (!seen.has(e.path)) { seen.add(e.path); files.push(e.path) }
  }
  for (const a of applied) {
    if (!seen.has(a.edit.path)) { seen.add(a.edit.path); files.push(a.edit.path) }
  }
  const current =
    applied.length > 0
      ? applied[applied.length - 1].edit.path
      : staged.length > 0
        ? staged[staged.length - 1].path
        : undefined
  return { files, current }
}

/**
 * Section 4 view-model: long assistant messages (>400 chars) become artifact
 * cards, plus one "Files changed" card summarising this session's applied edits.
 */
export function deriveArtifacts(msgs: Msg[], applied: { edit: StagedEdit; verify?: VerifyResult }[]): Artifact[] {
  const out: Artifact[] = []
  for (const m of msgs) {
    if (m.role === 'assistant' && m.text.length > ARTIFACT_MIN_CHARS) {
      out.push({
        id: `msg-${m.id}`,
        title: truncateTitle(m.text),
        summary: cutGraphemes(m.text, 160).trim() + (graphemeLength(m.text) > 160 ? '…' : ''),
        body: m.text,
        icon: 'file-text'
      })
    }
  }
  if (applied.length > 0) {
    const lines = applied.map((a) => {
      const badge = a.verify
        ? a.verify.ok
          ? 'verified'
          : `check failed: ${a.verify.error ?? 'syntax check failed'}`
        : 'unchecked'
      return `${a.edit.path}  (+${a.edit.added} −${a.edit.removed}) — ${badge}`
    })
    out.push({
      id: 'files-changed',
      title: 'Files changed',
      summary: `${applied.length} file${applied.length === 1 ? '' : 's'} applied this session`,
      body: lines.join('\n'),
      icon: 'archive'
    })
  }
  return out
}

/**
 * Section 3 view-model — "what has it achieved", read off the same applied-edit
 * and verify facts as the Diff/Artifacts sections. Every edit lands as one row
 * ("+ Added" for a new file, "✓ Updated" otherwise); a verify result that
 * followed it lands as a second row. Nothing here is invented — no commit
 * messages, no synthesized summaries.
 */
export function deriveActivity(applied: { edit: StagedEdit; verify?: VerifyResult }[]): ActivityItem[] {
  const out: ActivityItem[] = []
  applied.forEach((a, i) => {
    out.push({
      id: `applied-${a.edit.id}-${i}`,
      // ✎ (the same write/edit glyph the timeline uses), NOT ✓ — an "Updated x.ts" row and a
      // "Verify passed" row render back to back in this feed, and both leading with ✓ made
      // "something changed" and "something was checked" indistinguishable at a glance.
      icon: a.edit.isNew ? 'plus' : 'pencil',
      text: `${a.edit.isNew ? 'Added' : 'Updated'} ${a.edit.path}`,
      ok: true
    })
    if (a.verify) {
      out.push({
        id: `verify-${a.edit.id}-${i}`,
        icon: a.verify.ok ? 'check' : 'close',
        text: a.verify.ok ? 'Verify passed' : `Verify failed — ${a.verify.error ?? 'check failed'}`,
        ok: a.verify.ok
      })
    }
  })
  return out
}

/**
 * Section 3 view-model — where the agent currently lives: the workspace name,
 * the current file's folder, the file itself, and how many files depend on it.
 * Dependents comes straight off the real blast-radius graph as a COUNT only —
 * never invented file names (the graph gives no honest "which files" signal
 * beyond what blastRadius() already surfaces elsewhere).
 */
export function deriveContext(input: {
  projectPath: string
  currentFile: string | null
  blast: Record<string, BlastRadius>
}): ContextData {
  const workspace = input.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? input.projectPath
  let folder: string | null = null
  if (input.currentFile) {
    const parts = input.currentFile.split('/')
    folder = parts.length > 1 ? parts.slice(0, -1).join('/') : null
  }
  const dependents = input.currentFile ? (input.blast[input.currentFile]?.dependents ?? null) : null
  return { workspace, folder, currentFile: input.currentFile, dependents }
}

/** Confidence chip color: a careful edit is calm green, a risky one is loud red. */
function confClass(confidence: number): DiffFile['confidenceClass'] {
  return confidence >= 70 ? 'conf-high' : confidence >= 40 ? 'conf-mid' : 'conf-low'
}

/** The plain-English "why this score" beside the confidence number — short and honest. */
function confBasis(e: StagedEdit): string {
  if (e.isNew) return 'new file'
  const parts: string[] = []
  if (e.readBeforeWrite) parts.push('read first')
  if (e.sizeRatio <= 0.25) parts.push('surgical change')
  else if (e.sizeRatio > 1) parts.push('sweeping change')
  return parts.join(' · ') || 'existing file'
}

/** Staged edits → Diff Preview rows, with confidence + blind-edit signals folded in. */
export function deriveDiffFiles(staged: StagedEdit[]): DiffFile[] {
  return staged.map((e) => ({
    id: e.id,
    path: e.path,
    isNew: e.isNew,
    added: e.added,
    removed: e.removed,
    diff: e.diff,
    confidence: e.confidence,
    confidenceClass: confClass(e.confidence),
    confidenceBasis: confBasis(e),
    blind: isBlindEdit(e)
  }))
}

/** Applied edits → the read-only "Recently applied" rows with verify badges. */
export function deriveAppliedFiles(applied: { edit: StagedEdit; verify?: VerifyResult }[]): AppliedFile[] {
  return applied.map((a, i) => ({
    key: `${a.edit.id}-${i}`,
    path: a.edit.path,
    added: a.edit.added,
    removed: a.edit.removed,
    confidence: a.edit.confidence,
    blind: isBlindEdit(a.edit),
    verify: a.verify ? (a.verify.ok ? 'verified' : 'failed') : 'unchecked'
  }))
}

/**
 * Section 7 view-model — Workspace Health. Only real signals: the latest
 * post-apply verify, the agent's own busy flag, the run queue, the dev-server
 * state, the repo's live git branch/changes, and a rollup of anything that
 * needs attention (a blocked command or a failed check). Nothing faked.
 */
export function deriveHealth(input: {
  running: boolean
  queued: number
  verify: VerifyResult | null
  devServer: DevServerState | null
  git: GitInfo | null
  hasBlockedCommand: boolean
}): StatusRow[] {
  const rows: StatusRow[] = []
  const v = input.verify
  rows.push({
    label: 'Verify',
    state: !v ? 'idle' : v.ok ? 'ok' : 'error',
    value: !v ? 'No checks yet' : v.ok ? 'Passed' : 'Failed'
  })
  rows.push({
    label: 'Agent',
    state: input.running ? 'running' : 'idle',
    value: input.running ? 'Running' : 'Idle'
  })
  if (input.queued > 0) {
    rows.push({ label: 'Queue', state: 'running', value: `${input.queued} waiting` })
  }
  const ds = input.devServer
  rows.push({
    label: 'Preview',
    state:
      !ds || ds.status === 'idle' || ds.status === 'stopped'
        ? 'idle'
        : ds.status === 'running'
          ? 'ok'
          : ds.status === 'error'
            ? 'error'
            : 'running',
    value: !ds
      ? 'Unknown'
      : ds.status === 'running'
        ? 'Running'
        : ds.status === 'starting'
          ? 'Starting'
          : ds.status === 'error'
            ? 'Error'
            : 'Stopped'
  })
  const g = input.git
  if (g && g.isRepo) {
    rows.push({
      label: 'Git',
      state: g.changes.length > 0 ? 'warning' : 'ok',
      value: g.changes.length > 0 ? `${g.branch} · ${g.changes.length} changed` : g.branch
    })
  }
  const warnings = (input.hasBlockedCommand ? 1 : 0) + (v && !v.ok ? 1 : 0)
  if (warnings > 0) {
    rows.push({
      label: 'Warnings',
      state: 'warning',
      value: `${warnings} to review`
    })
  }
  return rows
}
