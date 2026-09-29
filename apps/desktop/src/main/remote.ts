import { spawnStream } from './terminal'
import { homedir } from 'node:os'
import { binOverride } from './util'
import { audit } from './audit'
import { applyEnterprisePolicy } from './policy'
import { certificateCredential } from './identity'
import type {
  RemoteConfig,
  RemoteDirEntry,
  RemotePolicy,
  RemoteResult,
  RemoteReadResult
} from '../shared/types'

/**
 * Company-server workspace: the project lives on the CUSTOMER'S OWN server
 * (AWS, Hetzner, anything reachable over SSH) and is edited through Studio
 * without ever copying the codebase to the local machine. Uses the system
 * `ssh` binary with key auth — no native deps, works with any provider.
 *
 * STUDIO_SSH_BIN overrides the binary so tests can run against a local fake.
 */

let session: { cfg: RemoteConfig; policy: RemotePolicy } | null = null

export function activeRemote(): { cfg: RemoteConfig; policy: RemotePolicy } | null {
  return session
}

export function remotePolicy(): RemotePolicy | null {
  return session?.policy ?? null
}

const SSH = (): string => binOverride('STUDIO_SSH_BIN', 'ssh')

/** Quote for the REMOTE shell (single-quote safe). Nothing here quotes for a LOCAL shell — see below. */
export const rq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The ssh argv for this config. AN ARRAY, NOT A STRING, and that is the whole point.
 *
 * The previous version built a command line and handed it to a shell:
 *
 *   `${SSH()} -i ${JSON.stringify(cfg.keyPath)} -p ${cfg.port} … ${JSON.stringify(`${user}@${host}`)}`
 *
 * `JSON.stringify` emits DOUBLE quotes, and a POSIX shell expands `$(...)`, backticks and `$VAR`
 * inside double quotes. A host of `box$(id>/tmp/pwned)` therefore executed. Host, user, port, key
 * path and remote command all come from a config file, a settings form or a control-plane
 * response, so every one of them was a live injection point. An argv array removes the parser that
 * made that possible: each element reaches ssh as exactly one word.
 *
 * BatchMode=yes is load-bearing beyond safety — it makes ssh fail immediately instead of hanging on
 * a password prompt, which is what lets `git-provision`'s preflight tell four failures apart.
 *
 * `--` before the destination is the second lock. Even as its own argv element, a host of
 * `-oProxyCommand=...` would be read by ssh as an OPTION, which is arbitrary local execution by a
 * different route — argv arrays stop the shell, not ssh's own option parser. `--` ends options, so
 * whatever follows is a destination or nothing.
 */
export function sshArgs(cfg: RemoteConfig, options: string[] = [], command?: string): string[] {
  const args: string[] = []
  for (const c of sshCredential(cfg)) args.push(...c)
  args.push('-p', String(cfg.port || 22))
  args.push('-o', 'BatchMode=yes')
  // accept-new: first connect records the host key; a CHANGED key is refused by ssh itself —
  // exactly the "reject host key changes" stance we want.
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  args.push('-o', 'ConnectTimeout=10')
  args.push(...options)
  args.push('--', `${cfg.user}@${cfg.host}`)
  if (command !== undefined) args.push(command)
  return args
}

/**
 * Which credential ssh should offer, as argv fragments.
 *
 * TWO MODES, kept apart on purpose:
 *
 *  - MANAGED. A certificate issued by the company's control plane, plus the private key it was
 *    issued against. `IdentitiesOnly=yes` stops ssh from wandering through the agent and every
 *    default identity first, which on a server that only trusts the CA produces "Too many
 *    authentication failures" before the right credential is ever tried.
 *  - STANDALONE / BYO. The dedicated key from the Settings form, or nothing at all, in which case
 *    ssh uses the agent exactly as it always did.
 *
 * A managed seat never silently falls back to a local key, and a standalone seat never acquires a
 * certificate it was not issued. Studio reads the CERTIFICATE (a public document) and names the
 * private key by path; it never opens, copies or transmits the private half.
 */
