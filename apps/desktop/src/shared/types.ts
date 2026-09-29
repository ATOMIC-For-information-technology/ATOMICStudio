// Types shared between the Electron main process, preload bridge, and renderer.

import type { StudioMode } from './mode'
import type { Identity, Role } from './roles'
import type { Theme, ThemeInstallResult } from './theme'
import type { MediaKind, MediaModelDef, MediaReceipt, MediaUsage } from './media'

export type { MediaKind, MediaModelDef, MediaReceipt, MediaUsage }

/**
 * A media provider as the renderer sees it: the registry entry plus whether this machine already
 * holds a key for it. `hasKey` is computed in main — the key itself never crosses the bridge.
 */
export interface MediaProviderInfo {
  id: string
  label: string
  sharesChatKey: boolean
  keyUrl: string
  planNote: string
  hasKey: boolean
  models: MediaModelDef[]
}

export interface MediaGenerateRequest {
  projectPath: string
  kind: MediaKind
  providerId: string
  model: string
  prompt: string
  size?: string
  seconds?: number
  /** Project-relative image to edit or animate. Read in main, never sent as bytes from the renderer. */
  sourceFile?: string
}

export type DevServerStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error'

export interface ProjectInfo {
  /** Absolute path to the opened project folder. */
  path: string
  /** Folder name, shown as the project title. */
  name: string
  /** Detected framework, best-effort. */
  framework: DetectedFramework
  /** The npm script we will run to start the dev server (e.g. "dev"). */
  devScript: string | null
}

export type DetectedFramework =
  | 'vite'
  | 'next'
  | 'expo'
  | 'react'
  | 'vue'
  | 'svelte'
  | 'static-html'
  | 'unknown'

export interface DevServerState {
  status: DevServerStatus
  /** The detected local URL once the dev server is up (e.g. http://localhost:5173). */
  url: string | null
  /** Last error message, if status === 'error'. */
  error: string | null
}

/** A single line of dev-server console output streamed to the renderer. */
export interface LogLine {
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  ts: number
}

/** A source element the user clicked in the live preview. */
export interface CanvasSelection {
  file: string
  line: number
  name: string
}

/** An error captured from inside the running preview (runtime or build). */
export interface CanvasError {
  message: string
  stack?: string
}

/** Request to run a multi-model "goal" workflow that edits a file. */
export interface GoalEditRequest {
  projectPath: string
  file: string
  instruction: string
  elementName?: string
}

/** A step that ran as part of a goal, surfaced to the UI. */
export interface GoalStepInfo {
  id: string
  provider: string
  model?: string
  ok: boolean
}

export interface GoalEditResult {
  ok: boolean
  file?: string
  error?: string
  canUndo: boolean
  steps: GoalStepInfo[]
}

/** Request to auto-fix an error in a specific file. */
export interface AutoFixRequest {
  projectPath: string
  file: string
  errorText: string
  provider?: string
  model?: string
}

/** A selectable AI provider, surfaced to the settings UI. */
export interface ProviderInfo {
  id: string
  label: string
  needsKey: boolean
  defaultModel: string
}

/** A recommended on-device model in the Air-Gapped model catalog. */
export interface CatalogModel {
  name: string
  size: string
  useCase: string
}
export interface ModelCatalogEntry extends CatalogModel {
  installed: boolean
  pullCommand: string
  /** False when this machine's RAM is below what the model wants resident. Advisory only. */
  fitsMemory: boolean
  /** Working set in GB this model wants (0 for models we have no figure for). */
  needsGb: number
}

/**
 * Three distinct situations that used to collapse into one "not available":
 *  - `not-installed` — no `ollama` binary; the answer is an install command.
 *  - `stopped` — binary present, daemon down; the answer is a Start button.
 *  - `ready` — usable now.
 */
export type OllamaState = 'not-installed' | 'stopped' | 'ready'

export interface ModelCatalog {
  /** True only in the `ready` state — kept so existing callers behave exactly as before. */
  available: boolean
  state: OllamaState
  /** How to get Ollama on this platform. Shown as a copyable command; never run for the user. */
  install: { command: string; url: string }
  totalMemoryGb: number
  models: ModelCatalogEntry[]
  /** Models the user pulled themselves that aren't in the curated list. */
  others: ModelCatalogEntry[]
}

/** What the agent can do to the running preview. */
export type PreviewControlAction = 'click' | 'type' | 'snap'

export interface PreviewControlResult {
  ok: boolean
  /** Plain-English outcome for the agent's observation, e.g. 'Clicked "Sign up".' */
  text?: string
  /** snap only: a PNG data URL of what the preview looked like. */
  dataUrl?: string
  /** snap only: the guest frame to capture — main does the capture, the renderer picks the frame. */
  webContentsId?: number
  error?: string
}

// ---- AI Build Receipt ----

/** One file the run touched, with what it cost in bytes and whether the check passed. */
export interface ReceiptFile {
  path: string
  added: number
  removed: number
  /** Size change on disk. The one size number this app can prove without running a build. */
  bytesDelta: number
  /** undefined when nothing checkable ran for this file (not every file has a syntax check). */
  verified?: boolean
  error?: string
}

/**
 * What a run actually did, in evidence rather than prose.
 *
 * Every field is measured. Deliberately absent: performance and bundle deltas — measuring either
 * honestly means running the project's build and a benchmark, which this does not do. A zero we
 * cannot back up would be worse than an omission, so they are named in ROADMAP.md as needing a
 * build-metrics probe rather than shown as "0".
 */
export interface BuildReceipt {
  runId: number
  instruction: string
  summary: string
  startedAt: number
  endedAt: number
  durationMs: number
  files: ReceiptFile[]
  /** Sum of the per-file size changes, in bytes. */
  bytesDelta: number
  checks: { ran: number; passed: number }
  /** Restore point taken before the run — the receipt's own undo. */
  rollbackId: string | null
  /** Tokens this run spent (the difference across the run, not the session total). */
  tokens: { requests: number; estTokens: number; model: string | null }
  /** 0–1, the same signal the confidence meter shows: how much of what it changed it had read. */
  confidence: number | null
  /** The preview after the agent used the app, when it did. */
  snapshot?: string
}

// ---- Project Memory ----

/**
 * What a memory entry is ABOUT. The kinds are fixed because retrieval weights them: `forbidden` and
 * `business-rule` are always injected, the rest compete for the remaining budget.
 */
export type MemoryKind =
  | 'goal'
  | 'decision'
  | 'convention'
  | 'design-rule'
  | 'business-rule'
  | 'bug'
  | 'debt'
  | 'file'
  | 'ai-decision'
  | 'preference'
  | 'forbidden'
  | 'pending'
  | 'idea'

export interface MemoryEntry {
  id: string
  ts: number
  kind: MemoryKind
  text: string
  /** Stable identity for a fact that can be restated (e.g. `convention:indent`). A new entry with
   *  the same key supersedes the old one instead of contradicting it. */
  key?: string
  /** Files this fact is about — used to detect that it has gone stale. */
  files?: string[]
  tags?: string[]
  /** Who wrote it. A user entry always outranks an agent entry on the same key. */
  source: 'user' | 'agent'
  /** The agent run that wrote it, so any claim can be traced back to what happened. */
  runId?: number
  pinned?: boolean
  /** Set when a newer entry with the same key replaced this one; kept for history, never retrieved. */
  supersededBy?: string
  /** True when a file this entry names no longer exists. Kept and shown, but not injected. */
  stale?: boolean
  /** Tombstone: the user removed it. Append-only store, so removal is a marker, not a deletion. */
  forgotten?: boolean
  lastUsedAt?: number
}

