#!/usr/bin/env node
/**
 * atomic-workspaced — ATOMIC Workspaces reference control-plane server.
 *
 * Zero dependencies (node:http/crypto/fs/child_process). Deploy on any box:
 *
 *   scp server/atomic-workspaced.mjs root@yourbox:/usr/local/bin/
 *   ATOMIC_WS_TOKEN=<long-random> ATOMIC_WS_ROOT=/srv/atomic \
 *   ATOMIC_WS_SSH_HOST=yourbox.example ATOMIC_WS_SSH_USER=atomic \
 *     node /usr/local/bin/atomic-workspaced.mjs
 *
 * (systemd unit: ExecStart the line above; Restart=always.)
 *
 * ARCHITECTURE: this daemon is ONLY the lifecycle control plane. The data
 * plane is the box's stock sshd; the editor is ATOMIC Studio's remote engine.
 * A workspace here is a directory under $ATOMIC_WS_ROOT/ws/<id>.
 *
 * PRODUCTION ROADMAP (v0 is honest about what it is):
 *  - isolation: one Unix user per workspace (`useradd ws-<id>`) + systemd
 *    template unit with MemoryMax/CPUQuota/TasksMax; v0 uses plain dirs.
 *  - prebuild cache: shared read-only node_modules/image cache mounted per
 *    workspace; v0 has none.
 *  - port forwarding: ssh -L from the client; nothing needed here.
 *  - migration BYO↔cloud: streamed tar between two sshd's; endpoints reserved.
 *
 * ENV:
 *  ATOMIC_WS_TOKEN     bearer token (required)
 *  ATOMIC_WS_ROOT      data root        (default /srv/atomic)
 *  ATOMIC_WS_PORT      listen port      (default 8791; 0 = ephemeral)
 *  ATOMIC_WS_HOST      listen host      (default 127.0.0.1 — front with a TLS proxy)
 *  ATOMIC_WS_SSH_HOST / _SSH_USER / _SSH_PORT   coordinates returned to clients
 *  ATOMIC_WS_IDLE_MS   auto-suspend idle threshold (default 30 min)
 *  ATOMIC_WS_SWEEP_MS  suspend sweep interval      (default 60 s)
 */
import http from 'node:http'
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { verifyJwt, roleFromClaims } from './atomic-oidc.mjs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { canAs, isSafeRepoName, visibleReposAs, ROLE_CAPS } from './atomic-git-acl.mjs'
import { currentEpoch, readEpochs } from './atomic-git-cert.mjs'

const TOKEN = process.env.ATOMIC_WS_TOKEN
if (!TOKEN) {
  console.error('ATOMIC_WS_TOKEN is required.')
  process.exit(1)
}
const ROOT = process.env.ATOMIC_WS_ROOT || '/srv/atomic'
const WS_DIR = path.join(ROOT, 'ws')
const TRASH = path.join(ROOT, '.trash')
const SNAPS = path.join(ROOT, 'snapshots')
const META = path.join(ROOT, 'meta')
const IDLE_MS = parseInt(process.env.ATOMIC_WS_IDLE_MS ?? '', 10) || 30 * 60_000
const SWEEP_MS = parseInt(process.env.ATOMIC_WS_SWEEP_MS ?? '', 10) || 60_000
// ---- Git: bare repos + the authorized_keys that gate them ----
// Same members.json as workspaces, on purpose: a teammate is invited once and gets
// both, with one audit trail. A second list is a second thing to forget to revoke.
const GIT_ROOT = process.env.ATOMIC_GIT_ROOT || path.join(ROOT, 'git')
const AUTHORIZED_KEYS = process.env.ATOMIC_GIT_AUTHORIZED_KEYS || ''
const GIT_SHELL_BIN = process.env.ATOMIC_GIT_SHELL_BIN || '/usr/local/bin/atomic-git-shell.mjs'
/**
 * The pre-receive hook, resolved from where THIS FILE lives rather than from the working directory.
 *
 * `process.argv[1]` is the script path, which is right when the daemon is started by its unit file
 * and wrong the moment anything runs it through a wrapper or a symlink. The install layout puts
 * every module in one directory (see server/INSTALL-GIT.md), so resolving relative to
 * `import.meta.url` is the only form that survives being installed rather than run from a checkout.
 */
const GIT_HOOK_SRC =
  process.env.ATOMIC_GIT_HOOK || fileURLToPath(new URL('./hooks/pre-receive.mjs', import.meta.url))
/** Revocation ledger: name -> epoch. Bumped when a member is deleted; read by atomic-git-shell. */
const EPOCHS = process.env.ATOMIC_GIT_EPOCHS || path.join(ROOT, 'identity-epochs.json')

const SSH = {
  host: process.env.ATOMIC_WS_SSH_HOST || 'localhost',
  user: process.env.ATOMIC_WS_SSH_USER || os.userInfo().username,
  port: parseInt(process.env.ATOMIC_WS_SSH_PORT ?? '', 10) || 22
}

/**
 * Company identity provider. OPTIONAL: unset, the server behaves exactly as it always has and
 * static bearer tokens are the only credential. Set, tokens from the IdP are ALSO accepted and
 * carry a role — the static owner token keeps working so an admin is never locked out of their
 * own server by an IdP outage.
 *
 *   ATOMIC_WS_OIDC_ISSUER      https://id.company.internal/realms/atomic
 *   ATOMIC_WS_OIDC_AUDIENCE    the client id Studio authenticates with
 *   ATOMIC_WS_OIDC_GROUPS      claim holding groups (default 'groups')
 *   ATOMIC_WS_OIDC_ROLES       JSON, e.g. {"eng-leads":"lead","eng":"dev"}
 *   ATOMIC_GIT_CA_KEY          the SSH CA private key used to sign certificates
 *   ATOMIC_GIT_CERT_TTL        certificate lifetime, default '8h'
 */
