import { app } from 'electron'
import { existsSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { execStream, spawnStream, type CaptureOpts } from './terminal'
import { getApiKey } from './keyvault'
import { certificateCredential } from './identity'
import { serverConfig } from './forge-atomic'

/**
 * The one place that actually runs `git`.
 *
 * Split out of the old single-file git.ts so that the porcelain (git-core), the
 * history folds (git-insight) and the forge clients (forge-*) all share ONE
 * runner with one set of shell-safety rules. Every rule below was a bug once;
 * keep the comments with the code.
 *
 * Credentials reach git ONLY through a GIT_ASKPASS bridge — never embedded in
 * URLs, remotes, or on-disk config. The ATOMIC server's data plane is SSH, so its
 * pushes authenticate with an SSH certificate or key and never take the token path
 * at all; `withAuth` stays here for HTTPS forges. The SSH half is `sshCommand()`.
 */

/**
 * Personal access token for one forge, by forge id.
 *
 * The vault has ALWAYS been keyed per-forge — the renderer writes `setApiKey(activeForge, ...)`
 * — but the reader here was pinned to the literal 'github' from the days when GitHub was the only
 * forge. A GitLab token was therefore stored correctly and then never read, which surfaces as "the
 * token did not save" and is not a diagnosis anyone would reach for.
 */
export function tokenFor(forgeId: string): string | null {
  return getApiKey(forgeId)
}

/** The GitHub token, by name, for call sites that predate multi-forge auth. Prefer `tokenFor(id)`. */
export function token(): string | null {
  return tokenFor('github')
}

/**
 * A forge that authenticates over HTTPS with a token, and the host it does it on.
 *
 * Forges REGISTER rather than being imported, because git-exec sits BELOW them: every forge-*.ts
 * already imports this file, so importing them back would close a cycle. Registration is done
 * explicitly by the barrel (git.ts) rather than by a side effect at the bottom of each forge
 * module — a side effect would make authentication depend on whether something happened to import
 * that file, which is exactly the kind of load-order coupling that fails only in the test harness.
 *
 * `host` is a function, not a string: a self-hosted GitLab's host comes from config and can change
 * without an app restart.
 */
export interface CredentialSource {
  forgeId: string
  host(): string | null
}

const credentialSources: CredentialSource[] = []

export function registerCredentialSource(src: CredentialSource): void {
  if (!credentialSources.some((s) => s.forgeId === src.forgeId)) credentialSources.push(src)
}

/** Forge id → env var suffix. Ids are lowercase alnum today; this survives one that is not. */
function envSuffix(forgeId: string): string {
  return forgeId.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

/** Every (host, token) pair this seat can actually authenticate with, in registration order. */
function credentialHosts(): { forgeId: string; host: string; varName: string }[] {
  const out: { forgeId: string; host: string; varName: string }[] = []
  for (const src of credentialSources) {
    const h = src.host()
    if (!h) continue
    if (!tokenFor(src.forgeId)) continue
    if (out.some((o) => o.host === h)) continue
    out.push({ forgeId: src.forgeId, host: h, varName: `STUDIO_GIT_TOKEN_${envSuffix(src.forgeId)}` })
  }
  return out
}

/**
 * The token for a host none of the sources claim — or null to answer nothing.
 *
 * UNAMBIGUOUS CASES KEEP WORKING; AMBIGUOUS ONES FAIL CLOSED. Before multi-forge auth, ANY https
 * remote received the one stored token, which is how GitHub Enterprise and self-hosted GitLab work
 * today without ever being configured as a host. Failing closed on an unknown host would silently
 * break those seats, so with exactly one token configured the old behaviour is preserved.
 *
 * With two or more, there is no answer that is right more often than it is wrong, and guessing
 * sends one forge's credential to the other's server. That is a credential disclosure, not an
 * inconvenience, so the guess is refused and git reports an auth failure the user can act on.
 */
function fallbackToken(hosts: { forgeId: string }[]): string | null {
  return hosts.length === 1 ? tokenFor(hosts[0].forgeId) : null
}

/**
 * GIT_ASKPASS helper; echoes the username, or the token belonging to the host git is asking about.
 *
 * Two flavours, because a `#!/bin/sh` script is not executable on Windows — git there needs a .bat
 * that cmd.exe can run.
 *
 * ONLY THE MAPPING IS BAKED IN, NEVER A TOKEN. The script maps a host to the NAME of an environment
 * variable; the value lives in the child's environment and never reaches disk, where anything
 * running as this user could read it.
 *
 * THE FILENAME CARRIES A HASH OF THE MAPPING. This was previously a fixed name written only when
 * absent, so changing the script's contents would leave every existing install running the OLD one
 * forever — an upgrade bug that presents as "the new forge just doesn't authenticate". A changed
 * mapping is a changed filename, so it can never be served from a stale cache.
 */
function askpassPath(hosts: { host: string; varName: string }[]): string {
  const win = process.platform === 'win32'
  const sig = createHash('sha256').update(hosts.map((h) => `${h.host}=${h.varName}`).join('|')).digest('hex').slice(0, 12)
  const p = join(app.getPath('userData'), win ? `git-askpass-${sig}.bat` : `git-askpass-${sig}.sh`)
  if (!existsSync(p)) {
    if (win) {
      const branches = hosts
        .map((h) => `echo %1 | findstr /I /C:"${h.host}" >nul\r\nif %errorlevel%==0 (echo %${h.varName}%& exit /b)\r\n`)
        .join('')
      writeFileSync(
        p,
        `@echo off\r\necho %1 | findstr /I "sername" >nul\r\nif %errorlevel%==0 (echo x-access-token& exit /b)\r\n${branches}echo %STUDIO_GIT_TOKEN_FALLBACK%\r\n`,
        'utf8'
      )
    } else {
      // The username arm stays FIRST. Git's PASSWORD prompt embeds the whole URL, so on a
      // `https://user@host/` remote it contains a username too — a host arm placed ahead of it
      // would answer the username question with the token.
      const branches = hosts.map((h) => `*${h.host}*) echo "$${h.varName}" ;;\n`).join('')
      writeFileSync(
        p,
        `#!/bin/sh\ncase "$1" in\n*sername*) echo x-access-token ;;\n${branches}*) echo "$STUDIO_GIT_TOKEN_FALLBACK" ;;\nesac\n`,
        'utf8'
      )
      chmodSync(p, 0o700)
    }
  }
  return p
}

/**
 * Every git process ever spawned by this app, counted. Development instrumentation for the
 * Source Control refresh budget ("one process for an ordinary refresh, three at most"), read by
 * `gitSnapshot` to report its own cost and by the headless suite to hold the line on it.
 */
let processes = 0
export function gitProcessCount(): number {
  return processes
}

/**
 * The environment every git child gets, built once so the two runners cannot drift apart.
 *
 * Environment goes through spawn, NOT as a `VAR=value ` prefix on the command string: that prefix is
 * POSIX-only, and cmd.exe would try to execute a program literally named "GIT_TERMINAL_PROMPT=0",
 * breaking every git command on Windows.
 */
function gitEnv(withAuth: boolean): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' }
  if (withAuth) {
    // One variable per forge, and the askpass script picks between them by the host git names in
    // its own prompt. Routing by host rather than by caller is what lets `push`/`pull`/`fetch`
    // authenticate correctly: they act on a remote that was configured earlier, so nothing in the
    // call path knows which forge it is talking to, and asking git would cost an extra process on
    // every authenticated operation.
    const hosts = credentialHosts()
    const fallback = fallbackToken(hosts)
    if (hosts.length || fallback) {
      env.GIT_ASKPASS = askpassPath(hosts)
      for (const h of hosts) {
        const t = tokenFor(h.forgeId)
        if (t) env[h.varName] = t
      }
      if (fallback) env.STUDIO_GIT_TOKEN_FALLBACK = fallback
    }
  }
  // Never override an explicit GIT_SSH_COMMAND from the environment: the test suites set one to
  // point git at a local fake transport, and clobbering it would make every git-over-ssh assertion
  // dial a real host.
  if (!process.env.GIT_SSH_COMMAND) {
    const ssh = sshCommand()
    if (ssh) env.GIT_SSH_COMMAND = ssh
  }
  return env
}

export async function git(cwd: string, args: string, withAuth = false, cap?: CaptureOpts): Promise<{ code: number | null; output: string; truncated: boolean }> {
  processes++
  const handle = execStream(`git ${args}`, cwd, () => {}, 120_000, cap, gitEnv(withAuth))
  const res = await handle.done
  return { code: res.code, output: res.output, truncated: res.truncated }
}

/**
 * Default output cap for `gitArgv`. `git()`'s callers pass LOG_CAPTURE/DIFF_CAPTURE explicitly; a
 * new caller that forgets should still be bounded rather than free to buffer a whole repository.
 * `keep: 'head'` for the reason LOG_CAPTURE gives — git prints newest first, so a tail cut would
 * keep the OLDEST commits and silently answer a question about last week with last year.
 */
export const ARGV_CAPTURE: CaptureOpts = { keep: 'head', max: 10_000_000 }

/**
 * The same runner as `git()`, given an ARGV ARRAY and no shell.
 *
 * USE THIS FOR ANYTHING NEW. `git()` interpolates its arguments into one string that a shell then
 * parses, which is why every call site taking user data has to validate-then-quote by hand, and why
 * `gitShowHead` carries five lines of comment proving no quote can survive its own filter. That
 * discipline has held, but it is re-derived at every site, and Phase 1 adds roughly fifteen commands
 * that all take user-controlled refs, paths and search terms. An argv array has no parser to fool:
 * every element reaches git as exactly one word, whatever is in it.
 *
 * It is not the whole defence. An argv array closes SHELL injection; it does not stop a value that
 * starts with `-` from being read as an OPTION. Refs, paths and free text must still go through
 * `shared/gitref.ts`, and paths must still be passed after a `--` separator.
 *
 * Built on `spawnStream` rather than a second `spawn` call, so capture, truncation, the timeout and
 * the kill path are the ones already proven by `remote.ts` — one runner, one set of edge cases.
 */
export async function gitArgv(
  cwd: string,
  argv: string[],
  opts?: { auth?: boolean; cap?: CaptureOpts; timeoutMs?: number }
): Promise<{ code: number | null; output: string; truncated: boolean }> {
  processes++
  const handle = spawnStream(
    'git',
    argv,
    cwd,
    () => {},
    opts?.timeoutMs ?? 120_000,
    opts?.cap ?? ARGV_CAPTURE,
    gitEnv(opts?.auth ?? false)
  )
  const res = await handle.done
  return { code: res.code, output: res.output, truncated: res.truncated }
}

/**
 * `GIT_SSH_COMMAND` for this seat, or null.
 *
 * WHY THIS EXISTS. `remote.ts` learned to present the issued certificate, but `git` is a separate
 * process that has never heard of Studio's config: it runs plain `ssh`, which offers the user's
 * default identities and knows nothing about `CertificateFile` or the dedicated key the Settings
 * form created. So clone, fetch, pull and push authenticated differently from everything else
 * Studio does over SSH — and on a server that trusts only the CA, they simply failed.
 *
 * Two modes, the same separation `remote.ts` makes:
 *   MANAGED     the control plane's certificate + the private key it was issued against.
 *   STANDALONE  the dedicated key from the Git server settings, if one is configured.
 * Neither is applied to an HTTPS remote — git ignores GIT_SSH_COMMAND unless the transport is ssh.
 *
 * QUOTING: git splits this value with its own shell-like parser, so paths are single-quoted. A path
 * containing a single quote cannot be expressed safely and is refused rather than mangled — both
 * paths are Studio-generated (`app.getPath('userData')`, `~/.ssh`), so this is a guard against a
 * pathological home directory, not a routine case.
 */
export function sshCommand(): string | null {
  const q = (p: string): string | null => (p.includes("'") ? null : `'${p}'`)
  const parts: string[] = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new']

  const cert = certificateCredential()
  if (cert) {
    const c = q(cert.certPath)
    const k = q(cert.keyPath)
    if (!c || !k) return null
    // IdentitiesOnly stops ssh offering every agent key first and exhausting the server's
    // MaxAuthTries before the certificate is ever tried.
    parts.push('-o', `CertificateFile=${c}`, '-i', k, '-o', 'IdentitiesOnly=yes')
    return parts.join(' ')
  }

  let keyPath = ''
  try {
    keyPath = serverConfig()?.keyPath ?? ''
  } catch {
    // serverConfig() reads Electron's userData path, which is unavailable before app-ready. A git
    // command that early is not an ssh one, so no credential is the right answer.
    return null
  }
  if (!keyPath) return null
  const k = q(keyPath)
  if (!k) return null
  parts.push('-i', k, '-o', 'IdentitiesOnly=yes')
  return parts.join(' ')
}

/**
 * Capture settings for a `git log` scan. git prints NEWEST FIRST, so the default tail-capture would
 * keep only the oldest commits and throw away everything recent — a "changed most often lately"
 * ranking would then describe the repo as it was years ago. Keep the head, with room for a real
 * history (400 commits × numstat on a big repo runs to a few hundred KB).
 */
export const LOG_CAPTURE: CaptureOpts = { keep: 'head', max: 4_000_000 }

/** Same reasoning as LOG_CAPTURE, for the working-tree scans: keep the HEAD of the output. */
export const DIFF_CAPTURE: CaptureOpts = { keep: 'head', max: 2_000_000 }

/**
 * Quote a path for the shell that will actually run. POSIX single-quoting is safe for any filename, but
 * cmd.exe does not treat ' as a quote at all — there the path would reach git with literal quotes and
 * every scoped command would silently miss. Windows uses double quotes (and forbids " in filenames).
 */
export function shellQuote(p: string): string {
  if (process.platform === 'win32') return `"${p.replace(/"/g, '')}"`
  return `'${p.replace(/'/g, `'\\''`)}'`
}

export const tail = (s: string): string => s.trim().split('\n').slice(-4).join('\n').slice(0, 400)

/**
 * A git ref name we are willing to interpolate into a command line. Deliberately stricter than
 * git's own check-ref-format: this is a shell-injection guard first and a validity check second,
 * and it is re-applied at EVERY branch-taking call site rather than assumed by the caller.
 */
export function isSafeRef(ref: string): boolean {
  return /^[\w./-]+$/.test(ref) && !ref.includes('..') && ref.length <= 255
}

/**
 * A project-relative path safe to interpolate. `shellQuote` handles quoting, but traversal and
 * absolute paths are a different failure (writing outside the project), so they are refused outright
 * — same rule fs-service applies to every path it resolves.
 */
export function isSafeRelPath(p: string): boolean {
  return Boolean(p) && p.length <= 400 && !p.includes('..') && !p.startsWith('/') && !/[\r\n\0]/.test(p)
}