/** What retrieval returned, and whether the budget forced anything out. */
export interface MemoryRetrieval {
  entries: MemoryEntry[]
  /** How many relevant entries did not fit — surfaced rather than silently dropped. */
  omitted: number
}

export interface MemoryStats {
  total: number
  byKind: Partial<Record<MemoryKind, number>>
  stale: number
  /** Whether ATOMIC-MEMORY.md is kept in sync inside the project folder. */
  syncToProject: boolean
}

// ---- Connectors (MCP) + installable extensions ----

/** One tool an MCP connector exposes. `approved` gates the agent from calling it. */
export interface ConnectorTool {
  name: string
  description: string
  approved: boolean
}

export interface ConnectorInfo {
  id: string
  name: string
  /** The exact command line this connector runs, shown so the user can see what they enabled. */
  command: string
  enabled: boolean
  running: boolean
  /** True when the connector is on but Air-Gapped Mode is overriding it. */
  blockedByAirGap: boolean
  source: 'folder' | 'github' | 'registry' | 'manual'
  tools: ConnectorTool[]
  approvedTools: string[]
}

export interface McpCallResult {
  ok: boolean
  text?: string
  error?: string
}

/** `atomic-extension.json` — what an installable extension declares about itself. */
export interface ExtensionManifest {
  id: string
  name: string
  version: string
  description: string
  kind: 'mcp' | 'addon'
  /** mcp only: the server process to spawn. */
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export interface InstallResult {
  ok: boolean
  manifest?: ExtensionManifest
  error?: string
}

/** One row in the curated registry. */
export interface RegistryEntry {
  id: string
  name: string
  description: string
  repo: string
  publisher: string
  installed: boolean
}

/** One entry (file or folder) in the project file tree. Path is relative to root. */
export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  /** A symbolic link. The Explorer marks these and never follows one while walking. */
  isSymlink?: boolean
}

/** Result of reading a file for the editor. */
export interface ReadFileResult {
  ok: boolean
  content?: string
  error?: string
  binary?: boolean
  tooLarge?: boolean
}

/** A generic filesystem mutation result. */
export interface FsResult {
  ok: boolean
  error?: string
}

/** An installed iOS simulator device. */
export interface SimulatorDevice {
  udid: string
  name: string
  state: string
  runtime: string
}

export interface SimulatorResult {
  ok: boolean
  error?: string
}

export interface SimulatorScreenshotResult {
  ok: boolean
  dataUrl?: string
  error?: string
}

/** Outcome of an undo. */
export interface UndoEditResult {
  ok: boolean
  file?: string
  canUndo: boolean
}

/** Current undo availability + the label of the next undoable change. */
export interface UndoState {
  canUndo: boolean
  label: string | null
}

/** One entry in the change timeline (oldest first; index = stack position). */
export interface UndoHistoryEntry {
  label: string
  file: string
  ts: number
}

export interface UndoToResult {
  ok: boolean
  restored: string[]
  canUndo: boolean
}

/** A plain-English edit request against a clicked element's source file. */
export interface EditRequest {
  projectPath: string
  file: string
  line: number
  elementName?: string
  instruction: string
  provider?: string
  model?: string
}

export interface EditResult {
  ok: boolean
  absolutePath?: string
  newContent?: string
  error?: string
}

/** Tab autocomplete: code around the cursor → text to insert (ghost text). */
export interface AutocompleteRequest {
  file: string
  prefix: string
  suffix: string
  provider?: string
  model?: string
}

export interface AutocompleteResult {
  ok: boolean
  text?: string
}

/** ⌘K inline edit: rewrite only the selected lines; renderer splices the result. */
export interface InlineEditRequest {
  projectPath: string
  file: string
  fileContent: string
  startLine: number
  endLine: number
  selectedText: string
  instruction: string
  provider?: string
  model?: string
}

export interface InlineEditResult {
  ok: boolean
  replacement?: string
  error?: string
}

/** Outcome reported back to the renderer after an edit attempt. */
export interface ApplyEditResult {
  ok: boolean
  file?: string
  error?: string
  canUndo: boolean
}

/** One CSS file's preview for "apply design tokens": how many hardcoded hex literals would
 * become var(--token), and the folded diff of that rewrite. `file` is project-relative. */
export interface TokenApplyPlan {
  file: string
  replacements: number
  diff: DiffLine[]
}

/** Result of writing the chosen files (each snapshotted; grouped under one checkpoint). */
export interface TokenApplyResult {
  ok: boolean
  filesWritten: number
  checkpointId?: string
  error?: string
}

// ---- Phase 10 — built-in AI agent ----

/** plan = read-only (propose, never stage); build = stage edits for review. */
export type AgentMode = 'plan' | 'build'

export interface AgentRunRequest {
  projectPath: string
  instruction: string
  mode: AgentMode
  provider?: string
  model?: string
  /** Start a fresh conversation instead of continuing the session transcript. */
  newChat?: boolean
}

/** Tech-debt signal from the background index (Project Explainer / Insight). */
export interface DebtItem {
  kind: 'oversized' | 'dead' | 'untested' | 'todo'
  path: string
  detail: string
}

export interface Usage {
  requests: number
  estTokens: number
  byModel: Record<string, { requests: number; estTokens: number }>
  lastModel: string | null
  capTokens: number
}

/** One AI edit in the "What Changed & Why" ledger. */
export interface LedgerEntry {
  ts: number
  file: string
  why: string
  model: string
}

/** A recorded project decision — the project's memory of a deliberate choice. */
export interface Decision {
  ts: number
  title: string
  detail: string
  tags?: string[]
}

/** One event in the Development Replay story timeline. */
export type ReplayKind = 'ai-edit' | 'change' | 'checkpoint' | 'agent-run'
export interface ReplayEvent {
  ts: number
  kind: ReplayKind
  title: string
  detail: string
  file?: string
  /** For 'change' events: the undo-stack position, so it can be reverted-to. */
  stackIndex?: number
}

/** One point in the Analytics-over-time trend (per-project metric snapshot). */
export interface MetricSnapshot {
  ts: number
  score: number
  debtCount: number
  secrets: number | null
  fileCount: number
  agentRunsDone: number
}

export interface SecurityFinding {
  severity: 'critical' | 'high' | 'medium'
  file: string
  line: number
  message: string
}

export interface SecurityReport {
  ok: boolean
  verdict: string
  findings: SecurityFinding[]
  filesScanned: number
  /** How much of the project this scan actually read — a clean verdict is only as good as this. */
  coverage: import('./coverage').Coverage
  /** Every problem found, including any past the collection cap (findings[] is the shown subset). */
  findingsTotal: number
}

/** One color in the project's palette (Design Review). */
export interface DesignColor {
  value: string
  count: number
  isToken: boolean
}

/** The project's design-system consistency review. */
export interface DesignReview {
  ok: boolean
  verdict: string
  palette: DesignColor[]
  hardcodedColors: number
  tokensUsed: number
  nearDuplicates: { a: string; b: string; distance: number }[]
  spacingScale: number[]
  fontSizeScale: number[]
  filesScanned: number
}

export interface ProjectInsight {
  fileCount: number
  totalSymbols: number
  languages: Record<string, number>
  topImports: { name: string; count: number }[]
  entryPoints: string[]
  debt: DebtItem[]
  /** A test file was SEEN. False means "not in what we read" — check `coverage` before concluding. */
  hasTests: boolean
  /** How much of the project the index actually holds (it stops at MAX_FILES). */
  coverage: import('./coverage').Coverage
}