const OIDC = {
  issuer: (process.env.ATOMIC_WS_OIDC_ISSUER || '').trim(),
  audience: (process.env.ATOMIC_WS_OIDC_AUDIENCE || '').trim(),
  groupsClaim: (process.env.ATOMIC_WS_OIDC_GROUPS || 'groups').trim(),
  groupRoles: (() => {
    try {
      const parsed = JSON.parse(process.env.ATOMIC_WS_OIDC_ROLES || '{}')
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      // A malformed mapping means NOBODY maps to a role, which locks people out loudly rather
      // than quietly granting whatever the last valid parse happened to contain.
      console.error('ATOMIC_WS_OIDC_ROLES is not valid JSON — no group will map to a role.')
      return {}
    }
  })()
}
const CA_KEY = (process.env.ATOMIC_GIT_CA_KEY || '').trim()
const CERT_TTL = (process.env.ATOMIC_GIT_CERT_TTL || '8h').trim()
const oidcEnabled = () => Boolean(OIDC.issuer && OIDC.audience)

try {
  for (const d of [WS_DIR, TRASH, SNAPS, META]) fs.mkdirSync(d, { recursive: true })
} catch (err) {
  // A missing token already exits with one clear line; an un-creatable root must not do worse and
  // dump a raw Node stack (the default /srv/atomic cannot be created on macOS, where / is read-only).
  console.error(
    `Cannot create the workspace root "${ROOT}" (${err.code ?? err.message}).\n` +
      `Set ATOMIC_WS_ROOT to a directory this user can write, e.g. ATOMIC_WS_ROOT=$HOME/atomic-ws`
  )
  process.exit(1)
}

// ---------------------------------------------------------------- auth + rate limit

const tokenHash = createHash('sha256').update(TOKEN).digest()

// ---- Team: members.json holds invited tokens (hashed) with roles ----
// owner  = full control (team management, deletes, subscribe setup)
// editor = create/open/edit workspaces + snapshots
// viewer = read-only (list/get/keepalive)
const MEMBERS = path.join(ROOT, 'members.json')

function readMembers() {
  try {
    return JSON.parse(fs.readFileSync(MEMBERS, 'utf8'))
  } catch {
    return []
  }
}
function writeMembers(list) {
  const tmp = MEMBERS + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
  fs.renameSync(tmp, MEMBERS)
}

/**
 * Who is calling, as `{ name, role }` — or null.
 *
 * TWO credentials, checked in this order:
 *   1. a static bearer token (the owner token, or an invited member's) — the original scheme,
 *      still first because it must keep working when the IdP is unreachable; and
 *   2. an OIDC access token from the company provider, whose signature is verified against the
 *      issuer's published keys and whose groups decide the role.
 *
 * `name` matters as much as `role`: the git ACL is per-member, so an OIDC caller must resolve to
 * the SAME member name that owns their SSH key, or they would authenticate as a role with no
 * repositories. `preferred_username` is that link.
 */
async function identityOf(req) {
  const staticRole = roleOf(req)
  if (staticRole) return { name: memberNameOf(req) ?? 'owner', role: staticRole }
  if (!oidcEnabled()) return null
  const h = req.headers.authorization ?? ''
  if (!h.startsWith('Bearer ')) return null
  const claims = await verifyJwt(h.slice(7), { issuer: OIDC.issuer, audience: OIDC.audience })
  if (!claims) return null
  const role = roleFromClaims(claims, { groupsClaim: OIDC.groupsClaim, groupRoles: OIDC.groupRoles })
  if (!role) return null // authenticated, but no group maps to a role: not an error, just no access
  const name = typeof claims.preferred_username === 'string' ? claims.preferred_username : null
  if (!name) return null
  return { name, role, oidc: true }
}

/**
 * Role capabilities for the CONTROL PLANE, across both vocabularies.
 *
 * The routes below used to compare role strings directly — `role === 'editor'`, `role !== 'owner'`
 * — which was fine while only owner/editor/viewer existed. Once `/v1/team` began storing canonical
 * roles, a member saved as `dev` matched NONE of those strings: it sailed past the
 * `role === 'editor'` guard on workspace DELETE and could delete what an editor could not. A
 * privilege escalation created by unifying half a vocabulary, caught by the agent suite.
 *
 * So: one table, both vocabularies, and every route asks it rather than comparing strings.
 */
const ADMIN_ROLES = new Set(['owner', 'admin'])
const READ_ONLY_ROLES = new Set(['viewer', 'manager'])
/** May administer: manage members, delete repos and workspaces, read everything. */
const mayAdminister = (r) => ADMIN_ROLES.has(r)
/** Read-only: every write method is refused. */
const isReadOnly = (r) => READ_ONLY_ROLES.has(r)

/** The member name behind a static token, for the audit trail. Null for the owner token. */
function memberNameOf(req) {
  const h = req.headers.authorization ?? ''
  if (!h.startsWith('Bearer ')) return null
  const got = createHash('sha256').update(h.slice(7)).digest()
  for (const m of readMembers()) {
    if (typeof m?.tokenHash !== 'string' || !m.tokenHash) continue
    try {
      const mh = Buffer.from(m.tokenHash, 'hex')
      if (mh.length === got.length && timingSafeEqual(got, mh)) return m.name
    } catch {
      continue
    }
  }
  return null
}

/** Returns the caller's role ('owner'|'editor'|'viewer') or null. */
function roleOf(req) {
  const h = req.headers.authorization ?? ''
  if (!h.startsWith('Bearer ')) return null
  const got = createHash('sha256').update(h.slice(7)).digest()
  if (timingSafeEqual(got, tokenHash)) return 'owner'
  for (const m of readMembers()) {
    // A member may legitimately have NO token: git access is granted by an SSH key,
    // so someone can exist for `authorized_keys` and never hold a REST credential.
    // Buffer.from(undefined, 'hex') throws, and this loop runs on every non-owner
    // request — so one key-only teammate used to 500 the whole API for everybody.
    if (typeof m?.tokenHash !== 'string' || !m.tokenHash) continue
    let mh
    try {
      mh = Buffer.from(m.tokenHash, 'hex')
    } catch {
      continue
    }
    if (mh.length === got.length && timingSafeEqual(got, mh)) return m.role
  }
  return null
}

