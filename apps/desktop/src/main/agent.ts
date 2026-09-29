import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { apiKeyFor, complete, getProvider, type ChatMessage, getUsage } from './providers'
import * as fsService from './fs-service'
import { buildSymbolIndex, findSymbol, houseStylePrompt } from './index-service'
import { decisionsPrompt } from './decisions'
import { memoryPrompt, remember, isKind as memoryIsKind } from './memory'
import { diffLines, diffStats, foldContext } from './diff'
import { execStream, isAgentSafeCommand, scriptVerdictFor } from './terminal'
import { scriptRefusal } from '../shared/scriptrisk'
import { scanLines } from './security'
import { checkpoint } from './undo'
import { ledgerAppend } from './ledger'
import * as mcp from './mcp'
import * as previewctl from './previewctl'
import { generate as mediaGenerate, defaultImageChoice } from './media'
import type { ProcessManager } from './process-manager'
import type {
  AgentEvent,
  AgentRunRequest,
  AgentState,
  AgentTask,
  ApplyStagedResult,
  BuildReceipt,
  ReceiptFile,
  StagedEdit,
  StagedSecretGuard,
  Usage,
  VerifyResult
} from '../shared/types'

/**
 * Phase 10 — the built-in AI agent (the Claude-terminal replacement).
 *
 * A provider-agnostic tool loop over `complete()`: the model answers with ONE
 * plain-text ACTION per turn (list_files / read_file / search / run / write /
 * done); we execute it and feed the result back. No native tool-calling API is
 * required, so the same loop runs on all six providers including the free
 * ATOMIC Hub.
 *
 * Safety spine (the anti-"rogue agent" wedge):
 *  - `write` NEVER touches disk — it stages a diff the user must Apply.
 *  - `run` only executes read-only/build commands (isAgentSafeCommand), and a project script
 *    whose BODY deploys/resets something live is refused too (scriptVerdictFor);
 *    anything else is refused and surfaced to the user.
 *  - plan mode stages nothing at all.
 *  - Applying uses fs-service.writeFile, which snapshots for one-click Undo.
 */

const MAX_TURNS = 14
const MAX_READ_CHARS = 60_000
const MAX_TREE_ENTRIES = 400
const MAX_SEARCH_RESULTS = 30
const MAX_CMD_OUTPUT = 4_000
const CMD_TIMEOUT_MS = 120_000

const SYSTEM_PROMPT = `You are the ATOMIC Studio agent: you help a NON-CODER change their software project. You work in small careful steps and you never pretend something worked.

Each reply must contain EXACTLY ONE action as its last part. You may write one short plain-English sentence before the action to tell the user what you are doing (no jargon). The action formats are:

ACTION list_files
ACTION read_file <path>
ACTION search <text>
ACTION symbols <name>   (find where a function/class/component is defined)
ACTION run <command>
ACTION run_preview
ACTION stop_preview
ACTION write <path>
\`\`\`
<the COMPLETE new content of that file>
\`\`\`
ACTION generate_image <description of the picture>   (optionally --size 16:9 --provider openai --model gpt-image-1)
ACTION remember <kind> <one sentence worth keeping forever>
ACTION preview_click <button or link text, or a CSS selector>
ACTION preview_type <css selector> <text to type>
ACTION preview_snap
ACTION done
<a short plain-English summary of what you changed and why>

Rules:
- Paths are relative to the project root, e.g. src/App.tsx.
- ALWAYS read a file before writing it. write must contain the ENTIRE file, not a fragment.
- Prefer the smallest change that accomplishes the goal; preserve style, imports, formatting.
- run may only use safe commands: ls, git status/diff/log, npm test, npm run <script>, npx tsc, node <file>, and installing dependencies (npm install / npm i / yarn / yarn add / pnpm install / pnpm add / bun install / bun add / pip install / poetry install). If a build or run fails because dependencies are missing, install them yourself with one of these — do not just tell the user to do it. Other commands will be refused.
- When the user asks you to "run", "start", "launch", or "preview" the app/website itself (as opposed to a one-shot script), use ACTION run_preview. NEVER use run for npm start/npm run dev/anything long-running — those never exit, run will refuse them, and you must NOT tell the user to type it into the Terminal themselves. run_preview starts the SAME dev server the app's own "Run preview" button starts, and the user sees it live in the app's Preview tab — you never need to mention a URL, a terminal, or a browser tab unless run_preview's result tells you to.
- When the goal is achieved (or impossible), use ACTION done with an honest summary.
- Use remember when you learn something about this project that would NOT be obvious from reading the code again later: a goal, a rule the business depends on, something you must never do, a convention, a decision and why, or work left pending. kind is one of: goal, decision, convention, design-rule, business-rule, bug, debt, file, preference, forbidden, pending, idea. Do NOT remember things that are already in the code — the code is read fresh every time; remember only what re-reading it could never tell you.
- After changing something the user can SEE, use the preview actions to try it yourself: run_preview, then preview_click / preview_type the thing you changed, then preview_snap. If an interaction fails, say so — a screenshot of the working feature is worth more than any description, and claiming it works without trying it is the one thing you must never do.
- generate_image creates a REAL picture and saves it into assets/generated/, then tells you the path to use in code. It is billed to the user's own image account, so use it only when the project genuinely needs artwork it does not have (a hero image, an illustration, an app icon, a placeholder photo) — never to decorate something the user did not ask about, and never more than a couple of times in one task without being asked. Say what you are creating before you create it. If it fails because there is no key, tell the user plainly and carry on with the rest of the work instead of retrying.
- There is no video action: video costs real money per clip and takes minutes, so the user starts those themselves from the Create panel.
- Never invent file contents or claim success you have not verified.`

// ---------------------------------------------------------------- run state

interface PendingEdit extends StagedEdit {
  content: string
  /** The instruction that produced this edit + the model — recorded to the
   * ledger only when the edit is actually applied (never at stage time). */
  why: string
  model: string
}

let running = false
let cancelled = false
/** Background queue: instructions submitted while a run is active wait here. */
const queue: { req: AgentRunRequest; emit: (ev: AgentEvent) => void; pm?: ProcessManager }[] = []
let runCounter = 0
let editCounter = 0
let activeKill: (() => void) | null = null
const staged = new Map<string, PendingEdit>()
let stagedProject = ''
// Confidence Meter: files the agent actually READ this run — a proxy for
// "did it look before it edited?". Reset at the START of every run.
const readThisRun = new Set<string>()
/**
 * What this run actually changed on disk — the receipt's evidence.
 *
 * Sizes are measured immediately before and after each write, because that is the only size number
 * this app can prove without running the project's build. Keyed by path so a file written twice in
 * one run counts once, with the size change measured across the whole run.
 */
