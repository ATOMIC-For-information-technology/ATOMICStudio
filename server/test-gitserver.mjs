#!/usr/bin/env node
/**
 * test-gitserver — the ATOMIC git server suite. Plain node, no Electron.
 *
 * Nothing under test touches `app` or `safeStorage`, so unlike the desktop suites
 * this runs on bare node — and on the server itself, which is where you most want
 * to be able to run it.
 *
 * THE TRICK that makes layer 2 possible with no sshd: git shells out to
 * $GIT_SSH_COMMAND as `<cmd> <host> <git-upload-pack 'repo'>`. Pointing that at a
 * two-line script which exports SSH_ORIGINAL_COMMAND and execs atomic-git-shell
 * reproduces EXACTLY what sshd does with a forced command. So a real `git clone`
 * and a real `git push` travel the real gate — identity, ACL, hooks and all —
 * without a daemon, a port, or a key. Only the transport is simulated.
 *
 *   node server/test-gitserver.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { can, canPushProtected, roleOf, visibleRepos, resolveRepo, isSafeRepoName, readMembers } from './atomic-git-acl.mjs'
import { parseCommand } from './atomic-git-shell.mjs'
import { certificateFromAuthInfo, currentEpoch, decodeCertificate, readEpochs, readPublicKeyBlob, verifyCertificate } from './atomic-git-cert.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-git-test-'))
const ROOT = path.join(TMP, 'git')
const MEMBERS = path.join(TMP, 'members.json')
const AUDIT = path.join(TMP, 'git-audit.log')
const SHELL = path.join(HERE, 'atomic-git-shell.mjs')
const HOOK = path.join(HERE, 'hooks', 'pre-receive.mjs')

let pass = 0
const failures = []
const step = async (name, fn) => {
  try {
    const note = await fn()
    pass++
    console.log(`\x1b[32mPASS\x1b[0m  ${name}`)
    if (note) console.log(`      ${note}`)
  } catch (e) {
    failures.push({ name, error: e.message + (process.env.GS_STACK ? '\n' + e.stack : '') })
    console.log(`\x1b[31mFAIL\x1b[0m  ${name}\n      ${e.message}`)
  }
}
/** Reported separately from a pass: a check that could not run is not a check that succeeded. */
const skipped = []
const skip = (name, why) => {
  skipped.push({ name, why })
  console.log(`\x1b[33mSKIP\x1b[0m  ${name}\n      ${why}`)
}
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// ---------------------------------------------------------------- fixture
fs.mkdirSync(ROOT, { recursive: true })
fs.writeFileSync(
  MEMBERS,
  JSON.stringify([
    // alice is the suite's main author and pushes to `main`, so she must be a role that may:
    // `lead`. Before roles existed she was an `editor`, and that is exactly the migration a
    // real install has to make (see the MIGRATION note in hooks/pre-receive.mjs).
    { name: 'alice', role: 'lead', repos: ['*'], emails: ['alice@team.internal'], createdAt: 1 },
    { name: 'bob', role: 'viewer', repos: ['studio'], createdAt: 1 },
    // carol/dave keep the LEGACY `editor` name on purpose: the alias must keep working.
    { name: 'carol', role: 'editor', repos: ['other'], createdAt: 1 },
    { name: 'dave', role: 'editor', createdAt: 1 }, // no `repos` field at all
    { name: 'olive', role: 'owner', createdAt: 1 },
    { name: 'maya', role: 'manager', createdAt: 1 }, // reads everything, writes nothing, no scope
    { name: 'dan', role: 'dev', repos: ['studio'], createdAt: 1 }
  ], null, 2)
)

function makeBareRepo(name) {
  const dir = path.join(ROOT, name + '.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir])
  fs.copyFileSync(HOOK, path.join(dir, 'hooks', 'pre-receive'))
  fs.chmodSync(path.join(dir, 'hooks', 'pre-receive'), 0o755)
  return dir
}
makeBareRepo('studio')
makeBareRepo('other')

// A fake `ssh` that does what sshd's forced command does, and nothing else.
const FAKE_SSH = path.join(TMP, 'fake-ssh.sh')
fs.writeFileSync(
  FAKE_SSH,
  `#!/bin/sh
# git calls: <this> <host> <command>.  $ATOMIC_TEST_USER stands in for the name
# baked into authorized_keys, which is the whole point: the client never sends it.
SSH_ORIGINAL_COMMAND="$2" \\
ATOMIC_GIT_ROOT="${ROOT}" ATOMIC_GIT_MEMBERS="${MEMBERS}" ATOMIC_GIT_AUDIT="${AUDIT}" \\
exec node "${SHELL}" "$ATOMIC_TEST_USER"
`
)
fs.chmodSync(FAKE_SSH, 0o755)

const asUser = (user) => ({
  GIT_SSH_COMMAND: FAKE_SSH,
  ATOMIC_TEST_USER: user,
  ATOMIC_GIT_ROOT: ROOT,
  ATOMIC_GIT_MEMBERS: MEMBERS,
  ATOMIC_GIT_AUDIT: AUDIT
})

/** Run a git command that talks to the "server". Returns {code, out}. */
function remoteGit(cwd, user, ...args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...asUser(user) }
  })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

console.log(`\n  ATOMIC git server suite — ${TMP}\n`)

// ---------------------------------------------------------------- 1. ACL
await step('ACL: fails closed on a missing or malformed members.json', () => {
  eq(readMembers(path.join(TMP, 'nope.json')).length, 0, 'missing file')
  const bad = path.join(TMP, 'bad.json')
  fs.writeFileSync(bad, '{ not json')
  eq(readMembers(bad).length, 0, 'malformed file')
  eq(can(bad, 'alice', 'studio', 'read'), false, 'malformed grants nothing')
  eq(can(path.join(TMP, 'nope.json'), 'alice', 'studio', 'write'), false, 'missing grants nothing')
  return 'a corrupt ACL refuses access rather than granting it'
})

await step('ACL: roles and scopes decide, and an absent scope is NOT "all"', () => {
  eq(can(MEMBERS, 'alice', 'studio', 'write'), true, 'lead with * writes')
  eq(can(MEMBERS, 'bob', 'studio', 'read'), true, 'viewer reads in scope')
  eq(can(MEMBERS, 'bob', 'studio', 'write'), false, 'viewer never writes')
  eq(can(MEMBERS, 'carol', 'studio', 'read'), false, 'editor out of scope')
  eq(can(MEMBERS, 'carol', 'other', 'write'), true, 'editor in scope')
  eq(can(MEMBERS, 'olive', 'anything', 'write'), true, 'owner everywhere')
  eq(can(MEMBERS, 'dave', 'studio', 'read'), false, 'missing repos field grants nothing')
  eq(can(MEMBERS, 'mallory', 'studio', 'read'), false, 'unknown member')
  eq(can(MEMBERS, 'alice', 'studio', 'admin'), false, 'unknown access verb')
  return 'viewer/editor/owner + scoping; a forgotten `repos` locks out rather than opens up'
})

await step('ACL: the four ATOMIC roles, and the legacy names still map', () => {
  // Legacy vocabulary keeps working — an install that predates roles must not break.
  eq(roleOf(MEMBERS, 'olive'), 'admin', 'owner -> admin')
  eq(roleOf(MEMBERS, 'carol'), 'dev', 'editor -> dev')
  eq(roleOf(MEMBERS, 'bob'), 'viewer', 'viewer stays viewer')
  eq(roleOf(MEMBERS, 'alice'), 'lead', 'lead is canonical')
  eq(roleOf(MEMBERS, 'nobody'), null, 'unknown member has no role')

  // manager: reads EVERYTHING including repos it has no scope for, and never writes.
  eq(can(MEMBERS, 'maya', 'studio', 'read'), true, 'manager reads unscoped')
  eq(can(MEMBERS, 'maya', 'other', 'read'), true, 'manager reads every repo')
  eq(can(MEMBERS, 'maya', 'studio', 'write'), false, 'manager never writes')
  eq(canPushProtected(MEMBERS, 'maya', 'studio'), false, 'manager cannot push protected')

  // dev: scoped read+write, never protected.
  eq(can(MEMBERS, 'dan', 'studio', 'write'), true, 'dev writes in scope')
  eq(can(MEMBERS, 'dan', 'other', 'write'), false, 'dev out of scope')
  eq(canPushProtected(MEMBERS, 'dan', 'studio'), false, 'dev cannot push protected')

  // lead and admin may; a role with write but no protected grant may not.
  eq(canPushProtected(MEMBERS, 'alice', 'studio'), true, 'lead may push protected')
  eq(canPushProtected(MEMBERS, 'olive', 'studio'), true, 'admin may push protected')
  eq(canPushProtected(MEMBERS, 'bob', 'studio'), false, 'viewer may not')
  eq(canPushProtected(MEMBERS, 'nobody', 'studio'), false, 'unknown member may not')

  // A manager reads everything, so the catalog must show everything — that is the grant.
  const seen = visibleRepos(MEMBERS, 'maya', ROOT)
  if (!seen.includes('studio') || !seen.includes('other')) throw new Error(`manager catalog: ${JSON.stringify(seen)}`)
  eq(visibleRepos(MEMBERS, 'dan', ROOT).join(','), 'studio', 'dev catalog is scoped')
  eq(visibleRepos(MEMBERS, 'dave', ROOT).length, 0, 'no scope, no catalog')
  return 'admin/manager/lead/dev + viewer; owner and editor still map; protected push is its own grant'
})

await step('ACL: a typo in a role locks the member out rather than defaulting', () => {
  const typo = path.join(TMP, 'typo-members.json')
  fs.writeFileSync(typo, JSON.stringify([{ name: 'eve', role: 'Lead', repos: ['*'], createdAt: 1 }]))
  eq(roleOf(typo, 'eve'), null, 'case-sensitive: "Lead" is not a role')
  eq(can(typo, 'eve', 'studio', 'read'), false, 'no role, no read')
  eq(can(typo, 'eve', 'studio', 'write'), false, 'no role, no write')
  return 'an unrecognised role grants nothing — no silent fallback to the weakest role'
})

