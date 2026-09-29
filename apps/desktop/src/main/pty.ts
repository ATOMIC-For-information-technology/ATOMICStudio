import { homedir } from 'node:os'
import { platform, env } from 'node:process'
import type { WebContents } from 'electron'
import type { IPty } from 'node-pty'

/**
 * Real terminal sessions, backed by a pseudo-terminal.
 *
 * The old runner spawned each command with `child_process` and streamed its lines. That is fine for
 * "run this and tell me what happened" — which is all the AGENT needs, so `terminal.ts` keeps doing
 * exactly that — but it is not a terminal: programs could see they weren't talking to a TTY, so
 * they disabled colour and interactivity; there was no way to answer a prompt, hit Ctrl-C, or run
 * anything full-screen (vim, top, a git rebase); and every command paid process-spawn latency.
 *
 * A PTY gives the shell a real terminal device: interactive, full-speed, and byte-accurate.
 * `node-pty` is a native module, so it is external to the bundle and rebuilt against Electron's ABI
 * by the `rebuild:native` script.
 */

// Loaded lazily and defensively: a native module that failed to rebuild must degrade to "terminal
// unavailable" with an honest message, never take the whole app down at import time.
let ptyLib: typeof import('node-pty') | null = null
let ptyLoadError: string | null = null
/** True when the module is simply not in this build, as opposed to present-but-broken. */
let ptyMissing = false
function lib(): typeof import('node-pty') | null {
  if (ptyLib || ptyLoadError) return ptyLib
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyLib = require('node-pty') as typeof import('node-pty')
  } catch (e) {
    ptyLoadError = e instanceof Error ? e.message : String(e)
    ptyMissing = /cannot find module|MODULE_NOT_FOUND/i.test(ptyLoadError)
  }
  return ptyLib
}

/**
 * Why there is no terminal, in words the person reading it can act on.
 *
 * The raw failure is `Cannot find module 'node-pty'`, which is true and useless: it does not say
 * whether this is a broken install or a build that never carried the feature, and it does not say
 * what still works. Two genuinely different situations, so two answers:
 *
 *  - **Missing** — the Windows build ships without it on purpose. `node-pty` is a native module with
 *    no Windows prebuilt, and it cannot be compiled from the Mac these builds are made on. Nothing
 *    is broken and nothing the user can do will fix it; they need a build made on Windows.
 *  - **Present but wouldn't load** — usually an Electron ABI mismatch after an upgrade, which
 *    `npm run rebuild:native` does fix. Worth naming, because that one IS actionable.
 */
export function describeNoTerminal(missing: boolean, plat: string, loadError: string | null): string {
  const stillWorks =
    'Everything else works normally — the AI agent still runs commands for you, and Run preview still starts your app.'
  if (missing) {
    return plat === 'win32'
      ? `The built-in terminal is not included in this Windows build. It relies on a component that has to be compiled on Windows, and this build was made on a Mac. ${stillWorks}`
      : `The built-in terminal is not included in this build. ${stillWorks}`
  }
  return `The built-in terminal could not start on this machine. ${stillWorks}\n\nTechnical detail: ${loadError ?? 'node-pty failed to load'}\nA developer can usually fix this with: npm run rebuild:native`
}

function unavailableReason(): string {
  return describeNoTerminal(ptyMissing, process.platform, ptyLoadError)
}

/** Whether a real terminal is available at all — lets the UI hide the "new tab" affordance. */
export function terminalAvailable(): boolean {
  return lib() !== null
}
export function terminalUnavailableReason(): string | null {
  return lib() ? null : unavailableReason()
}

export interface PtySession {
  id: number
  proc: IPty
  /** Everything the session has printed, capped — replayed when a tab is remounted. */
  scrollback: string
}

const sessions = new Map<number, PtySession>()
let nextId = 1

/** Scrollback kept per session. Generous enough for a build log, bounded so a runaway loop
 *  can't grow the main process without limit. */
const MAX_SCROLLBACK = 400_000

/** The user's real login shell, so their prompt, aliases and PATH are the ones they know. */
function defaultShell(): string {
  if (platform === 'win32') return env.COMSPEC || 'powershell.exe'
  return env.SHELL || '/bin/zsh'
}

/**
 * Login+interactive flags matter: without them zsh/bash skip the user's rc files, so the prompt is
 * a bare `%` and none of their aliases exist — the first thing anyone notices as "not my terminal".
 */
