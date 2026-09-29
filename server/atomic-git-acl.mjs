/**
 * atomic-git-acl — who may read or write which repository.
 *
 * ONE source of truth, imported by all three consumers: the forced command
 * (atomic-git-shell), the push gate (hooks/pre-receive), and the REST control
 * plane (atomic-workspaced). A second copy of this logic is how a server ends up
 * refusing a push it would happily have served over another door.
 *
 * It deliberately extends the EXISTING members.json rather than adding a second
 * list: a teammate is invited once and gets workspace and repo access together,
 * with one audit trail. The role vocabulary is the server's existing one.
 *
 *   {"members":[
 *     {"name":"alice","role":"editor","tokenHash":"…","createdAt":1,
 *      "sshKeys":["ssh-ed25519 AAAA… alice@laptop"],"repos":["*"]},
 *     {"name":"bob","role":"viewer","tokenHash":"…","createdAt":1,
 *      "sshKeys":["ssh-ed25519 AAAA… bob@laptop"],"repos":["studio"]}
 *   ]}
 *
 * ── ROLES: the server is the authority, `shared/roles.ts` is the mirror ──────────────
 *
 * The desktop app's table (`apps/desktop/src/shared/roles.ts`) decides what a seat SHOWS.
 * This file decides what the server ALLOWS, and it is the only one of the two that matters.
 * Keep them in step; where they disagree, this file wins and the UI is simply wrong.
 *
 *   admin   → read + write everywhere, may push protected refs, may administer
 *   manager → read EVERYWHERE, never writes                    (oversight, not authorship)
 *   lead    → read + write scoped by `repos`, may push protected refs
 *   dev     → read + write scoped by `repos`, never protected
 *   viewer  → read only, scoped by `repos`                     (legacy; no UI in Studio)
 *
 * LEGACY ALIASES. This server shipped with `owner`/`editor`/`viewer` and existing
 * members.json files use them. They are mapped, not removed — an install that predates the
 * identity work keeps working untouched, and `viewer` stays a role in its own right because
 * "scoped read-only" has no equivalent among the four (manager reads everything).
 *
 *   owner  -> admin      editor -> dev      viewer -> viewer
 *
 * Zero dependencies, so it runs from a git hook on a box with nothing installed.
 */
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_ROOT = process.env.ATOMIC_GIT_ROOT || '/srv/atomic/git'

/**
 * members.json may be an array (what atomic-workspaced writes today) or an object
 * with a `members` key. Both are accepted so this can be dropped onto an existing
 * install without a migration step.
 */
export function readMembers(membersPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(membersPath, 'utf8'))
    if (Array.isArray(raw)) return raw
    if (raw && Array.isArray(raw.members)) return raw.members
    return []
  } catch {
    // Unreadable or malformed → NO members. Never "everyone", never a crash: a
    // corrupt ACL file must fail closed, refusing access rather than granting it.
    return []
  }
}

export function memberByName(membersPath, name) {
  if (!name || typeof name !== 'string') return null
  return readMembers(membersPath).find((m) => m && m.name === name) ?? null
}

/** A repository name we are willing to turn into a path. Not a path itself. */
export function isSafeRepoName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 100 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
    !name.includes('..')
  )
}

/**
 * Turn a client-supplied path into a real repository directory under `root`, or
 * null. Everything hostile is refused HERE, once, so no caller has to remember to.
 *
 * The realpath check is the load-bearing one: a name can pass every string test
 * and still be a symlink pointing at /etc. Resolving both sides and comparing
 * prefixes is the only check that survives that.
 */
export function resolveRepo(root, requested) {
  if (typeof requested !== 'string' || !requested) return null
  // Clients send '/srv/atomic/git/x.git', '~/x.git' or 'x.git' depending on the URL
  // form. Normalise to a bare name, then rebuild the path ourselves — the client
  // never gets to choose a directory.
  let rel = requested.trim().replace(/^~\/?/, '').replace(/^\/+/, '')
  const absRoot = path.resolve(root)
  if (path.resolve('/' + rel).startsWith(absRoot + path.sep)) {
    rel = path.resolve('/' + rel).slice(absRoot.length + 1)
  }
  rel = rel.replace(/\.git\/?$/, '')
  if (!isSafeRepoName(rel)) return null

  const dir = path.join(absRoot, rel + '.git')
  let real
  try {
    real = fs.realpathSync(dir)
  } catch {
    return null // does not exist
  }
  const realRoot = fs.realpathSync(absRoot)
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null // symlink escape
  // A bare repo, not just any directory: refuse to serve something that is not one.
  if (!fs.existsSync(path.join(real, 'HEAD')) || !fs.existsSync(path.join(real, 'objects'))) return null
  return { name: rel, dir: real }
}

/**
 * What each role may do. `'all'` ignores the member's `repos` scope; `'scoped'` honours it;
 * `'none'` refuses outright. This is the server-side mirror of `shared/roles.ts`.
 */