await step('ACL: resolveRepo refuses traversal, symlink escape and non-repos', () => {
  eq(resolveRepo(ROOT, 'studio.git').name, 'studio', 'plain name')
  // The form a client actually sends for ssh://host/<root>/studio.git — an absolute
  // path INSIDE the root is accepted and normalised back to the bare name.
  eq(resolveRepo(ROOT, path.join(ROOT, 'studio.git')).name, 'studio', 'absolute path inside root')
  // An absolute path outside the root is refused, not silently reinterpreted.
  eq(resolveRepo(ROOT, '/srv/atomic/git/studio.git'), null, 'absolute path outside root')
  eq(resolveRepo(ROOT, '~/studio.git').name, 'studio', 'tilde form')
  for (const bad of ['../../etc/passwd', '../other.git', 'a/b.git', '', '-flag.git', 'nope.git']) {
    eq(resolveRepo(ROOT, bad), null, `refused ${bad}`)
  }
  fs.mkdirSync(path.join(TMP, 'outside.git'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'outside.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.mkdirSync(path.join(TMP, 'outside.git', 'objects'), { recursive: true })
  fs.symlinkSync(path.join(TMP, 'outside.git'), path.join(ROOT, 'escape.git'))
  eq(resolveRepo(ROOT, 'escape.git'), null, 'symlink out of root refused')
  fs.mkdirSync(path.join(ROOT, 'notarepo.git'), { recursive: true })
  eq(resolveRepo(ROOT, 'notarepo.git'), null, 'directory that is not a bare repo refused')
  return 'traversal, symlink escape and non-repos all refused at one choke point'
})

// ---------------------------------------------------------------- 2. the forced command
await step('shell: the command allow-list accepts 3 verbs and refuses everything else', () => {
  eq(parseCommand("git-upload-pack 'studio.git'").access, 'read', 'upload-pack')
  eq(parseCommand("git-receive-pack 'studio.git'").access, 'write', 'receive-pack')
  eq(parseCommand("git-upload-archive 'studio.git'").access, 'read', 'upload-archive')
  eq(parseCommand('git upload-pack studio.git').access, 'read', 'space form')
  for (const bad of [
    "git-upload-pack 'x.git'; rm -rf /", 'bash -i', 'git-upload-pack', '',
    "git-upload-pack '--upload-pack=touch /tmp/x'", "git-receive-pack 'a.git' 'b.git'",
    'git-upload-pack $(evil)', 'git-upload-pack `evil`', "git-upload-pack 'a.git' | sh",
    'scp -f /etc/passwd', 'git-upload-pack\nbash'
  ]) eq(parseCommand(bad), null, `refused ${JSON.stringify(bad)}`)
  return '3 verbs allowed; 11 hostile commands refused, including option injection'
})

await step('shell: an interactive ssh gets no shell, and an unknown repo is indistinguishable from a forbidden one', () => {
  const bare = spawnSync('node', [SHELL, 'alice'], { encoding: 'utf8', env: { ...process.env, ...asUser('alice'), SSH_ORIGINAL_COMMAND: '' } })
  if (bare.status === 0) throw new Error('interactive ssh was allowed')
  if (!/git access only/i.test(bare.stderr)) throw new Error(`unexpected message: ${bare.stderr}`)

  const run = (user, cmd) => spawnSync('node', [SHELL, user], {
    encoding: 'utf8', env: { ...process.env, ...asUser(user), SSH_ORIGINAL_COMMAND: cmd }
  })
  const missing = run('alice', "git-upload-pack 'ghost.git'")
  const forbidden = run('carol', "git-upload-pack 'studio.git'")
  if (missing.status === 0 || forbidden.status === 0) throw new Error('a denial exited 0')
  eq(forbidden.stderr.trim(), missing.stderr.trim(), 'forbidden and missing must read identically')
  return `both say "${missing.stderr.trim()}" — the repo list is not disclosed by probing`
})

// ---------------------------------------------------------------- 3. real git through the real gate
const work = path.join(TMP, 'work')
await step('e2e: alice clones and pushes for real, through the forced command', () => {
  const r = remoteGit(TMP, 'alice', 'clone', '-q', `ssh://git@fake/${ROOT}/studio.git`, work)
  if (r.code !== 0) throw new Error(`clone failed: ${r.out}`)
  // Cloning an EMPTY repo names the local unborn branch from `init.defaultBranch`, NOT from the
  // remote's HEAD. On a machine where that is unset git falls back to `master`, and every
  // `push origin main` below then fails with "src refspec main does not match any". Pinning it
  // here is what lets this suite run on a fresh server — which is the whole point of it being
  // plain node. (Found 2026-09-01 running it on Ubuntu 24.04 with no global git config.)
  git(work, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(work, 'config', 'user.email', 'alice@team.internal')
  git(work, 'config', 'user.name', 'Alice')
  fs.writeFileSync(path.join(work, 'readme.md'), '# studio\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'first')
  const p = remoteGit(work, 'alice', 'push', '-q', 'origin', 'main')
  if (p.code !== 0) throw new Error(`push failed: ${p.out}`)
  const log = git(path.join(ROOT, 'studio.git'), 'log', '--oneline', '-n', '1')
  if (!log.includes('first')) throw new Error(`server log: ${log}`)
  return `a real clone + push travelled the gate; server HEAD = "${log.trim()}"`
})

await step('e2e: bob (viewer) can clone, and is refused on push', () => {
  const bobDir = path.join(TMP, 'bob')
  const c = remoteGit(TMP, 'bob', 'clone', '-q', `ssh://git@fake/${ROOT}/studio.git`, bobDir)
  if (c.code !== 0) throw new Error(`viewer could not clone: ${c.out}`)
  git(bobDir, 'config', 'user.email', 'bob@team.internal')
  git(bobDir, 'config', 'user.name', 'Bob')
  fs.writeFileSync(path.join(bobDir, 'b.txt'), 'x\n')
  git(bobDir, 'add', '-A')
  git(bobDir, 'commit', '-qm', 'bob was here')
  const p = remoteGit(bobDir, 'bob', 'push', 'origin', 'main')
  if (p.code === 0) throw new Error('a viewer pushed')
  return 'read granted, write refused — by role, over a real transport'
})

await step('e2e: a dev pushes a branch but is refused on main, over the real transport', () => {
  // The unit test proves canPushProtected(); this proves the HOOK actually calls it. Those are
  // different failures: an ACL that says no while the gate never asks is the bug worth catching.
  const danDir = path.join(TMP, 'dan')
  const c = remoteGit(TMP, 'dan', 'clone', '-q', `ssh://git@fake/${ROOT}/studio.git`, danDir)
  if (c.code !== 0) throw new Error(`dev could not clone: ${c.out}`)
  git(danDir, 'config', 'user.email', 'dan@team.internal')
  git(danDir, 'config', 'user.name', 'Dan')
  fs.writeFileSync(path.join(danDir, 'dan.txt'), 'work\n')
  git(danDir, 'add', '-A')
  git(danDir, 'commit', '-qm', 'dan does his job')

  // A feature branch is ordinary work and must stay allowed — a role gate that blocked this
  // would make the product unusable for the role that does most of the pushing.
  git(danDir, 'checkout', '-q', '-b', 'dan/feature')
  const branch = remoteGit(danDir, 'dan', 'push', '-q', 'origin', 'dan/feature')
  if (branch.code !== 0) throw new Error(`dev could not push a feature branch: ${branch.out}`)

  // main is protected and dan is a dev: refused, with a message that says what to do instead.
  git(danDir, 'checkout', '-q', 'main')
  const toMain = remoteGit(danDir, 'dan', 'push', 'origin', 'main')
  if (toMain.code === 0) throw new Error('a dev pushed straight to main')
  if (!/cannot push to it directly/.test(toMain.out)) throw new Error(`wrong refusal: ${toMain.out}`)
  if (!/merge request/.test(toMain.out)) throw new Error('the refusal does not say what to do instead')
  return 'feature branch allowed, main refused by role, and the message names the way forward'
})

await step('e2e: carol cannot even see a repo outside her scope', () => {
  const c = remoteGit(TMP, 'carol', 'clone', '-q', `ssh://git@fake/${ROOT}/studio.git`, path.join(TMP, 'carol'))
  if (c.code === 0) throw new Error('cloned a repo outside scope')
  return 'out-of-scope clone refused'
})

// ---------------------------------------------------------------- 4. the push gate
const pushFile = (name, body, msg) => {
  fs.writeFileSync(path.join(work, name), body)
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', msg)
  return remoteGit(work, 'alice', 'push', 'origin', 'main')
}
const undoLast = () => git(work, 'reset', '-q', '--hard', 'HEAD~1')

await step('gate: a conflict marker never reaches the server', () => {
  const r = pushFile('conf.txt', 'a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n', 'oops markers')
  if (r.code === 0) throw new Error('markers were accepted')
  if (!/conflict marker/i.test(r.out)) throw new Error(`unexpected refusal: ${r.out}`)
  undoLast()
  return 'refused by git’s own --check, the same detector the client commits with'
})

await step('gate: a hardcoded secret is refused, a placeholder is not', () => {
  const bad = pushFile('cfg.js', 'const k = "AKIA1234567890ABCDEF"\n', 'add key')
  if (bad.code === 0) throw new Error('an AWS key was accepted')
  if (!/AWS access key/i.test(bad.out)) throw new Error(`unexpected refusal: ${bad.out}`)
  undoLast()
  const ok = pushFile('cfg.js', 'const k = process.env.AWS_KEY // e.g. AKIAEXAMPLEEXAMPLE01\n', 'use env')
  if (ok.code !== 0) throw new Error(`a placeholder was refused: ${ok.out}`)
  return 'real key refused, EXAMPLE placeholder allowed through'
})

await step('gate: an oversized blob is refused', () => {
  const r = (() => {
    fs.writeFileSync(path.join(work, 'big.bin'), Buffer.alloc(1024 * 200, 7))
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'big file')
    return spawnSync('git', ['push', 'origin', 'main'], {
      cwd: work, encoding: 'utf8',
      env: { ...process.env, ...asUser('alice'), ATOMIC_GIT_MAX_BLOB: '65536' }
    })
  })()
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.status === 0) throw new Error('an oversized blob was accepted')
  if (!/over the/i.test(out)) throw new Error(`unexpected refusal: ${out}`)
  undoLast()
  return 'a 200 KB blob refused against a 64 KB limit — a bare repo never forgets'
})

await step('gate: main is protected from force-push and deletion; a topic branch is not', () => {
  git(work, 'checkout', '-q', '-b', 'topic')
  fs.writeFileSync(path.join(work, 't.txt'), 'x\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'topic work')
  const t = remoteGit(work, 'alice', 'push', '-q', 'origin', 'topic')
  if (t.code !== 0) throw new Error(`topic push failed: ${t.out}`)

  git(work, 'checkout', '-q', 'main')
  git(work, 'reset', '-q', '--hard', 'HEAD~1') // drop a commit the server has
  const force = remoteGit(work, 'alice', 'push', '--force', 'origin', 'main')
  if (force.code === 0) throw new Error('force-push to a protected branch succeeded')
  if (!/rewrite history/i.test(force.out)) throw new Error(`unexpected refusal: ${force.out}`)

  const del = remoteGit(work, 'alice', 'push', 'origin', '--delete', 'main')
  if (del.code === 0) throw new Error('deleted a protected branch')

  const delTopic = remoteGit(work, 'alice', 'push', 'origin', '--delete', 'topic')
  if (delTopic.code !== 0) throw new Error(`could not delete an unprotected branch: ${delTopic.out}`)
  return 'main: force-push and delete refused. topic: both allowed.'
})

await step('gate: a commit attributed to someone else is refused', () => {
  git(work, 'reset', '-q', '--hard', 'origin/main')
  fs.writeFileSync(path.join(work, 'imposter.txt'), 'x\n')
  git(work, 'add', '-A')
  execFileSync('git', ['commit', '-qm', 'not me', '--author', 'Mallory <mallory@evil.example>'], {
    cwd: work,
    env: { ...process.env, GIT_COMMITTER_NAME: 'Mallory', GIT_COMMITTER_EMAIL: 'mallory@evil.example' }
  })
  const r = remoteGit(work, 'alice', 'push', 'origin', 'main')
  if (r.code === 0) throw new Error("alice pushed a commit authored by someone else")
  if (!/not one of alice/i.test(r.out)) throw new Error(`unexpected refusal: ${r.out}`)
  git(work, 'reset', '-q', '--hard', 'origin/main')
  return "alice's key cannot land commits wearing mallory's name"
})

await step('gate: a secret and an oversized blob added then REMOVED in the same push are refused', () => {
  /**
   * THE HOLE THIS CLOSES. The gate used to diff old-tip against new-tip and nothing else. Add a
   * key in commit 1 and delete it in commit 2 and that diff is EMPTY — the push sails through, and
   * the blob containing the credential is in the pack forever, reachable by anyone who clones and
   * runs `git log -p`. "I removed it in the next commit" is the single most common way a secret
   * ends up permanently on a server.
   *
   * Same for a 200 MB accident: deleting it does not un-send it.
   */
  git(work, 'reset', '-q', '--hard', 'origin/main')
  fs.writeFileSync(path.join(work, 'leak.js'), 'const k = "AKIA1234567890ABCDEF"\n')
  fs.writeFileSync(path.join(work, 'huge.bin'), Buffer.alloc(1024 * 200, 7))
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'oops, a key and a big file')
  fs.rmSync(path.join(work, 'leak.js'))
  fs.rmSync(path.join(work, 'huge.bin'))
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'removed them again')

  // Prove the premise: the tip-to-tip diff really is clean, so ONLY a scan of the new objects can
  // catch this. Without this assertion the test would pass even if the old gate were restored.
  const tipDiff = git(work, 'diff', '--name-only', 'origin/main', 'HEAD').trim()
  if (tipDiff) throw new Error(`the premise failed — the tip-to-tip diff is not empty: ${tipDiff}`)

  const r = spawnSync('git', ['push', 'origin', 'main'], {
    cwd: work, encoding: 'utf8',
    env: { ...process.env, ...asUser('alice'), ATOMIC_GIT_MAX_BLOB: '65536' }
  })
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.status === 0) throw new Error('a secret and an oversized blob were accepted because they were removed later')
  if (!/AWS access key/i.test(out)) throw new Error(`the secret was not caught: ${out}`)
  if (!/over the/i.test(out)) throw new Error(`the oversized blob was not caught: ${out}`)
  git(work, 'reset', '-q', '--hard', 'origin/main')
  return 'added in commit 1, removed in commit 2, tip-to-tip diff empty — both still refused'
})

