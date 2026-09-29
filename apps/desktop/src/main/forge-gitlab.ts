import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tokenFor } from './git-exec'
import type { ForgeRepo, ForgeUser } from '../shared/types'
import type { Forge } from './forge'

/**
 * GitLab as one Forge among several — sibling to `forge-github.ts`.
 *
 * ONE IMPLEMENTATION, TWO DEPLOYMENTS. gitlab.com and a company's own GitLab speak the identical
 * v4 REST API, so the only thing that varies between them is the base URL. That is why this is a
 * `host` config rather than a second forge module: a self-hosted GitLab is not a different
 * product, and giving it its own file would guarantee the two drift.
 *
 * `<userData>/gitlab-forge.json` (absent → gitlab.com):
 *
 *   { "host": "gitlab.company.internal" }
 *
 * NOT YET WIRED TO SETTINGS: nothing in the UI writes that file today, so a self-hosted GitLab has
 * to be configured by hand. That is also why `name` stays plain "GitLab" rather than naming the
 * host — displaying a host the user has no control to change is a dead control by another name.
 */

const FORGE_ID = 'gitlab'

interface GitLabForgeConfig {
  host?: string
}

function configPath(): string {
  return process.env.STUDIO_GITLAB_FORGE ?? join(app.getPath('userData'), 'gitlab-forge.json')
}

/**
 * The host this forge talks to. Also what `git-exec` routes the token by, which is why it is
 * exported: the askpass mapping and the API client must never disagree about where GitLab is.
 *
 * A malformed or absent config falls back to gitlab.com rather than failing. The hosted case is
 * overwhelmingly the common one, and a typo in a hand-edited file should not silently take the
 * forge off the list with nothing to notice.
 */
export function gitlabHost(): string {
  try {
    const p = configPath()
    if (!existsSync(p)) return 'gitlab.com'
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as GitLabForgeConfig
    const host = typeof cfg?.host === 'string' ? cfg.host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : ''
    return host || 'gitlab.com'
  } catch {
    return 'gitlab.com'
  }
}

function apiBase(): string {
  return `https://${gitlabHost()}/api/v4`
}

/**
 * PRIVATE-TOKEN, not `Authorization: Bearer`. Both work for a personal access token on current
 * GitLab, but Bearer is also how OAuth tokens arrive and a PAT sent that way is rejected by older
 * self-hosted instances. The header that has only ever meant "PAT" is the one that works against
 * the widest range of company installs.
 */
function headers(t: string): Record<string, string> {
  return { 'PRIVATE-TOKEN': t, Accept: 'application/json' }
}

export async function glSignedIn(): Promise<boolean> {
  return Boolean(tokenFor(FORGE_ID))
}

export async function glUser(): Promise<ForgeUser | null> {
  const t = tokenFor(FORGE_ID)
  if (!t) return null
  try {
    const res = await fetch(`${apiBase()}/user`, { headers: headers(t) })
    if (!res.ok) return null
    const u = (await res.json()) as { username: string; name?: string }
    return { login: u.username, name: u.name ?? u.username }
  } catch {
    return null
  }
}

export async function glRepos(): Promise<ForgeRepo[]> {
  const t = tokenFor(FORGE_ID)
  if (!t) return []
  try {
    // `membership=true` is load-bearing, not a filter for tidiness. Without it GitLab answers with
    // every PUBLIC project on the instance — millions of rows on gitlab.com, and on a company box
    // the shape of the whole estate poured into a clone picker. GitHub's /user/repos is scoped to
    // the caller by definition, so forge-github.ts needs no equivalent and this looks asymmetric.
    const res = await fetch(`${apiBase()}/projects?membership=true&per_page=100&order_by=last_activity_at`, {
      headers: headers(t)
    })
    if (!res.ok) return []
    const list = (await res.json()) as {
      path_with_namespace: string
      visibility: string
      http_url_to_repo: string
      description?: string | null
    }[]
    return list.map((r) => ({
      fullName: r.path_with_namespace,
      // GitLab has three visibilities where ForgeRepo has two states. `internal` means "every
      // signed-in person on this instance", which is not public — reading it as private errs
      // toward showing the padlock, and that is the safe direction to be wrong in: a private repo
      // displayed as public is a disclosure, the reverse is cosmetic.
      private: r.visibility !== 'public',
      cloneUrl: r.http_url_to_repo,
      description: r.description ?? ''
    }))
  } catch {
    return []
  }
}

export const gitlabForge: Forge = {
  id: FORGE_ID,
  name: 'GitLab',
  kind: 'cloud',
  signedIn: glSignedIn,
  user: glUser,
  repos: glRepos,
  cloneUrl: (r) => r.cloneUrl
}