export const ROLE_CAPS = {
  admin: { read: 'all', write: 'all', pushProtected: true, approveMerge: true },
  manager: { read: 'all', write: 'none', pushProtected: false, approveMerge: false },
  lead: { read: 'scoped', write: 'scoped', pushProtected: true, approveMerge: true },
  dev: { read: 'scoped', write: 'scoped', pushProtected: false, approveMerge: false },
  viewer: { read: 'scoped', write: 'none', pushProtected: false, approveMerge: false }
}

/** Pre-identity role names, kept working. See the header. */
const ROLE_ALIASES = { owner: 'admin', editor: 'dev' }

/**
 * The canonical role for a member, or null.
 *
 * Null for anything unrecognised, which is what makes every caller below fail closed: a
 * members.json with a typo'd role locks that person out rather than falling through to a
 * default. A default role here would grant access to every misconfigured entry on the server.
 */
export function roleOf(membersPath, name) {
  const m = memberByName(membersPath, name)
  if (!m || typeof m.role !== 'string') return null
  const canonical = ROLE_ALIASES[m.role] ?? m.role
  return Object.prototype.hasOwnProperty.call(ROLE_CAPS, canonical) ? canonical : null
}

/** Is `repo` inside this member's `repos` scope? `repos` absent is NOT "all" — see can(). */
function inScope(membersPath, name, repo) {
  const m = memberByName(membersPath, name)
  const scopes = Array.isArray(m?.repos) ? m.repos : []
  return scopes.includes('*') || scopes.includes(repo)
}

/**
 * The role this decision should use.
 *
 * TWO SOURCES, and the certificate wins where it exists. Under `authorized_keys` the role can only
 * come from members.json, because a key line carries nothing but a name. Under certificates the
 * role is SIGNED BY THE CA and arrives with the identity, which is the whole reason certificates
 * were adopted: a role that expires cannot be left behind in a file someone forgot to edit.
 *
 * `certRole` is only ever a value this server verified itself (atomic-git-cert.mjs). It is never
 * read from the client's environment — see the header of atomic-git-shell.mjs.
 *
 * An unrecognised role, from either source, is null: fail closed, never a default.
 */
export function effectiveRole(membersPath, name, certRole) {
  if (certRole) {
    const canonical = ROLE_ALIASES[certRole] ?? certRole
    return Object.prototype.hasOwnProperty.call(ROLE_CAPS, canonical) ? canonical : null
  }
  return roleOf(membersPath, name)
}

/**
 * May `name`, acting as `role`, do `access` ('read'|'write') to `repo`?
 *
 * Fails closed on every unknown: no role, no scope → false. `repos` absent is NOT treated as
 * "all" — an admin who forgets the field should find a teammate locked out, not silently granted
 * the whole server. That holds for a certificate identity too: the certificate says WHAT you are,
 * members.json still says WHICH repositories you were given.
 */
export function canAs(membersPath, name, repo, access, role) {
  if (access !== 'read' && access !== 'write') return false
  if (!role || !Object.prototype.hasOwnProperty.call(ROLE_CAPS, role)) return false
  const reach = ROLE_CAPS[role][access]
  if (reach === 'none') return false
  if (reach === 'all') return true
  return inScope(membersPath, name, repo)
}

/** The members.json-only form, kept because the legacy authorized_keys path has no certificate. */
export function can(membersPath, name, repo, access) {
  return canAs(membersPath, name, repo, access, roleOf(membersPath, name))
}

/**
 * May `name`, acting as `role`, move a PROTECTED ref (main/master) in `repo`?
 *
 * Separate from `canAs(..., 'write')` on purpose: a dev writes freely to feature branches and must
 * still be stopped at `main`. Requires write access first, so a manager — who reads everything —
 * can never reach this through the `read: 'all'` grant.
 */
export function canPushProtectedAs(membersPath, name, repo, role) {
  if (!role || !ROLE_CAPS[role]?.pushProtected) return false
  return canAs(membersPath, name, repo, 'write', role)
}

export function canPushProtected(membersPath, name, repo) {
  return canPushProtectedAs(membersPath, name, repo, roleOf(membersPath, name))
}

/** Repos this member can see, for the REST list and Studio's forge picker. */
export function visibleReposAs(membersPath, name, root = DEFAULT_ROOT, role = null) {
  const effective = role ?? roleOf(membersPath, name)
  let names = []
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && d.name.endsWith('.git'))
      .map((d) => d.name.replace(/\.git$/, ''))
  } catch {
    return []
  }
  return names.filter((r) => isSafeRepoName(r) && canAs(membersPath, name, r, 'read', effective)).sort()
}

export function visibleRepos(membersPath, name, root = DEFAULT_ROOT) {
  return visibleReposAs(membersPath, name, root, roleOf(membersPath, name))
}