/** Post-apply verification of one written file (cheap syntax check). */
export interface VerifyResult {
  path: string
  ok: boolean
  error?: string
}

export type DiffLineKind = 'ctx' | 'add' | 'del' | 'fold'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** A pending file change proposed by the agent — nothing is on disk until Apply. */
export interface StagedEdit {
  id: string
  path: string
  isNew: boolean
  added: number
  removed: number
  diff: DiffLine[]
  // --- Confidence Meter (Wave 3): transparent signals, computed at stage time ---
  /** Did the agent read this file this run before proposing the change? */
  readBeforeWrite: boolean
  /** Lines in the file before the edit (0 for a brand-new file). */
  beforeLines: number
  /** (added+removed)/beforeLines — how sweeping the change is (0 when isNew). */
  sizeRatio: number
  /** 0–100 confidence from the signals above; the dock explains the basis. */
  confidence: number
}

export type AgentEvent =
  | { runId: number; type: 'started'; instruction: string }
  | { runId: number; type: 'queued'; position: number }
  | { runId: number; type: 'assistant'; text: string }
  | { runId: number; type: 'tool'; tool: string; detail: string; ok: boolean }
  | { runId: number; type: 'staged'; edit: StagedEdit }
  // Build mode auto-applies immediately after staging (no click-to-approve) — this event tells the
  // renderer to move the card from "Proposed changes" to "Recently applied" with its verify result.
  | { runId: number; type: 'applied'; edit: StagedEdit; verify?: VerifyResult }
  | { runId: number; type: 'command-blocked'; command: string }
  | {
      runId: number
      type: 'done'
      summary: string
      turns: number
      /** PNG data URL: the preview as the agent left it, when it used the app during the run. */
      snapshot?: string
      /** What the run did, measured — see BuildReceipt. */
      receipt?: BuildReceipt
    }
  | { runId: number; type: 'error'; error: string }

/** One agent run for the Multi-Agent Board: live, queued, or finished. */
export interface AgentTask {
  runId: number
  instruction: string
  projectPath: string
  mode: AgentMode
  status: 'running' | 'queued' | 'done' | 'error' | 'cancelled' | 'stopped'
  turns: number
  stagedCount: number
  summary?: string
  error?: string
  startedAt: number
  endedAt?: number
}

export interface AgentState {
  running: boolean
  /** Instructions waiting behind the active run (background agents). */
  queued: number
  staged: StagedEdit[]
  // --- Multi-Agent Board (Wave 4): optional so existing consumers are unaffected ---
  active?: AgentTask | null
  queuedTasks?: AgentTask[]
  finished?: AgentTask[]
}

export interface ApplyStagedResult {
  ok: boolean
  applied: string[]
  error?: string
  canUndo: boolean
  /** Syntax checks run on the applied files ("did the AI break it?"). */
  verify: VerifyResult[]
}

/** One live terminal command execution. */
export interface TermStartResult {
  ok: boolean
  id?: number
  error?: string
}

export interface TermLineEvent {
  id: number
  line: LogLine
}

// ---- Enterprise: GitHub / git ----

export interface GhUser {
  login: string
  name: string
}

export interface GhRepo {
  fullName: string
  private: boolean
  cloneUrl: string
  description: string
}

export interface GitChange {
  status: string
  /**
   * The RAW two columns of `git status --porcelain`: X = index (staged), Y = working tree.
   * `status` is the trimmed pair, which is fine for display but destroys position — 'M ' and
   * ' M' both trim to 'M', and those are the opposite facts (staged vs not). The staged/unstaged
   * split needs the columns intact, so they are carried separately rather than re-derived.
   */
  x: string
  y: string
  file: string
  /** For a rename/copy: the path it came from. Only `git status --porcelain=v2 -z` can say. */
  orig?: string
  /** An unmerged path — its own state, neither staged nor unstaged. */
  unmerged?: boolean
}

export interface GitInfo {
  /** The project folder is git-IGNORED: it sits inside a repo but git tracks nothing in it, so an
   *  empty change list means "invisible to git", NOT "safely backed up". */
  isIgnored?: boolean
  isRepo: boolean
  /** True only when the opened project IS the repo root (not a subfolder of a bigger repo). */
  isRepoRoot: boolean
  branch: string
  /** Project-scoped since 2026-09-02 (was the whole repo — see gitSnapshot). */
  changes: GitChange[]
}

/**
 * The HOT status of a repository, from ONE `git status --porcelain=v2 --branch -z` process:
 * working tree, index, branch, upstream, divergence and conflicts together. Everything the
 * Source Control view redraws on every keystroke and watcher event comes from here; the cold
 * data (history, branch catalog, remotes) has its own lazily-loaded channels.
 */
export interface GitSnapshot {
  isRepo: boolean
  isRepoRoot: boolean
  /** The project folder itself is git-ignored — an empty list means "invisible", not "saved". */
  isIgnored: boolean
  /** '' while detached or before the first commit's branch exists. */
  branch: string
  detached: boolean
  /** `git init` with no commit: nothing to diff HEAD against, and unstage means `rm --cached`. */
  initial: boolean
  headOid: string
  upstream: string | null
  ahead: number
  behind: number
  merging: boolean
  rebasing: boolean
  /** Rows INSIDE the opened folder, project-relative. */
  changes: GitChange[]
  /** Count of `changes` as git reported it; equals `changes.length` unless `truncated`. */
  total: number
  /** git's output was cut at the capture limit: `total` is a floor, and the list is a prefix. */
  truncated: boolean
  /** Staged rows OUTSIDE the opened folder — a commit from here includes them. */
  outsideStaged: number
  conflicts: string[]
  /** Development instrumentation: how many git processes this snapshot cost and how long it took. */
  perf: { processes: number; ms: number }
}

/**
 * Which two things a file diff compares. The renderer names the row's list; the main process
 * runs the matching git command, so a staged row can never accidentally show working-tree edits.
 *   staged     index ↔ HEAD          (`git diff --cached -- file`)
 *   unstaged   working tree ↔ index  (`git diff -- file`)
 *   untracked  the whole new file    (no git process; read from disk)
 *   conflict   an unmerged file      (hunk count only; the editor resolves it)
 */
export type GitDiffMode = 'staged' | 'unstaged' | 'untracked' | 'conflict'

export interface GitFileDiff {
  mode: GitDiffMode
  lines: DiffLine[]
  added: number
  removed: number
  binary: boolean
  /** Cut at the line cap; what is shown is the head of the patch. */
  truncated: boolean
  /** conflict mode: how many `<<<<<<<` hunks the file holds right now. */
  conflictHunks?: number
  error?: string
}

export interface GitResult {
  ok: boolean
  error?: string
}

/**
 * Forge-neutral aliases. The GhUser/GhRepo names date from when GitHub was the only
 * option; the shapes are already generic, so the self-hosted forge reuses them under
 * honest names rather than duplicating the fields. Kept as aliases (not a rename) so
 * no existing call site has to churn.
 */
export type ForgeUser = GhUser
export type ForgeRepo = GhRepo

/** A forge as the renderer sees it. `kind` drives which options stay visible under policy. */
export interface ForgeInfo {
  id: string
  name: string
  kind: 'cloud' | 'self-hosted'
  signedIn: boolean
}

/** A local branch with its upstream and divergence. ahead/behind are 0 when there is no upstream. */
export interface GitBranch {
  name: string
  current: boolean
  remote?: string
  ahead: number
  behind: number
}