const receiptFiles = new Map<string, ReceiptFile>()
// The project of the currently-running run. Queueing is confined to this project:
// the `staged` Map + stagedProject are single globals, so letting a run for a
// DIFFERENT project drain while this one's edits are still staged would let
// Apply-all write one project's content into another. Same-project follow-ups
// (the intended use) are always safe.
let activeProject = ''
// Multi-Agent Board: the live task + a bounded ring of recently-finished runs.
let activeTask: AgentTask | null = null
const finishedRuns: AgentTask[] = []
const MAX_FINISHED = 20

// Conversation memory: the transcript survives across runs on the same project
// so follow-ups ("now make it shorter") work like a chat, not a fresh start.
let session: { project: string; messages: ChatMessage[] } | null = null
// Keep the transcript bounded: past this many messages, drop the oldest
// exchanges but ALWAYS keep the seed message (index 0 — goal + project tree).
const MAX_SESSION_MESSAGES = 40

export function resetSession(): void {
  session = null
}

/** Exposed for tests: how many messages the live transcript holds. */
export function sessionLength(): number {
  return session?.messages.length ?? 0
}

export function getAgentState(): AgentState {
  return {
    running,
    queued: queue.length,
    staged: [...staged.values()].map(toPublic),
    active: activeTask,
    queuedTasks: queue.map((q) => ({
      runId: -1,
      instruction: q.req.instruction,
      projectPath: q.req.projectPath,
      mode: q.req.mode,
      status: 'queued',
      turns: 0,
      stagedCount: 0,
      startedAt: 0
    })),
    finished: [...finishedRuns].reverse() // newest first
  }
}

/**
 * Wave 16 — Secret Leak Guard on staged edits. Runs the SAME secret scanner (security.scanLines) over
 * ONLY the ADDED lines of each staged edit, so a key/password the AI is about to paste is caught at the
 * Apply moment. Returns count + severity + a generic rule message per path — NEVER the matched value
 * (Secret Handling Protocol). Added-lines-only: a secret already living in the file (not introduced by
 * this edit) is not re-flagged; PLACEHOLDER already suppresses obvious test tokens.
 */
function scanEditSecrets(e: PendingEdit): StagedSecretGuard | null {
  const rank = { critical: 3, high: 2, medium: 1 } as const
  // Normally scan ONLY the added lines (so a secret already in the file isn't re-flagged). But for a
  // large edit (>3000 lines) diffLines collapses to a two-line "(entire file replaced …)" marker with
  // no real added text — so a pasted key would be silently missed at the very moment we promise to warn.
  // In that case fall back to scanning the full staged content (a rare over-scan beats a silent miss).
  const collapsed = e.diff.length === 2 && /entire file replaced/.test(e.diff[e.diff.length - 1].text)
  const lines = collapsed ? e.content.split('\n') : e.diff.filter((l) => l.kind === 'add').map((l) => l.text)
  const findings = scanLines(lines)
  if (!findings.length) return null
  const worst = findings.reduce((a, f) => (rank[f.severity] > rank[a.severity] ? f : a), findings[0])
  return { count: findings.length, severity: worst.severity, message: worst.message }
}

export function scanStagedSecrets(): Record<string, StagedSecretGuard> {
  const out: Record<string, StagedSecretGuard> = {}
  for (const e of staged.values()) {
    const g = scanEditSecrets(e)
    if (g) out[e.path] = g
  }
  return out
}

function toPublic(e: PendingEdit): StagedEdit {
  return {
    id: e.id,
    path: e.path,
    isNew: e.isNew,
    added: e.added,
    removed: e.removed,
    diff: e.diff,
    readBeforeWrite: e.readBeforeWrite,
    beforeLines: e.beforeLines,
    sizeRatio: e.sizeRatio,
    confidence: e.confidence
  }
}

export function cancelAgent(): void {
  cancelled = true
  queue.length = 0 // cancelling stops pending queued runs too, not just the active one
  activeKill?.()
}

/** Start the next queued run, if any. The single serial hand-off point. */
function drainQueue(): void {
  const next = queue.shift()
  if (next) void startAgent(next.req, next.emit, next.pm)
}

/**
 * Apply staged edits to disk (each write snapshots for Undo), then immediately
 * syntax-check what was written — the anti-"AI said done but broke it" wedge.
 * A failed check never auto-reverts; it is reported so the user can Undo.
 */
export async function applyStaged(ids: string[] | 'all'): Promise<ApplyStagedResult> {
  const pick = ids === 'all' ? [...staged.values()] : [...staged.values()].filter((e) => ids.includes(e.id))
  const applied: string[] = []
  for (const e of pick) {
    const res = fsService.writeFile(stagedProject, e.path, e.content)
    if (!res.ok) return { ok: false, applied, error: `${e.path}: ${res.error}`, canUndo: true, verify: [] }
    staged.delete(e.id)
    applied.push(e.path)
    // Ledger records at APPLY time only — an edit the user rejects (or never
    // applies) never appears in the "what changed & why" history.
    ledgerAppend(stagedProject, { file: e.path, why: e.why, model: e.model })
  }
  const verify: VerifyResult[] = []
  for (const path of applied) {
    const v = await verifyFile(stagedProject, path)
    if (v) verify.push(v)
  }
  return { ok: true, applied, canUndo: applied.length > 0, verify }
}

/**
 * Cheap per-file syntax check; null = file type we can't check.
 *
 * `node --check` goes through execFile with an ARGV ARRAY, never a shell string. This used to be
 * `execStream(`node --check ${JSON.stringify(abs)}`)`, and JSON.stringify is NOT a shell escape:
 * it emits double quotes, and a POSIX shell still expands `$(...)`, backticks and `$VAR` inside
 * those. The path is model-controlled — it is the `write` action's own path — and nothing upstream
 * restricts its charset: `fs-service` only rejects paths that ESCAPE the project root, and
 * `isSafeRelPath` blocks just `..`, a leading `/` and CR/LF/NUL. So a model emitting
 * `write a$(id).js` produced `node --check "…/a$(id).js"` and the shell ran `id`.
 *
 * The safety spine exists so that a weak or hostile model cannot reach past the tools it was
 * given. Passing argv means there is no shell to reach past.
 */
