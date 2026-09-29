import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ForgeRepo, ForgeUser, GitServer } from '../shared/types'
import type { Forge } from './forge'
import { enterprisePolicy, identityRequired } from './policy'
import { currentIdentity, ensureAccessToken } from './identity'

/**
 * The self-hosted ATOMIC git server, as a Forge.
 *
 * TWO SOURCES, ONE SEAM. When a company identity provider is configured, the repo catalog comes
 * from the control plane over REST and is FILTERED BY THE SERVER to what this person may see —
 * need-to-know is enforced where it cannot be bypassed, not by hiding rows in the renderer.
 * Without an IdP (every standalone seat) it reads the same shape from a local config file.
 *
 * The promise the previous version of this comment made has now been kept: swapping the file read
 * for a fetch was a change to THIS FILE ONLY. `git-core`'s clone/push/pull still take a plain URL
 * and still have no idea which forge produced it, which is the whole point of the `Forge` seam.
 *
 * `<userData>/atomic-forge.json`:
 *
 *   {
 *     "name": "ATOMIC Team",
 *     "sshUser": "git",
 *     "host": "git.company.internal",
 *     "root": "/srv/atomic/git",
 *     "repos": [{ "name": "studio", "description": "The IDE" }]
 *   }
 *
 * SECURITY: there is no token here and there never will be. The data plane is
 * stock sshd, so the user's SSH key is the credential and it stays in their agent
 * — Studio never reads, stores, or forwards it.
 */

interface AtomicForgeConfig {
  name?: string
  sshUser?: string
  host?: string
  root?: string
  port?: number
  keyPath?: string
  repos?: { name: string; description?: string; private?: boolean }[]
}

function configPath(): string {
  return process.env.STUDIO_ATOMIC_FORGE ?? join(app.getPath('userData'), 'atomic-forge.json')
}

function readConfig(): AtomicForgeConfig | null {
  try {
    const p = configPath()
    if (!existsSync(p)) return null
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as AtomicForgeConfig
    // A config without a host cannot produce a clone URL. Treat it as absent rather than
    // half-configured: a repo list you cannot clone from is a dead control.
    return cfg && typeof cfg.host === 'string' && cfg.host.trim() ? cfg : null
  } catch {
    /* malformed config → not configured, never a crash */
    return null
  }
}

/**
 * The server half of the config, as the Settings form sees it.
 *
 * Deliberately the SAME file `readConfig` already reads: configuring the server in Settings is
 * therefore also what populates the provider dropdown and the repo list, and there is one truth
 * about where this server lives rather than two that can disagree.
 */
export function serverConfig(): GitServer | null {
  const cfg = readConfig()
  if (!cfg || !cfg.host) return null
  return {
    host: cfg.host,
    sshUser: cfg.sshUser ?? 'git',
    root: cfg.root ?? '',
    port: cfg.port ?? 22,
    keyPath: cfg.keyPath ?? ''
  }
}

/**
 * Merge the server fields in, PRESERVING `repos` and anything else already in the file.
 *
 * AUTHORITATIVE GUARD, not just the IPC handler's: this is exported and reachable from any future
 * main-process caller (a migration, an import, a workspace bootstrap), and every one of those must
 * be unable to point a managed seat at a server of the caller's choosing — a local config would
 * override the control plane's server-side, need-to-know filtering. Checking it here, before any
 * write, means the rule holds even for a caller that never goes through IPC at all. The
 * `IPC.gitServerSave` handler in index.ts keeps its own copy of this check too (see the comment
 * there for why two layers is deliberate).
 */
