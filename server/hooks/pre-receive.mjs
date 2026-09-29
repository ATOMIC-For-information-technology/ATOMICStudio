#!/usr/bin/env node
/**
 * pre-receive — the server-side gate. Runs inside the bare repo AFTER the objects
 * arrive but BEFORE any ref moves, so a non-zero exit means nothing changed.
 *
 * Install per repo (or via core.hooksPath for all of them):
 *   ln -s /usr/local/lib/atomic/pre-receive.mjs /srv/atomic/git/x.git/hooks/pre-receive
 *
 * Copying the file works too — see loadAcl() below for why that needed care.
 *
 * WHO is pushing comes from $ATOMIC_GIT_USER, set by atomic-git-shell just before
 * it exec'd git-receive-pack. A hook cannot ask sshd anything, so that variable is
 * the only link back to the authenticated key. If it is missing the push is
 * REFUSED rather than attributed to nobody: an unauthenticated path into this hook
 * would mean someone reached receive-pack without going through the forced
 * command, which is exactly the thing worth stopping.
 *
 * Two families of check, both cheap and both decidable from the push alone. There
 * is deliberately no typecheck/build here — that would need a toolchain on the box
 * and turn a git server into a CI runner.
 *
 *   content   conflict markers · hardcoded secrets · oversized blobs
 *   history   no deletion or force-push of a protected branch · author identity
 *
 * ENV:
 *   ATOMIC_GIT_PROTECTED   comma-separated refs (default refs/heads/main,refs/heads/master)
 *   ATOMIC_GIT_MAX_BLOB    bytes, default 10485760 (10 MB)
 *   ATOMIC_GIT_STRICT_AUTHOR  '1' to require the member to declare emails
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Find the shared ACL module.
 *
 * A relative import is NOT enough: git hooks are commonly installed by COPYING the
 * file into <repo>.git/hooks/, which puts '../atomic-git-acl.mjs' inside the repo
 * where it does not exist. (A symlink happens to work, because node resolves from
 * the realpath — so the copy install would have failed in production while every
 * symlinked test passed. Caught by the suite, 2026-08-31.)
 *
 * atomic-git-shell therefore exports ATOMIC_GIT_LIB pointing at its own directory,
 * and that is tried first; the relative path remains as the fallback for a direct
 * run. If neither resolves, the author check cannot run and says so rather than
 * silently passing.
 */
async function loadAcl() {
  const candidates = [
    process.env.ATOMIC_GIT_LIB ? path.join(process.env.ATOMIC_GIT_LIB, 'atomic-git-acl.mjs') : null,
    fileURLToPath(new URL('../atomic-git-acl.mjs', import.meta.url))
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      return await import(pathToFileURL(c).href)
    } catch {
      /* try the next candidate */
    }
  }
  return null
}
const ACL = await loadAcl()

const ZERO = '0'.repeat(40)
// git's own constant for "nothing", so a brand-new branch can be diffed like any other.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const USER = process.env.ATOMIC_GIT_USER || ''
/**
 * The role atomic-git-shell resolved, when it resolved one.
 *
 * Under CERTIFICATES this is the role the CA signed, and it is the authority — members.json may
 * not even have a row for this person. Under authorized_keys the shell copies the members.json
 * role here, so the two paths look identical from inside the hook. Absent, `effectiveRole` falls
 * back to members.json, and a lookup that also fails leaves the role null: fail closed.
 *
 * It is set by the shell AFTER spreading the client's environment, so a client cannot pre-set it.
 */
const ROLE = process.env.ATOMIC_GIT_ROLE || ''
const REPO = process.env.ATOMIC_GIT_REPO || path.basename(process.cwd()).replace(/\.git$/, '')
const MEMBERS = process.env.ATOMIC_GIT_MEMBERS || ''
const AUDIT = process.env.ATOMIC_GIT_AUDIT || ''
const PROTECTED = (process.env.ATOMIC_GIT_PROTECTED || 'refs/heads/main,refs/heads/master')
  .split(',').map((s) => s.trim()).filter(Boolean)