async function verifyFile(root: string, path: string): Promise<VerifyResult | null> {
  const abs = join(root, path)
  if (/\.(js|cjs|mjs)$/.test(path)) {
    const res = await new Promise<{ code: number; output: string }>((resolve) => {
      execFile('node', ['--check', abs], { cwd: root, timeout: 15_000 }, (err, stdout, stderr) => {
        // A syntax error is the EXPECTED outcome here, not a crash, so the exit code is read off
        // the error object rather than thrown. node reports the offending line on stderr.
        const e = err as (Error & { code?: number }) | null
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, output: `${stdout}${stderr}` })
      })
    })
    return res.code === 0
      ? { path, ok: true }
      : { path, ok: false, error: (res.output.split('\n').find((l) => l.trim()) ?? 'syntax error').slice(0, 200) }
  }
  if (path.endsWith('.json')) {
    try {
      JSON.parse(readFileSync(abs, 'utf8'))
      return { path, ok: true }
    } catch (e) {
      return { path, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'invalid JSON' }
    }
  }
  return null
}

export function rejectStaged(ids: string[] | 'all'): AgentState {
  if (ids === 'all') staged.clear()
  else for (const id of ids) staged.delete(id)
  return getAgentState()
}

// ---------------------------------------------------------------- tools

function toolListFiles(root: string): string {
  const lines: string[] = []
  const walk = (rel: string, depth: number): void => {
    if (lines.length >= MAX_TREE_ENTRIES) return
    for (const entry of fsService.listDir(root, rel)) {
      if (lines.length >= MAX_TREE_ENTRIES) {
        lines.push('… (tree truncated)')
        return
      }
      lines.push('  '.repeat(depth) + (entry.isDir ? entry.name + '/' : entry.name))
      if (entry.isDir && depth < 6) walk(entry.path, depth + 1)
    }
  }
  walk('', 0)
  return lines.length ? lines.join('\n') : '(empty project)'
}

/**
 * read_file sees staged content first so multi-step edits compose. Returns an
 * explicit ok flag so callers never confuse a genuine read failure with a file
 * whose *content* happens to begin with "ERROR:" (which would false-trip the
 * Loop Breaker and mislabel the tool event).
 */
function toolReadFile(root: string, path: string): { text: string; ok: boolean; fromStaged: boolean } {
  const stagedEdit = [...staged.values()].find((e) => e.path === path)
  if (stagedEdit) return { text: clip(stagedEdit.content, MAX_READ_CHARS) + '\n(NOTE: this is your STAGED version, not yet applied)', ok: true, fromStaged: true }
  const res = fsService.readFile(root, path)
  if (!res.ok) return { text: `ERROR: ${res.error === 'binary' ? 'binary file' : res.error}`, ok: false, fromStaged: false }
  return { text: clip(res.content ?? '', MAX_READ_CHARS), ok: true, fromStaged: false }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + `\n… (truncated, ${text.length} chars total)` : text
}

function toolSearch(root: string, query: string): string {
  const q = query.toLowerCase()
  const hits: string[] = []
  const walk = (rel: string): void => {
    if (hits.length >= MAX_SEARCH_RESULTS) return
    for (const entry of fsService.listDir(root, rel)) {
      if (hits.length >= MAX_SEARCH_RESULTS) return
      if (entry.isDir) {
        walk(entry.path)
        continue
      }
      const abs = join(root, entry.path)
      try {
        if (statSync(abs).size > 512 * 1024) continue
        const content = readFileSync(abs, 'utf8')
        if (content.includes('\0')) continue
        content.split('\n').forEach((line, i) => {
          if (hits.length < MAX_SEARCH_RESULTS && line.toLowerCase().includes(q)) {
            hits.push(`${entry.path}:${i + 1}: ${line.trim().slice(0, 160)}`)
          }
        })
      } catch {
        /* unreadable file — skip */
      }
    }
  }
  walk('')
  return hits.length ? hits.join('\n') : `No matches for "${query}".`
}

async function toolRun(root: string, command: string, emit: (ev: AgentEvent) => void, runId: number): Promise<string> {
  if (!isAgentSafeCommand(command)) {
    emit({ runId, type: 'command-blocked', command })
    return `REFUSED: "${command}" is not on the safe list (ls, git status/diff/log, npm test, npm run <script>, npx tsc, node <file>; no pipes/chaining). Ask the user to run it in the Terminal panel instead.`
  }
  // `npm run <script>` passes the safe list, but the SCRIPT ITSELF may deploy to a live site or reset a
  // database — outcomes no Undo in this app can reverse. Read its body before running it.
  const verdict = scriptVerdictFor(root, command)
  // 'unknown' means we could NOT read what this does. Failing open there is how a deploy sneaks through,
  // so an honest "I can't tell" is refused too — the user can always run it themselves in the Terminal.
  if (verdict && (verdict.risk === 'risky' || verdict.risk === 'unknown')) {
    emit({ runId, type: 'command-blocked', command })
    return `REFUSED: ${scriptRefusal(verdict)}`
  }
  const handle = execStream(command, root, () => {}, CMD_TIMEOUT_MS)
  activeKill = handle.kill
  const res = await handle.done
  activeKill = null
  const tail = res.output.length > MAX_CMD_OUTPUT ? '…' + res.output.slice(-MAX_CMD_OUTPUT) : res.output
  return `exit code: ${res.code ?? 'none'}${res.timedOut ? ' (TIMED OUT)' : ''}${res.error ? ` (${res.error})` : ''}\n--- output ---\n${tail || '(no output)'}`
}

/**
 * Real bug this fixes: "run the app" for a long-running dev server can NEVER go through `run` —
 * `execStream` waits for the process to EXIT, and a dev server never exits, so the agent would just
 * refuse and tell the non-coder user to open the Terminal and type it themselves. This starts the SAME
 * ProcessManager the app's own "Run preview" button uses (spawn-and-return, no blocking), then polls its
 * pushed state briefly so the model gets a real answer instead of firing-and-forgetting.
 */
async function toolRunPreview(root: string, pm: ProcessManager | undefined): Promise<string> {
  if (!pm) return 'ERROR: preview control is unavailable in this context.'
  const already = pm.getState()
  if (already.status === 'running' && already.url) {
    return `Already running at ${already.url} — the Preview tab in the app already shows it live, no need to start it again.`
  }
  const info = pm.inspectProject(root)
  if (info.framework !== 'static-html' && !info.devScript) {
    return 'ERROR: no "dev"/"start" script found in package.json — there is nothing to run.'
  }
  pm.start(info)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const s = pm.getState()
    if (s.status === 'running' && s.url) return `Running at ${s.url} — the Preview tab in the app now shows it live. Tell the user to look there; they do not need to open a terminal or a browser.`
    if (s.status === 'error') return `ERROR starting the preview: ${s.error ?? 'unknown error'}`
    await new Promise((r) => setTimeout(r, 300))
  }
  return 'Still starting after 20 seconds — a big project can take a while on its first boot. Check the Preview tab; if it is still not up shortly, say so honestly instead of claiming it worked.'
}