export interface GitRemote {
  name: string
  fetchUrl: string
  pushUrl: string
}

/** A git server the user owns, reachable over SSH. */
export interface GitServer {
  host: string
  sshUser: string
  /** Absolute directory on the server that holds bare repositories. */
  root: string
  port?: number
  /**
   * ALWAYS absolute, never `~`. `sshBase()` in main/remote.ts passes this as
   * `-i "<path>"`, and the shell cannot expand a tilde inside those quotes — a
   * `~/...` value here authenticates against nothing and reports only
   * "Permission denied", which is the least debuggable failure in the whole flow.
   */
  keyPath?: string
}

/** The four ordered checks that run before Studio will touch a server. */
/**
 * `control` is the MANAGED-seat step and replaces `writable`/`git`.
 *
 * On a managed server the developer has no business writing into the repository root or checking
 * whether git is installed — a repository is created by the authenticated control-plane API, not by
 * running `git init --bare` down an SSH pipe. So the ladder asks a different last question there:
 * did the control plane answer, and does this role have somewhere to put a repository.
 */
export type PreflightId = 'reach' | 'auth' | 'writable' | 'git' | 'control'

export type RemedyKind =
  | 'unreachable' | 'no-key' | 'key-refused' | 'host-key-changed' | 'not-writable' | 'no-git'
  /** The control plane is unreachable, or the seat is not signed in to it. */
  | 'not-signed-in'
  /** Signed in, but this role may not create repositories (or has no team record to grant one to). */
  | 'not-permitted'

export interface PreflightStep {
  id: PreflightId
  ok: boolean
  detail: string
}

export interface PreflightResult {
  ok: boolean
  steps: PreflightStep[]
  /** Present only on failure: what the user can do about it. */
  remedy?: { kind: RemedyKind; publicKey?: string; command?: string }
}

/** Everything the confirm screen shows. Producing it changes NOTHING, anywhere. */
export interface PublishPlan {
  preflight: PreflightResult
  url: string
  /** The literal command Studio will run on the server, shown before it runs. */
  command: string
  /** The folder is not a repository yet. */
  willInit: boolean
  /** There are files to commit before anything can be pushed. */
  willCommit: boolean
  /**
   * True when the repository will be created through the control-plane API rather than over SSH.
   * The confirm screen shows `command` verbatim either way, so this is what makes that honest:
   * a managed seat is shown a REST call because a REST call is what runs.
   */
  managed: boolean
}

export interface PublishResult {
  ok: boolean
  url?: string
  pushed: boolean
  error?: string
}

export interface GitServerInfo {
  server: GitServer | null
  /** True on a managed seat: the catalogue is server-filtered, so the form is read-only. */
  managed: boolean
  keyPath: string
  hasKey: boolean
}

/**
 * A merge outcome. Conflicts are DATA, not an error: stopping on a conflict is the
 * normal path the conflict UI exists to serve, so `conflicts` being non-empty must
 * not be rendered as a failure.
 */
export interface GitMergeResult {
  ok: boolean
  error?: string
  conflicts: string[]
}

export interface GitStageResult {
  ok: boolean
  error?: string
  staged: number
}

/** A Search Everywhere hit from the background AI project index. */
export interface IndexHit {
  kind: 'symbol' | 'file' | 'import'
  path: string
  detail: string
}

/** One commit in the visual Git timeline. */
/**
 * One commit.
 *
 * `hash` is the FULL 40-character id, because that is what everything downstream addresses a commit
 * by — the diff at a commit, blame's "show me that change", a future compare view. `short` exists
 * only to be displayed: an abbreviation is ambiguous by construction and grows a character every
 * time the repository does, so it is never the value handed back to git. `gitTimeline` used to
 * return the short hash under the name `hash`, which is why the History section could show a commit
 * and never open one.
 */
export interface GitCommitInfo {
  hash: string
  /** Abbreviated hash, for display only. */
  short: string
  /** Parent hashes: none for a root commit, two or more for a merge. The graph needs these. */
  parents: string[]
  author: string
  email: string
  ts: number
  /** Decorations pointing here — `HEAD -> main`, `origin/main`, `tag: v1.0`. */
  refs: string[]
  subject: string
  /** Everything after the subject line. May be empty, and may contain blank lines. */
  body: string
}

/** What to ask the log for. Every field is optional; the default is "the current branch". */
export interface GitLogQuery {
  /** Commits to skip — the paging cursor. */
  skip?: number
  /** Page size. Clamped in the main process; a renderer cannot ask for the whole repository. */
  limit?: number
  /** Project-relative path: history for one file, followed through renames. */
  path?: string
  /** Message search. Matched literally, never as a regular expression. */
  grep?: string
  /** Author name or email substring. */
  author?: string
  /** `-S`: commits that changed the number of occurrences of this string. */
  pickaxe?: string
  /** Branches or tags to walk instead of HEAD. */
  refs?: string[]
}

export interface GitLogPage {
  commits: GitCommitInfo[]
  /** Pass as the next `skip`. null when this page reached the end of the history. */
  nextSkip: number | null
}

// ---- Project Brain (Wave 3): a deep, no-model understanding of the project ----

/** A change hotspot: a file with high commit count + churn (adds+dels). */
export interface GitHotspot {
  file: string
  commits: number
  churn: number
}

/** One author's contribution count to a file (Team Knowledge Graph). */
export interface AuthorStat {
  name: string
  commits: number
  /** Canonical identity (lowercased email) — one person across name aliases. */
  email?: string
}

/** Who owns a file, by commit count — authors[0] is the primary owner. */
export interface FileOwnership {
  file: string
  authors: AuthorStat[]
}

/** Who owns a directory/module, rolled up from its files. */
export interface ModuleOwner {
  dir: string
  owners: AuthorStat[]
}

/** Cross-repo Knowledge Graph — owners + churn aggregated across the open projects. */
export interface CrossRepoOwner {
  name: string
  email?: string
  /** Total contribution weight across all repos (file-touch commits, matching the single-repo KG). */
  commits: number
  /** How many of the aggregated repos this person has touched. */
  repos: number
}
export interface CrossRepoHotspot {
  /** Repo-qualified path ("reponame/src/x.ts") so same-named files across repos never collide. */
  file: string
  repo: string
  commits: number
  churn: number
}
export interface CrossRepoGraph {
  repos: string[]
  owners: CrossRepoOwner[]
  hotspots: CrossRepoHotspot[]
}

/** One Dependency Health finding — plain English, never a CVE/vulnerable/out-of-date claim. */
export interface DependencyFinding {
  severity: 'high' | 'medium' | 'low'
  kind: 'unpinned' | 'duplicate' | 'no-lockfile' | 'unused' | 'phantom' | 'typosquat' | 'heavyweight' | 'overlap'
  package: string
  message: string
}
export interface DependencyReport {
  ok: boolean
  verdict: string
  findings: DependencyFinding[]
  depCount: number
  hasLockfile: boolean
}

/** Blast Radius — how LOAD-BEARING a staged file is (the counterpart to AI Confidence). */
export interface BlastRadius {
  /** Files that directly import this one. */
  dependents: number
  /** Files reachable within 2 import hops (dependents + their dependents). */
  reach: number
  isEntry: boolean
  band: 'low' | 'medium' | 'high'
  /** Plain-English risk sentence for a non-coder. */
  summary: string
  /** The graph hit a cap, or the file isn't indexed yet — the number is a floor, not exact. */
  partial: boolean
}

