import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { readFileSync } from 'node:fs'
import { join, resolve, sep, isAbsolute, dirname } from 'node:path'
import { classifyScript, classifyFileBody, type ScriptVerdict } from '../shared/scriptrisk'
import type { LogLine } from '../shared/types'

/**
 * Spawn-based command runner shared by the Terminal panel and the agent's
 * `run` tool. Streams merged stdout/stderr lines, enforces a timeout, and
 * supports kill. Deliberately not a PTY: no native deps, no interactive TUIs —
 * commands run to completion, which is all the agent and a non-coder need.
 */

export interface RunHandle {
  /** Resolves with the exit summary; never rejects. */
  done: Promise<{ code: number | null; output: string; timedOut: boolean; error?: string; truncated: boolean }>
  kill: () => void
}

const MAX_CAPTURE = 20_000 // chars of output kept for the agent / result

/**
 * Which END of a long output to keep when it overflows MAX_CAPTURE.
 * 'tail' (default) is right for a build/test run — the error is at the bottom.
 * 'head' is right for anything NEWEST-FIRST, above all `git log`: keeping the tail there silently
 * discards the RECENT commits and leaves only ancient history, so a "busiest files" ranking would be
 * computed from the oldest 20 KB of the repo. Callers that scan a log must ask for 'head'.
 */
export interface CaptureOpts {
  keep?: 'head' | 'tail'
  max?: number
}