await step('gate: an unauthorized author beyond commit 200 cannot slip past the verifier', () => {
  /**
   * THE BYPASS THIS REMOVES. `checkAuthor` ended with `commits.slice(0, 200)`. rev-list emits
   * NEWEST FIRST, so that verified the most recent 200 and waved through everything older — which
   * made "pad the push with 200 commits" a working technique for landing a commit wearing somebody
   * else's name. A bound is still needed (a hook must terminate), but it now REFUSES rather than
   * skips: this pushes 205 commits with the forged one deliberately OLDEST.
   */
  git(work, 'reset', '-q', '--hard', 'origin/main')
  fs.writeFileSync(path.join(work, 'forged.txt'), 'x\n')
  git(work, 'add', '-A')
  execFileSync('git', ['commit', '-qm', 'the forged one', '--author', 'Mallory <mallory@evil.example>'], {
    cwd: work,
    env: { ...process.env, GIT_COMMITTER_NAME: 'Alice', GIT_COMMITTER_EMAIL: 'alice@team.internal' }
  })
  for (let i = 0; i < 204; i++) git(work, 'commit', '-q', '--allow-empty', '-m', `padding ${i}`)

  const count = git(work, 'rev-list', '--count', 'origin/main..HEAD').trim()
  if (Number(count) < 201) throw new Error(`the premise failed — only ${count} commits, the old slice would have covered them all`)

  const r = remoteGit(work, 'alice', 'push', 'origin', 'main')
  if (r.code === 0) throw new Error(`a forged author at depth ${count} was accepted — the 200-commit bypass is back`)
  if (!/not one of alice/i.test(r.out)) throw new Error(`wrong refusal: ${r.out}`)
  git(work, 'reset', '-q', '--hard', 'origin/main')
  return `${count} commits pushed, the forged one oldest — still refused`
})

await step('gate: a push larger than the bound is REFUSED, never silently half-checked', () => {
  // The other half of removing the slice: the bound has to exist, and hitting it must be an
  // answer the user can act on rather than a quiet gap in the verification.
  git(work, 'reset', '-q', '--hard', 'origin/main')
  for (let i = 0; i < 6; i++) git(work, 'commit', '-q', '--allow-empty', '-m', `bulk ${i}`)
  const r = spawnSync('git', ['push', 'origin', 'main'], {
    cwd: work, encoding: 'utf8',
    env: { ...process.env, ...asUser('alice'), ATOMIC_GIT_MAX_PUSH_COMMITS: '3' }
  })
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.status === 0) throw new Error('a push over the commit bound was accepted')
  if (!/smaller pieces/i.test(out)) throw new Error(`the refusal does not say what to do: ${out}`)
  git(work, 'reset', '-q', '--hard', 'origin/main')
  return '6 commits against a bound of 3 — refused with a way forward, not truncated'
})

await step('gate: receive-pack reached without the forced command is refused outright', () => {
  const r = spawnSync('node', [HOOK], {
    cwd: path.join(ROOT, 'studio.git'),
    input: `${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/x\n`,
    encoding: 'utf8',
    env: { ...process.env, ATOMIC_GIT_USER: '' }
  })
  if (r.status === 0) throw new Error('an unattributed push was accepted')
  if (!/did not come through atomic-git-shell/i.test(r.stderr)) throw new Error(`unexpected: ${r.stderr}`)
  return 'no identity, no push — the hook fails closed'
})

await step('audit: every decision was recorded', () => {
  const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const allows = lines.filter((l) => l.event === 'allow').length
  const denies = lines.filter((l) => l.event === 'deny').length
  const rejects = lines.filter((l) => l.event === 'push-rejected').length
  if (!allows || !denies || !rejects) throw new Error(JSON.stringify({ allows, denies, rejects }))
  if (lines.some((l) => !l.ts)) throw new Error('an entry has no timestamp')
  return `${lines.length} entries — ${allows} allow, ${denies} deny, ${rejects} push-rejected`
})

// ---------------------------------------------------------------- 5. control plane
const WS_PORT = 8993
const WS_ROOT = path.join(TMP, 'wsroot')
const AK = path.join(TMP, 'authorized_keys')
fs.mkdirSync(WS_ROOT, { recursive: true })
fs.copyFileSync(MEMBERS, path.join(WS_ROOT, 'members.json'))

