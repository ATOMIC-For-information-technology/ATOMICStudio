import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { audit } from './audit'
import { applyEnterprisePolicy } from './policy'
import { getApiKey, setApiKey } from './keyvault'
import * as remote from './remote'
import { sshRun, rq } from './remote'
import * as agent from './agent'
import type {
  RemoteConfig,
  RemotePolicy,
  Workspace,
  WorkspaceManifest,
  WsCloudCreateRequest,
  WsHealth,
  WsOpenResult,
  WsProvisionRequest,
  WsResult,
  WsSnapshotInfo
} from '../shared/types'

/**
 * ATOMIC Workspaces — two-tier codespaces.
 *
 * Architecture rule (do not violate): REST is ONLY the lifecycle control
 * plane, stock sshd is the data plane, and remote.ts is the editor. Both
 * workspace kinds end in the exact same `remoteConnect(cfg, policy)` call, so
 * the confidential-AI allowlist, export blocking, and audit trail apply
 * identically to the free company tier and the paid ATOMIC Cloud tier.
 *
 * Secrets: NEVER in the registry. The cloud API key lives in the OS keychain
 * (`atomic-cloud`), per-workspace secrets under `ws-secrets:<id>`; the registry
 * holds only SSH key *paths* and keychain references.
 */

// ---------------------------------------------------------------- registry

interface Registry {
  defaultCloudUrl: string | null
  workspaces: Workspace[]
}

function registryPath(): string {
  return join(app.getPath('userData'), 'workspaces.json')
}

function loadRegistry(): Registry {
  try {
    if (existsSync(registryPath())) {
      const r = JSON.parse(readFileSync(registryPath(), 'utf8')) as Registry
      return { defaultCloudUrl: r.defaultCloudUrl ?? null, workspaces: r.workspaces ?? [] }
    }
  } catch {
    /* corrupt registry — start fresh rather than crash */
  }
  return { defaultCloudUrl: null, workspaces: [] }
}

/** Atomic write: temp file + rename, so a crash never corrupts the registry. */
function saveRegistry(r: Registry): void {
  const tmp = registryPath() + '.tmp'
  writeFileSync(tmp, JSON.stringify(r, null, 2), 'utf8')
  renameSync(tmp, registryPath())
}

export function wsList(): Workspace[] {
  return loadRegistry().workspaces.sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0))
}

export function wsGet(id: string): Workspace | undefined {
  return loadRegistry().workspaces.find((w) => w.id === id)
}

function wsUpsert(ws: Workspace): void {
  const r = loadRegistry()
  r.workspaces = [...r.workspaces.filter((w) => w.id !== ws.id), ws]
  saveRegistry(r)
}

function wsPatch(id: string, patch: Partial<Workspace>): Workspace | undefined {
  const ws = wsGet(id)
  if (!ws) return undefined
  const next = { ...ws, ...patch }
  wsUpsert(next)
  return next
}

export function wsCloudSetup(baseUrl: string): void {
  const r = loadRegistry()
  r.defaultCloudUrl = baseUrl.replace(/\/$/, '') || null
  saveRegistry(r)
}

export function wsCloudConfig(): { baseUrl: string | null; hasKey: boolean } {
  return { baseUrl: loadRegistry().defaultCloudUrl, hasKey: Boolean(getApiKey('atomic-cloud')) }
}

const newId = (): string => randomBytes(5).toString('hex')

// ---------------------------------------------------------------- templates

/**
 * Starter templates. v0 ships static-html only; adding a template means adding
 * an entry here (files written over ssh) — the registry/provisioner need no
 * changes (future: Next.js/Vue/FastAPI/... shipped as tarballs).
 */
const TEMPLATES: Record<string, { files: Record<string, string>; manifest: WorkspaceManifest }> = {
  'static-html': {
    files: {
      'index.html':
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <title>New ATOMIC workspace</title>\n</head>\n<body>\n  <h1>Your workspace is ready 🎉</h1>\n  <p>Open index.html in the editor and start building.</p>\n</body>\n</html>\n',
      'workspace.json': JSON.stringify({ language: 'html', framework: 'static-html', template: 'static-html', ai: 'enabled' }, null, 2) + '\n'
    },
    manifest: { language: 'html', framework: 'static-html', template: 'static-html' }
  }
}

