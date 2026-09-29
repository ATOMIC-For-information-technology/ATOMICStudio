#!/usr/bin/env node
/**
 * atomic-git-shell — the ONLY thing an authenticated developer is allowed to run.
 *
 * TWO WAYS IN, and identity is un-spoofable in both.
 *
 * ── 1. Certificates (managed ATOMIC servers) ──────────────────────────────────────────────────
 * One CA replaces every authorized_keys line. sshd is configured with:
 *
 *   TrustedUserCAKeys /etc/atomic/ssh-ca.pub
 *   Match User git
 *       ForceCommand /usr/local/bin/atomic-git-shell
 *       ExposeAuthInfo yes
 *
 * `ForceCommand` takes no %-tokens, so the name cannot arrive in argv. It arrives instead in the
 * certificate sshd ACCEPTED, which `ExposeAuthInfo` writes to a file named by $SSH_USER_AUTH —
 * written by sshd after authentication, never chosen by the client. atomic-git-cert.mjs re-verifies
 * the CA signature on that certificate before a single field of it is believed, because the file is
 * merely *named* by an environment variable and a certificate carries its own (public) CA key.
 *
 * Every certificate carries three principals: the shared login account (so sshd accepts it for
 * `git`), the certified `<name>`, and exactly one `role:<role>`. The ROLE therefore comes from the
 * CA, not from a file an administrator has to remember to edit.
 *
 * ── 2. authorized_keys (standalone / BYO servers) ─────────────────────────────────────────────
 * The original scheme, unchanged and still supported:
 *
 *   command="/usr/local/bin/atomic-git-shell alice",no-pty,no-port-forwarding,\
 *     no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... alice@laptop
 *
 * The name baked into that line cannot be spoofed either — sshd substitutes the forced command for
 * whatever the client asked for. Here the role comes from members.json, because a key line has
 * nowhere to carry one.
 *
 * ── What is NEVER trusted ─────────────────────────────────────────────────────────────────────
 * The client's environment. $ATOMIC_GIT_USER and $ATOMIC_GIT_ROLE are DELETED on entry before
 * anything reads them: they are outputs of this program (passed down to the pre-receive hook), not
 * inputs. An sshd with a careless `AcceptEnv ATOMIC_*` would otherwise let a client name itself.
 * Missing or malformed identity, from either path, is refused — never attributed to nobody.
 *
 * The gate is a pure function of (identity, $SSH_ORIGINAL_COMMAND), which is why every hostile
 * case is tested with no sshd running at all.
 *
 * NOTHING here goes through a shell. The repository is passed to git as a single argv element, so
 * neither shell metacharacters nor a leading '-' can become anything but a (rejected) filename —
 * `--upload-pack=<cmd>` is the classic way a "URL" turns into code execution, and an argv array
 * closes it at the boundary.
 *
 * ENV (server-side configuration only; none of it comes from the client):
 *   ATOMIC_GIT_ROOT     bare repos live here   (default /srv/atomic/git)
 *   ATOMIC_GIT_MEMBERS  members.json           (default <root>/../members.json)
 *   ATOMIC_GIT_AUDIT    JSONL audit trail      (default <root>/../git-audit.log)
 *   ATOMIC_GIT_CA_PUB   the CA public key certificates must be signed by
 *   ATOMIC_GIT_EPOCHS   revocation ledger      (default <root>/../identity-epochs.json)
 *   ATOMIC_GIT_ACCOUNT  the shared login account certificates must name (default: the Unix user)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { canAs, effectiveRole, resolveRepo, DEFAULT_ROOT } from './atomic-git-acl.mjs'
import { certificateFromAuthInfo, currentEpoch, readEpochs, readPublicKeyBlob, verifyCertificate } from './atomic-git-cert.mjs'

/** Where our own modules live, passed to the hook so a COPIED hook can still find them. */
const LIB = path.dirname(fileURLToPath(import.meta.url))