const { spawn } = await import('node:child_process')
// A throwaway SSH CA so certificate issuance can be tested for real rather than mocked.
const CA_KEY = path.join(TMP, 'ca')
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'atomic-test-ca', '-f', CA_KEY])
const USER_KEY = path.join(TMP, 'user')
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'alice@laptop', '-f', USER_KEY])
const EPOCHS = path.join(WS_ROOT, 'identity-epochs.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DAEMON = path.join(HERE, 'atomic-workspaced.mjs')
const BASE_ENV = {
  ATOMIC_WS_TOKEN: 'test-owner-token',
  ATOMIC_GIT_CA_KEY: CA_KEY,
  ATOMIC_GIT_CA_PUB: CA_KEY + '.pub',
  ATOMIC_GIT_CERT_TTL: '8h',
  ATOMIC_WS_ROOT: WS_ROOT,
  ATOMIC_WS_HOST: '127.0.0.1',
  ATOMIC_GIT_ROOT: ROOT,
  ATOMIC_GIT_AUTHORIZED_KEYS: AK,
  ATOMIC_GIT_SHELL_BIN: SHELL,
  ATOMIC_GIT_HOOK: HOOK,
  ATOMIC_GIT_EPOCHS: EPOCHS
}

const daemons = []
let nextPort = WS_PORT

/**
 * Start a control plane and wait for it to actually listen.
 *
 * A LAUNCHER rather than one long-lived instance, because several checks below need a DIFFERENT
 * configuration — a broken hook path, a non-default SSH port, an OIDC issuer, the staged install
 * layout — and each of those is a property of how the daemon was started. Polling `/v1/me` instead
 * of sleeping keeps the suite fast and removes the flake.
 */
async function startDaemon({ script = DAEMON, env = {} } = {}) {
  const port = nextPort++
  const proc = spawn('node', [script], {
    env: { ...process.env, ...BASE_ENV, ...env, ATOMIC_WS_PORT: String(port) },
    stdio: 'ignore'
  })
  daemons.push(proc)
  const call = async (method, route, body, token = 'test-owner-token', headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    let json = null
    try { json = await r.json() } catch { /* empty body */ }
    return { status: r.status, body: json }
  }
  for (let i = 0; i < 80; i++) {
    try {
      await call('GET', '/v1/me')
      return { proc, port, api: call }
    } catch {
      await sleep(50)
    }
  }
  try { proc.kill() } catch { /* already gone */ }
  return null
}

const main = await startDaemon()
const up = Boolean(main)
const api = main ? main.api : async () => ({ status: 0, body: null })

const GOOD_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL9kZ2xhbXBsZWtleWZvcnRlc3Rpbmcwog alice@laptop'

if (!up) {
  await step('control plane: daemon starts', () => { throw new Error(`no listener on ${WS_PORT}`) })
} else {
  await step('control plane: an SSH key cannot inject its own authorized_keys line', async () => {
    const add = await api('POST', '/v1/keys/alice', { key: GOOD_KEY })
    eq(add.status, 201, 'good key accepted')

    // The attack: a newline ends our forced-command line and starts one WITHOUT it,
    // which would give this key a full shell. Every variant must be refused.
    for (const evil of [
      GOOD_KEY + '\nssh-ed25519 AAAAB3attacker mallory@evil',
      GOOD_KEY + '\r\ncommand="/bin/sh" ssh-ed25519 AAAAB3x m@e',
      'not-a-key at all',
      'ssh-ed25519',
      'ssh-ed25519 !!!not-base64!!! x'
    ]) {
      const r = await api('POST', '/v1/keys/alice', { key: evil })
      eq(r.status, 400, `refused ${JSON.stringify(evil.slice(0, 40))}`)
    }

    const written = fs.readFileSync(AK, 'utf8')
    const keyLines = written.split('\n').filter((l) => l && !l.startsWith('#'))
    eq(keyLines.length, 1, 'exactly one key line')
    if (!keyLines[0].startsWith(`command="${SHELL} alice",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc `))
      throw new Error(`line lacks the forced command + restrictions: ${keyLines[0].slice(0, 120)}`)
    if (/mallory|\/bin\/sh/.test(written)) throw new Error('injected content reached authorized_keys')
    return 'forced command + 5 restrictions written; 5 injection attempts refused'
  })

  await step('control plane: repos are created, name-validated, and never hard-deleted', async () => {
    const made = await api('POST', '/v1/repos', { name: 'newrepo' })
    eq(made.status, 201, 'created')
    if (!fs.existsSync(path.join(ROOT, 'newrepo.git', 'hooks', 'pre-receive'))) throw new Error('hook not installed on a new repo')
    eq((await api('POST', '/v1/repos', { name: 'newrepo' })).status, 409, 'duplicate refused')
    for (const bad of ['../evil', 'a/b', '', '.hidden', '-flag'])
      eq((await api('POST', '/v1/repos', { name: bad })).status, 400, `refused name ${JSON.stringify(bad)}`)

    const del = await api('DELETE', '/v1/repos/newrepo')
    eq(del.status, 200, 'deleted')
    eq(del.body.recoverable, true, 'recoverable')
    if (fs.existsSync(path.join(ROOT, 'newrepo.git'))) throw new Error('repo still in place')
    const trashed = fs.readdirSync(path.join(WS_ROOT, '.trash')).filter((f) => f.startsWith('newrepo.git.'))
    if (!trashed.length) throw new Error('deleted repo was not moved to the trash')
    return 'created with hook, 5 bad names refused, delete moved to .trash (never rm -rf)'
  })

  await step('control plane: the repo list respects the same scoping as the shell', async () => {
    const team = await api('POST', '/v1/team', { name: 'zed', role: 'viewer' })
    eq(team.status, 201, 'member created')
    // zed has no `repos` scope at all, so must see nothing — the same fail-closed
    // rule the ACL applies, proving the two doors agree.
    const zed = await api('GET', '/v1/repos', undefined, team.body.token)
    if (!Array.isArray(zed.body)) throw new Error(`zed GET /v1/repos -> ${zed.status} ${JSON.stringify(zed.body)}`)
    eq(zed.body.length, 0, 'unscoped member sees no repos')
    const owner = await api('GET', '/v1/repos')
    if (!owner.body.some((r) => r.name === 'studio')) throw new Error(`owner list: ${JSON.stringify(owner.body)}`)
    if (!owner.body.every((r) => r.url.startsWith('ssh://'))) throw new Error('clone URL is not ssh://')
    return `owner sees ${owner.body.length} repos over ssh://, an unscoped member sees 0`
  })

  await step('control plane: /v1/team honours the role asked for, and refuses an unknown one', async () => {
    // Regression: this endpoint used to read `body.role === 'viewer' ? 'viewer' : 'editor'`, so
    // asking for `lead` silently produced an `editor` (-> dev) that could not push to main. The
    // caller only found out at the first refused push. Silent coercion of a permission is the bug.
    const lead = await api('POST', '/v1/team', { name: 'liv', role: 'lead', repos: ['*'] })
    eq(lead.status, 201, 'created')
    eq(lead.body.role, 'lead', 'the role asked for is the role given')
    const mgr = await api('POST', '/v1/team', { name: 'mira', role: 'manager' })
    eq(mgr.body.role, 'manager', 'manager is a real role now')
    // Legacy names still map rather than breaking an existing caller.
    const legacy = await api('POST', '/v1/team', { name: 'ed', role: 'editor' })
    eq(legacy.body.role, 'dev', 'editor -> dev')
    // An unknown role is REFUSED, not quietly downgraded.
    const bad = await api('POST', '/v1/team', { name: 'nope', role: 'superuser' })
    eq(bad.status, 400, 'unknown role refused')
    if (!Array.isArray(bad.body.accepted)) throw new Error('the refusal should say what IS accepted')
    return `lead/manager honoured, editor->dev, "superuser" refused with the accepted list`
  })

  await step('control plane: a certificate is issued, and carries the identity AND the role', async () => {
    const pub = fs.readFileSync(USER_KEY + '.pub', 'utf8').trim()
    const r = await api('POST', '/v1/cert', { publicKey: pub })
    if (r.status !== 200) throw new Error(`POST /v1/cert -> ${r.status} ${JSON.stringify(r.body)}`)
    if (typeof r.body.certificate !== 'string' || !r.body.certificate.includes('-cert-v01@openssh.com')) {
      throw new Error(`not a certificate: ${JSON.stringify(r.body).slice(0, 200)}`)
    }
    // Read it back with ssh-keygen, so the assertion is about what OpenSSH will actually see
    // rather than about the string we happened to return.
    const certFile = path.join(TMP, 'issued-cert.pub')
    fs.writeFileSync(certFile, r.body.certificate + '\n')
    const info = execFileSync('ssh-keygen', ['-L', '-f', certFile], { encoding: 'utf8' })
    if (!/Principals:/.test(info)) throw new Error(`no principals: ${info}`)
    // `owner` is the control plane's legacy name for `admin`; certificates carry the CANONICAL
    // role, because atomic-git-cert only accepts the five the ACL knows.
    if (!/\brole:admin\b/.test(info)) throw new Error(`role principal missing:\n${info}`)
    if (!/Valid:.*to/.test(info)) throw new Error(`certificate has no validity window:\n${info}`)
    // The audit entry must be FLAT — `audit(event, detail)`, not `audit({event})`. Calling it the
    // wrong way still writes a line containing the right words, so only a shape assertion catches
    // it; a query filtering on event === 'cert-issued' would otherwise miss every certificate.
    const log = path.join(WS_ROOT, 'git-audit.log')
    const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const issued = entries.filter((e) => e.event === 'cert-issued')
    if (!issued.length) throw new Error(`no flat cert-issued entry: ${JSON.stringify(entries.slice(-3))}`)
    eq(typeof issued.at(-1).user, 'string', 'audit entry carries a user at the top level')
    eq(issued.at(-1).role, 'admin', 'audit entry carries the role at the top level')
    return 'a real ssh certificate, principals carry name + role:<role>, with an expiry; audit entry is flat'
  })

  await step('control plane: invalid member names and prototype role names are rejected before writing', async () => {
    for (const name of ['bad name', 'bad,name', 'bad/name', 'a'.repeat(61), '', 42]) {
      eq((await api('POST', '/v1/team', { name, role: 'dev' })).status, 400, 'invalid member name ' + JSON.stringify(name))
    }
    for (const role of ['toString', 'constructor', '__proto__']) {
      eq((await api('POST', '/v1/team', { name: 'invalid-role-' + role, role })).status, 400, 'invalid role ' + role)
    }
    const listed = await api('GET', '/v1/team')
    if (listed.body.some(m => m.name.startsWith('invalid-role-') || m.name === 'bad name')) throw new Error('invalid member persisted')
  })

  await step('control plane: every new repository gets an EXECUTABLE pre-receive hook, or is not created', async () => {
    const made = await api('POST', '/v1/repos', { name: 'hooked' })
    eq(made.status, 201, 'created')
    const hook = path.join(ROOT, 'hooked.git', 'hooks', 'pre-receive')
    if (!fs.existsSync(hook)) throw new Error('no pre-receive hook on a new repository')
    // Executable, not merely present: git skips a non-executable hook WITHOUT A WORD, so a repo
    // with a 0644 pre-receive has no push gate at all and nothing ever says so.
    if (!(fs.statSync(hook).mode & 0o111)) throw new Error('the hook is not executable — git would silently skip it')

    /**
     * And the other half: installing the hook is MANDATORY. It used to be wrapped in a
     * `try {} catch {}` with the note "a repo without the hook is still usable; the shell still
     * gates access" — true of access and false of everything else the hook does (secrets, blob
     * size, protected branches, author verification). A repository created without it is silently
     * unguarded, which is worse than a repository that failed to be created.
     */
    const strictRoot = path.join(TMP, 'strict-git')
    fs.mkdirSync(strictRoot, { recursive: true })
    const strict = await startDaemon({ env: { ATOMIC_GIT_ROOT: strictRoot, ATOMIC_GIT_HOOK: path.join(TMP, 'no-such-hook.mjs') } })
    if (!strict) throw new Error('the strict daemon did not start')
    const failed = await strict.api('POST', '/v1/repos', { name: 'unguarded' })
    if (failed.status === 201) throw new Error('a repository was created without its push gate')
    eq(failed.status, 500, 'a missing hook is a server failure')
    if (fs.existsSync(path.join(strictRoot, 'unguarded.git'))) throw new Error('the half-made repository was left behind')
    if (fs.readdirSync(strictRoot).length) throw new Error(`creation left litter: ${fs.readdirSync(strictRoot)}`)
    return 'hook present + executable; a hook that cannot be installed fails the create and rolls it back cleanly'
  })

  await step('control plane: concurrent creates of the same name have exactly ONE winner', async () => {
    /**
     * `existsSync(dir)` then `git init` is check-then-act. Two requests can both see nothing, both
     * init, and the second silently ADOPTS the first's repository — the caller is handed a URL to
     * somebody else's work and finds out by pushing into it. Creation now builds in a temp
     * directory and renames it into place, so the decision is one atomic syscall.
     */
    const results = await Promise.all(
      Array.from({ length: 8 }, () => api('POST', '/v1/repos', { name: 'raced' }))
    )
    const created = results.filter((r) => r.status === 201)
    const refused = results.filter((r) => r.status === 409)
    eq(created.length, 1, 'exactly one create succeeded')
    eq(refused.length, 7, 'every loser was told the name is taken')
    if (!fs.existsSync(path.join(ROOT, 'raced.git', 'HEAD'))) throw new Error('the winner did not leave a repository')
    // No half-built directories left over from the seven that lost the rename.
    const litter = fs.readdirSync(ROOT).filter((d) => d.startsWith('.creating-'))
    if (litter.length) throw new Error(`losing attempts left litter: ${litter.join(', ')}`)
    return '8 concurrent creates, 1×201 and 7×409, no litter'
  })

  await step('control plane: a scoped creator is granted access transactionally', async () => {
    /**
     * A `dev` reads and writes only what their `repos` scope lists. Creating a repository outside
     * that scope produced one the creator could not then clone: the server did the work and handed
     * back a URL that answered "no such repository". Silently useless is the worst outcome
     * available, so the grant is now part of the create.
     */
    const scout = await api('POST', '/v1/team', { name: 'scout', role: 'dev', repos: ['studio'] })
    eq(scout.status, 201, 'member created')
    const made = await api('POST', '/v1/repos', { name: 'scoutrepo' }, scout.body.token)
    eq(made.status, 201, 'a dev may create a repository')

    const row = readMembers(path.join(WS_ROOT, 'members.json')).find((m) => m.name === 'scout')
    if (!row.repos.includes('scoutrepo')) throw new Error(`the creator was not granted access: ${JSON.stringify(row.repos)}`)
    // And prove it end to end rather than trusting the file: the catalogue must now show it.
    const mine = await api('GET', '/v1/repos', undefined, scout.body.token)
    if (!mine.body.some((r) => r.name === 'scoutrepo')) throw new Error(`the creator cannot see what they created: ${JSON.stringify(mine.body)}`)
    if (mine.body.some((r) => r.name === 'other')) throw new Error('the grant widened the scope beyond the new repository')

    // A manager reads everything and writes nothing — creating is a write.
    const mgr = await api('POST', '/v1/team', { name: 'mgr2', role: 'manager' })
    const refused = await api('POST', '/v1/repos', { name: 'nope-mgr' }, mgr.body.token)
    eq(refused.status, 403, 'a manager cannot create')
    return 'dev creates and is granted exactly that repo; scope not widened; manager refused'
  })

  await step('control plane: revoking a member removes their key, and reusing the name does not revive it', async () => {
    /**
     * DELETE /v1/team/<name> used to drop the member row and NOTHING ELSE. Two consequences, both
     * live:
     *   · their authorized_keys line stayed, so the key kept working forever; and
     *   · recreating the name re-pointed that stale line's forced command at the NEW person, so
     *     whoever held the old key inherited the new one's access.
     * A certificate has the same shape of problem, which is why every certificate carries the
     * revocation epoch its identity was at when it was issued.
     */
    const REX_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL9rZXhrZXlmb3J0ZXN0aW5ncmV2b2tlMDAK rex@laptop'
    const rex = await api('POST', '/v1/team', { name: 'rex', role: 'dev', repos: ['studio'] })
    eq(rex.status, 201, 'member created')
    eq((await api('POST', '/v1/keys/rex', { key: REX_KEY })).status, 201, 'key added')
    if (!fs.readFileSync(AK, 'utf8').includes(REX_KEY)) throw new Error("rex's key never reached authorized_keys")

    // A certificate issued while rex is current.
    const rexPub = fs.readFileSync(USER_KEY + '.pub', 'utf8').trim()
    const issued = await api('POST', '/v1/cert', { publicKey: rexPub }, rex.body.token)
    eq(issued.status, 200, 'certificate issued for rex')
    const beforeCert = issued.body.certificate
    const caBlob = readPublicKeyBlob(CA_KEY + '.pub')
    const okNow = verifyCertificate(beforeCert, { caPublicKeyBlob: caBlob })
    if (!okNow.ok || okNow.name !== 'rex') throw new Error(`the certificate should verify while rex is current: ${JSON.stringify(okNow)}`)

    const gone = await api('DELETE', '/v1/team/rex')
    eq(gone.status, 200, 'revoked')
    eq(gone.body.epoch, 1, 'the revocation epoch was bumped')
    if (fs.readFileSync(AK, 'utf8').includes(REX_KEY)) throw new Error("revoking left rex's key in authorized_keys")

    // Reuse the name. The new rex is a different person and must inherit nothing.
    const rex2 = await api('POST', '/v1/team', { name: 'rex', role: 'dev', repos: ['studio'] })
    eq(rex2.status, 201, 'the name can be reused')
    if (fs.readFileSync(AK, 'utf8').includes(REX_KEY)) throw new Error('reusing the name revived the old key')

    // The old certificate still verifies cryptographically — it has not expired — but its epoch is
    // stale, which is exactly the case expiry alone cannot cover.
    const stale = verifyCertificate(beforeCert, { caPublicKeyBlob: caBlob })
    if (!stale.ok) throw new Error('the old certificate should still be cryptographically valid; the epoch is what kills it')
    eq(stale.epoch, 0, 'the old certificate carries the old epoch')
    const ledger = JSON.parse(fs.readFileSync(EPOCHS, 'utf8'))
    eq(ledger.rex, 1, 'the server now expects epoch 1')
    return 'key removed on revoke, not revived by name reuse, and the old certificate is one epoch behind'
  })

  await step('control plane: a non-default SSH port survives into every clone URL', async () => {
    /**
     * `gitUrl` was already careful; the DESKTOP was not, rebuilding the URL from host + root and
     * dropping the port — so a server on 2222 handed out URLs that dialled 22. The server half is
     * asserted here; the desktop half (`atomicCloneUrl` preferring the server's own URL) is in the
     * agent suite.
     */
    const alt = await startDaemon({ env: { ATOMIC_WS_SSH_PORT: '2222', ATOMIC_WS_SSH_HOST: 'git.example', ATOMIC_WS_SSH_USER: 'git' } })
    if (!alt) throw new Error('the alternate-port daemon did not start')
    const list = await alt.api('GET', '/v1/repos')
    if (!list.body.length) throw new Error('no repositories to check')
    for (const r of list.body) {
      if (!r.url.startsWith('ssh://git@git.example:2222/')) throw new Error(`port lost from the clone URL: ${r.url}`)
    }
    const made = await alt.api('POST', '/v1/repos', { name: 'ported' })
    eq(made.status, 201, 'created')
    if (!made.body.url.includes(':2222/')) throw new Error(`create returned a URL without the port: ${made.body.url}`)
    return `${list.body.length} catalogue URLs and the create response all carry :2222`
  })

  await step('control plane: a repeated create with the same Idempotency-Key returns the original', async () => {
    const key = randomUUID()
    const first = await api('POST', '/v1/repos', { name: 'idem' }, 'test-owner-token', { 'Idempotency-Key': key })
    eq(first.status, 201, 'created')
    const again = await api('POST', '/v1/repos', { name: 'idem' }, 'test-owner-token', { 'Idempotency-Key': key })
    eq(again.status, 201, 'the retry replays the original response rather than 409')
    eq(again.body.url, first.body.url, 'same resource')
    // Without the key it is a genuine second create, and the name is taken.
    const bare = await api('POST', '/v1/repos', { name: 'idem' })
    eq(bare.status, 409, 'a create without the key still refuses a taken name')
    return 'retry replays 201, a fresh request still gets 409'
  })

  await step('control plane: certificate issuance refuses junk and unauthenticated callers', async () => {
    const bad = [
      { publicKey: 'not-a-key' },
      { publicKey: 'ssh-ed25519' },
      { publicKey: 'ssh-ed25519 AAAA\nssh-rsa BBBB' }, // two lines: a second key smuggled in
      { publicKey: 'ssh-dss AAAAB3NzaC1kc3M=' }, // not on the allow-list
      {}
    ]
    for (const b of bad) {
      const r = await api('POST', '/v1/cert', b)
      if (r.status === 200) throw new Error(`issued a certificate for ${JSON.stringify(b)}`)
    }
    const anon = await api('POST', '/v1/cert', { publicKey: fs.readFileSync(USER_KEY + '.pub', 'utf8').trim() }, 'wrong-token')
    eq(anon.status, 401, 'unauthenticated cert request')
    return `${bad.length} malformed keys refused, and an unauthenticated request gets 401`
  })

  await step('workspaces: a teammate cannot see, suspend or restore a workspace that is not theirs', async () => {
    /**
     * THE BUG THIS CLOSES. Workspace metadata carried no owner, and the only gates on
     * /v1/workspaces/* were role gates — "may this ROLE write" — which every ordinary member
     * passes. Nothing ever asked whose workspace it was. So any invited dev could list every
     * workspace on the box, suspend someone else's, read their snapshot descriptions, and call
     * restore, which empties the directory and untars over it. That last one destroys another
     * tenant's work outright, and none of it was audited.
     *
     * This whole surface had NO test of any kind, which is how it survived a suite that covers the
     * git side heavily. 404 rather than 403 is deliberate: "not yours" and "does not exist" must be
     * one answer, or other people's workspace ids can be confirmed by probing.
     */
    const owner = await api('GET', '/v1/me')
    const mine = await api('POST', '/v1/workspaces', { name: 'owner-ws' })
    eq(mine.status, 201, 'owner creates a workspace')
    eq(mine.body.ownedBy, owner.body.name, 'the creator is recorded as the owner')

    const dev = await api('POST', '/v1/team', { name: 'wsdev', role: 'dev', repos: ['*'] })
    eq(dev.status, 201, 'a dev teammate is invited')
    const tok = dev.body.token

    const theirs = await api('POST', '/v1/workspaces', { name: 'dev-ws' }, tok)
    eq(theirs.status, 201, 'the dev creates their own workspace')
    eq(theirs.body.ownedBy, 'wsdev', 'and owns it')

    // The list is the reconnaissance step for every attack below, so it is scoped too.
    const seen = await api('GET', '/v1/workspaces', undefined, tok)
    const ids = seen.body.map((w) => w.id)
    eq(ids.includes(theirs.body.id), true, 'the dev sees their own workspace')
    eq(ids.includes(mine.body.id), false, "the dev does not see the owner's workspace")

    const victim = mine.body.id
    for (const [method, url] of [
      ['GET', `/v1/workspaces/${victim}`],
      ['POST', `/v1/workspaces/${victim}/stop`],
      ['POST', `/v1/workspaces/${victim}/start`],
      ['POST', `/v1/workspaces/${victim}/keepalive`],
      ['GET', `/v1/workspaces/${victim}/snapshots`],
      ['POST', `/v1/workspaces/${victim}/snapshots`],
      ['POST', `/v1/workspaces/${victim}/snapshots/1/restore`]
    ]) {
      const r = await api(method, url, method === 'GET' ? undefined : {}, tok)
      eq(r.status, 404, `${method} ${url} is refused, indistinguishably from a missing one`)
    }

    // DELETE is refused one gate earlier, by role, and so answers 403 instead. That is not a
    // disclosure: the role gate runs before the workspace is ever looked up, so a member gets the
    // same 403 for an id that does not exist — it states a fact about their role, not about the
    // workspace. Asserted rather than assumed, because a 403 that varied by id WOULD leak.
    const delReal = await api('DELETE', `/v1/workspaces/${victim}`, {}, tok)
    const delBogus = await api('DELETE', '/v1/workspaces/0000000000', {}, tok)
    eq(delReal.status, 403, 'a member cannot delete a workspace')
    eq(delBogus.status, delReal.status, 'and gets the same answer for an id that does not exist')

    // An admin still administers everything — the gate scopes members, it does not lock the owner out.
    const all = await api('GET', '/v1/workspaces')
    eq(all.body.map((w) => w.id).includes(theirs.body.id), true, "an admin still sees a member's workspace")
    return '8 cross-tenant routes refused, the list is scoped, and an admin still sees everything'
  })

  await step('workspaces: an Idempotency-Key from one caller cannot replay another caller a response', async () => {
    /**
     * THE BUG THIS CLOSES. The idempotency cache was keyed on method + path + the client's own
     * Idempotency-Key — three values the caller supplies in full — and consulted BEFORE the route's
     * role check. Reusing someone else's key therefore returned their cached response with no
     * authorization run at all. For POST /v1/team that body carries the plaintext, one-time
     * member-invite token, so the replay hands the caller a credential rather than a duplicate.
     */
    const key = 'shared-key-' + Date.now().toString(36)
    const first = await api('POST', '/v1/team', { name: 'idemA', role: 'dev', repos: ['*'] }, undefined, { 'idempotency-key': key })
    eq(first.status, 201, 'the admin invite succeeds')
    const leaked = first.body.token
    eq(typeof leaked, 'string', 'and returns a one-time token')

    // The same key, replayed by the member that invite just created, must NOT return the cached body.
    const replay = await api('POST', '/v1/team', { name: 'idemB', role: 'dev' }, leaked, { 'idempotency-key': key })
    eq(replay.status === 201 && replay.body?.token === leaked, false, "a different caller is not served the first caller's cached response")

    // The same caller reusing their own key still gets the retry semantics the cache exists for.
    const again = await api('POST', '/v1/team', { name: 'idemA', role: 'dev', repos: ['*'] }, undefined, { 'idempotency-key': key })
    eq(again.status, 201, 'the original caller still replays their own 201')
    eq(again.body.token, leaked, 'byte for byte')
    return 'a cross-caller replay misses the cache and hits the role check; a same-caller retry still replays'
  })
}

// ---------------------------------------------------------------- 5b. OIDC callers

await step('control plane: an OIDC caller gets the repository list their ROLE entitles them to', async () => {
  /**
   * THE BUG THIS CLOSES. `/v1/repos` resolved the caller's name with a second helper that only
   * understood STATIC tokens. An OIDC caller — verified signature, mapped role, everything correct
   * — resolved to the empty string, so `visibleRepos('')` matched no member and returned []. Every
   * OIDC seat saw an empty catalogue regardless of role, and it looked like a permissions problem
   * rather than the plumbing mistake it was. The route now uses the verified identity, once.
   *
   * A REAL issuer is stood up here (RSA keypair, discovery document, JWKS) and real RS256 tokens
   * are signed, because the interesting part is the whole chain: signature → groups → role →
   * filtered list. A stubbed verifier would test none of it.
   */
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  // `publicKey` is already a public KeyObject; passing one to createPublicKey() throws, because
  // that function exists to DERIVE a public key from a private one.
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  let issuer = ''
  const idp = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.url.startsWith('/.well-known/openid-configuration')) return send({ issuer, jwks_uri: `${issuer}/jwks` })
    if (req.url.startsWith('/jwks')) return send({ keys: [jwk] })
    res.writeHead(404).end()
  })
  await new Promise((r) => idp.listen(0, '127.0.0.1', r))
  issuer = `http://127.0.0.1:${idp.address().port}`

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const token = (username, groups) => {
    const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
    const p = b64({
      iss: issuer, aud: 'atomic-studio', sub: `sub-${username}`,
      exp: Math.floor(Date.now() / 1000) + 600, preferred_username: username, groups
    })
    const sig = createSign('RSA-SHA256').update(`${h}.${p}`).end().sign(privateKey).toString('base64url')
    return `${h}.${p}.${sig}`
  }

  try {
    // Team rows carry the SCOPE; the IdP carries the ROLE. Both halves have to be right.
    for (const [name, role, repos] of [['odev', 'dev', ['studio']], ['olead', 'lead', ['other']]]) {
      const r = await api('POST', '/v1/team', { name, role, repos })
      eq(r.status, 201, `${name} created`)
    }

    const oidc = await startDaemon({
      env: {
        ATOMIC_WS_OIDC_ISSUER: issuer,
        ATOMIC_WS_OIDC_AUDIENCE: 'atomic-studio',
        ATOMIC_WS_OIDC_GROUPS: 'groups',
        ATOMIC_WS_OIDC_ROLES: JSON.stringify({ 'eng-admins': 'admin', 'eng-leads': 'lead', eng: 'dev', delivery: 'manager' })
      }
    })
    if (!oidc) throw new Error('the OIDC daemon did not start')
    const names = async (t) => {
      const r = await oidc.api('GET', '/v1/repos', undefined, t)
      if (!Array.isArray(r.body)) throw new Error(`GET /v1/repos -> ${r.status} ${JSON.stringify(r.body)}`)
      return r.body.map((x) => x.name).sort()
    }

    // admin and manager both READ EVERYTHING — that is the role table, and the two roles differ on
    // WRITE, not on what they can see.
    const all = await names(token('oadmin', ['eng-admins']))
    for (const must of ['studio', 'other']) {
      if (!all.includes(must)) throw new Error(`admin cannot see ${must}: ${all.join(', ')}`)
    }
    const mgr = await names(token('omanager', ['/delivery']))  // Keycloak's leading-slash form
    if (JSON.stringify(mgr) !== JSON.stringify(all)) throw new Error(`manager should read everything: ${mgr.join(', ')} vs ${all.join(', ')}`)

    // lead and dev are SCOPED, by the member row that shares their name.
    eq(JSON.stringify(await names(token('olead', ['eng-leads']))), JSON.stringify(['other']), 'lead sees only their scope')
    eq(JSON.stringify(await names(token('odev', ['eng']))), JSON.stringify(['studio']), 'dev sees only their scope')

    // Authenticated, correctly roled, but no team record: no scope, so nothing — and creating a
    // repository is refused with a POLICY answer rather than a 500 or a repo they cannot reach.
    eq(JSON.stringify(await names(token('oghost', ['eng']))), '[]', 'a dev with no team record sees nothing')
    const ghost = await oidc.api('POST', '/v1/repos', { name: 'ghostrepo' }, token('oghost', ['eng']))
    eq(ghost.status, 403, 'a scoped creator with no team record is refused')
    eq(ghost.body.code, 'NO_MEMBER_RECORD', 'and told exactly why')
    if (fs.existsSync(path.join(ROOT, 'ghostrepo.git'))) throw new Error('the refused create still made a repository')

    // Authenticated but in no mapped group: no role, no access. Never a default.
    const stranger = await oidc.api('GET', '/v1/repos', undefined, token('ostranger', ['some-other-team']))
    eq(stranger.status, 401, 'an unmapped group grants nothing')
    // A token signed by somebody else is not a token.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
    const pl = b64({ iss: issuer, aud: 'atomic-studio', exp: Math.floor(Date.now() / 1000) + 600, preferred_username: 'oadmin', groups: ['eng-admins'] })
    const forged = `${h}.${pl}.${createSign('RSA-SHA256').update(`${h}.${pl}`).end().sign(other.privateKey).toString('base64url')}`
    eq((await oidc.api('GET', '/v1/repos', undefined, forged)).status, 401, 'a forged signature is refused')

    return 'admin/manager read everything, lead/dev are scoped, no team record means nothing + a policy refusal, unmapped and forged tokens get 401'
  } finally {
    idp.close()
  }
})