/**
 * Rate limit PER CALLER, not per server.
 *
 * The original counter was one global bucket of 60/min, which meant any single client — or the
 * test suite — could exhaust the budget for the entire team. Worse, it made a denial of service
 * against everyone cost one loop. The bucket is now keyed by credential and source address, with a
 * separate, much higher global ceiling so a distributed flood still hits a wall.
 */
const PER_CALLER_PER_MIN = parseInt(process.env.ATOMIC_WS_RATE ?? '', 10) || 600
const GLOBAL_PER_MIN = parseInt(process.env.ATOMIC_WS_RATE_GLOBAL ?? '', 10) || 6000
const hits = new Map() // "<minute>|<caller>" → count

function rateLimited(req) {
  const bucket = Math.floor(Date.now() / 60_000)
  const h = req.headers.authorization ?? ''
  // Hash the credential rather than key on it: this map is long-lived and a token in a key is a
  // token in a heap dump.
  const cred = h ? createHash('sha256').update(h).digest('hex').slice(0, 16) : 'anon'
  const caller = `${bucket}|${req.socket?.remoteAddress ?? '?'}|${cred}`
  const all = `${bucket}|*`
  for (const k of hits.keys()) if (Number(k.split('|')[0]) < bucket) hits.delete(k)
  const mine = (hits.get(caller) ?? 0) + 1
  const total = (hits.get(all) ?? 0) + 1
  hits.set(caller, mine)
  hits.set(all, total)
  return mine > PER_CALLER_PER_MIN || total > GLOBAL_PER_MIN
}

// ---------------------------------------------------------------- state

const metaPath = (id) => path.join(META, `${id}.json`)

function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'))
  } catch {
    return null
  }
}

/** Atomic write (temp + rename) so a crash never corrupts workspace state. */
function writeMeta(meta) {
  const tmp = metaPath(meta.id) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2))
  fs.renameSync(tmp, metaPath(meta.id))
}

function listMeta() {
  return fs
    .readdirSync(META)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readMeta(f.slice(0, -5)))
    .filter(Boolean)
}

const pub = (m) => ({
  id: m.id,
  name: m.name,
  state: m.state,
  ownedBy: m.ownedBy ?? null,
  createdAt: m.createdAt,
  lastSeen: m.lastSeen,
  ssh: { ...SSH, root: path.join(WS_DIR, m.id) }
})

/**
 * May `me` (holding `role`) act on this workspace at all?
 *
 * The role gates on the workspace routes answer "what may this ROLE do to A workspace". Nothing
 * answered "is this the caller's workspace" — meta carried no owner at all — so every id-scoped
 * route was cross-tenant. Any non-read-only member could list the whole box, suspend another
 * tenant's workspace, read their snapshot names and descriptions, and call restore, which deletes
 * the directory's contents and untars over them. Ownership is the missing half of that pair, and
 * it is checked in ONE place so a route added later cannot forget it.
 *
 * A workspace written before this field existed has no `ownedBy`. Those are administrable but not
 * everyone's: the entire point of the fix is that an unowned workspace must not stay a
 * free-for-all, so it fails closed to admins, who can hand one over by setting the field. Every
 * other refusal in this server leans the same way.
 */
const mayTouchWorkspace = (meta, me, role) =>
  mayAdminister(role) || (!!meta.ownedBy && meta.ownedBy === me)

// ---------------------------------------------------------------- templates

const TEMPLATES = {
  'static-html': {
    'index.html':
      '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>ATOMIC Cloud workspace</title></head>\n<body><h1>Your cloud workspace is ready 🎉</h1></body></html>\n',
    'workspace.json': JSON.stringify({ language: 'html', framework: 'static-html', template: 'static-html' }, null, 2) + '\n'
  }
}

// ---------------------------------------------------------------- idle auto-suspend

setInterval(() => {
  const now = Date.now()
  for (const m of listMeta()) {
    const busyHold = m.busyUntil && m.busyUntil > now
    if (m.state === 'ready' && !busyHold && now - (m.lastSeen ?? m.createdAt) > IDLE_MS) {
      m.state = 'suspended'
      writeMeta(m)
      console.log(`[suspend] ${m.id} idle`)
    }
  }
}, SWEEP_MS).unref()

// ---------------------------------------------------------------- http

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'x-atomic-proto': '1' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > 64_000) req.destroy()
  })
  req.on('end', () => {
    try {
      // handle() is async because verifying an OIDC signature may need the issuer's keys.
      // The .catch is not optional: an async handler's rejection would otherwise be an
      // unhandled promise and the client would hang until it timed out rather than see a 500.
      handle(req, res, body ? JSON.parse(body) : {}).catch((e) =>
        json(res, 500, { error: e instanceof Error ? e.message : 'server error' })
      )
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : 'server error' })
    }
  })
})

// ---------------------------------------------------------------- git helpers

/**
 * The clone URL the client should use, built ONCE, here.
 *
 * `path.posix.join`, not `path.join`: this is a URL path, and on a Windows daemon `path.join`
 * would emit backslashes that no git client can parse. The port is included whenever it is not 22
 * — a URL that silently drops a non-default port produces a clone that dials the wrong service and
 * fails with something unrelated to the real cause. Clients are expected to USE this string rather
 * than rebuild one from parts, which is how the port got lost on the desktop side.
 */
const gitUrl = (name) =>
  `ssh://${SSH.user}@${SSH.host}${SSH.port === 22 ? '' : ':' + SSH.port}${path.posix.join(GIT_ROOT.split(path.sep).join('/'), name + '.git')}`