// ---------------------------------------------------------------- company driver

/**
 * Provision a workspace on the CUSTOMER'S OWN server over the existing ssh
 * wrapper: probe → mkdir → non-empty guard → optional shallow git clone
 * (token via the GIT_ASKPASS bridge env, never written to remote disk) →
 * optional starter template. Every step audited.
 */
export async function wsCreateCompany(req: WsProvisionRequest): Promise<WsResult> {
  req = { ...req, policy: applyEnterprisePolicy(req.policy) }
  const cfg: RemoteConfig = { ...req.cfg, root: req.cfg.root.replace(/\/$/, '') }
  const id = newId()
  audit('ws-provision', `start ${req.name} → ${cfg.user}@${cfg.host}:${cfg.root}`)

  // Probe: reachability + toolchain in one round-trip.
  const probe = await sshRun(cfg, `sh -c 'uname -s; command -v git >/dev/null && echo GIT_OK; command -v node >/dev/null && echo NODE_OK; command -v npm >/dev/null && echo NPM_OK'`)
  if (probe.code !== 0) {
    return { ok: false, error: `Could not reach ${cfg.user}@${cfg.host} — check the address, user, and SSH key. (${probe.output.trim().split('\n').pop() ?? ''})` }
  }
  const hasGit = probe.output.includes('GIT_OK')

  // Create the workspace folder; refuse a non-empty one unless explicitly allowed.
  const mk = await sshRun(cfg, `sh -c 'mkdir -p ${rq(cfg.root)} && ls -A ${rq(cfg.root)} | head -1'`)
  if (mk.code !== 0) return { ok: false, error: `Could not create ${cfg.root} on the server.` }
  if (mk.output.trim() && !req.allowNonEmpty) {
    return { ok: false, error: `${cfg.root} is not empty. Pick an empty folder, or enable "use non-empty folder" if you are sure.` }
  }

  if (req.repo) {
    if (!hasGit) return { ok: false, error: 'The server has no git installed — ask your admin to run: apt install git' }
    const token = getApiKey('github')
    const auth = token ? `GIT_ASKPASS=/bin/false ` : '' // never prompt on the remote
    const url = token ? req.repo.replace('https://', `https://x-access-token:${token}@`) : req.repo
    // The token rides only inside this one ssh exec's command line env; it is
    // never persisted remotely (git strips credentials from origin on clone? it
    // does NOT — so reset the remote URL to the clean one right after).
    const clone = await sshRun(cfg, `sh -c 'cd ${rq(cfg.root)} && ${auth}git clone --depth 1 ${rq(url)} . && git remote set-url origin ${rq(req.repo)}'`, undefined, 180_000)
    if (clone.code !== 0) return { ok: false, error: `Clone failed: ${clone.output.trim().split('\n').pop() ?? 'unknown error'}` }
    audit('ws-provision', `cloned ${req.repo}`)
  } else if (req.template && TEMPLATES[req.template]) {
    for (const [file, content] of Object.entries(TEMPLATES[req.template].files)) {
      const w = await sshRun(cfg, `sh -c 'cat > ${rq(`${cfg.root}/${file}`)}'`, content)
      if (w.code !== 0) return { ok: false, error: `Could not write the ${req.template} starter files.` }
    }
    audit('ws-provision', `template ${req.template}`)
  }

  const ws: Workspace = {
    id,
    name: req.name,
    kind: 'company',
    cfg,
    policy: req.policy,
    repo: req.repo,
    template: req.template,
    createdAt: Date.now(),
    lastOpened: null,
    state: 'ready'
  }
  wsUpsert(ws)
  audit('ws-provision', `done ${req.name} (${id})`)
  return { ok: true, workspace: ws }
}

// ---------------------------------------------------------------- cloud driver