// ---------------------------------------------------------------- 5c. the installed layout

await step('deploy: upgrades preserve configuration and CA while restarting the installed service', () => {
  // Capture the actual remote payload with a fake transport, then run it against
  // a temporary filesystem. Only account ownership and service management are stubs.
  // This exercises first install and upgrade without contacting a server or using root.
  const box = fs.mkdtempSync(path.join(TMP, 'deploy-upgrade-'))
  const bin = path.join(box, 'bin')
  const capture = path.join(box, 'remote.sh')
  const services = path.join(box, 'services.log')
  fs.mkdirSync(bin)
  const executable = (name, content) => fs.writeFileSync(path.join(bin, name), content, { mode: 0o755 })
  executable('ssh', '#!/bin/sh\nprintf "%s" "$2" > "$DEPLOY_CAPTURE"\n')
  executable('scp', '#!/bin/sh\nexit 0\n')
  executable('id', '#!/bin/sh\nexit 0\n')
  executable('chown', '#!/bin/sh\nexit 0\n')
  executable('sshd', '#!/bin/sh\nexit 0\n')
  executable('systemctl', '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEPLOY_SERVICES"\n')
  executable('install', '#!' + process.execPath + '\n' + `
    const { spawnSync } = require('node:child_process')
    const input = process.argv.slice(2), args = []
    for (let i = 0; i < input.length; i++) {
      if (input[i] === '-o' || input[i] === '-g') i++
      else args.push(input[i])
    }
    const r = spawnSync('/usr/bin/install', args, { stdio: 'inherit' })
    process.exit(r.status ?? 1)
  `)
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, DEPLOY_CAPTURE: capture, DEPLOY_SERVICES: services }
  execFileSync('sh', [path.join(HERE, 'deploy-workspaced.sh'), 'unused.invalid'], { env, stdio: 'pipe' })
  const payload = fs.readFileSync(capture, 'utf8').replace(/\/(?:usr\/local|etc|srv\/atomic|home\/git|tmp\/atomic-deploy)(?=\/|\s|$)/g, prefix => box + prefix)
  for (const rel of ['usr/local/bin', 'etc/ssh', 'etc/systemd/system', 'home/git']) fs.mkdirSync(path.join(box, rel), { recursive: true })
  fs.writeFileSync(path.join(box, 'etc/ssh/sshd_config'), '# test sshd configuration\n')
  const stage = () => {
    const dir = path.join(box, 'tmp/atomic-deploy')
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true })
    for (const name of ['atomic-workspaced.mjs', 'atomic-git-acl.mjs', 'atomic-git-cert.mjs', 'atomic-git-shell.mjs', 'atomic-oidc.mjs', 'atomic-workspaced.service']) {
      fs.copyFileSync(path.join(HERE, name), path.join(dir, name))
    }
    fs.copyFileSync(HOOK, path.join(dir, 'hooks/pre-receive.mjs'))
  }
  stage()
  execFileSync('sh', ['-c', payload], { env, stdio: 'pipe' })
  const config = path.join(box, 'etc/atomic-workspaced.env')
  const first = fs.readFileSync(config, 'utf8')
  if (!/^ATOMIC_WS_TOKEN=[a-f0-9]{48}$/m.test(first)) throw new Error('first install did not generate an owner key')
  const customized = first + 'ATOMIC_OIDC_ISSUER=https://login.example.test\n'
  fs.writeFileSync(config, customized)
  const ca = fs.readFileSync(path.join(box, 'etc/atomic/ssh-ca.pub'), 'utf8')
  stage()
  execFileSync('sh', ['-c', payload], { env, stdio: 'pipe' })
  eq(fs.readFileSync(config, 'utf8'), customized, 'upgrade preserves token and custom settings byte for byte')
  eq(fs.readFileSync(path.join(box, 'etc/atomic/ssh-ca.pub'), 'utf8'), ca, 'upgrade preserves trusted CA')
  const calls = fs.readFileSync(services, 'utf8').trim().split('\n')
  eq(calls.filter(x => x === 'restart atomic-workspaced').length, 2, 'both install and upgrade restart the service')
  eq(calls.filter(x => x === 'is-active --quiet atomic-workspaced').length, 2, 'both runs check service health')
  return 'actual deployment payload replayed twice locally; owner key, custom settings and CA preserved; restart and health check requested'
})

