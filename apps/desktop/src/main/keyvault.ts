import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/**
 * Stores the user's AI provider API keys encrypted at rest using the OS keychain
 * (macOS Keychain / Windows DPAPI) via Electron safeStorage. Main-process only —
 * the key never travels to the renderer.
 *
 * ── Why this file distinguishes "empty" from "unreadable" ──────────────────────────────────────────
 * It used to collapse both into `{}`. Live testing on 2026-08-12 walked straight into what that
 * costs. A helper process read the vault under a different app name, so macOS handed it a different
 * Keychain entry and `decryptString` threw — and the swallowed error presented as "no API key set"
 * for keys that were sitting right there. Two consequences, one of them destructive:
 *
 *   1. The UI tells the user to paste a key they already pasted.
 *   2. Far worse: `setApiKey` merges into whatever `readAll()` returned. Merging into `{}` REWRITES
 *      the file with only the newest key, silently destroying every other credential the user had.
 *      So the "just paste it again" that bug 1 provokes is exactly the action that triggers bug 2.
 *
 * A vault that cannot be opened is therefore never treated as an empty one: reads report it, and
 * writes REFUSE rather than overwrite something they could not read.
 */

/** `empty` = nothing saved yet (fine). `unreadable` = there IS a vault and we cannot open it. */
export type VaultStatus = 'ok' | 'empty' | 'unreadable'

const keyFile = (): string => join(app.getPath('userData'), 'atomic-studio-keys.bin')

interface VaultRead {
  status: VaultStatus
  keys: Record<string, string>
}

function readVault(): VaultRead {
  const f = keyFile()
  if (!existsSync(f)) return { status: 'empty', keys: {} }
  try {
    const raw = readFileSync(f)
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
    const parsed = JSON.parse(json) as Record<string, string>
    // A file that decrypts to something that isn't an object is corrupt, not empty.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'unreadable', keys: {} }
    return { status: 'ok', keys: parsed }
  } catch {
    return { status: 'unreadable', keys: {} }
  }
}

/** Whether the saved credentials can be opened at all — surfaced so the UI never says "no key" for a
 *  vault that is merely locked. */
export function vaultStatus(): VaultStatus {
  return readVault().status
}

export interface SaveKeyResult {
  ok: boolean
  error?: string
}

/**
 * Save one credential, preserving the others.
 *
 * Refuses outright when the existing vault cannot be decrypted, because the only way to "merge" into
 * an unreadable vault is to replace it — and that throws away credentials the user still has. Losing
 * a key silently is far worse than being told to fix the problem.
 */
export function setApiKey(provider: string, key: string): SaveKeyResult {
  const current = readVault()
  if (current.status === 'unreadable') {
    return {
      ok: false,
      error:
        'Your saved keys exist but this Mac will not unlock them, so saving now would erase the others. This usually means the app was moved or renamed, or the login keychain is locked. Unlock your keychain and restart Studio — or delete atomic-studio-keys.bin from the app data folder to start the key list fresh.'
    }
  }
  const all = { ...current.keys, [provider]: key }
  try {
    const json = JSON.stringify(all)
    const enc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8')
    writeFileSync(keyFile(), enc)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Studio could not save the key: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export function getApiKey(provider: string): string | null {
  return readVault().keys[provider] ?? null
}

export function hasApiKey(provider: string): boolean {
  return Boolean(getApiKey(provider))
}