const MAX_BLOB = parseInt(process.env.ATOMIC_GIT_MAX_BLOB ?? '', 10) || 10 * 1024 * 1024
/**
 * How much history one push may introduce before this hook stops inspecting and starts refusing.
 *
 * There used to be a silent `commits.slice(0, 200)` in the author check: a push of 201 commits had
 * its 201st onwards waved through unverified, which is exactly the shape an attacker wants — pad
 * the push and the gate stops looking. A bound is still necessary (a hook must terminate), but it
 * has to be a REFUSAL, not a bypass. Push in smaller batches, or raise this deliberately.
 */
const MAX_PUSH_COMMITS = parseInt(process.env.ATOMIC_GIT_MAX_PUSH_COMMITS ?? '', 10) || 2000
/** The same idea for objects: a push that introduces more than this is refused, never half-checked. */
const MAX_PUSH_OBJECTS = parseInt(process.env.ATOMIC_GIT_MAX_PUSH_OBJECTS ?? '', 10) || 50000

/**
 * The app's Secret Leak Guard rules, verbatim from src/main/security.ts.
 *
 * DUPLICATED ON PURPOSE, and the duplication is the lesser evil: this hook must
 * run on a server with nothing installed but node and git, so it cannot import
 * from the desktop app. Keep the two in step — if you add a rule there, add it
 * here, and the test suite asserts the id lists match.
 */
const RULES = [
  { id: 'aws-key', re: /AKIA[0-9A-Z]{16}/, what: 'an AWS access key' },
  { id: 'private-key', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/, what: 'a private key' },
  { id: 'google-key', re: /AIza[0-9A-Za-z_-]{35}/, what: 'a Google API key' },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_]{20,}/, what: 'an OpenAI-style API key' },
  { id: 'slack-token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/, what: 'a Slack token' },
  { id: 'generic-secret', re: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i, what: 'a hardcoded password or secret' },
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: 'a JWT' }
]
const PLACEHOLDER = /(your[_-]?key|example|placeholder|xxx+|changeme|dummy|test[_-]?key|not-needed|redacted|\*{3,})/i

/**
 * Run git and return stdout — INCLUDING when it exits non-zero.
 *
 * `git diff --check` exits 1 precisely when it has something to report, so a
 * helper that swallowed output on a non-zero exit threw away the only rows that
 * mattered and the marker gate silently passed everything. Anything genuinely
 * broken still yields '' and the caller finds nothing, which is the same as before.
 */
/**
 * Thrown when git produced MORE output than maxBuffer, so what came back is a prefix of the truth.
 *
 * This is the one failure `git()` must never hand back as data. Node kills the child with SIGTERM
 * and reports ENOBUFS, and `e.stdout` still holds the first maxBuffer bytes — indistinguishable, to
 * a caller that only looks at the string, from a complete result. `scanAddedLines` streams the
 * whole `git log -p` of every new commit through this helper, so a push padded with a few
 * multi-megabyte text files (comfortably inside the commit, object and per-blob caps) pushes that
 * diff past 64 MB, the output is cut, and every secret and conflict marker after the cut is never
 * examined. The gate would pass by not looking, which is the one outcome this file exists to
 * prevent — so truncation is refused, like every other limit here, rather than silently accepted.
 */
class TruncatedOutput extends Error {}