await step('deploy: the INSTALLED layout starts and resolves its own imports', async () => {
  /**
   * THE FAILURE THIS CATCHES. `deploy-workspaced.sh` used to scp atomic-workspaced.mjs and nothing
   * else. That file imports ./atomic-oidc.mjs, ./atomic-git-acl.mjs and ./atomic-git-cert.mjs as
   * SIBLINGS, so the installed service died on ERR_MODULE_NOT_FOUND before binding a port — while
   * every test passed, because every test ran it from the source tree where the siblings happen to
   * be present. Nothing short of starting the STAGED tree can catch that class of bug.
   */
  const stage = path.join(TMP, 'stage')
  execFileSync('sh', [path.join(HERE, 'deploy-workspaced.sh'), '--stage', stage], { encoding: 'utf8' })
  const lib = path.join(stage, 'usr', 'local', 'lib', 'atomic')
  for (const f of ['atomic-workspaced.mjs', 'atomic-git-acl.mjs', 'atomic-git-cert.mjs', 'atomic-git-shell.mjs', 'atomic-oidc.mjs', path.join('hooks', 'pre-receive.mjs')]) {
    if (!fs.existsSync(path.join(lib, f))) throw new Error(`the install is missing ${f}`)
  }
  for (const f of ['atomic-git-shell.mjs', path.join('hooks', 'pre-receive.mjs')]) {
    if (!(fs.statSync(path.join(lib, f)).mode & 0o111)) throw new Error(`${f} is installed non-executable`)
  }
  const wrapper = path.join(stage, 'usr', 'local', 'bin', 'atomic-git-shell')
  if (!(fs.statSync(wrapper).mode & 0o111)) throw new Error('the forced-command wrapper is not executable')
  // sshd does not inherit systemd's EnvironmentFile. Exercise the installed wrapper
  // with no CA in its environment; the node stand-in reports only public configuration.
  const probeBin = path.join(TMP, 'wrapper-probe-bin')
  fs.mkdirSync(probeBin)
  fs.writeFileSync(path.join(probeBin, 'node'), '#!/bin/sh\nprintf "%s" "$ATOMIC_GIT_CA_PUB"\n', { mode: 0o755 })
  const probe = spawnSync(wrapper, [], { encoding: 'utf8', env: { PATH: probeBin + ':' + process.env.PATH } })
  eq(probe.status, 0, 'installed wrapper starts node')
  eq(probe.stdout, '/etc/atomic/ssh-ca.pub', 'installed wrapper supplies the trusted CA')


  const freshRoot = path.join(TMP, 'installed-root')
  const freshGit = path.join(freshRoot, 'git')
  fs.mkdirSync(freshGit, { recursive: true })
  // ATOMIC_GIT_HOOK is deliberately BLANK: the daemon must find its own hook relative to where it
  // was installed. That default is the thing under test.
  const d = await startDaemon({
    script: path.join(lib, 'atomic-workspaced.mjs'),
    env: {
      ATOMIC_WS_ROOT: freshRoot,
      ATOMIC_GIT_ROOT: freshGit,
      ATOMIC_GIT_HOOK: '',
      ATOMIC_GIT_AUTHORIZED_KEYS: path.join(freshRoot, 'authorized_keys'),
      ATOMIC_GIT_EPOCHS: path.join(freshRoot, 'identity-epochs.json')
    }
  })
  if (!d) throw new Error('the installed daemon did not start — its imports do not resolve from the install layout')

  const made = await d.api('POST', '/v1/repos', { name: 'installed' })
  eq(made.status, 201, 'the installed daemon can create a repository')
  const hook = path.join(freshGit, 'installed.git', 'hooks', 'pre-receive')
  if (!fs.existsSync(hook)) throw new Error('the installed daemon could not find its own hook to install')
  if (!(fs.statSync(hook).mode & 0o111)) throw new Error('the installed hook is not executable')
  return '6 modules + wrapper staged, the daemon starts from the install tree and installs its hook from it'
})

// ---------------------------------------------------------------- 6. certificate identity

/** Sign a certificate with the test CA (or another), exactly as /v1/cert does. */
function signCert({ keyId, principals, validity = '+8h', ca = CA_KEY, key = USER_KEY }) {
  const dir = fs.mkdtempSync(path.join(TMP, 'cert-'))
  const pub = path.join(dir, 'id.pub')
  fs.copyFileSync(key + '.pub', pub)
  execFileSync('ssh-keygen', ['-q', '-s', ca, '-I', keyId, '-n', principals.join(','), '-V', validity, pub])
  return fs.readFileSync(path.join(dir, 'id-cert.pub'), 'utf8').trim()
}

const CA_BLOB = readPublicKeyBlob(CA_KEY + '.pub')

await step('cert: a well-formed certificate yields exactly the identity and role the CA signed', () => {
  const line = signCert({ keyId: 'atomic:alice:0', principals: ['git', 'alice', 'role:lead'] })
  const v = verifyCertificate(line, { caPublicKeyBlob: CA_BLOB, loginAccount: 'git' })
  if (!v.ok) throw new Error(`a valid certificate was refused: ${v.reason}`)
  eq(v.name, 'alice', 'certified name')
  eq(v.role, 'lead', 'certified role')
  eq(v.epoch, 0, 'revocation epoch')
  // And the reader that pulls it out of what sshd writes for $SSH_USER_AUTH.
  eq(certificateFromAuthInfo(`publickey ${line}\n`), line, 'certificate recovered from the auth-info file')
  if (certificateFromAuthInfo('publickey ssh-ed25519 AAAAC3Nza notacert') !== null) {
    throw new Error('a PLAIN public key is not a certificate and must not be read as one')
  }
  return 'name, role and epoch all come from the signed certificate'
})