/**
 * The canonical role name, across both vocabularies, for handing to the git ACL.
 *
 * The control plane still speaks `owner`/`editor` for compatibility; `atomic-git-acl` speaks the
 * four canonical roles plus `viewer`. Translating HERE, once, is what stops a route from asking the
 * ACL about a role it has never heard of and getting a fail-closed `false` that looks like a
 * permissions bug.
 */
const ROLE_ALIASES = { owner: 'admin', editor: 'dev' }
function canonicalRole(role) {
  const c = ROLE_ALIASES[role] ?? role
  return Object.prototype.hasOwnProperty.call(ROLE_CAPS, c) ? c : null
}

const isScope = (s) => s === '*' || isSafeRepoName(s)

/** Every bare repo on disk. Owner-only; members go through visibleRepos(). */
function allRepoNames() {
  try {
    return fs
      .readdirSync(GIT_ROOT, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && d.name.endsWith('.git'))
      .map((d) => d.name.replace(/\.git$/, ''))
      .filter(isSafeRepoName)
      .sort()
  } catch {
    return []
  }
}

/**
 * An OpenSSH public key, strictly. This string is written into authorized_keys, so
 * a newline in it would let the caller inject their OWN options line — including
 * one without a forced command. That is the whole file's security in one regex.
 */
function isSafeSshKey(key) {
  if (typeof key !== 'string' || key.length > 8192 || /[\r\n\0]/.test(key)) return false
  return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]{0,200})?$/.test(key.trim())
}

/**
 * Install the push gate. MANDATORY — it throws, and the caller rolls the whole creation back.
 *
 * This used to swallow every failure with "a repo without the hook is still usable; the shell still
 * gates access". That is true of ACCESS and false of everything else the hook does: secrets,
 * oversized blobs, protected branches and author verification all live here and none of them are
 * checked by the forced command. A repository created without it is a repository with no push gate
 * at all, silently, and nothing later notices. A repository that failed to be created is a far
 * smaller problem than one that is quietly unguarded.
 */
function installHook(dir) {
  if (!fs.existsSync(GIT_HOOK_SRC)) {
    throw new Error(`the pre-receive hook is missing from this install (${GIT_HOOK_SRC})`)
  }
  const dest = path.join(dir, 'hooks', 'pre-receive')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(GIT_HOOK_SRC, dest)
  fs.chmodSync(dest, 0o755)
  // Prove it, rather than assume the copy took: a hook that is not executable is not a hook, and
  // git skips it without a word.
  fs.accessSync(dest, fs.constants.X_OK)
}

/**
 * Create a bare repository so that CONCURRENT callers cannot both win.
 *
 * `fs.existsSync(dir)` followed by `git init` is a check-then-act race: two requests can both see
 * nothing, both init, and the second silently adopts the first's repository — the same hazard the
 * desktop's `createBareRepo` refuses to take with `test -e`. Building in a temporary directory and
 * `rename`-ing it into place moves the decision into a single atomic syscall: exactly one rename
 * onto a non-empty target succeeds, and the loser is told the name is taken.
 *
 * The temp directory lives INSIDE the git root so the rename stays on one filesystem (a rename
 * across devices is EXDEV, not an atomic anything), and its name cannot end in `.git`, so it is
 * invisible to every lister and to `resolveRepo`.
 */
function createRepoAtomically(name) {
  const dir = path.join(GIT_ROOT, name + '.git')
  if (fs.existsSync(dir)) return { ok: false, taken: true }
  fs.mkdirSync(GIT_ROOT, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(GIT_ROOT, `.creating-${name}-`))
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', tmp])
    installHook(tmp)
    try {
      fs.renameSync(tmp, dir)
    } catch (e) {
      // ENOTEMPTY / EEXIST / ENOTDIR all mean the same thing here: somebody else got there first.
      if (['ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(e.code)) return { ok: false, taken: true }
      throw e
    }
    return { ok: true, dir }
  } finally {
    // Always: on the success path the rename already moved it, and rmSync on a gone path is a no-op.
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/**
 * Rewrite authorized_keys from the member list. This file IS the access control
 * for the data plane, so it is generated, never hand-edited: every line carries a
 * forced command naming its owner, and the four no-* options that stop the key
 * being used for tunnels, agents or a shell.
 *
 * Written atomically — a truncated authorized_keys locks the whole team out.
 * Returns the number of key lines written, or -1 when not configured.
 */
function syncAuthorizedKeys(list = readMembers()) {
  if (!AUTHORIZED_KEYS) return -1
  const lines = [
    '# GENERATED BY atomic-workspaced — do not edit by hand.',
    '# Every change here comes from POST /v1/keys/<member>.',
    ''
  ]
  let n = 0
  for (const m of list) {
    if (!m?.name || !/^[A-Za-z0-9._-]{1,60}$/.test(m.name)) continue
    for (const key of m.sshKeys ?? []) {
      if (!isSafeSshKey(key)) continue
      lines.push(
        `command="${GIT_SHELL_BIN} ${m.name}",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc ${key.trim()}`
      )
      n++
    }
  }
  try {
    const tmp = AUTHORIZED_KEYS + '.tmp'
    fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 })
    fs.renameSync(tmp, AUTHORIZED_KEYS)
  } catch {
    return -1
  }
  return n
}

/**
 * The revocation ledger. `name -> epoch`, bumped when a member is deleted.
 *
 * WHY IT EXISTS. Certificates end at expiry, which is a fine answer for "this person left" and a
 * bad one for "this NAME was reused". Delete `alice`, create a new `alice`, and until the old
 * certificate expired its holder would authenticate as the new one — a stale key revived by name
 * reuse. Every certificate therefore carries the epoch it was issued under (in its key id), and
 * `atomic-git-shell` refuses any certificate whose epoch is not the current one.
 *
 * Written atomically, so a malformed file means tampering rather than a torn write — which is why
 * the reader treats malformed as "refuse everything" rather than "start from zero".
 */
function bumpEpoch(name) {
  const current = readEpochs(EPOCHS)
  // A ledger we cannot read is one we must not silently replace: doing so would reset every epoch
  // to zero and revive exactly the certificates this file exists to kill.
  if (current === null) throw new Error('the revocation ledger could not be read')
  const next = { ...current, [name]: (current[name] ?? 0) + 1 }
  const tmp = EPOCHS + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, EPOCHS)
  return next[name]
}

