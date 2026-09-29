/** Shared main-process helpers. */
import { app } from 'electron'

/** Normalize any thrown value to a string message. Used in catch blocks. */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * A binary-path override (`STUDIO_DOCKER_BIN` / `STUDIO_SSH_BIN` / `STUDIO_OLLAMA_BIN`)
 * is a TEST affordance for pointing at a fake binary. Honour it ONLY in unpackaged
 * (dev/test) builds — a shipped/packaged app always execs the real docker/ssh/ollama, so
 * a planted env var can never redirect a privileged exec. Fails OPEN to dev behaviour if
 * `app` is unavailable (e.g. a non-Electron context), and reads the env at CALL time so
 * tests that set it after import still take effect.
 */
export function binOverride(envName: string, fallback: string): string {
  let packaged = false
  try {
    packaged = app?.isPackaged === true
  } catch {
    packaged = false
  }
  return pickBin(packaged, process.env[envName], fallback)
}

/** Pure gate behind {@link binOverride} (unit-testable without mocking Electron's `app`):
 * a packaged build always uses the fallback; unpackaged honours the env override if set. */
export function pickBin(packaged: boolean, envVal: string | undefined, fallback: string): string {
  return packaged ? fallback : envVal || fallback
}