/** ENOBUFS is how spawnSync reports a maxBuffer overrun. Verified against Node 22. */
const isTruncation = (e) => e?.code === 'ENOBUFS'

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    if (isTruncation(e)) throw new TruncatedOutput(`git ${args[0]} produced more output than the server will read`)
    return typeof e?.stdout === 'string' ? e.stdout : e?.stdout?.toString('utf8') ?? ''
  }
}
/** A size a human can read. `0 MB` for a 64 KB limit told nobody anything. */
const human = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`)

/** Same, with stdin — `cat-file --batch-check` is the only caller and it needs one. */
const gitIn = (input, ...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    if (isTruncation(e)) throw new TruncatedOutput(`git ${args[0]} produced more output than the server will read`)
    return typeof e?.stdout === 'string' ? e.stdout : e?.stdout?.toString('utf8') ?? ''
  }
}
const gitOk = (...args) => {
  try {
    execFileSync('git', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function audit(entry) {
  if (!AUDIT) return
  try {
    fs.appendFileSync(AUDIT, JSON.stringify({ ts: Date.now(), repo: REPO, user: USER, ...entry }) + '\n', 'utf8')
  } catch {
    /* never block a push because the log is unwritable */
  }
}

const problems = []
const reject = (ref, msg) => problems.push({ ref, msg })

/** Every ref update the client is asking for, from stdin. */
function readUpdates() {
  let raw = ''
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [oldSha, newSha, ref] = l.split(/\s+/)
      return { oldSha, newSha, ref }
    })
    .filter((u) => u.ref)
}

/**
 * May this person move a protected ref at all?
 *
 * FAILS CLOSED when the ACL cannot be loaded or the member list is unknown. That differs from
 * `checkAuthor`, which warns and continues, and the asymmetry is deliberate: skipping an author
 * check leaves a mislabelled commit, while skipping this one lets anybody rewrite `main`. When
 * the highest-risk operation cannot be authorised, refusing is the only safe answer.
 *
 * MIGRATION (2026-09-01): before roles existed, any member with write access could push to
 * `main`. A legacy `editor` now maps to `dev` and is refused here. Give anyone who legitimately
 * pushes to a protected branch the `lead` role in members.json.
 */
function mayPushProtected(ref) {
  if (!ACL || typeof ACL.canPushProtectedAs !== 'function' || typeof ACL.effectiveRole !== 'function') {
    reject(ref, 'the server could not check your permissions, so it refused a protected-branch push.')
    return false
  }
  // With a certificate the role arrives signed and members.json need not know this person at all,
  // so an empty MEMBERS is no longer automatically fatal — but a missing ROLE with no member list
  // to fall back on still is.
  const role = ACL.effectiveRole(MEMBERS, USER, ROLE || null)
  if (!role) {
    reject(ref, 'the server could not establish your role, so it refused a protected-branch push.')
    return false
  }
  if (!ACL.canPushProtectedAs(MEMBERS, USER, REPO, role)) {
    reject(ref, `${ref} is protected — your role cannot push to it directly. Push a branch and open a merge request.`)
    return false
  }
  return true
}

function checkHistory({ oldSha, newSha, ref }) {
  const isProtected = PROTECTED.includes(ref)
  if (!isProtected) return
  // The role gate runs FIRST: someone who may not touch this ref at all should be told that,
  // not handed a fast-forward lecture about a push that was never going to be allowed.
  if (!mayPushProtected(ref)) return
  if (newSha === ZERO) return reject(ref, `${ref} is protected — it cannot be deleted.`)
  if (oldSha === ZERO) return
  // Fast-forward means the old tip is still reachable. If it is not, this push
  // would discard commits that are already on the server for everyone else.
  if (!gitOk('merge-base', '--is-ancestor', oldSha, newSha)) {
    reject(ref, `${ref} is protected — this would rewrite history someone else already has. Rebase onto it and push again.`)
  }
}

/**
 * Every commit this update introduces that the server did not already have.
 *
 * `--not --all` is what makes this the NEW set rather than the diff between two tips: pre-receive
 * runs before any ref moves, so `--all` still names the old state and everything left is genuinely
 * arriving now. That distinction is the whole point — a secret added in commit 3 and removed in
 * commit 5 is invisible to a tip-to-tip diff and is sitting in the object store forever.
 */
function newCommits({ newSha }) {
  if (!newSha || newSha === ZERO) return []
  // `oldSha` is deliberately unused: it is ALREADY excluded by `--all` (the ref has not moved
  // yet), and naming it explicitly would only reintroduce the tip-to-tip thinking this replaced.
  return git('rev-list', newSha, '--not', '--all').split('\n').map((s) => s.trim()).filter(Boolean)
}

function checkAuthor(ref, commits) {
  if (!ACL) {
    // The server is misconfigured, not the push. Say so instead of pretending the
    // check passed; under STRICT that is fatal, otherwise it is a loud no-op.
    process.stderr.write('atomic-git: warning — the ACL module could not be loaded, author verification skipped.\n')
    if (process.env.ATOMIC_GIT_STRICT_AUTHOR === '1') reject(ref, 'the server could not load its member list.')
    return
  }
  const member = MEMBERS ? ACL.memberByName(MEMBERS, USER) : null
  const emails = Array.isArray(member?.emails) ? member.emails.map((e) => String(e).toLowerCase()) : []
  if (!emails.length) {
    // Not configured. Refusing everyone because an admin has not filled in a field
    // would be a worse failure than not checking, so this is opt-in via STRICT.
    if (process.env.ATOMIC_GIT_STRICT_AUTHOR === '1') {
      reject(ref, `${USER} has no verified email addresses configured on the server, and strict author checking is on.`)
    }
    return
  }
  // EVERY commit in the bounded set — no slice. A push larger than the bound was already refused
  // by `run()` before we got here, so "checked all of them" is now literally true.
  for (const c of commits) {
    const who = git('log', '-1', '--format=%ae%x1f%ce', c).trim().split('\x1f')
    for (const addr of who) {
      if (addr && !emails.includes(addr.toLowerCase())) {
        reject(ref, `commit ${c.slice(0, 8)} is attributed to ${addr}, which is not one of ${USER}'s verified addresses.`)
        return
      }
    }
  }
}