/**
 * Transparent confidence score (0–100) for a staged edit. Explainable on
 * purpose — the dock shows the same signals ("read first", "surgical change").
 * A new file starts mid; reading the file first is the biggest boost; a small,
 * surgical change scores higher than a sweeping rewrite. Post-apply the renderer
 * nudges this by the verify result.
 */
function confidenceScore(isNew: boolean, readBeforeWrite: boolean, sizeRatio: number): number {
  let score = 40
  if (readBeforeWrite) score += 25
  if (isNew) score += 15
  else if (sizeRatio <= 0.25) score += 25
  else if (sizeRatio <= 0.6) score += 15
  else if (sizeRatio <= 1) score += 5
  return Math.max(0, Math.min(100, score))
}

function stageWrite(root: string, path: string, content: string, why: string, model: string): StagedEdit | { error: string } {
  // Validate the path is inside the project by asking fs-service to read it.
  const probe = fsService.readFile(root, path)
  const abs = join(root, path)
  if (!probe.ok && probe.error === 'Path is outside the project folder.') return { error: probe.error }
  const isNew = !existsSync(abs)
  if (!isNew && probe.error === 'binary') return { error: 'Refusing to overwrite a binary file.' }
  const before = probe.ok ? (probe.content ?? '') : ''
  const full = foldContext(diffLines(before, content))
  const { added, removed } = diffStats(full)
  if (!isNew && added === 0 && removed === 0) return { error: 'The new content is identical to the current file.' }

  // Confidence signals (transparent, computed here so the renderer just draws):
  //  - readBeforeWrite: did the agent look at this file this run?
  //  - sizeRatio: how sweeping the change is vs the file it rewrites.
  const readBeforeWrite = isNew ? false : readThisRun.has(path)
  const beforeLines = isNew ? 0 : before.split('\n').length
  const sizeRatio = isNew || beforeLines === 0 ? 0 : (added + removed) / beforeLines
  const confidence = confidenceScore(isNew, readBeforeWrite, sizeRatio)

  // One staged edit per path — a rewrite replaces the previous proposal.
  const existing = [...staged.values()].find((e) => e.path === path)
  if (existing) staged.delete(existing.id)
  const edit: PendingEdit = { id: `e${++editCounter}`, path, isNew, added, removed, diff: full, content, why, model, readBeforeWrite, beforeLines, sizeRatio, confidence }
  staged.set(edit.id, edit)
  stagedProject = root
  return toPublic(edit)
}

// ---------------------------------------------------------------- protocol parsing

interface ParsedAction {
  preamble: string
  tool: string
  arg: string
  body?: string
}

/** The most recent preview screenshot taken during the current run — attached to the receipt. */
let lastSnapshot: string | null = null

/**
 * A generated image is a real artifact of the run — the Build Receipt would understate what happened
 * if a 900 KB hero image the agent paid for didn't appear in it. There is no "before" size (the file
 * cannot already exist: its name carries a timestamp), so the whole file is the delta and there are
 * no lines to add or remove.
 */
function noteGeneratedFile(rel: string, bytes: number): void {
  receiptFiles.set(rel, { path: rel, added: 0, removed: 0, bytesDelta: bytes })
}

/**
 * `ACTION generate_image <description>` with optional trailing `--` switches, e.g.
 *   ACTION generate_image a calm blue clinic reception --size 16:9
 *   ACTION generate_image an app icon of a blue atom --provider openai --model gpt-image-1
 *
 * Defaults come from the user's own saved preference (Settings → Create), not from a constant here,
 * so the agent spends money on the service the person actually chose. The description is everything
 * before the first switch, which keeps the common case a plain sentence with nothing to escape.
 */
export function parseImageSpec(arg: string): { prompt: string; providerId: string; model: string; size?: string } {
  const cut = arg.search(/\s--(?:size|provider|model)\b/)
  const prompt = (cut === -1 ? arg : arg.slice(0, cut)).trim()
  const flags = cut === -1 ? '' : arg.slice(cut)
  const pick = (name: string): string | undefined => flags.match(new RegExp(`--${name}\\s+([^\\s-][^\\s]*)`))?.[1]
  const def = defaultImageChoice()
  return {
    prompt,
    providerId: pick('provider') ?? def.providerId,
    model: pick('model') ?? def.model,
    size: pick('size')
  }
}


/** Size of a project file right now, or 0 if it does not exist yet (a brand-new file). */
function fileBytes(root: string, rel: string): number {
  try {
    return statSync(join(root, rel)).size
  } catch {
    return 0
  }
}

/**
 * Assemble the AI Build Receipt.
 *
 * Every number here was measured while the run happened — file sizes either side of each write,
 * the verify results the app already runs, the restore point taken before anything was touched, and
 * the token usage difference across the run. Nothing is estimated, and nothing the app cannot prove
 * (performance, bundle size) is included at all: an unbacked zero would be worse than an omission.
 */
function buildReceipt(input: {
  runId: number
  instruction: string
  summary: string
  startedAt: number
  rollbackId: string | null
  usageAtStart: Usage
  project: string
  snapshot: string | null
}): BuildReceipt {
  const files = [...receiptFiles.values()]
  const checked = files.filter((f) => f.verified !== undefined)
  const now = getUsage()
  const endedAt = Date.now()
  return {
    runId: input.runId,
    instruction: input.instruction,
    summary: input.summary,
    startedAt: input.startedAt,
    endedAt,
    durationMs: endedAt - input.startedAt,
    files,
    bytesDelta: files.reduce((n, f) => n + f.bytesDelta, 0),
    checks: { ran: checked.length, passed: checked.filter((f) => f.verified).length },
    rollbackId: input.rollbackId,
    tokens: {
      requests: Math.max(0, now.requests - input.usageAtStart.requests),
      estTokens: Math.max(0, now.estTokens - input.usageAtStart.estTokens),
      model: now.lastModel
    },
    // The same signal the confidence meter shows: of the files it changed, how many had it read.
    confidence: files.length === 0 ? null : files.filter((f) => readThisRun.has(f.path)).length / files.length,
    snapshot: input.snapshot ?? undefined
  }
}

/** Every tool the protocol accepts — used to keep the tolerant match below unambiguous. */
const ACTION_TOOLS = new Set([
  'list_files', 'read_file', 'search', 'symbols', 'run', 'run_preview', 'stop_preview',
  'write', 'preview_click', 'preview_type', 'preview_snap', 'generate_image', 'remember',
  'mcp', 'done'
])