/**
 * Idempotency-Key support, per the API conventions in docs/architecture/backend.md: a repeated
 * mutating request with the same key returns the ORIGINAL response rather than acting twice.
 *
 * In memory, and deliberately so for a reference server — the guarantee is "a retry within this
 * process's lifetime is safe", not "exactly once forever". A restart loses the map and the
 * underlying operations are still safe to repeat, because creation is atomic (one winner, 409 for
 * everyone else) rather than relying on this cache for its safety.
 */
const idempotency = new Map()
const IDEMPOTENCY_MAX = 500
/**
 * The cache key is bound to WHO is asking, not just what they asked for.
 *
 * It used to be `method + path + the client's own Idempotency-Key` — three values an attacker
 * supplies in full. Because the lookup runs before any route's role check, a caller who reused
 * another caller's key was handed that caller's cached RESPONSE without the authorization gate
 * ever running: for `POST /v1/team` that response body is the plaintext, one-time member-invite
 * token. Mixing the verified identity and role into the key makes a replay across callers miss the
 * cache and fall through to the route, where the role check it was skipping actually runs.
 *
 * JSON.stringify rather than string concatenation so a name or key containing the separator cannot
 * be arranged to collide with a different tuple.
 */
function idempotencyKey(req, who) {
  const k = req.headers['idempotency-key']
  if (!(typeof k === 'string' && k.length > 0 && k.length <= 200)) return null
  const caller = JSON.stringify([who?.name ?? '', who?.role ?? ''])
  return `${createHash('sha256').update(caller).digest('hex')} ${req.method} ${req.url.split('?')[0]} ${k}`
}
function rememberIdempotent(key, status, body) {
  if (!key) return body
  if (idempotency.size >= IDEMPOTENCY_MAX) idempotency.delete(idempotency.keys().next().value)
  idempotency.set(key, { status, body })
  return body
}

function audit(event, detail) {
  try {
    fs.appendFileSync(path.join(ROOT, 'git-audit.log'), JSON.stringify({ ts: Date.now(), event, ...detail }) + '\n', 'utf8')
  } catch {
    /* never fail a request because the log is unwritable */
  }
}