export function execStream(
  command: string,
  cwd: string,
  onLine: (line: LogLine) => void,
  timeoutMs = 180_000,
  capOpts?: CaptureOpts,
  /**
   * Extra environment for the child. Callers MUST use this instead of prefixing `VAR=value ` onto the
   * command string: that is POSIX shell syntax, and on Windows cmd.exe it is parsed as the name of a
   * program to run, so every such command fails outright.
   */
  extraEnv?: Record<string, string>
): RunHandle {
  let child: ChildProcess
  try {
    child = spawn(command, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1', ...extraEnv } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    onLine({ stream: 'system', text: `failed to start: ${msg}`, ts: Date.now() })
    return {
      done: Promise.resolve({ code: null, output: '', timedOut: false, error: msg, truncated: false }),
      kill: () => {}
    }
  }
  return attach(child, onLine, timeoutMs, capOpts)
}

/**
 * The same runner, given an ARGV ARRAY and no shell.
 *
 * Use this whenever any part of the command line comes from configuration, a server, or a user: a
 * host, a username, a port, a path, a key. `execStream` runs through a shell, and a shell expands
 * `$(...)`, backticks and `$VAR` inside double quotes — so `JSON.stringify(host)` is NOT an escape,
 * it is a way to feel safe while still executing whatever the host string contains. This codebase
 * has already had to fix that exact bug twice. An argv array has no parser to fool: every element
 * arrives at the child as one word, whatever is in it.
 *
 * `stdin`, when given, is written and the pipe closed — which is why `remote.ts` no longer has to
 * build a `printf '%s' '…' | ssh …` pipeline just to send a file's contents.
 */
export function spawnStream(
  file: string,
  args: string[],
  cwd: string,
  onLine: (line: LogLine) => void,
  timeoutMs = 180_000,
  capOpts?: CaptureOpts,
  extraEnv?: Record<string, string>,
  stdin?: string
): RunHandle {
  let child: ChildProcess
  try {
    child = spawn(file, args, {
      cwd,
      shell: false,
      env: { ...process.env, FORCE_COLOR: '0', CI: '1', ...extraEnv }
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    onLine({ stream: 'system', text: `failed to start: ${msg}`, ts: Date.now() })
    return {
      done: Promise.resolve({ code: null, output: '', timedOut: false, error: msg, truncated: false }),
      kill: () => {}
    }
  }
  if (stdin !== undefined) {
    // A child that exits before reading stdin makes the write fail with EPIPE. That is a normal
    // race, not an error worth surfacing — the exit code already says what happened.
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  }
  return attach(child, onLine, timeoutMs, capOpts)
}

/** Streaming, capture, timeout and exit handling — shared by both spawners above. */
function attach(
  child: ChildProcess,
  onLine: (line: LogLine) => void,
  timeoutMs: number,
  capOpts?: CaptureOpts
): RunHandle {
  let captured = ''
  let truncated = false
  let timedOut = false
  const capMax = capOpts?.max ?? MAX_CAPTURE
  const keepHead = capOpts?.keep === 'head'
  // One decoder PER STREAM, not `chunk.toString()`: a multi-byte UTF-8 character split across two
  // pipe chunks decodes as U+FFFD when each chunk is converted alone. On a `git status -z` of a
  // large tree that turned `café.ts` into `caf�.ts` for whichever row straddled the 64 KB boundary
  // — a filename that then could not be staged, diffed or opened. Found 2026-09-02.
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const text = decoders[stream].write(chunk)
    // 'head' stops appending once full (keeps the FIRST/newest output); 'tail' keeps the last chunk.
    if (keepHead) {
      if (captured.length + text.length > capMax) truncated = true
      if (captured.length < capMax) captured = (captured + text).slice(0, capMax)
    } else {
      if (captured.length + text.length > capMax) truncated = true
      captured = (captured + text).slice(-capMax)
    }
    for (const line of text.split('\n')) {
      if (line.trim() !== '') onLine({ stream, text: line, ts: Date.now() })
    }
  }
  child.stdout?.on('data', capture('stdout'))
  child.stderr?.on('data', capture('stderr'))

  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)

  const done = new Promise<{ code: number | null; output: string; timedOut: boolean; error?: string; truncated: boolean }>(
    (resolve) => {
      child.on('error', (err) => {
        clearTimeout(timer)
        onLine({ stream: 'system', text: `error: ${err.message}`, ts: Date.now() })
        resolve({ code: null, output: captured, timedOut, error: err.message, truncated })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        onLine({
          stream: 'system',
          text: timedOut ? `⏱ timed out after ${timeoutMs / 1000}s` : `exit ${code ?? '?'}`,
          ts: Date.now()
        })
        resolve({ code, output: captured, timedOut, truncated })
      })
    }
  )

  return { done, kill: () => child.kill('SIGKILL') }
}

/**
 * Commands the agent may run WITHOUT asking: read-only inspection and the
 * project's own build/test scripts. Everything else is refused and surfaced to
 * the user instead — the anti-"rogue agent" stance (see ROADMAP wedge #2).
 */
// Package-specifier charset for installer args (name, @scope/name, name@version, -D/--save-dev flags).
// Deliberately excludes $ ` ( ) and quotes — the same injection-safe discipline every other pattern
// below already uses — so `npm install $(evil)` cannot slip through as an "install" command.
const PKG_ARG = String.raw`[\w@/.:^~*=+-]+`

const AGENT_SAFE = [
  /^ls(\s|$)/,
  /^git (status|diff|log)(\s|$)/,
  /^npm (test|ci)(\s|$)/,
  /^npm run [\w:.-]+$/,
  // Installing dependencies is routine setup, not a destructive action — the same trust level `npm ci`
  // (which already deletes+reinstalls node_modules) already has. Covers `npm install`, `npm i <pkg>`,
  // scoped/versioned packages, and common flags (-D, --save-dev, --legacy-peer-deps, …).
  new RegExp(`^npm (install|i)(\\s+${PKG_ARG})*$`),
  new RegExp(`^yarn(\\s+(install|add)(\\s+${PKG_ARG})*)?$`),
  new RegExp(`^pnpm (install|i|add)(\\s+${PKG_ARG})*$`),
  new RegExp(`^bun (install|i|add)(\\s+${PKG_ARG})*$`),
  new RegExp(`^pip3? install(\\s+${PKG_ARG})*$`),
  new RegExp(`^poetry (install|add)(\\s+${PKG_ARG})*$`),
  /^npx tsc(\s|$)/,
  /^tsc(\s|$)/,
  // `node <file> <args>`: the file path is bare word/path chars; each arg after it may be a bare
  // word OR a "quoted string"/'quoted string' — real bug this fixes: `node tasks.js add "Buy milk"`
  // was blocked outright because the old pattern allowed no punctuation at all, quotes included.
  // Quoted content still excludes $ ` \ so command substitution can't hide inside the quotes, and
  // isAgentSafeCommand() above already refuses &&/||/;/|/> before this list is even checked.
  new RegExp(`^node [\\w./-]+(\\s+(?:"[^"$\`\\\\]*"|'[^'$\`\\\\]*'|[\\w./=,:@-]+))*$`)
]

export function isAgentSafeCommand(command: string): boolean {
  const c = command.trim()
  if (c.includes('&&') || c.includes('||') || c.includes(';') || c.includes('|') || c.includes('>'))
    return false
  return AGENT_SAFE.some((re) => re.test(c))
}

/**
 * `npm run <script>` is on the safe list because a project's own shortcuts are USUALLY build/test
 * chores — but on a real project one of them is `deploy` or `db:reset`, and neither this app nor its
 * Undo can take those back. Read the script body before running it.
 *
 * Returns null when the command isn't an `npm run` (nothing to look up), so the caller's existing
 * safe-list check stays the only other gate.
 */
export function scriptVerdictFor(root: string, command: string): ScriptVerdict | null {
  const cmd = command.trim()

  // `node <file>` is ALSO on the safe list, and a deploy.js at the project root is completely ordinary —
  // so the promise "the AI can't run your deploy script" would be hollow if we only inspected npm
  // scripts. Take argv[0] (the old end-anchored regex let `node deploy.js --now` slip past entirely).
  // First NON-FLAG token after `node` — `node --enable-source-maps deploy.js` must still be vetted.
  const nodeArg = /^node(\s|$)/.test(cmd) ? cmd.split(/\s+/).slice(1).find((t) => !t.startsWith('-')) : undefined
  if (nodeArg) {
    try {
      const abs = isAbsolute(nodeArg) ? resolve(nodeArg) : resolve(root, nodeArg)
      if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) {
        // Outside the opened project: we cannot vet it, so we must not wave it through.
        return { risk: 'unknown', chain: [nodeArg], matched: nodeArg, why: 'this runs a file outside your project, which I cannot check', byNameOnly: false }
      }
      const src = readFileSync(abs, 'utf8').slice(0, 200_000)
      return classifyFileBody(nodeArg, src)
    } catch {
      return null // not a real file — `node` will fail on its own
    }
  }

  // npm's LIFECYCLE aliases run project scripts without the word "run": `npm test` runs the `test`
  // script (plus pre/post), and `npm ci` runs the install hooks. Both are on the agent safe list, so
  // skipping them here would leave the documented "a test script that resets the DB" case wide open.
  const alias = /^npm\s+(test|t|ci|install|i)(\s|$)/.exec(cmd)
  const names = alias ? (/^(test|t)$/.test(alias[1]) ? ['test'] : ['preinstall', 'install', 'postinstall', 'prepare']) : null

  const m = /^(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)$|^(?:yarn|pnpm|bun)\s+(?!run\b|add\b|install\b|remove\b)([\w:.-]+)$/.exec(cmd)
  const single = m?.[1] || m?.[2]
  if (!names && !single) return null

  const scripts = readScripts(root)
  const targets = names ?? [single as string]
  // Let the fold READ a file a script hands off to, confined to the project. Without this every
  // ordinary `node scripts/build.js` would be refused as unreadable.
  const readFile = (rel: string): string | null => {
    try {
      const abs = isAbsolute(rel) ? resolve(rel) : resolve(root, rel)
      if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) return null
      return readFileSync(abs, 'utf8').slice(0, 200_000)
    } catch {
      return null
    }
  }
  let worst: ScriptVerdict | null = null
  for (const n of targets) {
    const v = classifyScript(n, scripts, { readFile })
    if (v.risk === 'risky') return v
    if (v.risk === 'unknown' && !worst) worst = v
  }
  return worst ?? { risk: 'safe', chain: targets, matched: null, why: null, byNameOnly: false }
}

/**
 * The scripts map npm would ACTUALLY use. npm walks up to the nearest package.json, so a project opened
 * as a SUBFOLDER (very common here — the demo project lives inside this monorepo) would otherwise be
 * vetted against a package.json that npm never reads. null = unreadable ⇒ classifyScript judges by name.
 */
function readScripts(root: string): Record<string, string> | null {
  let dir = resolve(root)
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
      if (pkg && typeof pkg === 'object') return pkg.scripts ?? {}
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
