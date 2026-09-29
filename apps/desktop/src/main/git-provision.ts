import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { validRepoName } from '../shared/gitnames'
import type { GitServer, PreflightResult, PreflightStep, PublishPlan, PublishResult, RemoteConfig } from '../shared/types'
import { audit } from './audit'
import { gitCommit, gitInfo, gitInit, gitPush, gitRemoteAdd, gitWorkingStat } from './git-core'
import { ensureAccessToken } from './identity'
import { enterprisePolicy, identityRequired } from './policy'
import { rq, sshRun } from './remote'

const execFileP = promisify(execFile)

// Re-exported so callers (this module's tests included) can talk to `git-provision` alone
// without needing to know the rule itself lives in `shared/gitnames` — that split exists so
// the renderer can import the same rule later without depending on a main-process module.
export { validRepoName }

/**
 * Putting a repository on the user's own server.
 *
 * This module deliberately sits BESIDE the `Forge` seam rather than inside it. `forge.ts` states
 * what that interface excludes — no clone, no push, no pull — because those live in `git-core` and
 * take a plain URL, so they never learn which forge produced it. Provisioning ends the same way:
 * it produces a plain `ssh://` URL and hands it on. Nothing here knows about catalogues.
 *
 * ── TWO SERVERS, TWO MECHANISMS, AND THEY ARE NOT INTERCHANGEABLE ─────────────────────────────
 *
 * STANDALONE / BYO. Somebody's own box with sshd and a directory of bare repositories. There is no
 * control plane to ask, so creating a repository IS `ssh <host> git init --bare <dir>` — a shell
 * command on a server the user owns and has an interactive account on. The `test -e` guard and the
 * name validation are what make that safe.
 *
 * MANAGED (ATOMIC). The server's shared `git` account has NO interactive shell: sshd runs a forced
 * command that speaks exactly three git verbs and refuses everything else, which is the wedge. So
 * `git init --bare` over SSH cannot work there and must not be made to work there — weakening the
 * forced command to accept it would hand every seat arbitrary remote execution to save one REST
 * call. Managed creation therefore goes to `POST /v1/repos` on the authenticated control plane,
 * which is the only component allowed to touch the repository root, applies the role table, and
 * installs the mandatory pre-receive hook.
 *
 * The two paths are chosen by `identityRequired()` and never blended. Anything that would let a
 * managed seat fall back to the SSH path is a downgrade attack on the managed server's model.
 *
 * All SSH goes through `remote.ts`'s low-level `sshRun`, whose own comment already names this use
 * ("used by ATOMIC Workspaces provisioning"). This is the established path, not a second one.
 */

/** ssh reserves 255 for ITS OWN failures; any other code means a shell ran on the far side. */
const SSH_OWN_FAILURE = 255

/** The one key Studio may create. Absolute, because `sshBase` passes it as `-i "<path>"` and the
 *  shell cannot expand a tilde inside those quotes. */
export function studioKeyPath(): string {
  return join(homedir(), '.ssh', 'atomic_studio_ed25519')
}

function toConfig(s: GitServer): RemoteConfig {
  return {
    host: s.host,
    user: s.sshUser,
    port: s.port ?? 22,
    // An empty string means "let ssh choose from the agent" — sshBase omits -i entirely.
    keyPath: s.keyPath ?? '',
    root: s.root
  }
}