function sshCredential(cfg: RemoteConfig): string[][] {
  const cert = certificateCredential()
  if (cert) return [['-o', `CertificateFile=${cert.certPath}`], ['-i', cert.keyPath], ['-o', 'IdentitiesOnly=yes']]
  return cfg.keyPath ? [['-i', cfg.keyPath]] : []
}

/**
 * Low-level ssh exec against an arbitrary config (used by ATOMIC Workspaces provisioning).
 *
 * `remoteCmd` is one argv element: ssh joins its remaining arguments with spaces and hands the
 * result to the REMOTE login shell, so quoting for that shell is the caller's job (`rq`) — but
 * nothing is parsed by a shell on THIS machine. `stdin` goes down the pipe rather than through a
 * `printf … |` pipeline, which is one fewer local shell to get right.
 */
export async function sshRun(cfg: RemoteConfig, remoteCmd: string, stdin?: string, timeoutMs = 30_000): Promise<{ code: number | null; output: string }> {
  const handle = spawnStream(SSH(), sshArgs(cfg, [], remoteCmd), homedir(), () => {}, timeoutMs, undefined, undefined, stdin)
  const res = await handle.done
  return { code: res.code, output: res.output }
}

/** Confine remote paths to the configured project root. */
function remoteSafe(path: string): string | null {
  const root = session?.cfg.root ?? ''
  if (!root) return null
  const norm = path.replace(/\/+/g, '/')
  if (norm !== root && !norm.startsWith(root.endsWith('/') ? root : root + '/')) return null
  if (norm.includes('..')) return null
  return norm
}

export async function remoteConnect(cfg: RemoteConfig, policy: RemotePolicy): Promise<RemoteResult> {
  const probe = await sshRun(cfg, `sh -c 'test -d ${rq(cfg.root)} && echo STUDIO_OK || echo STUDIO_NO_DIR'`)
  if (probe.code !== 0) {
    return { ok: false, error: `Could not reach ${cfg.user}@${cfg.host}:${cfg.port || 22} — ${probe.output.trim().split('\n').pop() ?? 'ssh failed'}` }
  }
  if (!probe.output.includes('STUDIO_OK')) {
    return { ok: false, error: `Connected, but ${cfg.root} does not exist on the server.` }
  }
  session = { cfg, policy: applyEnterprisePolicy(policy) }
  audit('remote-connect', `${cfg.user}@${cfg.host}:${cfg.root} confidential=${session.policy.confidential} export=${session.policy.allowExport} readOnly=${Boolean(session.policy.readOnly)}`)
  return { ok: true }
}

export function remoteDisconnect(): void {
  if (session) audit('remote-disconnect', `${session.cfg.user}@${session.cfg.host}`)
  session = null
  tunnelCloseAll()
}

export async function remoteList(path: string): Promise<RemoteDirEntry[]> {
  if (!session) return []
  const safe = remoteSafe(path)
  if (!safe) return []
  const res = await sshRun(session.cfg, `sh -c 'cd ${rq(safe)} && ls -1Ap'`)
  if (res.code !== 0) return []
  return res.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== './' && l !== '../')
    .filter((l) => !['node_modules/', '.git/', 'dist/', 'build/', '.next/'].includes(l))
    .slice(0, 500)
    .map((l) => ({ name: l.replace(/\/$/, ''), isDir: l.endsWith('/') }))
    .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
}

export async function remoteRead(path: string): Promise<RemoteReadResult> {
  if (!session) return { ok: false, error: 'Not connected.' }
  const safe = remoteSafe(path)
  if (!safe) return { ok: false, error: 'Path is outside the company workspace.' }
  const res = await sshRun(session.cfg, `sh -c 'wc -c < ${rq(safe)} && cat ${rq(safe)}'`)
  if (res.code !== 0) return { ok: false, error: 'Could not read the file.' }
  const nl = res.output.indexOf('\n')
  const size = parseInt(res.output.slice(0, nl).trim(), 10)
  if (Number.isFinite(size) && size > 2 * 1024 * 1024) return { ok: false, error: 'File too large.' }
  audit('remote-open', safe)
  return { ok: true, content: res.output.slice(nl + 1) }
}