await step('cert: validity ends exactly at validBefore, not one second later', () => {
  const line = signCert({ keyId: 'atomic:alice:0', principals: ['git', 'alice', 'role:lead'] })
  const cert = decodeCertificate(line)
  const end = Number(cert.validBefore) * 1000
  eq(verifyCertificate(line, { caPublicKeyBlob: CA_BLOB, now: end - 1 }).ok, true, 'last valid millisecond')
  eq(verifyCertificate(line, { caPublicKeyBlob: CA_BLOB, now: end }).ok, false, 'expiry boundary')
})

await step('cert: malformed revocation entries fail closed and special names retain their epoch', () => {
  const ledger = path.join(TMP, 'epoch-validation.json')
  eq(currentEpoch(readEpochs(ledger), 'alice'), 0, 'fresh install')
  for (const value of ['"1"', '-1', '0.5', 'null', '9007199254740992']) {
    fs.writeFileSync(ledger, '{"alice":' + value + '}')
    eq(readEpochs(ledger), null, 'invalid epoch ' + value)
  }
  fs.writeFileSync(ledger, '{"__proto__":2,"constructor":3,"alice":1}')
  const epochs = readEpochs(ledger)
  eq(currentEpoch(epochs, '__proto__'), 2, 'prototype-like name')
  eq(currentEpoch(epochs, 'constructor'), 3, 'constructor-like name')
  eq(currentEpoch(epochs, 'alice'), 1, 'ordinary name')
})

await step('cert: expired, wrong-CA, malformed, missing-principal and role-tampered are ALL refused', () => {
  const otherCa = path.join(TMP, 'ca2')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'impostor-ca', '-f', otherCa])

  const cases = [
    ['expired', signCert({ keyId: 'atomic:alice:0', principals: ['git', 'alice', 'role:lead'], validity: '-2h:-1h' }), /expired/i],
    ['not yet valid', signCert({ keyId: 'atomic:alice:0', principals: ['git', 'alice', 'role:lead'], validity: '+1h:+2h' }), /not valid yet/i],
    ['wrong CA', signCert({ keyId: 'atomic:alice:0', principals: ['git', 'alice', 'role:admin'], ca: otherCa }), /different authority/i],
    ['malformed', 'this is not a certificate at all', /could not be read/i],
    ['a plain public key', fs.readFileSync(USER_KEY + '.pub', 'utf8').trim(), /could not be read/i],
    ['no role principal', signCert({ keyId: 'atomic:alice:0', principals: ['git', 'alice'] }), /exactly one role/i],
    ['two role principals', signCert({ keyId: 'atomic:alice:0', principals: ['git', 'alice', 'role:dev', 'role:admin'] }), /exactly one role/i],
    ['an unknown role', signCert({ keyId: 'atomic:alice:0', principals: ['git', 'alice', 'role:superuser'] }), /role this server does not know/i],
    ['a name the principals do not carry', signCert({ keyId: 'atomic:alice:0', principals: ['git', 'bob', 'role:dev'] }), /name and principals disagree/i],
    ['no ATOMIC key id', signCert({ keyId: 'whatever', principals: ['git', 'alice', 'role:dev'] }), /does not name an ATOMIC identity/i],
    ['a host certificate', null, /host certificate/i]
  ]

  // A host certificate has to be made with -h; build it separately.
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'hostcert-'))
    const pub = path.join(dir, 'id.pub')
    fs.copyFileSync(USER_KEY + '.pub', pub)
    execFileSync('ssh-keygen', ['-q', '-s', CA_KEY, '-h', '-I', 'atomic:alice:0', '-n', 'git', '-V', '+8h', pub])
    cases[cases.length - 1][1] = fs.readFileSync(path.join(dir, 'id-cert.pub'), 'utf8').trim()
  }

  for (const [what, line, expect] of cases) {
    const v = verifyCertificate(line, { caPublicKeyBlob: CA_BLOB, loginAccount: 'git' })
    if (v.ok) throw new Error(`${what} was ACCEPTED`)
    if (!expect.test(v.reason)) throw new Error(`${what}: unexpected reason "${v.reason}"`)
  }

  /**
   * ROLE TAMPERING is the one that proves the signature is really checked. A certificate carries
   * its own CA public key, and that key is public — so anyone can build a blob that PRINTS our CA's
   * fingerprint under `ssh-keygen -L`. Comparing fingerprints would therefore prove nothing at all.
   * Here the principal bytes are edited in place, keeping the length so every offset still parses,
   * and the only thing that can catch it is verifying the CA signature over the real bytes.
   */
  const good = signCert({ keyId: 'atomic:alice:0', principals: ['git', 'alice', 'role:dev'] })
  const [type, b64] = good.split(/\s+/)
  const blob = Buffer.from(b64, 'base64')
  const at = blob.indexOf(Buffer.from('role:dev', 'utf8'))
  if (at === -1) throw new Error('could not find the role principal to tamper with')
  blob.write('role:adm', at, 'utf8') // same length, so the wire format still decodes cleanly
  const tampered = `${type} ${blob.toString('base64')}`
  if (decodeCertificate(tampered) === null) throw new Error('the tampered certificate should still DECODE — that is the point')
  const t = verifyCertificate(tampered, { caPublicKeyBlob: CA_BLOB, loginAccount: 'git' })
  if (t.ok) throw new Error('a role-tampered certificate was accepted')
  if (!/signature does not verify/i.test(t.reason)) throw new Error(`tampering was caught by the wrong check: ${t.reason}`)

  // And with no CA configured at all, nothing verifies. "Unconfigured" must never mean "open".
  const none = verifyCertificate(good, { caPublicKeyBlob: null })
  if (none.ok) throw new Error('a certificate was accepted with no trusted CA configured')

  return `${cases.length} malformed/expired/mis-signed certificates refused, role tampering caught by the signature, no-CA fails closed`
})

await step('shell: certificate identity drives the gate, and the client environment never does', () => {
  const certEnv = (extra = {}) => ({
    ...process.env,
    ATOMIC_GIT_ROOT: ROOT,
    ATOMIC_GIT_MEMBERS: MEMBERS,
    ATOMIC_GIT_AUDIT: AUDIT,
    ATOMIC_GIT_CA_PUB: CA_KEY + '.pub',
    ATOMIC_GIT_EPOCHS: EPOCHS,
    ATOMIC_GIT_ACCOUNT: 'git',
    ...extra
  })
  const authFile = (line) => {
    const f = path.join(fs.mkdtempSync(path.join(TMP, 'authinfo-')), 'auth')
    fs.writeFileSync(f, `publickey ${line}\n`)
    return f
  }
  const run = (line, cmd, extra = {}) =>
    spawnSync('node', [SHELL], {
      encoding: 'utf8',
      input: '',
      env: certEnv({ ...(line ? { SSH_USER_AUTH: authFile(line) } : {}), SSH_ORIGINAL_COMMAND: cmd, ...extra })
    })
  /**
   * DENIED means the GATE refused, not that the exit code was non-zero.
   *
   * `git-upload-pack` fed an empty stdin ends with "the remote end hung up unexpectedly" and a
   * non-zero status — a perfectly normal outcome for a request that was ALLOWED and then got no
   * protocol. Reading that as a refusal made an allow-case assertion fail for a reason that had
   * nothing to do with access. Every refusal this program makes is prefixed `atomic-git:`, so that
   * prefix is the thing to test.
   */
  const denied = (r) => /^atomic-git:/m.test(r.stderr || '')

  // 1. A valid certificate reaches git-upload-pack.
  const alice = signCert({ keyId: 'atomic:alice:0', principals: ['git', 'alice', 'role:lead'] })
  const ok = run(alice, "git-upload-pack 'studio.git'")
  if (denied(ok)) throw new Error(`a certified lead was refused: ${ok.stderr}`)

  // 2. The CERTIFICATE's role wins over members.json. `nobody` has no member row at all; as a
  //    manager they read everything, which is exactly what the role table says.
  const mgr = run(signCert({ keyId: 'atomic:nobody:0', principals: ['git', 'nobody', 'role:manager'] }), "git-upload-pack 'studio.git'")
  if (denied(mgr)) throw new Error(`a certified manager could not read: ${mgr.stderr}`)
  // …and a manager never writes.
  const mgrWrite = run(signCert({ keyId: 'atomic:nobody:0', principals: ['git', 'nobody', 'role:manager'] }), "git-receive-pack 'studio.git'")
  if (!denied(mgrWrite)) throw new Error('a certified manager was allowed to push')

  // 3. A scoped role with no member row has NO scope, so it sees nothing. Fail closed.
  const orphan = run(signCert({ keyId: 'atomic:nobody:0', principals: ['git', 'nobody', 'role:dev'] }), "git-upload-pack 'studio.git'")
  if (!denied(orphan)) throw new Error('a scoped role with no team record was granted access')

  // 4. NO certificate and NO argv identity: refused, never attributed to nobody.
  const anon = run(null, "git-upload-pack 'studio.git'")
  if (!denied(anon)) throw new Error('an unauthenticated caller was served')
  if (!/certificate/i.test(anon.stderr)) throw new Error(`unhelpful refusal: ${anon.stderr}`)

  /**
   * 5. THE ENVIRONMENT IS NOT AN IDENTITY. ATOMIC_GIT_USER and ATOMIC_GIT_ROLE are what this
   *    program hands DOWN to the pre-receive hook; if a client could pre-set them (an sshd with a
   *    careless AcceptEnv, say) it would name itself. They are deleted on entry.
   */
  const spoof = run(null, "git-upload-pack 'studio.git'", { ATOMIC_GIT_USER: 'alice', ATOMIC_GIT_ROLE: 'admin' })
  if (!denied(spoof)) throw new Error('a client named itself through the environment')
  const spoofWithCert = run(alice, "git-receive-pack 'other.git'", { ATOMIC_GIT_USER: 'olive', ATOMIC_GIT_ROLE: 'admin' })
  if (denied(spoofWithCert)) throw new Error(`alice is scoped to '*' and should have been allowed: ${spoofWithCert.stderr}`)
  // It had to succeed AS ALICE, with the role the CA signed. The audit line is the only place that
  // difference is visible, so that is where it is asserted.
  const lastAllow = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'allow').at(-1)
  eq(lastAllow.user, 'alice', 'the environment did not override the certified name')
  eq(lastAllow.role, 'lead', 'the environment did not override the certified role')
  eq(lastAllow.via, 'certificate', 'the identity came from the certificate')

  // 6. A stale epoch is refused even though the certificate has not expired.
  const stale = run(signCert({ keyId: 'atomic:rex:0', principals: ['git', 'rex', 'role:dev'] }), "git-upload-pack 'studio.git'")
  if (!denied(stale)) throw new Error('a certificate from before a revocation still worked')
  if (!/revoked or reissued/i.test(stale.stderr)) throw new Error(`wrong refusal for a stale epoch: ${stale.stderr}`)

  // 7. The interactive shell is still refused outright.
  const shell = spawnSync('node', [SHELL], { encoding: 'utf8', env: certEnv({ SSH_USER_AUTH: authFile(alice) }) })
  if (!denied(shell)) throw new Error('a certificate bought an interactive shell')
  return 'cert role is authoritative, no row means no scope, no cert means no identity, env cannot name you, stale epoch refused, still no shell'
})

// ---------------------------------------------------------------- 7. a REAL sshd

/**
 * Everything above proves the gate is a correct function of (certificate, command). This proves the
 * OTHER half: that sshd, configured the way server/INSTALL-GIT.md documents, actually hands the
 * certificate to the forced command in the first place. No amount of unit testing reaches
 * `TrustedUserCAKeys` + `ExposeAuthInfo` + `ForceCommand` working together — and that trio is where
 * the whole certificate scheme lives or dies.
 *
 * It runs UNPRIVILEGED on a loopback port, so it can only authenticate the user running the suite.
 * That is why the certificate's principals include the current account: sshd matches certificate
 * principals against the account being logged into, which is exactly how one shared `git` account
 * works in production without an authorized_keys line per person.
 */