const ROOT = process.env.ATOMIC_GIT_ROOT || DEFAULT_ROOT
const MEMBERS = process.env.ATOMIC_GIT_MEMBERS || path.join(path.dirname(path.resolve(ROOT)), 'members.json')
const AUDIT = process.env.ATOMIC_GIT_AUDIT || path.join(path.dirname(path.resolve(ROOT)), 'git-audit.log')
const EPOCHS = process.env.ATOMIC_GIT_EPOCHS || path.join(path.dirname(path.resolve(ROOT)), 'identity-epochs.json')
const CA_PUB = process.env.ATOMIC_GIT_CA_PUB || ''

/** The three verbs git actually speaks, and what each one needs. */
const VERBS = {
  'git-upload-pack': { bin: 'git-upload-pack', access: 'read' },
  'git-upload-archive': { bin: 'git-upload-archive', access: 'read' },
  'git-receive-pack': { bin: 'git-receive-pack', access: 'write' }
}

/**
 * Parse what the client asked for. An ALLOW-LIST of three verbs with one argument:
 * anything else — a second argument, an option, a pipeline, a bare shell — is not
 * "sanitised", it is refused. There is no request shape outside this set that a
 * git client ever legitimately sends.
 */
export function parseCommand(original) {
  if (typeof original !== 'string') return null
  const cmd = original.trim()
  if (!cmd || cmd.length > 4096 || /[\r\n\0]/.test(cmd)) return null
  // `git-upload-pack 'x.git'` and the older `git upload-pack 'x.git'` are the same request.
  const m = /^git[- ](upload-pack|receive-pack|upload-archive)[ \t]+(?:'((?:[^'\\]|\\.)*)'|"([^"]*)"|([^\s'";|&<>()$`]+))$/.exec(cmd)
  if (!m) return null
  const verb = 'git-' + m[1]
  const rawPath = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? m[4])
  if (!rawPath || rawPath.startsWith('-')) return null
  return { verb, bin: VERBS[verb].bin, access: VERBS[verb].access, rawPath }
}

function audit(entry) {
  try {
    fs.appendFileSync(AUDIT, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8')
  } catch {
    /* the audit trail must never be the reason a push fails */
  }
}

/** Refuse loudly on stderr — the client shows this verbatim — and exit non-zero. */
function deny(user, reason, detail) {
  audit({ event: 'deny', user, reason, detail })
  process.stderr.write(`atomic-git: ${reason}\n`)
  process.exit(128)
}

/**
 * Who is on the other end, as `{ name, role, via }` — or `{ error }`.
 *
 * argv[1] present  -> the authorized_keys path. sshd baked the name into the forced command, so
 *                     it is proven; the role comes from members.json.
 * argv[1] absent   -> the certificate path. The identity comes from the certificate sshd accepted,
 *                     re-verified here against the configured CA.
 *
 * There is no third option. An unauthenticated caller reaching this program has no identity, and
 * the answer is a refusal rather than a guess.
 */
export function resolveIdentity(argv, env) {
  const named = argv[0]
  if (named) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(named)) return { error: 'this key is not configured for git access' }
    return { name: named, role: effectiveRole(MEMBERS, named, null), via: 'authorized_keys' }
  }

  const authInfoPath = env.SSH_USER_AUTH
  if (!authInfoPath) {
    // Either sshd is missing `ExposeAuthInfo yes`, or this program was reached without sshd at
    // all. Both are configuration failures that must not resolve to an identity.
    return { error: 'this server could not establish who you are — no certificate was presented' }
  }
  let authInfo
  try {
    authInfo = fs.readFileSync(authInfoPath, 'utf8')
  } catch {
    return { error: 'this server could not read the credential you authenticated with' }
  }
  const certLine = certificateFromAuthInfo(authInfo)
  if (!certLine) return { error: 'git access on this server requires a certificate — sign in to Studio first' }

  const caBlob = CA_PUB ? readPublicKeyBlob(CA_PUB) : null
  const account = env.ATOMIC_GIT_ACCOUNT || safeUsername()
  const v = verifyCertificate(certLine, { caPublicKeyBlob: caBlob, loginAccount: account })
  if (!v.ok) return { error: v.reason }

  // REVOCATION. The epoch in the certificate must be the one this server currently expects for
  // that name. Deleting a member bumps it, so an old certificate — and a recreated account with
  // the same name — stop matching at once instead of at expiry.
  const expected = currentEpoch(readEpochs(EPOCHS), v.name)
  if (expected === null) return { error: 'this server could not check whether your access is still current' }
  if (expected !== v.epoch) return { error: 'your access was revoked or reissued — sign in to Studio again' }

  return { name: v.name, role: v.role, via: 'certificate' }
}