export async function remoteWrite(path: string, content: string): Promise<RemoteResult> {
  if (!session) return { ok: false, error: 'Not connected.' }
  if (session.policy.readOnly) {
    audit('readonly-blocked', `write ${path}`)
    return { ok: false, error: 'You have view-only access to this workspace.' }
  }
  const safe = remoteSafe(path)
  if (!safe) return { ok: false, error: 'Path is outside the company workspace.' }
  const res = await sshRun(session.cfg, `sh -c 'cat > ${rq(safe)}'`, content)
  if (res.code !== 0) return { ok: false, error: 'Save failed.' }
  audit('remote-save', safe)
  return { ok: true }
}

export async function remoteExec(command: string, envPrefix = ''): Promise<{ ok: boolean; output: string }> {
  if (!session) return { ok: false, output: 'Not connected.' }
  if (session.policy.readOnly) {
    audit('readonly-blocked', `exec ${command}`)
    return { ok: false, output: 'You have view-only access to this workspace.' }
  }
  const res = await sshRun(session.cfg, `sh -c 'cd ${rq(session.cfg.root)} && ${envPrefix}${command}'`, undefined, 120_000)
  audit('remote-exec', command)
  return { ok: res.code === 0, output: res.output.slice(-8_000) }
}

// ---------------------------------------------------------------- port forwarding

interface TunnelInfo {
  id: number
  localPort: number
  remotePort: number
}

const tunnels = new Map<number, TunnelInfo & { kill: () => void }>()
let tunnelCounter = 0

/**
 * Forward a workspace port to this machine over `ssh -N -L` — the running
 * remote app becomes reachable at http://localhost:<localPort> (and therefore
 * inside Studio's own preview). Heuristic readiness: ssh exits quickly on a
 * refused forward, so a process still alive after ~1.5s is considered up.
 */
export async function tunnelOpen(remotePort: number, localPort?: number): Promise<{ ok: boolean; error?: string; tunnel?: TunnelInfo }> {
  if (!session) return { ok: false, error: 'Not connected.' }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return { ok: false, error: 'Invalid port.' }
  const local = localPort ?? remotePort
  const cfg = session.cfg
  // Same argv discipline as sshRun: the two integers are validated above and the host/user/key
  // never touch a shell. A forward built by string concatenation was the second place a hostile
  // host string could have executed.
  const handle = spawnStream(
    SSH(),
    sshArgs(cfg, ['-N', '-L', `${local}:127.0.0.1:${remotePort}`]),
    homedir(),
    () => {},
    24 * 3600_000
  )

  const failedEarly = await Promise.race([
    handle.done.then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 1500))
  ])
  if (failedEarly) return { ok: false, error: `Could not forward port ${remotePort} — is something already using ${local} locally?` }

  const id = ++tunnelCounter
  const info: TunnelInfo = { id, localPort: local, remotePort }
  tunnels.set(id, { ...info, kill: handle.kill })
  void handle.done.then(() => tunnels.delete(id))
  audit('tunnel-open', `${local} ← ${cfg.host}:${remotePort}`)
  return { ok: true, tunnel: info }
}

export function tunnelList(): TunnelInfo[] {
  return [...tunnels.values()].map(({ id, localPort, remotePort }) => ({ id, localPort, remotePort }))
}

export function tunnelClose(id: number): void {
  const t = tunnels.get(id)
  if (t) {
    t.kill()
    tunnels.delete(id)
    audit('tunnel-close', `${t.localPort} ← :${t.remotePort}`)
  }
}

export function tunnelCloseAll(): void {
  for (const id of [...tunnels.keys()]) tunnelClose(id)
}