/**
 * Secrets, scanned over the ADDED LINES OF EVERY NEW COMMIT.
 *
 * Two properties have to hold at once and only this shape gives both:
 *  - a secret added and then removed later in the same push is still refused (the tip-to-tip diff
 *    shows nothing, but commit 3 added it and the blob is in the pack forever); and
 *  - a secret that is ALREADY in the server's history does not block every future push of the file
 *    it lives in. Scanning whole new blobs would do exactly that, and leave no way to recover.
 *
 * One `git log -p` covers the whole set in one process. `--cc` gives merge commits their combined
 * diff, so a secret introduced by a conflict resolution is seen too; the marker column is
 * `nParents` wide there, which is why the parents are read from the format line rather than assumed.
 */
function scanAddedLines(commits, onAdded) {
  if (!commits.length) return
  const out = git(
    'log', '--no-color', '--no-renames', '--unified=0', '--cc', '-p',
    '--format=%x01%H %P', '--no-walk=unsorted', ...commits
  )
  let width = 1
  let file = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('\x01')) {
      width = Math.max(1, line.slice(1).trim().split(/\s+/).length - 1)
      file = ''
      continue
    }
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^[ab]\//, '')
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('\\')) continue
    const marker = line.slice(0, width)
    if (marker.length < width) continue
    if (!/^[+ ]+$/.test(marker) || !marker.includes('+')) continue
    onAdded(line.slice(width), file)
  }
}

/**
 * Blob sizes, over every NEW OBJECT rather than the final tree.
 *
 * A 500 MB accident committed and then removed two commits later is still in the pack the server
 * just received, and a bare repo never forgets. `rev-list --objects` enumerates exactly the objects
 * this push is adding; one `cat-file --batch-check` sizes all of them in a single process.
 */
function checkNewBlobs(ref, update) {
  if (!update.newSha || update.newSha === ZERO) return
  const listed = git('rev-list', '--objects', update.newSha, '--not', '--all')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (listed.length > MAX_PUSH_OBJECTS) {
    reject(ref, `this push introduces ${listed.length} objects, over the ${MAX_PUSH_OBJECTS} the server will inspect. Push it in smaller pieces.`)
    return
  }
  const pathOf = new Map()
  const shas = []
  for (const row of listed) {
    const sp = row.indexOf(' ')
    const sha = sp === -1 ? row : row.slice(0, sp)
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue
    if (sp !== -1 && !pathOf.has(sha)) pathOf.set(sha, row.slice(sp + 1))
    shas.push(sha)
  }
  if (!shas.length) return
  const report = gitIn(shas.join('\n') + '\n', 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)')
  const over = []
  for (const line of report.split('\n')) {
    const m = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(line.trim())
    if (!m) continue
    const size = parseInt(m[2], 10)
    if (Number.isFinite(size) && size > MAX_BLOB) {
      over.push(`${pathOf.get(m[1]) || m[1].slice(0, 8)} is ${human(size)}`)
    }
  }
  if (over.length) {
    reject(ref, `${[...new Set(over)].slice(0, 5).join(', ')} — over the ${human(MAX_BLOB)} limit. Keep large files out of git; removing one in a later commit of the same push does not help, because the object is pushed either way.`)
  }
}

