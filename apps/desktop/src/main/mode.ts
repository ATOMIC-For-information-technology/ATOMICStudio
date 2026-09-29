import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeMode, DEFAULT_MODE, type StudioMode } from '../shared/mode'

/**
 * Which personality the app wears — Builder or Developer (see `shared/mode.ts`).
 *
 * It lives in the MAIN process, at `<userData>/mode.json`, rather than in the renderer's
 * localStorage, for two reasons: the application menu is built in main and has to hide the same
 * things the window does, and a second window must open in the mode the user is actually using.
 *
 * `STUDIO_MODE=builder` overrides the stored value for a run (tests, demos, a support session).
 * It is an override, not a lock: `setMode` still writes the file, so nothing gets stuck.
 */

function modeFilePath(): string {
  return join(app.getPath('userData'), 'mode.json')
}

let cached: StudioMode | null = null

export function getMode(): StudioMode {
  if (process.env.STUDIO_MODE) return normalizeMode(process.env.STUDIO_MODE)
  if (cached) return cached
  try {
    const p = modeFilePath()
    if (existsSync(p)) {
      cached = normalizeMode((JSON.parse(readFileSync(p, 'utf8')) as { mode?: unknown }).mode)
      return cached
    }
  } catch {
    /* unreadable/malformed → the default full IDE, never a half-hidden window */
  }
  return DEFAULT_MODE
}

/** True when the user has never chosen — drives the one-time, non-blocking invitation. */
export function modeChosen(): boolean {
  try {
    return existsSync(modeFilePath())
  } catch {
    return false
  }
}

/** Persist the choice; returns the EFFECTIVE mode (an env override still wins for this run). */
export function setMode(next: unknown): StudioMode {
  const mode = normalizeMode(next)
  cached = mode
  try {
    writeFileSync(modeFilePath(), JSON.stringify({ mode }), 'utf8')
  } catch {
    /* best-effort persistence — the session still switches */
  }
  return getMode()
}

/** For tests: drop the cache so a fresh file/env is re-read. */
export function resetModeCache(): void {
  cached = null
}