function firstLine(s: string): string {
  return (s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? ''
}

/**
 * Is this a MANAGED seat? One question, one place, so the two provisioning mechanisms can never be
 * blended by a caller that forgot which server it was talking to.
 */
export function isManaged(): boolean {
  return identityRequired()
}

function controlPlane(): string {
  return enterprisePolicy().idp?.controlPlane?.trim().replace(/\/+$/, '') ?? ''
}

interface ControlPlaneRepo {
  name?: string
  url?: string
  error?: string
  code?: string
}

/**
 * `POST /v1/repos` on the control plane. The ONLY way a managed repository is created.
 *
 * Every failure the server can express is turned into something a person can act on, because
 * "could not create the repository" was the whole complaint that started this work:
 *   401/403 NO_MEMBER_RECORD  you are signed in but not on the team — an administrator must add you
 *   403 otherwise             your role does not create repositories
 *   409                       the name is taken (the server refuses rather than adopting it)
 *
 * The URL comes back FROM THE SERVER and is used verbatim. Rebuilding it here from host + root is
 * how the port went missing: the server knows its own SSH port and the client is guessing.
 */
async function createManagedRepo(name: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cp = controlPlane()
  if (!cp) return { ok: false, error: 'This seat is managed, but no company server is configured.' }
  const token = await ensureAccessToken()
  if (!token) return { ok: false, error: 'Sign in to your company server first.' }
  let res: Response
  try {
    res = await fetch(`${cp}/v1/repos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-atomic-proto': '1',
        // A retried create must not make a second repository. The server returns the original
        // response for a repeat of the same key.
        'Idempotency-Key': `repo-${name}-${Date.now().toString(36)}`
      },
      body: JSON.stringify({ name })
    })
  } catch (e) {
    return { ok: false, error: `Studio could not reach the company server: ${e instanceof Error ? e.message : String(e)}` }
  }
  let body: ControlPlaneRepo = {}
  try {
    body = (await res.json()) as ControlPlaneRepo
  } catch {
    /* an empty or non-JSON body is covered by the status below */
  }
  if (res.status === 409) {
    return { ok: false, error: `A repository called ${name} already exists on this server — clone it instead.` }
  }
  if (res.status === 401) return { ok: false, error: 'Your company sign-in has expired. Sign in again.' }
  if (res.status === 403) {
    return { ok: false, error: body.error || 'Your role on this server cannot create repositories.' }
  }
  if (!res.ok) return { ok: false, error: body.error || `The company server refused (${res.status}).` }
  if (!body.url) return { ok: false, error: 'The company server created the repository but returned no clone URL.' }
  return { ok: true, url: body.url }
}

export async function preflight(s: GitServer): Promise<PreflightResult> {
  const cfg = toConfig(s)
  const steps: PreflightStep[] = []

  // ONE probe answers both "can I reach it" and "will it let me in", because ssh's own failures
  // are exit 255 and everything else proves we got a shell.
  const hello = await sshRun(cfg, 'true')
  if (hello.code === SSH_OWN_FAILURE || hello.code === null) {
    const out = hello.output || ''

    if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(out)) {
      // We reached SOMETHING at that address — that is exactly why this is alarming rather than
      // a connection problem. Never suggest clearing known_hosts; the right answer may be to stop.
      steps.push({ id: 'reach', ok: true, detail: `reached ${s.host}` })
      steps.push({ id: 'auth', ok: false, detail: 'the host key changed since last time' })
      return { ok: false, steps, remedy: { kind: 'host-key-changed' } }
    }

    if (/Permission denied|No supported authentication|Too many authentication/i.test(out)) {
      steps.push({ id: 'reach', ok: true, detail: `reached ${s.host}` })
      steps.push({ id: 'auth', ok: false, detail: 'the server refused the key' })
      return {
        ok: false,
        steps,
        remedy: { kind: existsSync(studioKeyPath()) ? 'key-refused' : 'no-key' }
      }
    }

    steps.push({ id: 'reach', ok: false, detail: firstLine(out) || `could not reach ${s.host}` })
    return { ok: false, steps, remedy: { kind: 'unreachable' } }
  }

  steps.push({ id: 'reach', ok: true, detail: `reached ${s.host}` })
  steps.push({ id: 'auth', ok: true, detail: `signed in as ${s.sshUser}` })

  if (isManaged()) {
    // A managed seat has no writable repository root and no business running `command -v git` —
    // both of those describe a shell it deliberately does not have. The question that actually
    // decides whether publishing will work is whether the control plane will answer.
    const cp = controlPlane()
    const token = await ensureAccessToken()
    if (!cp || !token) {
      steps.push({ id: 'control', ok: false, detail: 'not signed in to the company server' })
      return { ok: false, steps, remedy: { kind: 'not-signed-in' } }
    }
    try {
      const me = await fetch(`${cp}/v1/me`, { headers: { Authorization: `Bearer ${token}` } })
      if (!me.ok) {
        steps.push({ id: 'control', ok: false, detail: `the company server answered ${me.status}` })
        return { ok: false, steps, remedy: { kind: me.status === 403 ? 'not-permitted' : 'not-signed-in' } }
      }
      const who = (await me.json()) as { role?: string; name?: string }
      steps.push({ id: 'control', ok: true, detail: `the company server knows you as ${who.name ?? 'you'} (${who.role ?? 'no role'})` })
    } catch (e) {
      steps.push({ id: 'control', ok: false, detail: firstLine(e instanceof Error ? e.message : String(e)) || 'the company server did not answer' })
      return { ok: false, steps, remedy: { kind: 'not-signed-in' } }
    }
    return { ok: true, steps }
  }

  const writable = await sshRun(cfg, `test -w ${rq(s.root)}`)
  if (writable.code !== 0) {
    steps.push({ id: 'writable', ok: false, detail: `${s.root} is missing or not writable` })
    return { ok: false, steps, remedy: { kind: 'not-writable', command: `mkdir -p ${rq(s.root)}` } }
  }
  steps.push({ id: 'writable', ok: true, detail: `${s.root} is writable` })

  const git = await sshRun(cfg, 'command -v git')
  if (git.code !== 0) {
    steps.push({ id: 'git', ok: false, detail: 'git is not installed on the server' })
    // No distro detection: guessing the package manager wrong is worse than not guessing.
    return { ok: false, steps, remedy: { kind: 'no-git' } }
  }
  steps.push({ id: 'git', ok: true, detail: 'git is installed' })

  return { ok: true, steps }
}

/** Absolute path of a bare repo's directory on the server. No IO, no validation of `name` here —
 *  callers that build a shell command from this MUST go through `planRepo`, which validates first. */
export function repoDir(s: GitServer, name: string): string {
  return `${s.root.replace(/\/+$/, '')}/${name}.git`
}

/**
 * The URL and the exact command, with NO side effects — this is what the confirmation screen
 * shows before the user agrees to anything, so computing it must not be able to touch the
 * server just by being called. Two defences against a hostile `name`, and neither is optional:
 * `validRepoName` rejects it outright, and `rq()` quotes the path anyway before it reaches a
 * shell. (`JSON.stringify` was tried elsewhere in this codebase as a "quick" escape and produced
 * a real command injection — it emits double quotes, and a POSIX shell still expands `$(...)`
 * inside those. `rq()` single-quotes, which a POSIX shell never expands.)
 */
export function planRepo(s: GitServer, name: string): { url: string; command: string; managed: boolean } {
  if (!validRepoName(name)) {
    throw new Error(`"${name}" is not a valid repository name — use letters, numbers, dot, dash or underscore.`)
  }
  const dir = repoDir(s, name)
  // Omit the port when it's the default so the URL matches what everyone types by hand; a
  // non-default port must still show up, or a clone silently goes to 22 and fails opaquely.
  const port = s.port && s.port !== 22 ? `:${s.port}` : ''
  const url = `ssh://${s.sshUser}@${s.host}${port}${dir}`
  if (isManaged()) {
    // The URL here is a PREDICTION for the confirm screen; `publishRun` uses the one the server
    // returns, because the server is the authority on its own SSH port and repository root.
    return { url, command: `POST ${controlPlane() || '<company server>'}/v1/repos  {"name":"${name}"}`, managed: true }
  }
  return { url, command: `git init --bare ${rq(dir)}`, managed: false }
}

/**
 * Create the bare repository, having first proved the name is free.
 *
 * `git init --bare` on an EXISTING directory succeeds silently. Without the `test -e` below, a
 * user publishing under a name someone else already used would end up with `origin` pointed at
 * that other repository and would discover it by pushing into it. This is the one place in this
 * module where being helpful would be actively dangerous, so it refuses instead.
 */
export async function createBareRepo(
  s: GitServer,
  name: string
): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!validRepoName(name)) {
    return { ok: false, error: `"${name}" is not a valid repository name — use letters, numbers, dot, dash or underscore.` }
  }

  // MANAGED: the control plane creates it. This branch is FIRST and unconditional — a managed seat
  // must never reach the SSH path below, which would need an interactive shell the server does not
  // grant and, if it ever did, would bypass the role table and the mandatory pre-receive hook.
  if (isManaged()) {
    const made = await createManagedRepo(name)
    if (made.ok) audit('git-provision-create', `control-plane ${name} -> ${made.url}`)
    return made
  }

  const cfg = toConfig(s)
  const dir = repoDir(s, name)

  const taken = await sshRun(cfg, `test -e ${rq(dir)}`)
  if (taken.code === 0) {
    return { ok: false, error: `A repository called ${name} already exists on this server — clone it instead.` }
  }

  const { url, command } = planRepo(s, name)
  const res = await sshRun(cfg, command)
  if (res.code !== 0) {
    return { ok: false, error: firstLine(res.output) || `could not create ${name} on ${s.host}` }
  }
  audit('git-provision-create', `${s.sshUser}@${s.host}:${dir}`)
  return { ok: true, url }
}

/**
 * Make sure Studio has a key it may offer to this server.
 *
 * Three rules, all deliberate:
 *  - It writes ONE path, `studioKeyPath()` (`~/.ssh/atomic_studio_ed25519`), and NEVER `id_rsa` /
 *    `id_ed25519`. A tool that rewrites your default SSH identity is a tool you cannot trust with
 *    anything else — this is the whole reason `git-provision` never opens the default identity at
 *    all, not even to read it.
 *  - It never overwrites. If the private half is already on disk but the `.pub` is gone, the public
 *    half is DERIVED from the private key (`ssh-keygen -y`) rather than regenerated. Regenerating
 *    would silently invalidate a key the user already installed on their server — the failure
 *    shows up as "the server mysteriously stopped accepting me," with nothing to connect it back
 *    to Studio having run.
 *  - The key is generated with NO passphrase. That is normal for an automation key, and the blast
 *    radius is bounded because the key is dedicated rather than the user's own identity — but it
 *    is said here, out loud, rather than left for someone to discover later.
 *
 * Studio creates the private key and then never reads it again; only `ssh` does, via `-i`. The
 * argv passed to `ssh-keygen` is always an array, never an interpolated string — this codebase
 * already has two real command-injection fixes from the mistake of treating `JSON.stringify` as a
 * shell escape (it emits double quotes; a POSIX shell still expands `$(...)` inside those).
 */
export async function ensureKey(): Promise<{ path: string; publicKey: string; created: boolean }> {
  const keyPath = studioKeyPath()
  const pubPath = `${keyPath}.pub`

  if (existsSync(keyPath)) {
    if (existsSync(pubPath)) {
      return { path: keyPath, publicKey: readFileSync(pubPath, 'utf8').trim(), created: false }
    }
    // Private half present, public half lost: derive it rather than replace the pair.
    const { stdout } = await execFileP('ssh-keygen', ['-y', '-f', keyPath])
    return { path: keyPath, publicKey: stdout.trim(), created: false }
  }

  // `homedir()` can contain spaces; this is an argv array (mkdirSync, not a shell), so no quoting
  // question ever arises.
  mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 })
  await execFileP('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'atomic-studio', '-f', keyPath])
  chmodSync(keyPath, 0o600)
  return { path: keyPath, publicKey: readFileSync(pubPath, 'utf8').trim(), created: true }
}

