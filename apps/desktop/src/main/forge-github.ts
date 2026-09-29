import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { git, token, tail } from './git-exec'
import type { GhRepo, GhUser, GitResult } from '../shared/types'
import type { Forge } from './forge'

/**
 * GitHub as one Forge among several. Behaviour is byte-for-byte what git.ts did
 * before the split — this file exists so that GitHub is an OPTION rather than the
 * assumption baked into the panel. `forge-atomic.ts` is its sibling.
 */

const GH_API = 'https://api.github.com'

export async function ghSignedIn(): Promise<boolean> {
  return Boolean(token())
}

export async function ghUser(): Promise<GhUser | null> {
  const t = token()
  if (!t) return null
  try {
    const res = await fetch(`${GH_API}/user`, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json' } })
    if (!res.ok) return null
    const u = (await res.json()) as { login: string; name?: string }
    return { login: u.login, name: u.name ?? u.login }
  } catch {
    return null
  }
}

export async function ghRepos(): Promise<GhRepo[]> {
  const t = token()
  if (!t) return []
  try {
    const res = await fetch(`${GH_API}/user/repos?per_page=100&sort=updated`, {
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return []
    const list = (await res.json()) as { full_name: string; private: boolean; clone_url: string; description?: string }[]
    return list.map((r) => ({ fullName: r.full_name, private: r.private, cloneUrl: r.clone_url, description: r.description ?? '' }))
  } catch {
    return []
  }
}

/** Clone into destDir/<repo-name>; returns the new project path. */
export async function ghClone(cloneUrl: string, destDir: string): Promise<GitResult & { path?: string }> {
  const name = basename(cloneUrl, '.git')
  const target = join(destDir, name)
  if (existsSync(target)) return { ok: false, error: `${target} already exists.` }
  const res = await git(destDir, `clone ${JSON.stringify(cloneUrl)} ${JSON.stringify(target)}`, true)
  if (res.code !== 0) return { ok: false, error: tail(res.output) }
  return { ok: true, path: target }
}

export const githubForge: Forge = {
  id: 'github',
  name: 'GitHub',
  kind: 'cloud',
  signedIn: ghSignedIn,
  user: ghUser,
  repos: ghRepos,
  cloneUrl: (r) => r.cloneUrl
}