/** Apply-time "this change adds what looks like a secret" guard for a staged edit (Wave 16).
 * COUNT + severity + a generic rule message ONLY — never the matched secret value. */
export interface StagedSecretGuard {
  count: number
  severity: 'critical' | 'high' | 'medium'
  message: string
}

/** Apply-time "this file is your app's plumbing" advisory for a staged path (Wave 16). */
export interface ConfigAdvisory {
  /** True when the path is a well-known config/plumbing file (env, manifest, lockfile, CI, Docker…). */
  sensitive: boolean
  /** Short chip label, e.g. "secrets file", "dependency list". */
  label: string
  /** Plain-English why-it-matters sentence for a non-coder. */
  why: string
}

/** One file in an Auto-Context Pack, with why it's relevant. */
export interface ContextPackEntry {
  path: string
  reason: 'seed' | 'import' | 'importer' | 'symbol'
  score: number
  symbols: string[]
}

/** The most relevant files for a task/file, assembled from the graph + index. */
export interface ContextPack {
  root: string
  seed: string
  seedKind: 'file' | 'query'
  files: ContextPackEntry[]
}

/** A frozen architecture snapshot to detect drift against. */
export interface ArchBaseline {
  capturedAt: number
  /** True when captured with the full (uncapped) graph for exact drift. */
  full?: boolean
  map: ArchitectureMap
}

/** How the architecture has drifted from its baseline. */
export interface DriftReport {
  hasBaseline: boolean
  capturedAt: number | null
  /** True when the baseline or current map hit an analysis cap (top-20 deps /
   * 2000 edges / 300 files), so a reported add/remove may be a ranking artifact,
   * not real drift. The UI surfaces this as a caveat. */
  partial: boolean
  modules: { added: string[]; removed: string[] }
  edges: { added: { from: string; to: string }[]; removed: { from: string; to: string }[] }
  externalDeps: { added: string[]; removed: string[] }
}

/** The module/import dependency graph, folded from the background index. */
export interface ArchitectureMap {
  nodes: { path: string; symbols: number; language: string; isEntry: boolean }[]
  /** Resolved relative imports only (file → file inside the project). */
  edges: { from: string; to: string }[]
  externalDeps: { name: string; count: number }[]
  /**
   * The graph is INCOMPLETE — the file index hit its cap, the edge cap was hit, or some imports could
   * not be resolved (custom tsconfig aliases, workspace packages). Anything reading this map to say a
   * file is unused or a project is tangle-free MUST soften its claim when this is true.
   */
  partial?: boolean
}

/** The project's detected coding conventions (Team Brain / house-style). */
export interface HouseStyle {
  indent: 'tabs' | '2-spaces' | '4-spaces' | 'mixed'
  quotes: 'single' | 'double' | 'mixed'
  semicolons: boolean
  fileNaming: 'kebab' | 'camel' | 'pascal' | 'snake' | 'mixed'
  exportStyle: 'default' | 'named' | 'mixed'
  sampledFiles: number
}

/** Everything the IDE knows about a project without calling a model. */
export interface ProjectBrain {
  stack: { frameworks: string[]; languages: Record<string, number>; packageManagers: string[] }
  entryPoints: string[]
  graph: ArchitectureMap
  dbSchema: { source: string; models: string[] }[]
  envVars: { name: string; referenced: boolean; declared: boolean }[]
  hotspots: GitHotspot[]
  houseStyle?: HouseStyle
  generatedAt: number
  /** True when the index hit its file cap, so the picture is a partial sample. */
  partial: boolean
}

/** An open ssh port-forward from a workspace to this machine. */
export interface TunnelInfo {
  id: number
  localPort: number
  remotePort: number
}

// ---- Enterprise: company-server workspace (SSH) + protection policy ----

export interface RemoteConfig {
  host: string
  user: string
  port: number
  keyPath: string
  /** Absolute project root on the server; all access is confined to it. */
  root: string
}

export interface RemotePolicy {
  /** Only allowlisted AI providers may see server code. */
  confidential: boolean
  /** false = block copy/export of server code out of Studio (audited). */
  allowExport: boolean
  allowedProviders: string[]
  /** Company endpoint that receives violation/fraud reports. */
  fraudWebhook?: string
  /** Viewer role: browsing allowed, every write refused. */
  readOnly?: boolean
}

/** A teammate on the cloud control plane. */
export interface TeamMember {
  name: string
  role: 'owner' | 'editor' | 'viewer'
  createdAt: number
}

/** Company-wide managed configuration (deployed by IT / delivered by MDM). */
export interface EnterprisePolicy {
  managed: boolean
  allowedProviders?: string[]
  enforceConfidential?: boolean
  blockExport?: boolean
  fraudWebhook?: string
  /** Wave 3: MDM-forced air-gap — a hard floor the user toggle can't lift. */
  airGap?: boolean
  /**
   * The company identity provider. Its PRESENCE is what turns role gating on — see
   * `identityRequired()` in `main/policy.ts` and `surfaceAllowed()` in `shared/roles.ts`.
   * Absent (every standalone seat) means no roles exist and the app behaves as it always has.
   */
  idp?: IdpConfig
}

/**
 * On-prem OIDC (Keycloak) plus the control plane that turns a token into an SSH certificate.
 * All three hosts are inside the air gap; there is no public endpoint in this shape by design.
 */
export interface IdpConfig {
  /** Issuer URL, e.g. `https://id.company.internal/realms/atomic`. Discovery is read from it. */
  issuer: string
  clientId: string
  /** `atomic-workspaced`, e.g. `https://git.company.internal`. Issues the SSH certificate. */
  controlPlane: string
  /** JWT claim carrying the user's groups. Defaults to `groups`. */
  groupsClaim?: string
  /** IdP group name -> ATOMIC role. First match in ROLES order wins, so admin outranks dev. */
  groupRoles?: Record<string, Role>
}

/**
 * What the seat knows about who is signed in. `required` is the ONLY thing that distinguishes an
 * unmanaged install (no roles at all) from a managed one where nobody has signed in yet.
 */
export interface IdentityStatus {
  required: boolean
  signedIn: boolean
  identity: Identity | null
  /** Set when the last attempt failed. Phrased for a human, never a raw fetch error. */
  error?: string
}

/**
 * The device-code prompt. Studio deliberately does NOT embed a browser for login: an embedded
 * browser trains people to type company credentials into a window they cannot verify, and it
 * defeats the IdP's own MFA prompts. The user sees a short code and opens their real browser.
 */
export interface DeviceLoginPrompt {
  ok: boolean
  userCode?: string
  verificationUri?: string
  /** Pre-filled URL when the IdP offers one — saves typing the code. */
  verificationUriComplete?: string
  expiresInSec?: number
  error?: string
}

export interface IdentityResult {
  ok: boolean
  identity?: Identity
  error?: string
}

export interface RemoteResult {
  ok: boolean
  error?: string
}

export interface RemoteReadResult {
  ok: boolean
  content?: string
  error?: string
}

export interface RemoteDirEntry {
  name: string
  isDir: boolean
}

export interface RemoteState {
  connected: boolean
  cfg?: RemoteConfig
  policy?: RemotePolicy
}

export interface AuditEntry {
  ts: number
  event: string
  detail: string
}

export interface FraudReportResult {
  ok: boolean
  delivered: boolean
  error?: string
}

// ---- ATOMIC Workspaces: two-tier codespaces (company server / ATOMIC Cloud) ----

export type WorkspaceKind = 'company' | 'cloud'
export type WorkspaceState = 'ready' | 'provisioning' | 'suspended' | 'error'