interface CloudWs {
  id: string
  name: string
  state: string
  ssh: { host: string; user: string; port: number; root: string }
}

async function cloudFetch(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  const key = getApiKey('atomic-cloud')
  if (!key) throw new Error('No ATOMIC Cloud access key set.')
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(init?.headers ?? {}) }
  })
}

export async function wsCreateCloud(req: WsCloudCreateRequest): Promise<WsResult> {
  const { baseUrl } = wsCloudConfig()
  if (!baseUrl) return { ok: false, error: 'Set your ATOMIC Cloud server address first.' }
  try {
    const res = await cloudFetch(baseUrl, '/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: req.name, template: req.template })
    })
    if (!res.ok) return { ok: false, error: `Cloud error ${res.status}: ${(await res.text()).slice(0, 200)}` }
    const cw = (await res.json()) as CloudWs
    const ws: Workspace = {
      id: cw.id,
      name: req.name,
      kind: 'cloud',
      cfg: { host: cw.ssh.host, user: cw.ssh.user, port: cw.ssh.port, keyPath: '', root: cw.ssh.root },
      policy: { confidential: false, allowExport: true, allowedProviders: [] },
      template: req.template,
      cloudUrl: baseUrl,
      createdAt: Date.now(),
      lastOpened: null,
      state: 'ready'
    }
    wsUpsert(ws)
    audit('ws-cloud', `created ${req.name} (${cw.id}) on ${baseUrl}`)
    return { ok: true, workspace: ws }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Cloud request failed.' }
  }
}