/**
 * Everything the confirmation screen needs, and NOTHING that changes state — not on the server,
 * not in the folder. The user agreed to see the command before it ran; a plan that quietly
 * created the repository would make that promise false.
 */
export async function publishPlan(s: GitServer, projectPath: string, name: string): Promise<PublishPlan> {
  const { url, command, managed } = planRepo(s, name)
  const pre = await preflight(s)
  const info = await gitInfo(projectPath)
  const willInit = !info.isRepo
  // `total`, not `files.length`: ChangedFileList is capped, so `files` can be a partial page
  // and a big working tree would report willCommit:false with changes still waiting.
  const changed = willInit ? null : await gitWorkingStat(projectPath)
  return {
    preflight: pre,
    url,
    command,
    managed,
    willInit,
    willCommit: willInit ? hasAnyFile(projectPath) : (changed?.total ?? 0) > 0
  }
}

/**
 * Create the repository, then wire and push. Ordered so the step that is irreversible on someone
 * else's server happens FIRST and fails loudly, rather than after we have already rearranged the
 * user's folder.
 *
 * An EMPTY folder still gets `origin`: there is nothing to push, and saying so is more useful than
 * refusing to set up the remote the user asked for.
 */
export async function publishRun(s: GitServer, projectPath: string, name: string): Promise<PublishResult> {
  const created = await createBareRepo(s, name)
  if (!created.ok || !created.url) return { ok: false, pushed: false, error: created.error }

  const info = await gitInfo(projectPath)
  if (!info.isRepo) {
    const init = await gitInit(projectPath)
    if (!init.ok) return { ok: false, pushed: false, error: init.error }
  }

  const remote = await gitRemoteAdd(projectPath, 'origin', created.url)
  if (!remote.ok) return { ok: false, pushed: false, error: remote.error }

  // Ask GIT whether there is anything to commit, not the filesystem. This used to be
  // `!hasAnyFile(projectPath)`, which counted any directory entry other than `.git` as "a file" —
  // but an EMPTY SUBDIRECTORY is a directory entry, and `git add -A` never stages an empty
  // directory. A project whose only content was an empty subfolder therefore sailed past that
  // check, `gitCommit` correctly found "nothing to commit" (tolerated below), and `gitPush` then
  // failed outright because the brand-new repo had no commits at all — the user saw a raw git
  // error for a folder that, by git's own accounting, had nothing to publish. `gitWorkingStat` is
  // the same predicate `publishPlan` already uses once a folder is a repository; asking it here,
  // now that `gitInit` and `gitRemoteAdd` have both run, makes the two branches agree instead of
  // one asking the filesystem and the other asking git.
  const stat = await gitWorkingStat(projectPath)
  if (stat.total === 0) return { ok: true, url: created.url, pushed: false }

  const commit = await gitCommit(projectPath, 'Initial commit', true)
  // Belt and braces: `gitWorkingStat` above should already have caught the "nothing to commit"
  // case, but tolerate it here too rather than surface it as a failure if it ever slips through.
  if (!commit.ok && !/nothing to commit/i.test(commit.error ?? '')) {
    return { ok: false, pushed: false, error: commit.error }
  }
  const push = await gitPush(projectPath, true)
  if (!push.ok) return { ok: false, url: created.url, pushed: false, error: push.error }
  return { ok: true, url: created.url, pushed: true }
}

/**
 * PREVIEW ONLY, for `publishPlan`'s `willCommit` field when the folder is not a repository yet.
 * `publishPlan` may not run `git init` to get git's own answer — planning has no side effects,
 * that is a hard product promise (the user is shown the command before anything runs) — so this
 * has to guess from the filesystem instead. `publishRun`'s answer, taken from `gitWorkingStat`
 * after `git init` has actually run, is authoritative; this is a best-effort preview that can
 * still disagree with it (`.gitignore`, submodules and other git-specific exclusions are invisible
 * here).
 *
 * PREVIOUS VERSION WAS WRONG in the same way `publishRun` was: it treated any directory entry
 * other than `.git` as "a file", so a project containing nothing but an EMPTY SUBDIRECTORY told
 * the user "yes, this will commit" — which `publishRun` then contradicted by pushing nothing.
 * `git add -A` stages FILES, not empty directories, so this now recurses looking for an actual
 * file before it answers true, which at least gets that case right for the preview too.
 */
function hasAnyFile(projectPath: string): boolean {
  try {
    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      if (entry.isDirectory()) {
        if (hasAnyFile(join(projectPath, entry.name))) return true
      } else {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}