/** Optional project manifest (workspace.json at the workspace root). */
export interface WorkspaceManifest {
  language?: string
  framework?: string
  /** Command that starts the app, e.g. "npm run dev". */
  startup?: string
  ports?: number[]
  template?: string
  ai?: string
}

/**
 * One registered workspace. NO secrets live here — the SSH key stays a path,
 * the cloud API key and workspace secrets live in the OS keychain.
 */
export interface Workspace {
  id: string
  name: string
  kind: WorkspaceKind
  cfg: RemoteConfig
  policy: RemotePolicy
  /** Git repo cloned at provision time (company kind). */
  repo?: string
  template?: string
  /** Control-plane base URL (cloud kind). */
  cloudUrl?: string
  createdAt: number
  lastOpened: number | null
  state: WorkspaceState
  lastError?: string
}

export interface WsProvisionRequest {
  name: string
  cfg: RemoteConfig
  policy: RemotePolicy
  repo?: string
  template?: string
  /** Provision into a non-empty folder (guard against clobbering prod dirs). */
  allowNonEmpty?: boolean
}

export interface WsCloudCreateRequest {
  name: string
  template?: string
}

export interface WsResult {
  ok: boolean
  error?: string
  workspace?: Workspace
}

/** Pre-open health probe of the workspace server. */
export interface WsHealth {
  ok: boolean
  ssh: boolean
  os?: string
  cpus?: number
  diskFreeMb?: number
  git?: boolean
  node?: boolean
  npm?: boolean
  error?: string
}

export interface WsOpenResult {
  ok: boolean
  error?: string
  remote?: RemoteState
  manifest?: WorkspaceManifest | null
  /** True when a suspended cloud workspace was auto-woken. */
  woke?: boolean
  health?: WsHealth
}

export interface WsSnapshotInfo {
  id: string
  name: string
  description?: string
  ts: number
  bytes?: number
}