export function parseAction(reply: string): ParsedAction | { error: string } {
  /* This protocol is plain text precisely so weak and local models can drive it — so the parser has
   * to accept how those models actually write, not only the clean form.
   *
   * Two shapes were rejected outright, and both are common enough to make small models unusable:
   *
   *   "...I'll explore the project root to understand the layout.ACTION list_files"
   *   "<tool_call> ACTION list_files"
   *
   * The first glues the line onto the end of a sentence; the second wraps it in the tool-call tag
   * that natively tool-calling models are trained to emit. `^` with /m matched neither, so the agent
   * answered "No ACTION line found", the model produced the same shape again, and the Loop Breaker
   * halted the run — observed against a free model on a plain "describe the project".
   *
   * A properly placed line still wins: the tolerant pass runs only when no well-formed line exists,
   * and accepts only a KNOWN tool name, so prose that merely mentions an action in passing cannot be
   * executed by accident. */
  /* Natively tool-calling models do not merely WRAP the action in <tool_call> — they emit their
   * whole argument encoding around it:
   *
   *   <tool_call>ACTION
   *   write<arg_key>path</arg_key>
   *   <arg_value>README.md</arg_value></tool_call>
   *
   * Stripping only the outer tag left `<arg_key>path</arg_key><arg_value>README.md</arg_value>` as
   * the PATH. `fs-service` then honoured the slashes inside `</arg_key>` and built a directory tree
   * out of XML fragments — folders literally named `<arg_key>path<`. Observed against OpenCode Zen
   * on 2026-09-01. So: unwrap the argument encoding too, and rejoin a tool name that landed on the
   * line after a bare `ACTION`, which the same models do constantly. */
  const cleaned = reply
    .replace(/<\/?tool_call>/gi, ' ')
    .replace(/<arg_key>[\s\S]*?<\/arg_key>/gi, ' ')
    .replace(/<arg_value>([\s\S]*?)<\/arg_value>/gi, '$1')
    // `ACTION\n write foo` -> `ACTION write foo`
    .replace(/^([ \t]*ACTION)[ \t]*\r?\n[ \t]*(?=[a-z_]+)/gim, '$1 ')
    /* …and `ACTION write\nREADME.md` -> `ACTION write README.md`, because unwrapping
     * <arg_value> leaves the path on its own line. Deliberately narrow: the next line must be a
     * SINGLE whitespace-free token, so ordinary prose (which has spaces) and a ``` fence (which
     * starts with a backtick) can never be mistaken for an argument. */
    .replace(/^([ \t]*ACTION[ \t]+[a-z_]+)[ \t]*\r?\n[ \t]*([^\s`][^\s]*)[ \t]*$/gim, '$1 $2')
  let m: RegExpMatchArray | null = null
  for (const cand of cleaned.matchAll(/^[ \t]*ACTION[ \t]+([a-z_]+)[ \t]*(.*)$/gm)) {
    if (ACTION_TOOLS.has(cand[1])) { m = cand; break }
  }
  if (!m) {
    for (const cand of cleaned.matchAll(/ACTION[ \t]+([a-z_]+)[ \t]*([^\n]*)/g)) {
      if (ACTION_TOOLS.has(cand[1])) { m = cand; break }
    }
  }
  if (!m) return { error: 'No ACTION line found.' }
  const preamble = cleaned.slice(0, m.index).trim()
  const tool = m[1]
  const arg = (m[2] ?? '').trim()
  const rest = cleaned.slice((m.index ?? 0) + m[0].length)

  if (tool === 'write') {
    /* A path is never allowed to contain angle brackets. This is the belt to the unwrapping above:
     * if some other model invents a different markup we have not seen, the run is REFUSED with a
     * message the model can act on, instead of silently creating a folder tree named after it.
     * Refusing is right even though it costs a turn — a junk tree is far more expensive to undo. */
    if (/[<>]/.test(arg)) {
      return {
        error:
          'The file path contains markup. Write the ACTION as plain text — `ACTION write src/App.tsx` — with no tool-call tags or argument wrappers, then the fenced file contents.'
      }
    }
    const fence = rest.match(/```[a-zA-Z0-9]*\r?\n([\s\S]*?)\r?\n```/)
    if (!fence) return { error: 'ACTION write must be followed by a ``` fenced block with the complete file.' }
    return { preamble, tool, arg, body: fence[1] }
  }
  if (tool === 'mcp') {
    // Arguments may be inline JSON or a fenced block, because models reliably do both.
    const fence = rest.match(/```[a-zA-Z0-9]*\r?\n([\s\S]*?)\r?\n```/)
    return { preamble, tool, arg, body: fence ? fence[1] : undefined }
  }
  if (tool === 'done') return { preamble, tool, arg: '', body: (arg + '\n' + rest).trim() }
  return { preamble, tool, arg }
}

// ---------------------------------------------------------------- the loop

export async function startAgent(req: AgentRunRequest, emit: (ev: AgentEvent) => void, pm?: ProcessManager): Promise<{ ok: boolean; error?: string; queued?: boolean }> {
  if (running) {
    // Background agents: queue it — it starts the moment the current run ends.
    // Only within the SAME project, so a queued run can't drain and stage into a
    // different project while this one's edits are still pending (shared staged Map).
    if (req.projectPath !== activeProject) {
      return { ok: false, error: "Another project's task is still running — finish or cancel it before starting one here." }
    }
    queue.push({ req, emit, pm })
    emit({ runId: runCounter + 1, type: 'queued', position: queue.length })
    return { ok: true, queued: true }
  }
  const providerId = req.provider || 'atomic'
  if (!getProvider(providerId)) {
    // Don't strand runs queued behind this one — hand off to the next.
    drainQueue()
    return { ok: false, error: `Unknown provider: ${providerId}` }
  }

  running = true
  cancelled = false
  readThisRun.clear() // Confidence Meter: fresh "files read" ledger per run
  receiptFiles.clear() // the receipt describes THIS run and nothing before it
  lastSnapshot = null // the receipt's screenshot belongs to THIS run, never a previous one
  const runId = ++runCounter

  emit({ runId, type: 'started', instruction: req.instruction })
  const project = req.projectPath
  activeProject = project
  // Multi-Agent Board: record this run as the live task.
  activeTask = { runId, instruction: req.instruction, projectPath: project, mode: req.mode, status: 'running', turns: 0, stagedCount: 0, startedAt: Date.now() }
  /* Only APPROVED connector tools are described to the model, and only when some exist. Every tool
     listed here costs prompt tokens on every turn of every run, so an un-capped list would quietly
     make the agent both dumber and more expensive — the approval gate doubles as the budget.
     Computed HERE, deliberately: everything above sets `running`/`activeProject`/`activeTask`
     synchronously, and an await placed inside that meant a second start() arriving mid-await saw a
     run in progress but no project recorded — so it was REFUSED instead of queued. */
  const approvedTools = await mcp.agentTools()
  const connectorPrompt = approvedTools.length
    ? [
        'You also have connector tools the user has approved. Call one with:',
        'ACTION mcp <connector>.<tool> {"arg": "value"}',
        'Available:',
        ...approvedTools.map((a) => `- ${a.id}.${a.tool.name} — ${a.tool.description || 'no description provided'}`),
        'Only these exist. Never guess a tool name, and never claim you used one you did not.'
      ].join('\n')
    : ''

  // Team Brain: detect house style ONCE per run (file I/O) and prepend it to the
  // SYSTEM field so it survives transcript trimming every turn. '' when unclear.
  const houseStyle = houseStylePrompt(project)
  // Project Decisions: the project's remembered choices, injected so the agent
  // respects them. Computed once per run; '' when there are none.
  const decisions = decisionsPrompt(project)
  /* Project Memory: what this project has already established, retrieved for THIS task rather than
     dumped. Budgeted inside memory.ts — an unbounded memory would quietly make every run slower,
     costlier and less accurate. Empty string when there is nothing worth saying, so the
     .filter(Boolean) below drops it exactly like house style and decisions. */
  const memories = memoryPrompt(project, req.instruction)

  const modeLine = `MODE: ${req.mode === 'plan' ? 'PLAN — read and propose only; write is disabled' : 'BUILD — writes apply to disk immediately (Undo available); no user approval needed'}`
  /* Everything the receipt is built from is captured HERE, at the start, because a receipt
     assembled from whatever happens to be lying around at the end is not evidence. The restore
     point's id is the receipt's undo button; the usage snapshot makes "tokens this run" a
     difference rather than a session total. */
  const receiptStartedAt = Date.now()
  const usageAtStart = getUsage()
  const rollbackId = req.mode === 'build' ? checkpoint(`Before: ${req.instruction.slice(0, 60)}`) : null
  // Loop Breaker: halt when the SAME non-progressing step repeats. Signature-based
  // so it catches failing runs ("exit code: 1"), refused writes, and unparseable
  // replies — and never trips on a successful read whose content starts "ERROR:".
  let stuckSig = ''
  let stuckCount = 0
  const tripped = (sig: string | null): boolean => {
    if (!sig) {
      stuckSig = ''
      stuckCount = 0
      return false
    }
    if (sig === stuckSig) stuckCount++
    else {
      stuckSig = sig
      stuckCount = 1
    }
    if (stuckCount >= 3) {
      if (activeTask) {
        activeTask.status = 'stopped'
        activeTask.error = 'Got stuck repeating the same step.'
      }
      emit({ runId, type: 'error', error: 'The agent got stuck repeating the same step, so I stopped. Use ↩ Undo or restore your last checkpoint in Changes.' })
      return true
    }
    return false
  }
  if (req.newChat || !session || session.project !== project) {
    // Fresh conversation: seed with mode + goal + project tree + symbol index,
    // so turn 1 is never blind — even across files.
    const symbols = buildSymbolIndex(project)
    session = {
      project,
      messages: [
        {
          role: 'user',
          content:
            `${modeLine}\nGOAL: ${req.instruction}\n\nPROJECT FILES:\n${toolListFiles(project)}` +
            (symbols ? `\n\nPROJECT SYMBOLS (file: names):\n${symbols}` : '')
        }
      ]
    }
  } else {
    // Follow-up in the same conversation: the model keeps everything it learned.
    session.messages.push({ role: 'user', content: `${modeLine}\nFOLLOW-UP GOAL: ${req.instruction}` })
  }
  const messages = session.messages
  // Bound the transcript: keep the seed (tree + first goal) and the newest exchanges.
  if (messages.length > MAX_SESSION_MESSAGES) {
    messages.splice(1, messages.length - MAX_SESSION_MESSAGES)
    // Preserve user/assistant alternation after the cut (Anthropic requires it).
    while (messages.length > 1 && messages[1].role !== 'assistant') messages.splice(1, 1)
  }

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (activeTask) activeTask.turns = turn
      if (cancelled) {
        if (activeTask) activeTask.status = 'cancelled'
        emit({ runId, type: 'error', error: 'Cancelled.' })
        return { ok: true }
      }

      const res = await complete({
        providerId,
        model: req.model,
        apiKey: apiKeyFor(providerId),
        system: [houseStyle, decisions, memories, SYSTEM_PROMPT, connectorPrompt].filter(Boolean).join('\n\n'),
        messages
      })
      if (!res.ok || !res.text) {
        if (activeTask) {
          activeTask.status = 'error'
          activeTask.error = res.error ?? 'The model returned nothing.'
        }
        emit({ runId, type: 'error', error: res.error ?? 'The model returned nothing.' })
        return { ok: true }
      }
      messages.push({ role: 'assistant', content: res.text })

      const parsed = parseAction(res.text)
      if ('error' in parsed) {
        // Show the model's prose (often a direct answer), then nudge the protocol.
        emit({ runId, type: 'assistant', text: res.text.trim() })
        if (tripped('parse')) return { ok: true } // repeated unparseable replies = stuck
        messages.push({ role: 'user', content: `RESULT:\nERROR: ${parsed.error} Reply with exactly one ACTION.` })
        continue
      }

      if (parsed.preamble) emit({ runId, type: 'assistant', text: parsed.preamble })

      let observation: string
      let readOk = true // did a read_file genuinely succeed? (content may start "ERROR:")
      switch (parsed.tool) {
        case 'list_files':
          observation = toolListFiles(project)
          emit({ runId, type: 'tool', tool: 'list_files', detail: 'project tree', ok: true })
          break
        case 'read_file': {
          const r = toolReadFile(project, parsed.arg)
          observation = r.text
          readOk = r.ok
          // Confidence Meter: only a genuine read of the ACTUAL file counts as
          // "read before write" — reading back the agent's own staged draft does not.
          if (r.ok && !r.fromStaged) readThisRun.add(parsed.arg)
          emit({ runId, type: 'tool', tool: 'read_file', detail: parsed.arg, ok: r.ok })
          break
        }
        case 'search':
          observation = toolSearch(project, parsed.arg)
          emit({ runId, type: 'tool', tool: 'search', detail: parsed.arg, ok: true })
          break
        case 'symbols':
          observation = findSymbol(project, parsed.arg)
          emit({ runId, type: 'tool', tool: 'symbols', detail: parsed.arg, ok: !observation.startsWith('No symbol') })
          break
        case 'run':
          emit({ runId, type: 'tool', tool: 'run', detail: parsed.arg, ok: true })
          observation = await toolRun(project, parsed.arg, emit, runId)
          break
        case 'run_preview': {
          const r = await toolRunPreview(project, pm)
          emit({ runId, type: 'tool', tool: 'run_preview', detail: r.slice(0, 120), ok: !r.startsWith('ERROR') })
          observation = r
          break
        }
        case 'remember': {
          const sp = parsed.arg.indexOf(' ')
          const kind = sp === -1 ? parsed.arg : parsed.arg.slice(0, sp)
          const text = sp === -1 ? '' : parsed.arg.slice(sp + 1)
          if (!memoryIsKind(kind) || !text.trim()) {
            observation = 'ERROR: use ACTION remember <kind> <text>, where kind is one of goal, decision, convention, design-rule, business-rule, bug, debt, file, preference, forbidden, pending, idea.'
            emit({ runId, type: 'tool', tool: 'remember', detail: parsed.arg.slice(0, 80), ok: false })
            break
          }
          const saved = remember(project, { kind, text, source: 'agent', runId })
          observation = saved ? `Remembered (${kind}). It will be loaded automatically next time.` : 'ERROR: nothing to remember.'
          emit({ runId, type: 'tool', tool: 'remember', detail: `${kind}: ${text.slice(0, 60)}`, ok: !!saved })
          break
        }

        /* Connector tools. The refusal path matters more than the success path: mcp.callTool only
           runs what the user approved, so an un-approved tool comes back as an observation the
           model can act on ("ask them to approve it") rather than silently doing nothing. */
        case 'mcp': {
          const dot = parsed.arg.indexOf('.')
          const space = parsed.arg.indexOf(' ')
          const head = space === -1 ? parsed.arg : parsed.arg.slice(0, space)
          const rawArgs = (space === -1 ? '' : parsed.arg.slice(space + 1)).trim() || parsed.body?.trim() || '{}'
          if (dot <= 0 || dot > head.length) {
            observation = 'ERROR: use ACTION mcp <connector>.<tool> {json}'
            emit({ runId, type: 'tool', tool: 'mcp', detail: parsed.arg.slice(0, 80), ok: false })
            break
          }
          const server = head.slice(0, dot)
          const toolName = head.slice(dot + 1)
          let args: Record<string, unknown> = {}
          try {
            args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {}
          } catch {
            observation = `ERROR: the arguments after ${server}.${toolName} must be valid JSON.`
            emit({ runId, type: 'tool', tool: 'mcp', detail: `${server}.${toolName} (bad JSON)`, ok: false })
            break
          }
          const r = await mcp.callTool(server, toolName, args)
          observation = r.ok ? r.text || '(the tool returned nothing)' : `ERROR: ${r.error}`
          emit({ runId, type: 'tool', tool: 'mcp', detail: `${server}.${toolName}`, ok: r.ok })
          break
        }

        /* Using the app it just built. A failed interaction is reported as a failure — "I clicked it"
           when no such element exists is exactly the false claim this product refuses to make. */
        case 'preview_click':
        case 'preview_type':
        case 'preview_snap': {
          const action = parsed.tool === 'preview_click' ? 'click' : parsed.tool === 'preview_type' ? 'type' : 'snap'
          // preview_type takes "<target> <text to type>"; the target never contains a space.
          const sp = parsed.arg.indexOf(' ')
          const target = action === 'type' && sp > 0 ? parsed.arg.slice(0, sp) : parsed.arg
          const typed = action === 'type' && sp > 0 ? parsed.arg.slice(sp + 1) : undefined
          const r = await previewctl.request(action, target, typed)
          observation = r.ok ? r.text || 'Done.' : `ERROR: ${r.error}`
          if (r.ok && r.dataUrl) lastSnapshot = r.dataUrl
          emit({ runId, type: 'tool', tool: parsed.tool, detail: (target || 'screenshot').slice(0, 80), ok: r.ok })
          break
        }
        case 'stop_preview': {
          if (!pm) {
            observation = 'ERROR: preview control is unavailable in this context.'
          } else {
            pm.stop()
            observation = 'Preview stopped.'
          }
          emit({ runId, type: 'tool', tool: 'stop_preview', detail: observation, ok: true })
          break
        }
        case 'generate_image': {
          /* Real artwork instead of a grey placeholder box — but this is the one tool that spends the
             user's money without them pressing anything, so it is fenced on four sides:
               • images only (video costs dollars and takes minutes — that stays a deliberate click),
               • refused in PLAN mode like every other write,
               • the provider/key/air-gap/budget checks all live inside media.generate(),
               • and the cost is reported back in the observation, so the agent's own summary can say
                 what it spent rather than quietly burning credit. */
          if (req.mode === 'plan') {
            observation = 'REFUSED: you are in PLAN mode. Describe the image you would create and finish with ACTION done.'
            emit({ runId, type: 'tool', tool: 'generate_image', detail: 'blocked: plan mode', ok: false })
            break
          }
          const spec = parseImageSpec(parsed.arg)
          if (!spec.prompt) {
            observation = 'ERROR: generate_image needs a description, e.g. ACTION generate_image a calm blue clinic reception, wide'
            emit({ runId, type: 'tool', tool: 'generate_image', detail: 'no description', ok: false })
            break
          }
          emit({ runId, type: 'tool', tool: 'generate_image', detail: spec.prompt.slice(0, 80), ok: true })
          const gen = await mediaGenerate({
            projectPath: project,
            kind: 'image',
            providerId: spec.providerId,
            model: spec.model,
            prompt: spec.prompt,
            ...(spec.size ? { size: spec.size } : {})
          })
          if (!gen.ok || !gen.receipt) {
            observation = `ERROR: ${gen.error ?? 'the image could not be created.'}`
            emit({ runId, type: 'tool', tool: 'generate_image', detail: gen.error ?? 'failed', ok: false })
          } else {
            const r = gen.receipt
            // Counted as a real artifact of this run so the Build Receipt's byte totals stay honest.
            noteGeneratedFile(r.file, r.bytes)
            observation = `Created ${r.file} (${Math.round(r.bytes / 1024)} KB, ${r.providerLabel} ${r.model}${
              r.approxUsd !== null ? `, about $${r.approxUsd.toFixed(3)} of the user's own credit` : ''
            }). Reference it from code by this path.`
            emit({ runId, type: 'tool', tool: 'generate_image', detail: r.file, ok: true })
          }
          break
        }
        case 'write': {
          if (req.mode === 'plan') {
            observation = 'REFUSED: you are in PLAN mode. Describe the proposed change in plain English and finish with ACTION done.'
            emit({ runId, type: 'tool', tool: 'write', detail: `${parsed.arg} (blocked: plan mode)`, ok: false })
            break
          }
          const stagedRes = stageWrite(project, parsed.arg, parsed.body ?? '', req.instruction, res.model ?? providerId)
          if ('error' in stagedRes) {
            observation = `ERROR: ${stagedRes.error}`
            emit({ runId, type: 'tool', tool: 'write', detail: `${parsed.arg} — ${stagedRes.error}`, ok: false })
          } else {
            emit({ runId, type: 'staged', edit: stagedRes })
            emit({ runId, type: 'tool', tool: 'write', detail: `${parsed.arg} (+${stagedRes.added} −${stagedRes.removed})`, ok: true })
            // Secret Handling Protocol keeps the one real exception: a likely hardcoded key/password
            // stays staged for the user to see instead of landing on disk unseen. Everything else —
            // the vast majority of writes — auto-applies with no approval step (see modeLine above).
            const secretGuard = scanEditSecrets(staged.get(stagedRes.id)!)
            if (secretGuard) {
              observation = `Staged but NOT applied: ${parsed.arg} looks like it contains a real secret (${secretGuard.message}). Remove the hardcoded value (use an env var / config instead) and write it again, or tell the user this file needs their review.`
              break
            }
            // Build mode has no approval step — apply right now, synchronously, so the file is
            // genuinely on disk before the agent's NEXT tool call (e.g. `run`) reaches it. Real bug
            // this fixes: the agent used to write, immediately try to run, and the run would fail
            // because nothing was on disk yet — then it would (correctly, at the time) tell the user
            // the file was "still staged", which read as a broken permission wall.
            const beforeBytes = fileBytes(project, parsed.arg)
            const applyRes = await applyStaged([stagedRes.id])
            const v = applyRes.verify.find((r) => r.path === parsed.arg)
            if (applyRes.ok) {
              const prior = receiptFiles.get(parsed.arg)
              receiptFiles.set(parsed.arg, {
                path: parsed.arg,
                added: (prior?.added ?? 0) + stagedRes.added,
                removed: (prior?.removed ?? 0) + stagedRes.removed,
                // Across the whole run: the first write's "before" is the size that counts.
                bytesDelta: (prior ? prior.bytesDelta : 0) + (fileBytes(project, parsed.arg) - beforeBytes),
                verified: v ? v.ok : undefined,
                error: v && !v.ok ? v.error : undefined
              })
            }
            emit({ runId, type: 'applied', edit: stagedRes, verify: v })
            observation = !applyRes.ok
              ? `ERROR applying ${parsed.arg}: ${applyRes.error}`
              : v && !v.ok
                ? `Applied to disk: ${parsed.arg} (+${stagedRes.added} −${stagedRes.removed}). Syntax check FAILED: ${v.error}. Fix it before continuing.`
                : `Applied to disk: ${parsed.arg} (+${stagedRes.added} −${stagedRes.removed}). It is really there now — you can run it. Continue, or use ACTION done if finished.`
          }
          break
        }
        case 'done':
          if (activeTask) {
            activeTask.status = 'done'
            activeTask.summary = parsed.body || 'Done.'
          }
          /* The receipt: if the agent actually used the app during this run, the screenshot goes
             out with the summary. Competitors narrate what they did; this shows it running. */
          /* Auto-capture: what this run concluded becomes part of the project's memory, tagged to
             the run that produced it so any claim can be traced back to what actually happened. */
          if (parsed.body && parsed.body.trim().length > 20) {
            remember(project, { kind: 'ai-decision', text: parsed.body.trim(), source: 'agent', runId })
          }
          emit({
            runId,
            type: 'done',
            summary: parsed.body || 'Done.',
            turns: turn,
            snapshot: lastSnapshot ?? undefined,
            receipt: buildReceipt({
              runId,
              instruction: req.instruction,
              summary: parsed.body || 'Done.',
              startedAt: receiptStartedAt,
              rollbackId,
              usageAtStart,
              project,
              snapshot: lastSnapshot
            })
          })
          return { ok: true }
        default:
          observation = `ERROR: unknown action "${parsed.tool}".`
      }

      // Loop Breaker: a step is "stuck" only when it made no progress and can
      // repeat — a failing run (nonzero exit), a refused/failed write, a missing
      // read/symbol, or an unknown action. Successful reads/searches reset it.
      const stuck =
        parsed.tool === 'run'
          ? // Anchor to ^ — the observation ALWAYS begins "exit code: N"; without
            // the anchor a failing run whose OUTPUT text contains "exit code: 0"
            // would wrongly read as success and reset the breaker.
            /^exit code:\s*0\b/.test(observation)
            ? null
            : `run|${parsed.arg}`
          : parsed.tool === 'read_file'
            ? readOk
              ? null
              : `read|${parsed.arg}`
            : parsed.tool === 'write'
              ? observation.startsWith('ERROR:') || observation.startsWith('REFUSED:')
                ? `write|${parsed.arg}`
                : null
              : parsed.tool === 'symbols'
                ? observation.startsWith('No symbol')
                  ? `symbols|${parsed.arg}`
                  : null
                : observation.startsWith('ERROR:')
                  ? `err|${parsed.tool}`
                  : null
      if (tripped(stuck)) return { ok: true }
      messages.push({ role: 'user', content: `RESULT:\n${observation}` })
    }

    if (activeTask) {
      activeTask.status = 'stopped'
      activeTask.error = `Stopped after ${MAX_TURNS} steps without finishing.`
    }
    emit({ runId, type: 'error', error: `Stopped after ${MAX_TURNS} steps without finishing. Staged edits (if any) are ready for review.` })
    return { ok: true }
  } finally {
    running = false
    activeKill = null
    // Multi-Agent Board: retire the live task into the finished ring (any exit
    // path that didn't set a terminal status is treated as 'stopped').
    if (activeTask) {
      if (activeTask.status === 'running') activeTask.status = 'stopped'
      activeTask.stagedCount = staged.size
      activeTask.endedAt = Date.now()
      finishedRuns.push(activeTask)
      while (finishedRuns.length > MAX_FINISHED) finishedRuns.shift()
      activeTask = null
    }
    if (!queue.length) activeProject = '' // queue empty → no project is "active"
    drainQueue()
  }
}