export function saveServerConfig(s: GitServer): { ok: boolean; error?: string } {
  if (identityRequired()) return { ok: false, error: 'Your organisation manages this setting.' }
  try {
    const p = configPath()
    const existing = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as AtomicForgeConfig) : {}
    const next: AtomicForgeConfig = {
      ...existing,
      name: existing.name ?? 'ATOMIC Team',
      host: s.host.trim(),
      sshUser: (s.sshUser || 'git').trim(),
      root: s.root.trim(),
      port: s.port ?? 22,
      keyPath: s.keyPath ?? ''
    }
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * `ssh://git@host[:port]/srv/atomic/git/<repo>.git` — the stock-sshd data plane.
 *
 * THE PORT IS NOT OPTIONAL. This function used to omit it entirely, so a server on 2222 produced a
 * URL that dialled 22: the clone failed against whatever was (or was not) listening there, with an
 * error that named neither the port nor the cause. `git-provision.planRepo` had the port right,
 * which meant publishing and cloning the SAME repository disagreed about its address.
 *
 * A URL the server already gave us is always preferred over this — see `cloneUrl` below.
 */
export function atomicCloneUrl(repo: ForgeRepo): string {
  // The catalogue may already carry the URL the SERVER built, and the server is the authority on
  // its own port and repository root. Rebuilding one from local config is a guess.
  if (repo.cloneUrl?.trim()) return repo.cloneUrl.trim()
  const cfg = readConfig()
  if (!cfg) return ''
  const user = cfg.sshUser?.trim() || 'git'
  const root = (cfg.root?.trim() || '/srv/atomic/git').replace(/\/+$/, '')
  const name = repo.fullName.replace(/^.*\//, '').replace(/\.git$/, '')
  const port = cfg.port && cfg.port !== 22 ? `:${cfg.port}` : ''
  return `ssh://${user}@${cfg.host}${port}${root}/${name}.git`
}

/**
 * `url` is what the control plane returned, when it returned one. Passing it through rather than
 * discarding it is the difference between cloning the repository the server named and cloning a
 * URL this process reassembled from a config file that may not even be current.
 */
const toRepo = (name: string, description: string, isPrivate: boolean, url = ''): ForgeRepo => ({
  fullName: name,
  private: isPrivate,
  cloneUrl: url.trim() || atomicCloneUrl({ fullName: name, private: true, cloneUrl: '', description: '' }),
  description
})

function reposFromFile(): ForgeRepo[] {
  const cfg = readConfig()
  if (!cfg?.repos?.length) return []
  return cfg.repos
    .filter((r) => r && typeof r.name === 'string' && r.name.trim())
    // a self-hosted repo is private unless it says otherwise
    .map((r) => toRepo(r.name.trim(), r.description ?? '', r.private !== false))
}

/**
 * The catalog as the CONTROL PLANE sees it for this person. A 403 or an empty list is a real
 * answer — "you may see nothing" — and must render as an empty catalog, never as a fallback to
 * the local file. Falling back on an authorisation answer would quietly undo the filtering.
 * Only a TRANSPORT failure (server unreachable) returns null so the caller can say so.
 */
async function reposFromControlPlane(): Promise<ForgeRepo[] | null> {
  const cp = enterprisePolicy().idp?.controlPlane?.trim().replace(/\/+$/, '')
  if (!cp) return null
  const token = await ensureAccessToken()
  if (!token) return null
  try {
    const res = await fetch(`${cp}/v1/repos`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 403 || res.status === 404) return []
    if (!res.ok) return null
    const list = (await res.json()) as { name?: string; url?: string; description?: string; private?: boolean }[]
    if (!Array.isArray(list)) return null
    return list
      .filter((r) => r && typeof r.name === 'string' && r.name.trim())
      // `r.url` is the server's own clone URL, carrying its real SSH port and repository root.
      .map((r) => toRepo(r.name!.trim(), r.description ?? '', r.private !== false, typeof r.url === 'string' ? r.url : ''))
  } catch {
    return null // unreachable — not the same as "you may see nothing"
  }
}

export const atomicForge: Forge = {
  id: 'atomic',
  name: readConfig()?.name?.trim() || 'ATOMIC Server',
  kind: 'self-hosted',
  // On a managed seat, "signed in" means the IdP session — not the presence of a config file.
  signedIn: async () => (identityRequired() ? currentIdentity() !== null : readConfig() !== null),
  user: async (): Promise<ForgeUser | null> => {
    if (identityRequired()) {
      const who = currentIdentity()
      return who ? { login: who.user, name: who.display } : null
    }
    const cfg = readConfig()
    if (!cfg) return null
    const login = cfg.sshUser?.trim() || 'git'
    return { login, name: `${login}@${cfg.host}` }
  },
  repos: async (): Promise<ForgeRepo[]> => {
    if (identityRequired()) {
      const remote = await reposFromControlPlane()
      // Unreachable control plane => empty, NOT the local file. On a managed seat the local file
      // is stale by definition and showing it would present repos this person may no longer have.
      return remote ?? []
    }
    return reposFromFile()
  },
  cloneUrl: atomicCloneUrl
}
