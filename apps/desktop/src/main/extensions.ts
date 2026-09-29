import { app } from 'electron'
import { existsSync, readFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { execStream } from './terminal'
import { audit } from './audit'
import { getAirGap } from './policy'
import * as mcp from './mcp'
import type { ExtensionManifest, InstallResult, RegistryEntry } from '../shared/types'

/**
 * Installing extensions.
 *
 * One install path, three sources — a folder you already have, a GitHub URL, or the curated
 * registry — all landing in `<userData>/extensions/<id>/` with a manifest that says what the thing
 * is. An `mcp` extension registers itself as a connector; an `addon` is the small native format.
 *
 * The honest bit, and the reason the panel says it out loud: **an extension is code that runs on
 * this machine with the user's own permissions.** There is no sandbox that makes `npx some-server`
 * safe, so the product does the two things that actually help — it says so plainly before installing
 * from a URL, and it keeps every tool that extension exposes behind per-tool approval afterwards.
 */

const MANIFEST = 'atomic-extension.json'

export function extensionsDir(): string {
  const dir = join(app.getPath('userData'), 'extensions')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Read + validate a manifest. Returns null (never throws) for anything malformed. */
export function readManifest(dir: string): ExtensionManifest | null {
  try {
    const p = join(dir, MANIFEST)
    if (!existsSync(p)) return null
    const m = JSON.parse(readFileSync(p, 'utf8')) as ExtensionManifest
    if (!m || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(m.id)) return null
    if (m.kind !== 'mcp' && m.kind !== 'addon') return null
    if (m.kind === 'mcp' && typeof m.command !== 'string') return null
    return {
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      version: typeof m.version === 'string' ? m.version : '0.0.0',
      description: typeof m.description === 'string' ? m.description : '',
      kind: m.kind,
      command: m.command,
      args: Array.isArray(m.args) ? m.args.map(String) : [],
      env: m.env && typeof m.env === 'object' ? (m.env as Record<string, string>) : undefined
    }
  } catch {
    return null
  }
}

export function listInstalled(): (ExtensionManifest & { dir: string })[] {
  const root = extensionsDir()
  const out: (ExtensionManifest & { dir: string })[] = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const m = readManifest(dir)
    if (m) out.push({ ...m, dir })
  }
  return out
}

/** Register an installed extension so the rest of the app can see it. */
function activate(m: ExtensionManifest, source: 'folder' | 'github' | 'registry'): void {
  if (m.kind !== 'mcp') return
  mcp.upsert({
    id: m.id,
    name: m.name,
    command: m.command as string,
    args: m.args ?? [],
    env: m.env,
    // Installed, but OFF: nothing a user just downloaded starts running by itself, and its tools
    // are listed for them to look at before any of it is switched on.
    enabled: false,
    approvedTools: [],
    source
  })
}

/** Install from a folder that's already on disk. The base case, and the only one with no network. */
export function installFromFolder(srcDir: string): InstallResult {
  const src = resolve(srcDir)
  const m = readManifest(src)
  if (!m) return { ok: false, error: `No valid ${MANIFEST} in ${basename(src)}.` }
  const dest = join(extensionsDir(), m.id)
  try {
    rmSync(dest, { recursive: true, force: true })
    cpSync(src, dest, { recursive: true })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  activate(m, 'folder')
  audit('extension.installed', `${m.id} (folder)`)
  return { ok: true, manifest: m }
}

/**
 * Install from a GitHub URL by cloning it.
 *
 * The confirmation the renderer shows before calling this is not decoration — this clones and then
 * *runs* code from the internet inside an app that edits the user's files. The URL is restricted to
 * https so a `file://` or `git@` URL can't be smuggled through, and the clone is shallow.
 */
export async function installFromGit(url: string): Promise<InstallResult> {
  if (getAirGap()) return { ok: false, error: 'Air-Gapped Mode is on — nothing is downloaded.' }
  if (!/^https:\/\/[\w.-]+\/[\w.\-/]+$/.test(url)) {
    return { ok: false, error: 'Only https:// repository URLs can be installed.' }
  }
  const tmp = join(extensionsDir(), `.incoming-${Date.now()}`)
  try {
    const res = await execStream(`git clone --depth 1 ${JSON.stringify(url)} ${JSON.stringify(tmp)}`, extensionsDir(), () => {}, 120_000).done
    if (res.code !== 0) return { ok: false, error: res.output.slice(-400) || 'clone failed' }
    const m = readManifest(tmp)
    if (!m) return { ok: false, error: `That repository has no ${MANIFEST} — it isn't an ATOMIC extension.` }
    const dest = join(extensionsDir(), m.id)
    rmSync(dest, { recursive: true, force: true })
    cpSync(tmp, dest, { recursive: true })
    activate(m, 'github')
    audit('extension.installed', `${m.id} (github: ${url})`)
    return { ok: true, manifest: m }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export async function uninstall(id: string): Promise<InstallResult> {
  const dir = join(extensionsDir(), id)
  if (!existsSync(dir)) return { ok: false, error: `"${id}" is not installed.` }
  rmSync(dir, { recursive: true, force: true })
  // Awaited: the connector must be gone from the registry before this reports success, or the panel
  // refreshes onto a connector whose files no longer exist.
  await mcp.remove(id)
  audit('extension.uninstalled', id)
  return { ok: true }
}

/**
 * The curated registry.
 *
 * A static JSON file we publish, not a marketplace with accounts and moderation — curation IS the
 * moderation, and the panel says so rather than implying a review process that doesn't exist.
 * Fetched fresh, never cached to disk, so a removed entry disappears everywhere at once.
 */
const REGISTRY_URL = process.env.STUDIO_REGISTRY_URL || 'https://atomic.limited/studio/registry.json'

export async function registry(): Promise<{ ok: boolean; entries: RegistryEntry[]; error?: string }> {
  if (getAirGap()) return { ok: false, entries: [], error: 'Air-Gapped Mode is on — the registry is not fetched.' }
  try {
    const res = await fetch(REGISTRY_URL, { headers: { accept: 'application/json' } })
    if (!res.ok) return { ok: false, entries: [], error: `Registry returned ${res.status}.` }
    const data = (await res.json()) as unknown
    const raw = Array.isArray(data) ? data : (data as { extensions?: unknown }).extensions
    if (!Array.isArray(raw)) return { ok: false, entries: [], error: 'The registry file is not a list.' }
    const installed = new Set(listInstalled().map((e) => e.id))
    return {
      ok: true,
      entries: raw
        .filter((e): e is RegistryEntry => !!e && typeof (e as RegistryEntry).id === 'string')
        .map((e) => ({
          id: e.id,
          name: e.name ?? e.id,
          description: e.description ?? '',
          repo: e.repo ?? '',
          publisher: e.publisher ?? 'unknown',
          installed: installed.has(e.id)
        }))
    }
  } catch (e) {
    // Offline is the normal case here, not an error worth shouting about.
    return { ok: false, entries: [], error: e instanceof Error ? e.message : String(e) }
  }
}