/** The Unix account sshd logged us in as. Used only as the default certificate principal. */
function safeUsername() {
  try {
    return os.userInfo().username
  } catch {
    return ''
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  // The client's environment is INPUT to nothing. These two are what we hand DOWN to the hook, and
  // an sshd configured with a careless `AcceptEnv` must not be able to pre-set them.
  delete env.ATOMIC_GIT_USER
  delete env.ATOMIC_GIT_ROLE

  const who = resolveIdentity(argv, env)
  if (who.error) deny('?', who.error)
  const { name: user, role } = who
  // A name with no usable role is not an identity. Under authorized_keys this is a members.json
  // typo; under certificates it cannot happen, because the CA signs the role.
  if (!role) deny(user, 'your account has no role on this server — ask an administrator')

  const original = env.SSH_ORIGINAL_COMMAND
  if (!original) {
    // A plain `ssh git@host` with no command. git-shell says the same thing, and
    // saying it plainly beats dropping someone into a shell they should not have.
    audit({ event: 'deny', user, reason: 'interactive' })
    process.stderr.write('atomic-git: this account is for git access only — no interactive shell.\n')
    process.exit(128)
  }

  const req = parseCommand(original)
  if (!req) deny(user, 'that command is not allowed here', original.slice(0, 200))

  const repo = resolveRepo(ROOT, req.rawPath)
  // The SAME message whether the repo is missing or merely forbidden: telling an
  // unauthorised caller which repositories exist is itself a disclosure.
  if (!repo) deny(user, 'no such repository', req.rawPath.slice(0, 200))
  if (!canAs(MEMBERS, user, repo.name, req.access, role)) deny(user, 'no such repository', `${req.access} ${repo.name}`)

  audit({ event: 'allow', user, role, via: who.via, repo: repo.name, access: req.access, verb: req.verb })

  const child = spawn(req.bin, [repo.dir], {
    stdio: 'inherit',
    env: {
      ...env,
      // The push gate needs to know WHO and WHAT, and it cannot ask sshd. Passing them here is the
      // only link between the authenticated session and the pre-receive hook. They are set AFTER
      // the spread, so nothing the client sent can survive into the hook's view of itself.
      ATOMIC_GIT_USER: user,
      ATOMIC_GIT_ROLE: role,
      ATOMIC_GIT_REPO: repo.name,
      ATOMIC_GIT_MEMBERS: MEMBERS,
      ATOMIC_GIT_AUDIT: AUDIT,
      ATOMIC_GIT_LIB: LIB
    }
  })
  child.on('error', () => {
    process.stderr.write(`atomic-git: ${req.bin} is not installed on this server.\n`)
    process.exit(127)
  })
  child.on('exit', (code, signal) => process.exit(signal ? 128 : (code ?? 0)))
}

// Only run when executed directly, so the parser can be imported by the tests.
// Same realpath test as the hook, for the same reason: an install that renames or
// symlinks this file must not turn the entry point into a no-op.
const isMain = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? '')
  } catch {
    return false
  }
})()
if (isMain) main()