function checkContent(ref, update, commits) {
  const { oldSha, newSha } = update
  if (newSha === ZERO) return
  const base = oldSha === ZERO ? EMPTY_TREE : oldSha

  // 1. Conflict markers — git's OWN detector, the same one the client uses at
  //    commit time (`git diff --cached --check`), so the two can never disagree.
  //    --check also reports whitespace errors; only the marker rows are fatal.
  //    This one IS tip-to-tip on purpose: a marker resolved later in the same push is not a
  //    problem, because the tree everyone will check out is clean.
  const check = git('diff', '--check', base, newSha)
  const marked = [...new Set(
    check.split('\n').filter((l) => /leftover conflict marker/i.test(l)).map((l) => l.split(':')[0].trim()).filter(Boolean)
  )]
  if (marked.length) reject(ref, `unresolved conflict markers in ${marked.slice(0, 5).join(', ')}.`)

  // 2. Secrets — added lines of every new commit. See scanAddedLines().
  const found = []
  scanAddedLines(commits, (text, file) => {
    for (const r of RULES) {
      const m = r.re.exec(text)
      // Test the placeholder filter against the MATCHED secret, not the whole line,
      // so an `example.com` elsewhere on the line cannot suppress a real key.
      if (m && !PLACEHOLDER.test(m[0])) found.push(`${r.what} in ${file || '(unknown file)'}`)
    }
  })
  if (found.length) {
    reject(ref, `this push adds ${[...new Set(found)].slice(0, 5).join('; ')}. Remove it, rotate the credential, and push again. Deleting it in a later commit of the same push does not help — the object is still sent.`)
  }

  // 3. Oversized blobs — every new object, not the final tree. See checkNewBlobs().
  checkNewBlobs(ref, update)
}

export function run() {
  if (!USER) {
    process.stderr.write('atomic-git: this push did not come through atomic-git-shell — refusing.\n')
    return 1
  }
  const updates = readUpdates()
  for (const u of updates) {
    // Same rule as every other limit in this file: a check the server could not COMPLETE refuses
    // the ref, it does not pass it. Without this, a push whose diff overran git()'s buffer came
    // back as a truncated string that read exactly like a clean result, and the secret and
    // conflict-marker scans silently examined only the part that fit.
    try {
      checkHistory(u)
      const commits = newCommits(u)
      if (commits.length > MAX_PUSH_COMMITS) {
        // REFUSED, not truncated. The old code silently stopped verifying authors after 200 commits,
        // which turned "push more than 200" into a way past the gate.
        reject(u.ref, `this push introduces ${commits.length} commits, over the ${MAX_PUSH_COMMITS} the server will verify. Push it in smaller pieces.`)
        continue
      }
      checkAuthor(u.ref, commits)
      checkContent(u.ref, u, commits)
    } catch (e) {
      if (!(e instanceof TruncatedOutput)) throw e
      reject(u.ref, 'this push is too large for the server to inspect in one piece, so it was not verified. Push it in smaller pieces.')
    }
  }
  if (problems.length) {
    audit({ event: 'push-rejected', refs: updates.map((u) => u.ref), problems: problems.map((p) => p.msg) })
    process.stderr.write('\natomic-git refused this push:\n')
    for (const p of problems) process.stderr.write(`  · ${p.msg}\n`)
    process.stderr.write('\nNothing on the server changed.\n\n')
    return 1
  }
  audit({ event: 'push-accepted', refs: updates.map((u) => `${u.ref}`) })
  return 0
}

/**
 * Am I being executed, rather than imported by the tests?
 *
 * NOT a filename check: git requires this hook to be installed as exactly
 * `pre-receive`, with no extension, so `endsWith('pre-receive.mjs')` was false in
 * the only deployment that matters — the guard never fired, run() never ran, and
 * the hook exited 0, silently accepting every push it was installed to block.
 * Comparing realpaths is true for a copy and for a symlink alike. (Caught by the
 * suite, 2026-08-31 — it passed when invoked as *.mjs directly and failed the
 * moment a real git push went through an installed hook.)
 */
const isMain = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])
  } catch {
    return false
  }
})()
if (isMain) process.exit(run())