function shellArgs(shell: string): string[] {
  if (platform === 'win32') return []
  return /zsh|bash/.test(shell) ? ['-l', '-i'] : []
}

export interface StartResult {
  ok: boolean
  id?: number
  error?: string
}

/**
 * The environment a session starts in.
 *
 * The important part is what is REMOVED. If Studio is launched from a terminal, its own environment
 * carries that terminal's identity — `TERM_PROGRAM`, `TERM_SESSION_ID`, iTerm's variables — and
 * passing those through means every shell we spawn believes it is a tab of the terminal that started
 * us. On macOS that is not cosmetic: `/etc/zshrc` runs Apple's shell-session-save logic when it sees
 * those variables, so our sessions write into another terminal's session-restore state, keyed by an
 * ID they all share. Sessions then print "Restored session:" from someone else's history, and once
 * several have piled onto the same key a new shell can sit there producing nothing at all.
 *
 * So: strip the inherited identity, and say who we actually are — the same thing every other
 * terminal emulator does (VS Code sets TERM_PROGRAM=vscode for exactly this reason).
 */
function sessionEnv(): Record<string, string> {
  const e: Record<string, string> = { ...(env as Record<string, string>) }
  for (const k of [
    'TERM_SESSION_ID',
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'ITERM_SESSION_ID',
    'ITERM_PROFILE',
    'LC_TERMINAL',
    'LC_TERMINAL_VERSION',
    'SHLVL' // let the new shell count from its own beginning
  ]) {
    delete e[k]
  }
  return {
    ...e,
    TERM_PROGRAM: 'ATOMIC Studio',
    // Tells anything that asks that it has a full-colour terminal, and stops pagers from opening a
    // full-screen view the user can't escape inside a small panel.
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    GIT_PAGER: 'cat',
    PAGER: 'cat'
  }
}

export function startSession(cwd: string, cols: number, rows: number, send: (id: number, data: string) => void): StartResult {
  const pty = lib()
  if (!pty) return { ok: false, error: unavailableReason() }
  const shell = defaultShell()
  try {
    const proc = pty.spawn(shell, shellArgs(shell), {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      cwd: cwd || homedir(),
      env: sessionEnv()
    })
    const id = nextId++
    const session: PtySession = { id, proc, scrollback: '' }
    sessions.set(id, session)
    proc.onData((data) => {
      session.scrollback = (session.scrollback + data).slice(-MAX_SCROLLBACK)
      send(id, data)
    })
    /* Say so when the shell goes away. Without this the terminal is just a black rectangle: the
       session is gone, the tab still looks attached, and the user has no way to tell the difference
       between "still starting" and "died on startup". */
    proc.onExit(({ exitCode }) => {
      sessions.delete(id)
      const notice = `\r\n\x1b[90m[the shell exited${exitCode ? ` with code ${exitCode}` : ''} — open a new terminal tab to start another]\x1b[0m\r\n`
      session.scrollback = (session.scrollback + notice).slice(-MAX_SCROLLBACK)
      send(id, notice)
    })
    return { ok: true, id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Keystrokes from the renderer, verbatim — including Ctrl-C, arrows and escape sequences. */
export function write(id: number, data: string): void {
  sessions.get(id)?.proc.write(data)
}

/** The shell only reflows correctly if it's told the new size; without this, resizing the panel
 *  leaves wrapped lines broken until the next command. */
export function resize(id: number, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.resize(Math.max(2, cols), Math.max(1, rows))
  } catch {
    /* the process can exit between the renderer measuring and this call */
  }
}

export function kill(id: number): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.kill()
  } catch {
    /* already gone */
  }
  sessions.delete(id)
}

/** Replayed into xterm when a tab is remounted, so switching tabs doesn't blank the history. */
export function scrollback(id: number): string {
  return sessions.get(id)?.scrollback ?? ''
}

/** Every session dies with the window that owns them — an orphaned shell keeps the app alive. */
export function killAll(): void {
  for (const id of [...sessions.keys()]) kill(id)
}

export function sessionCount(): number {
  return sessions.size
}

/** Wire a session's output to a specific renderer, used by the IPC layer. */
export function senderFor(wc: WebContents, channel: string) {
  return (id: number, data: string): void => {
    if (!wc.isDestroyed()) wc.send(channel, { id, data })
  }
}