const sshdBin = ['/usr/sbin/sshd', '/usr/bin/sshd', '/usr/local/sbin/sshd'].find((p) => fs.existsSync(p))
const sshds = []

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

if (!sshdBin) {
  skip('sshd: a real certificate login reaches the forced command, clones and pushes', 'no sshd binary on this machine')
} else {
  await step('sshd: a real certificate login reaches the forced command, clones and pushes', async () => {
    const dir = path.join(TMP, 'sshd')
    fs.mkdirSync(dir, { recursive: true })
    const me = os.userInfo().username
    const port = await freePort()
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'hostkey')])

    // The forced command, exactly as sshd_config's ForceCommand names it. No argument: identity
    // must come from the certificate.
    const forced = path.join(dir, 'forced.sh')
    /**
     * ABSOLUTE PATHS, and an explicit PATH for the child.
     *
     * sshd runs a forced command through the user's LOGIN SHELL, which starts from a near-empty
     * environment — `node` was simply not found. A real install has the same problem and solves it
     * the same way, which is why deploy-workspaced.sh writes a wrapper with `/usr/bin/env node`
     * rather than assuming an interactive PATH. `git-upload-pack` needs to be findable too, since
     * the forced command spawns it by name.
     */
    const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    fs.writeFileSync(
      forced,
      `#!/bin/sh\n` +
        `PATH=${path.dirname(gitBin)}:${path.dirname(process.execPath)}:/usr/bin:/bin\n` +
        `export PATH\n` +
        `ATOMIC_GIT_ROOT=${JSON.stringify(ROOT)} ATOMIC_GIT_MEMBERS=${JSON.stringify(MEMBERS)} \\\n` +
        `ATOMIC_GIT_AUDIT=${JSON.stringify(AUDIT)} ATOMIC_GIT_CA_PUB=${JSON.stringify(CA_KEY + '.pub')} \\\n` +
        `ATOMIC_GIT_EPOCHS=${JSON.stringify(EPOCHS)} ATOMIC_GIT_ACCOUNT=${JSON.stringify(me)} \\\n` +
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(SHELL)}\n`
    )
    fs.chmodSync(forced, 0o755)

    const conf = path.join(dir, 'sshd_config')
    fs.writeFileSync(
      conf,
      [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${path.join(dir, 'hostkey')}`,
        `PidFile ${path.join(dir, 'sshd.pid')}`,
        'LogLevel ERROR',
        'UsePAM no',
        // The tmp tree is not mode 755 all the way up; StrictModes is about protecting a real
        // user's home directory and has nothing to do with what is under test.
        'StrictModes no',
        'PermitRootLogin no',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        // No authorized_keys anywhere: the CA is the ONLY way in. That is the point.
        'AuthorizedKeysFile none',
        `TrustedUserCAKeys ${CA_KEY}.pub`,
        'ExposeAuthInfo yes',
        `ForceCommand ${forced}`,
        'PermitTTY no',
        'AllowTcpForwarding no',
        'X11Forwarding no',
        'PermitTunnel no',
        'PermitUserEnvironment no',
        ''
      ].join('\n')
    )
    const check = spawnSync(sshdBin, ['-t', '-f', conf], { encoding: 'utf8' })
    if (check.status !== 0) throw new Error(`sshd rejected the documented config: ${check.stderr}`)

    const proc = spawn(sshdBin, ['-D', '-f', conf, '-E', path.join(dir, 'sshd.log')], { stdio: 'ignore' })
    sshds.push(proc)
    // Wait for the listener rather than sleeping.
    let listening = false
    for (let i = 0; i < 60 && !listening; i++) {
      listening = await new Promise((r) => {
        const c = net.connect(port, '127.0.0.1')
        c.on('connect', () => { c.destroy(); r(true) })
        c.on('error', () => r(false))
      })
      if (!listening) await sleep(50)
    }
    if (!listening) throw new Error(`sshd never listened on ${port}: ${fs.existsSync(path.join(dir, 'sshd.log')) ? fs.readFileSync(path.join(dir, 'sshd.log'), 'utf8') : ''}`)

    const cert = (name) => {
      const line = fs.readFileSync(path.join(dir, `${name}-cert.pub`), 'utf8')
      return line
    }
    const issue = (name, { principals, keyId = 'atomic:alice:0', validity = '+1h', ca = CA_KEY }) => {
      const pub = path.join(dir, `${name}.pub`)
      fs.copyFileSync(USER_KEY + '.pub', pub)
      execFileSync('ssh-keygen', ['-q', '-s', ca, '-I', keyId, '-n', principals.join(','), '-V', validity, pub])
      return path.join(dir, `${name}-cert.pub`)
    }
    const SSH_OPTS = (certFile) =>
      `ssh -p ${port} -i ${USER_KEY} -o CertificateFile=${certFile} -o IdentitiesOnly=yes ` +
      `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes`
    const withCert = (certFile) => ({ ...process.env, GIT_SSH_COMMAND: SSH_OPTS(certFile) })

    // --- the good certificate: clone, commit, push, all over a real transport ---
    const good = issue('good', { principals: [me, 'alice', 'role:lead'] })
    const url = `ssh://${me}@127.0.0.1:${port}${path.join(ROOT, 'studio.git')}`
    const dest = path.join(dir, 'clone')
    const cloned = spawnSync('git', ['clone', '-q', url, dest], { encoding: 'utf8', env: withCert(good) })
    if (cloned.status !== 0) throw new Error(`certificate clone failed: ${cloned.stdout}${cloned.stderr}`)
    if (!fs.existsSync(path.join(dest, 'readme.md'))) throw new Error('the clone brought no content')

    git(dest, 'config', 'user.email', 'alice@team.internal')
    git(dest, 'config', 'user.name', 'Alice')
    fs.writeFileSync(path.join(dest, 'over-ssh.txt'), 'pushed with a certificate\n')
    git(dest, 'add', '-A')
    git(dest, 'commit', '-qm', 'a real certificate push')
    const pushed = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/cert-branch'], { cwd: dest, encoding: 'utf8', env: withCert(good) })
    if (pushed.status !== 0) throw new Error(`certificate push failed: ${pushed.stdout}${pushed.stderr}`)
    const onServer = git(path.join(ROOT, 'studio.git'), 'log', '--oneline', '-n', '1', 'cert-branch')
    if (!/a real certificate push/.test(onServer)) throw new Error(`the push did not land: ${onServer}`)

    // The audit trail must name the CERTIFIED identity and say where it came from.
    const allows = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'allow' && e.via === 'certificate')
    if (!allows.length) throw new Error('nothing was audited as a certificate login')
    eq(allows.at(-1).user, 'alice', 'audited as the certified identity')

    // --- and an interactive shell is still refused, over the real transport ---
    const shell = spawnSync('ssh', SSH_OPTS(good).split(' ').slice(1).concat([`${me}@127.0.0.1`]), { encoding: 'utf8' })
    if (shell.status === 0) throw new Error('a real certificate login got an interactive shell')
    if (!/git access only/i.test(shell.stderr)) throw new Error(`wrong refusal for an interactive login: ${shell.stderr}`)

    /**
     * --- THE ARCHITECTURAL POINT: creation works, arbitrary remote commands do not ---
     *
     * `git-provision.createBareRepo` on a STANDALONE server runs `ssh <host> git init --bare <dir>`.
     * A managed server must never allow that, because allowing it means the shared account can run
     * commands — and then the forced command's allow-list, the role table and the mandatory hook
     * are all optional. The desktop therefore creates through the control plane on a managed seat.
     * Both halves are asserted here, together, because each is only meaningful with the other:
     * a server that refuses everything is secure and useless.
     */
    for (const hostile of [
      `git init --bare ${path.join(ROOT, 'sneaky.git')}`,
      'id',
      "git-upload-pack 'studio.git'; id",
      "git-upload-pack --upload-pack=id 'studio.git'",
      'git-upload-pack `id`'
    ]) {
      const attempt = spawnSync('ssh', SSH_OPTS(good).split(' ').slice(1).concat([`${me}@127.0.0.1`, hostile]), { encoding: 'utf8' })
      if (attempt.status === 0) throw new Error(`the secured server ran a remote command: ${hostile}`)
      if (!/atomic-git:/.test(attempt.stderr)) throw new Error(`refusal did not come from the gate: ${attempt.stderr}`)
    }
    if (fs.existsSync(path.join(ROOT, 'sneaky.git'))) throw new Error('an over-SSH `git init --bare` created a repository')

    // …and the supported route works, over the SAME certificate transport and a non-default port.
    const viaApi = await api('POST', '/v1/repos', { name: 'desktopmade' })
    eq(viaApi.status, 201, 'the control plane created the repository the desktop asked for')
    const madeDest = path.join(dir, 'clone-made')
    const cloneMade = spawnSync(
      'git',
      ['clone', '-q', `ssh://${me}@127.0.0.1:${port}${path.join(ROOT, 'desktopmade.git')}`, madeDest],
      { encoding: 'utf8', env: withCert(good) }
    )
    if (cloneMade.status !== 0) throw new Error(`could not clone the control-plane-created repository: ${cloneMade.stderr}`)

    // --- refusals, split across the two layers that must each hold ---
    const otherCa = path.join(dir, 'ca2')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', otherCa])
    const bySshd = [
      ['expired', issue('expired', { principals: [me, 'alice', 'role:lead'], validity: '-2h:-1h' })],
      ['signed by another CA', issue('wrongca', { principals: [me, 'alice', 'role:lead'], ca: otherCa })],
      ['without a principal for this account', issue('noaccount', { principals: ['alice', 'role:lead'] })]
    ]
    for (const [what, c] of bySshd) {
      const r = spawnSync('git', ['ls-remote', url], { encoding: 'utf8', env: withCert(c) })
      if (r.status === 0) throw new Error(`sshd accepted a certificate ${what}`)
    }
    // sshd only checks principals against the ACCOUNT — a certificate with no role principal is a
    // perfectly good login as far as it is concerned. Our forced command is what refuses it, and
    // proving that split is the point: neither layer alone is sufficient.
    const noRole = issue('norole', { principals: [me, 'alice'] })
    const r = spawnSync('git', ['ls-remote', url], { encoding: 'utf8', env: withCert(noRole) })
    if (r.status === 0) throw new Error('a certificate with no role was served')
    if (!/exactly one role/i.test(r.stderr)) throw new Error(`the forced command did not refuse it: ${r.stderr}`)
    // Likewise a role-tampered key id: sshd cannot see it, we must.
    const tamperedId = issue('badid', { principals: [me, 'alice', 'role:lead'], keyId: 'not-an-atomic-id' })
    const r2 = spawnSync('git', ['ls-remote', url], { encoding: 'utf8', env: withCert(tamperedId) })
    if (r2.status === 0) throw new Error('a certificate with no ATOMIC key id was served')

    return 'real sshd on a non-default port: clone + push work; 5 arbitrary remote commands refused while control-plane creation succeeds and clones; expired/wrong-CA/wrong-account refused by sshd, no-role and bad-key-id by the forced command; no shell'
  })
}

// ---------------------------------------------------------------- report
for (const d of daemons) { try { d.kill() } catch { /* already gone */ } }
for (const d of sshds) { try { d.kill() } catch { /* already gone */ } }
console.log(`\n\x1b[1m${pass}/${pass + failures.length} server checks passed\x1b[0m`)
for (const s of skipped) console.log(`\x1b[33mskipped:\x1b[0m ${s.name} — ${s.why}`)
if (failures.length) {
  console.log('\n\x1b[31mFailures:\x1b[0m')
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.error}`)
}
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(failures.length ? 1 : 0)