/** The API exposed to the renderer via contextBridge (window.studio). */
export interface StudioApi {
  openProject: () => Promise<ProjectInfo | null>
  openProjectAt: (path: string) => Promise<ProjectInfo | null>
  createProject: (parentDir: string, name: string, template: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  listProjectTemplates: () => Promise<{ id: string; label: string }[]>
  newWindow: () => Promise<void>
  indexSearch: (root: string, query: string) => Promise<IndexHit[]>
  dockerInfo: (projectPath: string) => Promise<{ composeFile: string | null; available: boolean }>
  dockerCompose: (projectPath: string, action: 'up' | 'down' | 'ps') => Promise<{ ok: boolean; output: string }>
  // Wave 1 — AI-native OS features
  projectInsight: (root: string) => Promise<ProjectInsight>
  // Wave 3 — Project Brain
  projectBrain: (root: string) => Promise<ProjectBrain>
  architectureMap: (root: string) => Promise<ArchitectureMap>
  /** How load-bearing each staged file is (Blast Radius), keyed by project-relative path. */
  blastRadius: (root: string, paths: string[]) => Promise<Record<string, BlastRadius>>
  configGuard: (paths: string[]) => Promise<Record<string, ConfigAdvisory>>
  scanStagedSecrets: () => Promise<Record<string, StagedSecretGuard>>
  explainProject: (root: string, provider: string, model?: string) => Promise<{ ok: boolean; text?: string; insight?: ProjectInsight; error?: string }>
  draftGitText: (kind: 'commit' | 'pr' | 'release', projectPath: string, provider: string, model?: string) => Promise<{ ok: boolean; text?: string; error?: string }>
  explainOutput: (output: string, provider: string, model?: string) => Promise<{ ok: boolean; text?: string; error?: string }>
  // Wave 2 — named guarantees
  getUsage: () => Promise<Usage>
  resetUsage: () => Promise<void>
  setSpendCap: (tokens: number) => Promise<void>

  // Media generation — the client's own subscription/API, never ATOMIC's
  mediaProviders: () => Promise<MediaProviderInfo[]>
  mediaGenerate: (req: MediaGenerateRequest) => Promise<{ ok: boolean; receipt?: MediaReceipt; error?: string }>
  mediaList: (projectPath: string) => Promise<MediaReceipt[]>
  mediaDelete: (projectPath: string, file: string) => Promise<{ ok: boolean; error?: string }>
  mediaDataUrl: (projectPath: string, file: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
  mediaUsage: () => Promise<MediaUsage>
  mediaSetCap: (usd: number) => Promise<void>
  /** Progress notes while a long video render runs, so the UI is never a silent spinner. */
  onMediaProgress: (cb: (ev: { note: string }) => void) => () => void
  undoCheckpoints: () => Promise<{ id: string; label: string; ts: number }[]>
  restoreCheckpoint: (id: string) => Promise<{ ok: boolean; restored: string[]; canUndo: boolean }>
  ledgerList: (project: string) => Promise<LedgerEntry[]>
  ledgerSearch: (project: string, query: string) => Promise<LedgerEntry[]>
  // Wave 5 — Decisions log, Analytics-over-time, Context Packs
  addDecision: (project: string, entry: { title: string; detail: string; tags?: string[] }) => Promise<void>
  listDecisions: (project: string) => Promise<Decision[]>
  analyticsRecord: (project: string, snap: Omit<MetricSnapshot, 'ts'>) => Promise<void>
  analyticsList: (project: string) => Promise<MetricSnapshot[]>
  contextPack: (root: string, seed: string) => Promise<ContextPack>
  // Wave 6 — Team Knowledge Graph, Architecture Drift
  gitAuthorship: (projectPath: string) => Promise<FileOwnership[]>
  /** Aggregate owners + churn across the given project paths (the renderer's recents). */
  kgCrossRepo: (paths: string[]) => Promise<CrossRepoGraph>
  saveArchBaseline: (project: string) => Promise<ArchBaseline>
  archDrift: (project: string) => Promise<DriftReport>
  designReview: (project: string) => Promise<DesignReview>
  planApplyTokens: (root: string, tokens: { name: string; value: string }[]) => Promise<TokenApplyPlan[]>
  applyTokens: (
    root: string,
    checkedFiles: string[],
    tokens: { name: string; value: string }[],
    blockCss: string,
    blockTargetFile: string
  ) => Promise<TokenApplyResult>
  securityScan: (project: string) => Promise<SecurityReport>
  /** Offline health audit of package.json + lockfile (unpinned/duplicate/unused/phantom/lockfile). */
  dependencyAudit: (project: string) => Promise<DependencyReport>
  /** Scaffold a deterministic *.test.<ext> skeleton for a source file (written + undoable). */
  generateTests: (root: string, srcRel: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  /** "How do I run this?" preflight — install/env/db/start checklist with copy commands. */
  runbook: (root: string) => Promise<import('./runbook').Runbook>
  complianceExport: (project: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  startDevServer: (projectPath: string) => Promise<void>
  stopDevServer: () => Promise<void>
  getDevServerState: () => Promise<DevServerState>
  onDevServerState: (cb: (state: DevServerState) => void) => () => void
  onLog: (cb: (line: LogLine) => void) => () => void
  /** Project-relative paths changed OUTSIDE the app (Finder, terminal, npm install, another editor). */
  onFsChanged: (cb: (paths: string[]) => void) => () => void

  // Phase 1 — click-to-edit
  applyEdit: (req: EditRequest) => Promise<ApplyEditResult>
  inlineEdit: (req: InlineEditRequest) => Promise<InlineEditResult>
  autocomplete: (req: AutocompleteRequest) => Promise<AutocompleteResult>
  autoFix: (req: AutoFixRequest) => Promise<ApplyEditResult>
  runEditGoal: (req: GoalEditRequest) => Promise<GoalEditResult>
  undoEdit: () => Promise<UndoEditResult>
  getUndoState: () => Promise<UndoState>
  getUndoHistory: () => Promise<UndoHistoryEntry[]>
  undoTo: (keep: number) => Promise<UndoToResult>
  undoDiff: (stackIndex: number) => Promise<DiffLine[]>

  // AI provider key management (stored encrypted in the OS keychain)
  setApiKey: (provider: string, key: string) => Promise<{ ok: boolean; error?: string }>
  /** 'unreadable' means saved keys exist but this Mac will not unlock them — never say "no key" then. */
  vaultStatus: () => Promise<'ok' | 'empty' | 'unreadable'>
  hasApiKey: (provider: string) => Promise<boolean>
  listProviders: () => Promise<ProviderInfo[]>
  modelCatalog: () => Promise<ModelCatalog>
  /** The live OpenCode Zen model catalog (free + paid) — a plain HTTPS call, not the opencode CLI. */
  opencodeModels: () => Promise<{ ok: true; models: { id: string; free: boolean }[] } | { ok: false; error: string }>
  modelPull: (name: string) => Promise<TermStartResult>
  /** Real terminal sessions (pseudo-terminal). Separate from termRun, which the agent uses. */
  ptyStart: (cwd: string, cols: number, rows: number) => Promise<{ ok: boolean; id?: number; error?: string }>
  ptyWrite: (id: number, data: string) => Promise<void>
  ptyResize: (id: number, cols: number, rows: number) => Promise<void>
  ptyKill: (id: number) => Promise<void>
  ptyScrollback: (id: number) => Promise<string>
  onPtyData: (cb: (ev: { id: number; data: string }) => void) => () => void
  /** Menu commands arrive as `menu:<id>` strings; App.tsx maps them to the same functions the
   *  buttons call, so there is one implementation per action. */
  onMenuCommand: (cb: (cmd: string) => void) => () => void
  /** Connectors (MCP) — the extension mechanism. */
  /** Project Memory — durable knowledge the agent loads before every task. */
  memoryList: (project: string) => Promise<MemoryEntry[]>
  memoryAdd: (project: string, entry: { kind: MemoryKind; text: string; key?: string; files?: string[] }) => Promise<MemoryEntry | null>
  memoryForget: (project: string, id: string) => Promise<void>
  memoryPin: (project: string, id: string, pinned: boolean) => Promise<void>
  memoryStats: (project: string) => Promise<MemoryStats>
  /** Preview what THIS task would load — the same retrieval the agent runs. */
  memoryPreview: (project: string, task: string) => Promise<MemoryRetrieval>
  /** Turn on (or off) keeping ATOMIC-MEMORY.md inside the project folder. */
  memorySetSync: (project: string, on: boolean) => Promise<void>
  connectorList: () => Promise<ConnectorInfo[]>
  connectorSetEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean; tools?: ConnectorTool[]; error?: string }>
  connectorApproveTool: (id: string, tool: string, approved: boolean) => Promise<void>
  connectorRemove: (id: string) => Promise<void>
  /** Installing extensions: from a folder already on disk, or cloned from an https repo. */
  extensionsList: () => Promise<ExtensionManifest[]>
  extensionInstallFolder: () => Promise<InstallResult>
  extensionInstallGit: (url: string) => Promise<InstallResult>
  extensionUninstall: (id: string) => Promise<InstallResult>
  extensionRegistry: () => Promise<{ ok: boolean; entries: RegistryEntry[]; error?: string }>
  /** Themes. `themeGet` returns the one in effect; `themeList` every one that exists. */
  themeList: () => Promise<Theme[]>
  themeGet: () => Promise<Theme>
  themeSet: (id: string) => Promise<Theme>
  themeInstallFile: () => Promise<ThemeInstallResult>
  themeRemove: (id: string) => Promise<ThemeInstallResult>
  /** Themes are application-wide: every window repaints, so a second window can never disagree. */
  onThemeChanged: (cb: (theme: Theme) => void) => () => void
  /** The agent driving the live preview: main asks, the renderer performs it, and answers. */
  onPreviewControl: (
    cb: (req: { id: number; action: PreviewControlAction; arg: string; text?: string }) => void
  ) => () => void
  previewControlResult: (id: number, result: PreviewControlResult) => Promise<void>
  /** Push the state the menu renders (labels flip, items enable) — menus are static once built. */
  menuState: (state: { hasProject?: boolean; previewRunning?: boolean; panelOpen?: boolean; agentOpen?: boolean }) => Promise<void>
  /** Start Ollama's local server; resolves with the state it reached, never a bare boolean. */
  ollamaStart: () => Promise<OllamaState>
  /** Model pulls still running (name → term id), to rehydrate Settings after a reopen. */
  listActivePulls: () => Promise<Record<string, number>>

  // Phase 7 — IDE shell: file tree + code editor
  /** `scope: 'explorer'` applies VS Code's file-tree exclusions; the default applies the scan list. */
  listDir: (projectPath: string, relPath: string, scope?: 'scan' | 'explorer') => Promise<DirEntry[]>
  readFile: (projectPath: string, relPath: string) => Promise<ReadFileResult>
  writeFile: (projectPath: string, relPath: string, content: string) => Promise<FsResult>
  createFile: (projectPath: string, relPath: string) => Promise<FsResult>
  createDir: (projectPath: string, relPath: string) => Promise<FsResult>
  renamePath: (projectPath: string, relPath: string, newRelPath: string) => Promise<FsResult>
  deletePath: (projectPath: string, relPath: string) => Promise<FsResult>
  previewPath: (projectPath: string, relPath: string) => Promise<{ isDir: boolean; files: number; dirs: number; bytes: number; capped: boolean; restorable: boolean; capReason?: 'too-big' | 'skipped-noise' | 'unreadable'; trashAvailable: boolean; trashName: string }>
  trashPath: (projectPath: string, relPath: string) => Promise<FsResult & { trashed: boolean; checkpointId?: string; restoredFiles?: number }>
  gitPathIgnored: (projectPath: string, relPath: string) => Promise<boolean | null>

  // Phase 8 — real iOS Simulator (macOS)
  listSimulators: () => Promise<SimulatorDevice[]>
  openInSimulator: (udid: string, url: string) => Promise<SimulatorResult>
  simulatorScreenshot: (udid: string) => Promise<SimulatorScreenshotResult>

  // Phase 10 — built-in AI agent
  agentStart: (req: AgentRunRequest) => Promise<{ ok: boolean; error?: string; queued?: boolean }>
  agentCancel: () => Promise<void>
  agentState: () => Promise<AgentState>
  agentApply: (ids: string[] | 'all') => Promise<ApplyStagedResult>
  agentReject: (ids: string[] | 'all') => Promise<AgentState>
  agentNewChat: () => Promise<void>
  onAgentEvent: (cb: (ev: AgentEvent) => void) => () => void

  // Phase 10 — integrated terminal (spawn-based)
  termRun: (projectPath: string, command: string) => Promise<TermStartResult>
  termKill: (id: number) => Promise<void>
  onTermLine: (cb: (ev: TermLineEvent) => void) => () => void

  // Enterprise — GitHub / git (token stored via setApiKey('github', …))
  ghUser: () => Promise<GhUser | null>
  pickFolder: () => Promise<string | null>
  gitInfo: (projectPath: string) => Promise<GitInfo>
  /** The hot status: one git process for the whole working-tree/index/branch picture. */
  gitSnapshot: (projectPath: string) => Promise<GitSnapshot>
  /** An exact diff for one row; `orig` is the rename source for a renamed staged row. */
  gitDiffFile: (projectPath: string, relPath: string, mode: GitDiffMode, orig?: string) => Promise<GitFileDiff>
  /** Something under `.git` changed (index, HEAD, refs, merge state) — from any process, not just Studio. */
  onGitChanged: (cb: () => void) => () => void
  gitCommit: (projectPath: string, message: string, stageAll?: boolean) => Promise<GitResult>
  /** `setUpstream` publishes a branch that has none yet — `push -u origin <branch>`. */
  gitPush: (projectPath: string, setUpstream?: boolean) => Promise<GitResult>
  gitPull: (projectPath: string) => Promise<GitResult>
  gitCheckout: (projectPath: string, branch: string, create: boolean) => Promise<GitResult>
  gitTimeline: (projectPath: string) => Promise<GitCommitInfo[]>
  /** Paged history. `skip` comes from the previous page's `nextSkip`. */
  gitLog: (projectPath: string, query?: GitLogQuery) => Promise<GitLogPage>
  gitWorkingStat: (projectPath: string, subPath?: string) => Promise<import('./worksafety').ChangedFileList>
  gitCompareHead: (projectPath: string, relPath: string) => Promise<{ inBackup: boolean; lines: DiffLine[] }>
  gitRestoreFile: (projectPath: string, relPath: string) => Promise<{ ok: boolean; error?: string }>
  gitCommitFiles: (projectPath: string, hash: string) => Promise<string[]>
  gitStage: (projectPath: string, relPaths: string[]) => Promise<GitStageResult>
  gitUnstage: (projectPath: string, relPaths: string[]) => Promise<GitStageResult>
  gitStagedStat: (projectPath: string) => Promise<import('./worksafety').ChangedFileList>
  gitBranches: (projectPath: string) => Promise<GitBranch[]>
  gitBranchDelete: (projectPath: string, branch: string, force?: boolean) => Promise<GitResult>
  gitFetch: (projectPath: string, remote?: string) => Promise<GitResult>
  gitRemotes: (projectPath: string) => Promise<GitRemote[]>
  gitRemoteAdd: (projectPath: string, name: string, url: string) => Promise<GitResult>
  gitClone: (url: string, destDir: string, name?: string) => Promise<GitResult & { path?: string }>
  // Self-hosted git provisioning (2026-09-03)
  gitServerConfig: () => Promise<GitServerInfo>
  gitServerSave: (server: GitServer) => Promise<{ ok: boolean; error?: string }>
  gitServerTest: (server: GitServer) => Promise<PreflightResult>
  gitServerKey: () => Promise<{ path: string; publicKey: string; created: boolean }>
  gitPublishPlan: (projectPath: string, name: string) => Promise<PublishPlan | { error: string }>
  gitPublishRun: (projectPath: string, name: string) => Promise<PublishResult>
  gitMerge: (projectPath: string, branch: string) => Promise<GitMergeResult>
  gitMergeAbort: (projectPath: string) => Promise<GitResult>
  gitMergeContinue: (projectPath: string) => Promise<GitResult>
  gitConflicts: (projectPath: string) => Promise<string[]>
  gitResolveFile: (projectPath: string, relPath: string) => Promise<GitResult>
  gitMergeInProgress: (projectPath: string) => Promise<boolean>
  forgeList: () => Promise<ForgeInfo[]>
  forgeRepos: (forgeId: string) => Promise<ForgeRepo[]>

  // Identity — on-prem OIDC sign-in and the role it resolves to (air-gapped enterprise)
  identityStatus: () => Promise<IdentityStatus>
  identityBeginLogin: () => Promise<DeviceLoginPrompt>
  /** Polls the IdP until the user finishes in their browser, then resolves the role. */
  identityCompleteLogin: () => Promise<IdentityResult>
  identityLogout: () => Promise<IdentityStatus>
  onIdentityChanged: (cb: (status: IdentityStatus) => void) => () => void

  // Enterprise — company-server workspace + protection policy
  remoteConnect: (cfg: RemoteConfig, policy: RemotePolicy) => Promise<RemoteResult>
  remoteDisconnect: () => Promise<void>
  remoteState: () => Promise<RemoteState>
  remoteList: (path: string) => Promise<RemoteDirEntry[]>
  remoteRead: (path: string) => Promise<RemoteReadResult>
  remoteWrite: (path: string, content: string) => Promise<RemoteResult>
  remoteExec: (command: string) => Promise<{ ok: boolean; output: string }>
  tunnelOpen: (remotePort: number, localPort?: number) => Promise<{ ok: boolean; error?: string; tunnel?: TunnelInfo }>
  tunnelList: () => Promise<TunnelInfo[]>
  tunnelClose: (id: number) => Promise<void>
  auditEvent: (event: string, detail: string) => Promise<void>
  auditTail: () => Promise<AuditEntry[]>
  reportFraud: (reason: string) => Promise<FraudReportResult>

  // ATOMIC Workspaces — two-tier codespaces
  wsList: () => Promise<Workspace[]>
  wsCreateCompany: (req: WsProvisionRequest) => Promise<WsResult>
  wsCreateCloud: (req: WsCloudCreateRequest) => Promise<WsResult>
  wsOpen: (id: string) => Promise<WsOpenResult>
  wsDelete: (id: string, alsoRemote: boolean) => Promise<WsResult>
  wsHealth: (id: string) => Promise<WsHealth>
  wsCloudSetup: (baseUrl: string) => Promise<void>
  wsCloudConfig: () => Promise<{ baseUrl: string | null; hasKey: boolean }>
  /** Workspace secrets: names are listable, values stay in the OS keychain. */
  wsSecretsSet: (id: string, secrets: Record<string, string>) => Promise<void>
  wsSecretNames: (id: string) => Promise<string[]>
  /** Run a command in the workspace with its secrets injected as env vars. */
  wsExec: (id: string, command: string) => Promise<{ ok: boolean; output: string }>
  wsSnapshot: (id: string, name: string, description?: string) => Promise<WsResult>
  wsSnapshots: (id: string) => Promise<WsSnapshotInfo[]>
  wsRestore: (id: string, snapshotId: string) => Promise<WsResult>

  // Phase 3 — team, billing touchpoint, enterprise policy
  wsTeamList: () => Promise<TeamMember[]>
  wsTeamInvite: (name: string, role: 'editor' | 'viewer') => Promise<{ ok: boolean; token?: string; error?: string }>
  wsTeamRevoke: (name: string) => Promise<{ ok: boolean; error?: string }>
  wsCloudRole: () => Promise<string | null>
  wsSubscribeInfo: () => Promise<{ link: string | null; price: string } | null>
  openExternal: (url: string) => Promise<void>
  enterprisePolicy: () => Promise<EnterprisePolicy>
  // Wave 3 — Air-Gapped Mode
  getAirGapped: () => Promise<boolean>
  setAirGapped: (on: boolean) => Promise<boolean>
  // Builder Mode / Developer Mode — `chosen:false` means the user has never picked one.
  getMode: () => Promise<{ mode: StudioMode; chosen: boolean }>
  setMode: (mode: StudioMode) => Promise<StudioMode>
  /** Another window switched personality — this one follows. Returns an unsubscribe. */
  onModeChanged: (cb: (mode: StudioMode) => void) => () => void
}