async function cloudAction(ws: Workspace, action: 'start' | 'stop' | 'keepalive', body?: object): Promise<boolean> {
  if (!ws.cloudUrl) return false
  try {
    const res = await cloudFetch(ws.cloudUrl, `/v1/workspaces/${ws.id}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body ?? {})
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- health

/** One-round-trip pre-open health probe. Tolerant parser — servers vary. */
export async function wsHealth(id: string): Promise<WsHealth> {
  const ws = wsGet(id)
  if (!ws) return { ok: false, ssh: false, error: 'Unknown workspace.' }
  const probe = await sshRun(
    ws.cfg,
    `sh -c 'uname -s; (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0); df -k ${rq(ws.cfg.root)} 2>/dev/null | tail -1; command -v git >/dev/null && echo GIT_OK; command -v node >/dev/null && echo NODE_OK; command -v npm >/dev/null && echo NPM_OK'`
  )
  if (probe.code !== 0) return { ok: false, ssh: false, error: 'Server unreachable over SSH.' }
  const lines = probe.output.split('\n').map((l) => l.trim())
  const dfLine = lines.find((l) => /\s\d+%?\s/.test(l) && l.includes('/'))
  const dfParts = dfLine?.split(/\s+/) ?? []
  const freeKb = parseInt(dfParts[3] ?? '', 10)
  return {
    ok: true,
    ssh: true,
    os: lines[0] || undefined,
    cpus: parseInt(lines[1] ?? '', 10) || undefined,
    diskFreeMb: Number.isFinite(freeKb) ? Math.round(freeKb / 1024) : undefined,
    git: probe.output.includes('GIT_OK'),
    node: probe.output.includes('NODE_OK'),
    npm: probe.output.includes('NPM_OK')
  }
}

// ---------------------------------------------------------------- open / keepalive

let keepaliveTimer: ReturnType<typeof setInterval> | null = null

function startKeepalive(ws: Workspace): void {
  stopKeepalive()
  keepaliveTimer = setInterval(() => {
    const active = remote.activeRemote()
    if (!active || active.cfg.root !== ws.cfg.root) {
      stopKeepalive()
      return
    }
    // Smart suspend: report busy while the AI agent is working so the server
    // never naps a workspace mid-task.
    void cloudAction(ws, 'keepalive', { busy: agent.getAgentState().running })
  }, 120_000)
}

export function stopKeepalive(): void {
  if (keepaliveTimer) clearInterval(keepaliveTimer)
  keepaliveTimer = null
}

/**
 * Open a workspace: (cloud) auto-wake if suspended → health probe → the same
 * remoteConnect(cfg, policy) as a direct connection → read workspace.json.
 */
export async function wsOpen(id: string): Promise<WsOpenResult> {
  const ws = wsGet(id)
  if (!ws) return { ok: false, error: 'Unknown workspace.' }

  let woke = false
  if (ws.kind === 'cloud' && ws.cloudUrl) {
    try {
      const res = await cloudFetch(ws.cloudUrl, `/v1/workspaces/${ws.id}`)
      if (res.ok) {
        const cw = (await res.json()) as CloudWs
        if (cw.state === 'suspended') {
          woke = await cloudAction(ws, 'start')
        }
      }
    } catch {
      /* control plane unreachable — still try ssh; the data plane may be up */
    }
  }

  const health = await wsHealth(id)
  if (!health.ssh) {
    wsPatch(id, { state: 'error', lastError: health.error })
    return { ok: false, error: health.error ?? 'Workspace unreachable.', health }
  }

  // Viewer teammates browse but never write; owner/editor keep the stored policy.
  let effectivePolicy = applyEnterprisePolicy(ws.policy)
  if (ws.kind === 'cloud') {
    const role = await wsCloudRole()
    if (role === 'viewer') effectivePolicy = { ...effectivePolicy, readOnly: true, allowExport: false }
  }
  const conn = await remote.remoteConnect(ws.cfg, effectivePolicy)
  if (!conn.ok) {
    wsPatch(id, { state: 'error', lastError: conn.error })
    return { ok: false, error: conn.error, health }
  }

  // Manifest: workspace.json at the root tells Studio how to run the project.
  let manifest: WorkspaceManifest | null = null
  const mf = await remote.remoteRead(`${ws.cfg.root}/workspace.json`)
  if (mf.ok && mf.content) {
    try {
      manifest = JSON.parse(mf.content) as WorkspaceManifest
    } catch {
      manifest = null
    }
  }

  wsPatch(id, { state: 'ready', lastOpened: Date.now(), lastError: undefined })
  if (ws.kind === 'cloud') {
    void cloudAction(ws, 'keepalive', { busy: false })
    startKeepalive(ws)
  }
  audit('ws-open', `${ws.name} (${ws.kind})`)
  return { ok: true, remote: { connected: true, cfg: ws.cfg, policy: ws.policy }, manifest, woke, health }
}

export async function wsDelete(id: string, alsoRemote: boolean): Promise<WsResult> {
  const ws = wsGet(id)
  if (!ws) return { ok: false, error: 'Unknown workspace.' }
  if (alsoRemote && ws.kind === 'cloud' && ws.cloudUrl) {
    try {
      await cloudFetch(ws.cloudUrl, `/v1/workspaces/${ws.id}`, { method: 'DELETE' })
    } catch {
      /* control plane unreachable — still forget it locally */
    }
  }
  // Company kind + alsoRemote is deliberately NOT wired to rm -rf: deleting a
  // customer's own server folder is a destructive action Studio never takes.
  const r = loadRegistry()
  r.workspaces = r.workspaces.filter((w) => w.id !== id)
  saveRegistry(r)
  audit('ws-delete', `${ws.name} (${ws.kind})${alsoRemote ? ' + remote' : ''}`)
  return { ok: true }
}

// ---------------------------------------------------------------- secrets

/**
 * Workspace secrets: values live ONLY in the OS keychain (one JSON blob per
 * workspace); the registry never sees them. They are injected as environment
 * variables per command run — never written to the repository or remote disk.
 */
function secretsOf(id: string): Record<string, string> {
  try {
    return JSON.parse(getApiKey(`ws-secrets:${id}`) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

export function wsSecretsSet(id: string, secrets: Record<string, string>): void {
  const merged = { ...secretsOf(id), ...secrets }
  for (const k of Object.keys(merged)) if (merged[k] === '') delete merged[k]
  setApiKey(`ws-secrets:${id}`, JSON.stringify(merged))
  audit('ws-secrets', `${id}: set ${Object.keys(secrets).join(', ')}`)
}

export function wsSecretNames(id: string): string[] {
  return Object.keys(secretsOf(id)).sort()
}

/**
 * Run a command in the (connected) workspace with its secrets in the env.
 *
 * The secrets + command travel as an STDIN SCRIPT that the remote shell
 * dot-sources — the ssh command line itself contains no `$`, because anything
 * inside the locally double-quoted ssh argument would be expanded by the LOCAL
 * shell before it ever reaches the server (a real, test-caught footgun).
 */
export async function wsExec(id: string, command: string): Promise<{ ok: boolean; output: string }> {
  const ws = wsGet(id)
  if (!ws) return { ok: false, output: 'Unknown workspace.' }
  const active = remote.activeRemote()
  if (!active || active.cfg.root !== ws.cfg.root) return { ok: false, output: 'Workspace is not open.' }
  const exportsScript = Object.entries(secretsOf(id))
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${k}=${rq(v)}`)
    .join('\n')
  const script = `${exportsScript}\n${command}\n`
  const res = await sshRun(ws.cfg, `sh -c 'cd ${rq(ws.cfg.root)} && . /dev/stdin'`, script, 120_000)
  audit('ws-exec', `${ws.name}: ${command}`)
  return { ok: res.code === 0, output: res.output.slice(-8_000) }
}

// ---------------------------------------------------------------- snapshots

/**
 * Snapshots, independent of git. Cloud kind = control-plane endpoints (tar on
 * the server); company kind = the same tar via ssh into .studio-snapshots/.
 */
export async function wsSnapshot(id: string, name: string, description?: string): Promise<WsResult> {
  const ws = wsGet(id)
  if (!ws) return { ok: false, error: 'Unknown workspace.' }

  if (ws.kind === 'cloud' && ws.cloudUrl) {
    try {
      const res = await cloudFetch(ws.cloudUrl, `/v1/workspaces/${ws.id}/snapshots`, {
        method: 'POST',
        body: JSON.stringify({ name, description })
      })
      if (!res.ok) return { ok: false, error: `Snapshot failed (${res.status}).` }
      audit('ws-snapshot', `${ws.name}: ${name}`)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Snapshot failed.' }
    }
  }

  const snapId = `${Date.now()}`
  const dir = `${ws.cfg.root}/.studio-snapshots`
  // The sidecar JSON rides on STDIN — data embedded in the command line loses a
  // quoting layer in the local-shell→ssh→remote-sh chain and gets brace-expanded.
  const res = await sshRun(
    ws.cfg,
    `sh -c 'mkdir -p ${rq(dir)} && cd ${rq(ws.cfg.root)} && tar czf ${rq(`${dir}/${snapId}.tgz`)} --exclude .studio-snapshots --exclude node_modules . && cat > ${rq(`${dir}/${snapId}.json`)}'`,
    JSON.stringify({ id: snapId, name, description, ts: Date.now() }),
    120_000
  )
  if (res.code !== 0) return { ok: false, error: 'Snapshot failed on the server.' }
  audit('ws-snapshot', `${ws.name}: ${name}`)
  return { ok: true }
}

export async function wsSnapshots(id: string): Promise<WsSnapshotInfo[]> {
  const ws = wsGet(id)
  if (!ws) return []

  if (ws.kind === 'cloud' && ws.cloudUrl) {
    try {
      const res = await cloudFetch(ws.cloudUrl, `/v1/workspaces/${ws.id}/snapshots`)
      return res.ok ? ((await res.json()) as WsSnapshotInfo[]) : []
    } catch {
      return []
    }
  }

  const res = await sshRun(ws.cfg, `sh -c 'cat ${rq(`${ws.cfg.root}/.studio-snapshots`)}/*.json 2>/dev/null'`)
  if (res.code !== 0 || !res.output.trim()) return []
  const out: WsSnapshotInfo[] = []
  for (const m of res.output.matchAll(/\{[^{}]*\}/g)) {
    try {
      out.push(JSON.parse(m[0]) as WsSnapshotInfo)
    } catch {
      /* skip malformed sidecar */
    }
  }
  return out.sort((a, b) => b.ts - a.ts)
}

export async function wsRestore(id: string, snapshotId: string): Promise<WsResult> {
  const ws = wsGet(id)
  if (!ws) return { ok: false, error: 'Unknown workspace.' }
  if (!/^[\w-]+$/.test(snapshotId)) return { ok: false, error: 'Invalid snapshot id.' }

  if (ws.kind === 'cloud' && ws.cloudUrl) {
    try {
      const res = await cloudFetch(ws.cloudUrl, `/v1/workspaces/${ws.id}/snapshots/${snapshotId}/restore`, { method: 'POST' })
      if (!res.ok) return { ok: false, error: `Restore failed (${res.status}).` }
      audit('ws-restore', `${ws.name}: ${snapshotId}`)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Restore failed.' }
    }
  }

  const tgz = `${ws.cfg.root}/.studio-snapshots/${snapshotId}.tgz`
  const res = await sshRun(
    ws.cfg,
    `sh -c 'test -f ${rq(tgz)} && cd ${rq(ws.cfg.root)} && find . -mindepth 1 -maxdepth 1 ! -name .studio-snapshots -exec rm -rf {} + && tar xzf ${rq(tgz)}'`,
    undefined,
    120_000
  )
  if (res.code !== 0) return { ok: false, error: 'Restore failed on the server.' }
  audit('ws-restore', `${ws.name}: ${snapshotId}`)
  return { ok: true }
}


// ---------------------------------------------------------------- team + billing touchpoint

async function cloudGet(path: string): Promise<Response | null> {
  const { baseUrl } = wsCloudConfig()
  if (!baseUrl) return null
  try {
    return await cloudFetch(baseUrl, path)
  } catch {
    return null
  }
}

/** The caller's role on the configured cloud control plane. */
export async function wsCloudRole(): Promise<string | null> {
  const res = await cloudGet('/v1/me')
  if (!res?.ok) return null
  return ((await res.json()) as { role: string }).role
}

export async function wsTeamList(): Promise<{ name: string; role: string; createdAt: number }[]> {
  const res = await cloudGet('/v1/team')
  return res?.ok ? ((await res.json()) as { name: string; role: string; createdAt: number }[]) : []
}

/** Owner invites a teammate; the one-time token is shown ONCE to hand over. */
export async function wsTeamInvite(name: string, role: 'editor' | 'viewer'): Promise<{ ok: boolean; token?: string; error?: string }> {
  const { baseUrl } = wsCloudConfig()
  if (!baseUrl) return { ok: false, error: 'Set your ATOMIC Cloud server first.' }
  try {
    const res = await cloudFetch(baseUrl, '/v1/team', { method: 'POST', body: JSON.stringify({ name, role }) })
    if (!res.ok) return { ok: false, error: `Invite failed (${res.status}).` }
    const data = (await res.json()) as { token: string }
    audit('ws-team', `invited ${name} as ${role}`)
    return { ok: true, token: data.token }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invite failed.' }
  }
}

export async function wsTeamRevoke(name: string): Promise<{ ok: boolean; error?: string }> {
  const { baseUrl } = wsCloudConfig()
  if (!baseUrl) return { ok: false, error: 'Set your ATOMIC Cloud server first.' }
  try {
    const res = await cloudFetch(baseUrl, `/v1/team/${encodeURIComponent(name)}`, { method: 'DELETE' })
    audit('ws-team', `revoked ${name}`)
    return res.ok ? { ok: true } : { ok: false, error: `Revoke failed (${res.status}).` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Revoke failed.' }
  }
}

/** Billing touchpoint: Studio never processes payments — it opens the link. */
export async function wsSubscribeInfo(): Promise<{ link: string | null; price: string } | null> {
  const res = await cloudGet('/v1/subscribe')
  return res?.ok ? ((await res.json()) as { link: string | null; price: string }) : null
}