async function handle(req, res, body) {
  if (!req.url?.startsWith('/v1/')) return json(res, 404, { error: 'unknown route' })
  if (rateLimited(req)) return json(res, 429, { error: 'rate limited' })
  const who = await identityOf(req)
  if (!who) return json(res, 401, { error: 'bad token' })
  const role = who.role
  // `me` is the caller's NAME, from the credential the server verified. Every ACL decision below
  // uses it. It used to be recomputed by a second token-matching helper that only understood
  // static tokens, so an OIDC caller resolved to '' and saw an empty repository list no matter
  // what their role was — authenticated, correctly roled, and shown nothing.
  const me = who.name
  const canon = canonicalRole(role)

  const idem = idempotencyKey(req, who)
  if (idem && idempotency.has(idem)) {
    const prev = idempotency.get(idem)
    return json(res, prev.status, prev.body)
  }

  const parts = req.url.split('?')[0].split('/').filter(Boolean) // ['v1','workspaces',id?,action?,...]

  // ---- identity + billing touchpoint ----
  if (parts[1] === 'me' && req.method === 'GET') return json(res, 200, { role, name: who.name })

  // ---- SSH certificate issuance ----
  /**
   * Exchange a verified identity for a short-lived SSH certificate.
   *
   * The certificate's PRINCIPALS carry the answer: `<name>` and `role:<role>`. That is what lets
   * sshd and atomic-git-shell know who is pushing without an authorized_keys line per person to
   * keep in step — and it is why revocation becomes expiry rather than a file rewrite.
   *
   * Nothing here touches a shell: ssh-keygen is exec'd with an argv array, and both the name and
   * the role are re-validated against a strict pattern first. A principal is not a place to find
   * out that a username contained a comma.
   */
  if (parts[1] === 'cert' && req.method === 'POST') {
    if (!CA_KEY) return json(res, 501, { error: 'this server does not issue certificates' })
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(who.name)) return json(res, 400, { error: 'unusable identity' })
    // `canon`, not a shape regex: the certificate carries a role the git ACL must recognise, and
    // "looks like a lowercase word" is not that. A shape check here would happily sign `role:god`.
    if (!canon) return json(res, 400, { error: 'unusable role' })
    const pub = typeof body?.publicKey === 'string' ? body.publicKey.trim() : ''
    // An allow-list of key types, one line, no control characters. A public key is attacker-
    // supplied input that is about to become a filename's contents and an argv element.
    if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\r\n]{0,200})?$/.test(pub)) {
      return json(res, 400, { error: 'that does not look like an SSH public key' })
    }
    // The epoch is what makes revocation immediate. A ledger we cannot read means we cannot say
    // whether this identity is current, and issuing anyway would hand out a certificate that
    // outlives a revocation nobody could check.
    const epoch = currentEpoch(readEpochs(EPOCHS), who.name)
    if (epoch === null) return json(res, 500, { error: 'the server could not check the revocation ledger' })
    /**
     * THREE principals, and each one is load-bearing:
     *   SSH.user     the shared login account. sshd matches certificate principals against the
     *                account being logged into, so without it the certificate authenticates to
     *                nothing and no AuthorizedPrincipalsFile is needed.
     *   who.name     the certified identity, which atomic-git-shell reads back.
     *   role:<role>  the role, signed by the CA rather than looked up in a file.
     * Deduplicated, because a person whose name happens to equal the login account would otherwise
     * get a repeated principal.
     */
    const principals = [...new Set([SSH.user, who.name, `role:${canon}`])]
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-cert-'))
    try {
      const keyPath = path.join(dir, 'id.pub')
      fs.writeFileSync(keyPath, pub + '\n', { mode: 0o600 })
      execFileSync(
        'ssh-keygen',
        ['-q', '-s', CA_KEY, '-I', `atomic:${who.name}:${epoch}`, '-n', principals.join(','), '-V', `+${CERT_TTL}`, keyPath],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      const certificate = fs.readFileSync(path.join(dir, 'id-cert.pub'), 'utf8').trim()
      audit('cert-issued', { user: who.name, role: canon, epoch, ttl: CERT_TTL })
      return json(res, 200, { certificate, principals, ttl: CERT_TTL, keyId: `atomic:${who.name}:${epoch}` })
    } catch (e) {
      audit('cert-failed', { user: who.name, role: canon, error: String(e?.message ?? e).slice(0, 200) })
      return json(res, 500, { error: 'the server could not sign a certificate' })
    } finally {
      // The public key is not secret, but a temp directory per request is still litter.
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
  if (parts[1] === 'subscribe' && req.method === 'GET') {
    return json(res, 200, { link: process.env.ATOMIC_WS_SUBSCRIBE_LINK || null, price: '$9/month flat — never metered' })
  }

  // ---- team management (owner only) ----
  if (parts[1] === 'team') {
    if (!mayAdminister(role)) return json(res, 403, { error: 'owner only' })
    if (!parts[2] && req.method === 'GET') {
      return json(res, 200, readMembers().map((m) => ({ name: m.name, role: m.role, createdAt: m.createdAt })))
    }
    if (!parts[2] && req.method === 'POST') {
      const name = body.name
      if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(name)) {
        return json(res, 400, { error: 'member name must be 1–60 letters, digits, dots, underscores or hyphens' })
      }
      /**
       * Validate the role against the ACL's OWN table, and REFUSE an unknown one.
       *
       * This used to read `body.role === 'viewer' ? 'viewer' : 'editor'` — a hardcoded binary
       * from before roles existed. Asking for `lead` silently produced an `editor`, which maps
       * to `dev` and cannot push to a protected branch: the caller believed they had created a
       * lead and found out at the first refused push. Silent coercion of a PERMISSION is worse
       * than an error, so an unrecognised role is now a 400 that lists what is accepted.
       */
      const wanted = String(body.role || 'dev')
      const ALIASES = { owner: 'admin', editor: 'dev' }
      const mrole = Object.prototype.hasOwnProperty.call(ROLE_CAPS, wanted) ? wanted
        : Object.prototype.hasOwnProperty.call(ALIASES, wanted) ? ALIASES[wanted] : null
      if (!mrole) {
        return json(res, 400, { error: `unknown role "${wanted}"`, accepted: Object.keys(ROLE_CAPS) })
      }
      if (readMembers().some((m) => m.name === name)) return json(res, 409, { error: 'name taken' })
      // `repos` absent means the member sees NOTHING (atomic-git-acl fails closed on purpose).
      // Accept it at creation so an admin is not forced to hand-edit members.json afterwards.
      const repos = Array.isArray(body.repos) ? body.repos.filter((r) => r === '*' || isSafeRepoName(r)) : []
      const token = randomBytes(24).toString('hex')
      writeMembers([...readMembers(), { name, role: mrole, repos, tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: Date.now() }])
      // Regenerate immediately. A recreated name must start from the CURRENT member list and
      // nothing else — never from whatever lines happened to survive an earlier delete.
      syncAuthorizedKeys()
      audit('member-create', { name, role: mrole, by: me })
      // The plain token is returned exactly ONCE — hand it to the teammate.
      return json(res, 201, rememberIdempotent(idem, 201, { name, role: mrole, repos, token }))
    }
    if (parts[2] && req.method === 'DELETE') {
      const name = decodeURIComponent(parts[2])
      if (!/^[A-Za-z0-9._-]{1,60}$/.test(name)) return json(res, 400, { error: 'bad member name' })
      const before = readMembers()
      if (!before.some((m) => m.name === name)) return json(res, 404, { error: 'no such member' })
      /**
       * REVOCATION IS THREE THINGS, and doing only the first is what a stale key looks like.
       *
       * 1. drop the member row (all this used to do);
       * 2. rewrite authorized_keys, or their SSH key keeps working forever — and worse, if the name
       *    is later recreated, the OLD key's forced command still names the NEW person, handing
       *    their access to whoever held the old key; and
       * 3. bump the certificate epoch, so certificates already issued under this name stop
       *    verifying at once instead of at expiry.
       *
       * The epoch is bumped FIRST: if the ledger cannot be written we must not report a successful
       * revocation, and leaving the member in place is the recoverable half of that failure.
       */
      let epoch
      try {
        epoch = bumpEpoch(name)
      } catch (e) {
        return json(res, 500, { error: `could not revoke: ${e.message}` })
      }
      const after = before.filter((m) => m.name !== name)
      writeMembers(after)
      const written = syncAuthorizedKeys(after)
      audit('member-revoke', { name, by: me, epoch, authorizedKeys: written })
      return json(res, 200, { ok: true, revoked: name, epoch, authorizedKeys: written })
    }
    return json(res, 404, { error: 'unknown route' })
  }

  // ---- git repositories (same member list, same roles) ----
  if (parts[1] === 'repos') {
    // The owner authenticates with the root token, which deliberately has no member
    // row — so canAs() knows nothing about it and would refuse. Role IS the authority
    // for the owner; canAs() exists to scope MEMBERS. (Locked the owner out of their
    // own repositories until the suite caught it, 2026-08-31.)
    const isOwner = mayAdminister(role)
    if (!parts[2] && req.method === 'GET') {
      // `me` and `canon` both come from the verified identity, so an OIDC caller is scoped by the
      // role their groups mapped to — admin/manager see everything, lead/dev/viewer see their
      // `repos` scope — exactly the table in server/INSTALL-GIT.md.
      const names = isOwner ? allRepoNames() : visibleReposAs(MEMBERS, me, GIT_ROOT, canon)
      return json(res, 200, names.map((name) => ({ name, url: gitUrl(name) })))
    }
    if (!parts[2] && req.method === 'POST') {
      if (isReadOnly(role)) return json(res, 403, { error: 'read-only access', code: 'READ_ONLY' })
      if (!canon || ROLE_CAPS[canon].write === 'none') {
        return json(res, 403, { error: 'your role cannot create repositories', code: 'NO_CREATE' })
      }
      const name = String(body.name || '').trim()
      if (!isSafeRepoName(name)) return json(res, 400, { error: 'name must be letters, digits, dot, dash or underscore' })

      /**
       * A SCOPED creator has to end up with access to what they just made.
       *
       * `lead` and `dev` read and write only what their `repos` scope lists. Creating a repository
       * outside that scope produced a repository the creator could not then clone — the server
       * accepted the request, did the work, and handed back a URL that answered "no such
       * repository". Silently useless is the worst of the three possible outcomes.
       *
       * So: grant it transactionally, or refuse with a reason. The grant needs somewhere to write,
       * which means a member row; an OIDC caller who has never been added to the team has none, and
       * that is a policy answer ("ask an administrator"), not a 500.
       */
      const needsGrant = ROLE_CAPS[canon].read === 'scoped'
      let list = null
      let member = null
      if (needsGrant) {
        list = readMembers()
        member = list.find((m) => m.name === me) ?? null
        if (!member) {
          return json(res, 403, {
            error: `${me} has no team record on this server, so a new repository could not be granted to them. Ask an administrator to add you to the team first.`,
            code: 'NO_MEMBER_RECORD'
          })
        }
      }

      let made
      try {
        made = createRepoAtomically(name)
      } catch (e) {
        // Includes a failed hook install. Nothing was renamed into place, so there is nothing to
        // clean up and no half-made repository to find later.
        audit('repo-create-failed', { name, by: me, error: String(e?.message ?? e).slice(0, 200) })
        return json(res, 500, { error: `could not create the repository: ${e.message}` })
      }
      if (!made.ok) return json(res, 409, { error: 'repository exists', code: 'REPO_EXISTS' })

      if (needsGrant) {
        const scopes = Array.isArray(member.repos) ? member.repos : []
        if (!scopes.includes('*') && !scopes.includes(name)) {
          member.repos = [...scopes, name]
          try {
            writeMembers(list)
          } catch (e) {
            // The grant is the half that makes the repository usable. If it cannot be recorded,
            // undo the creation rather than leave an orphan its own creator cannot reach.
            try { fs.rmSync(made.dir, { recursive: true, force: true }) } catch { /* best effort */ }
            audit('repo-create-rollback', { name, by: me, error: String(e?.message ?? e).slice(0, 200) })
            return json(res, 500, { error: 'the repository could not be granted to you, so it was not created' })
          }
        }
      }

      audit('repo-create', { name, by: me, role: canon })
      return json(res, 201, rememberIdempotent(idem, 201, { name, url: gitUrl(name) }))
    }
    const name = parts[2] ? decodeURIComponent(parts[2]) : ''
    if (!isSafeRepoName(name)) return json(res, 404, { error: 'unknown route' })
    // Same disclosure rule as the shell: a repo you cannot read does not exist.
    if (!isOwner && !canAs(MEMBERS, me, name, 'read', canon)) return json(res, 404, { error: 'no such repository' })
    if (req.method === 'GET') return json(res, 200, { name, url: gitUrl(name) })
    if (req.method === 'DELETE') {
      if (!mayAdminister(role)) return json(res, 403, { error: 'only the owner can delete a repository' })
      const dir = path.join(GIT_ROOT, name + '.git')
      if (!fs.existsSync(dir)) return json(res, 404, { error: 'no such repository' })
      // Moved, never rm -rf'd: a bare repo is the only copy of work that is not on
      // anyone's laptop, and "delete the repo" is the most expensive typo here.
      fs.mkdirSync(TRASH, { recursive: true })
      fs.renameSync(dir, path.join(TRASH, `${name}.git.${Date.now()}`))
      audit('repo-delete', { name, by: me })
      return json(res, 200, { ok: true, recoverable: true })
    }
    return json(res, 404, { error: 'unknown route' })
  }

  // ---- a member's SSH keys (owner only) — this is what actually grants git access ----
  if (parts[1] === 'keys') {
    if (!mayAdminister(role)) return json(res, 403, { error: 'owner only' })
    // NOT `who` — that is the authenticated caller. Shadowing it here once meant the audit trail
    // named the subject of the change instead of the person making it.
    const subject = parts[2] ? decodeURIComponent(parts[2]) : ''
    const list = readMembers()
    const m = list.find((x) => x.name === subject)
    if (!m) return json(res, 404, { error: 'no such member' })
    if (req.method === 'GET') return json(res, 200, { name: subject, sshKeys: m.sshKeys ?? [], repos: m.repos ?? [] })
    if (req.method === 'POST') {
      const key = String(body.key || '').trim()
      if (!isSafeSshKey(key)) return json(res, 400, { error: 'that does not look like an OpenSSH public key' })
      m.sshKeys = [...new Set([...(m.sshKeys ?? []), key])]
      if (body.repos !== undefined) m.repos = Array.isArray(body.repos) ? body.repos.filter(isScope) : []
      writeMembers(list)
      const written = syncAuthorizedKeys(list)
      audit('key-add', { name: subject, by: me })
      return json(res, 201, { name: subject, sshKeys: m.sshKeys.length, authorizedKeys: written })
    }
    if (req.method === 'DELETE') {
      const key = String(body.key || '').trim()
      m.sshKeys = (m.sshKeys ?? []).filter((k) => k !== key)
      writeMembers(list)
      const written = syncAuthorizedKeys(list)
      audit('key-remove', { name: subject, by: me })
      return json(res, 200, { ok: true, sshKeys: m.sshKeys.length, authorizedKeys: written })
    }
    return json(res, 404, { error: 'unknown route' })
  }

  if (parts[1] !== 'workspaces') return json(res, 404, { error: 'unknown route' })
  const [, , id, action, snapId, sub] = parts

  // ---- role gates: viewers are read-only; editors cannot delete workspaces ----
  const writeMethods = req.method !== 'GET'
  const isKeepalive = action === 'keepalive'
  if (isReadOnly(role) && writeMethods && !isKeepalive) return json(res, 403, { error: 'read-only access' })
  if (!mayAdminister(role) && req.method === 'DELETE' && !action) return json(res, 403, { error: 'only the owner can delete workspaces' })

  // POST /v1/workspaces — create
  if (!id && req.method === 'POST') {
    const wid = randomBytes(5).toString('hex')
    const dir = path.join(WS_DIR, wid)
    fs.mkdirSync(dir, { recursive: true })
    const tpl = TEMPLATES[body.template]
    if (tpl) for (const [f, c] of Object.entries(tpl)) fs.writeFileSync(path.join(dir, f), c)
    const meta = { id: wid, name: String(body.name || wid).slice(0, 80), state: 'ready', ownedBy: me, createdAt: Date.now(), lastSeen: Date.now() }
    writeMeta(meta)
    audit('workspace-create', { id: wid, by: me })
    return json(res, 201, pub(meta))
  }

  // GET /v1/workspaces — list. Scoped, because an unscoped list was itself the disclosure: it
  // handed every caller the id, name and ssh root of every tenant on the box, which is the
  // reconnaissance step for all of the id-scoped attacks below.
  if (!id && req.method === 'GET') {
    return json(res, 200, listMeta().filter((m) => mayTouchWorkspace(m, me, role)).map(pub))
  }

  const meta = id ? readMeta(id) : null
  if (!meta) return json(res, 404, { error: 'no such workspace' })
  // Ownership, once, before ANY id-scoped route runs. 404 rather than 403 on purpose: the same
  // answer for "does not exist" and "not yours" is the convention atomic-git-shell already uses
  // for repositories, and it keeps a stranger's workspace ids from being confirmed by probing.
  if (!mayTouchWorkspace(meta, me, role)) {
    audit('workspace-denied', { id, by: me, method: req.method, action: action ?? null })
    return json(res, 404, { error: 'no such workspace' })
  }

  // GET /v1/workspaces/:id
  if (!action && req.method === 'GET') return json(res, 200, pub(meta))

  // DELETE /v1/workspaces/:id — trash-can, never a hard delete
  if (!action && req.method === 'DELETE') {
    const dir = path.join(WS_DIR, id)
    if (fs.existsSync(dir)) fs.renameSync(dir, path.join(TRASH, `${id}-${Date.now()}`))
    fs.rmSync(metaPath(id), { force: true })
    audit('workspace-delete', { id, by: me, ownedBy: meta.ownedBy ?? null })
    // Trash is purged after 7 days by a cron/systemd timer in production.
    return json(res, 200, { ok: true })
  }

  if (action === 'start' && req.method === 'POST') {
    meta.state = 'ready'
    meta.lastSeen = Date.now()
    writeMeta(meta)
    return json(res, 200, pub(meta))
  }
  if (action === 'stop' && req.method === 'POST') {
    meta.state = 'suspended'
    writeMeta(meta)
    return json(res, 200, pub(meta))
  }
  if (action === 'keepalive' && req.method === 'POST') {
    meta.lastSeen = Date.now()
    if (body.busy) meta.busyUntil = Date.now() + 5 * 60_000
    writeMeta(meta)
    return json(res, 200, { ok: true })
  }

  // Snapshots: tar of the workspace dir, sidecar json metadata.
  if (action === 'snapshots') {
    const sdir = path.join(SNAPS, id)
    fs.mkdirSync(sdir, { recursive: true })

    if (!snapId && req.method === 'POST') {
      const sid = `${Date.now()}`
      const tgz = path.join(sdir, `${sid}.tgz`)
      execFileSync('tar', ['czf', tgz, '-C', path.join(WS_DIR, id), '.'])
      fs.writeFileSync(
        path.join(sdir, `${sid}.json`),
        JSON.stringify({ id: sid, name: String(body.name || sid).slice(0, 80), description: body.description, ts: Date.now(), bytes: fs.statSync(tgz).size })
      )
      return json(res, 201, { ok: true, id: sid })
    }
    if (!snapId && req.method === 'GET') {
      const list = fs
        .readdirSync(sdir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')))
        .sort((a, b) => b.ts - a.ts)
      return json(res, 200, list)
    }
    if (snapId && sub === 'restore' && req.method === 'POST') {
      if (!/^[\w-]+$/.test(snapId)) return json(res, 400, { error: 'bad snapshot id' })
      const tgz = path.join(sdir, `${snapId}.tgz`)
      if (!fs.existsSync(tgz)) return json(res, 404, { error: 'no such snapshot' })
      const dir = path.join(WS_DIR, id)
      // Destructive and unrecoverable: this empties the live workspace before untarring over it.
      // It is logged BEFORE the delete, so a restore that dies half-way still leaves a trail.
      audit('workspace-restore', { id, by: me, ownedBy: meta.ownedBy ?? null, snapshot: snapId })
      for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
      execFileSync('tar', ['xzf', tgz, '-C', dir])
      return json(res, 200, { ok: true })
    }
  }

  return json(res, 404, { error: 'unknown route' })
}

const PORT = process.env.ATOMIC_WS_PORT !== undefined ? Number(process.env.ATOMIC_WS_PORT) : 8791
const HOST = process.env.ATOMIC_WS_HOST || '127.0.0.1'
server.listen(PORT, HOST, () => {
  const a = server.address()
  console.log(`atomic-workspaced listening on ${HOST}:${typeof a === 'object' && a ? a.port : PORT} · root ${ROOT}`)
})
