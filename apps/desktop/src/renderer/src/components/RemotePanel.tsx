import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon'
import type {
  TeamMember,
  RemoteConfig,
  RemoteDirEntry,
  RemotePolicy,
  RemoteState,
  TunnelInfo,
  Workspace,
  WorkspaceManifest,
  WsSnapshotInfo
} from '../../../shared/types'

interface Props {
  onStateChange: (state: RemoteState) => void
  /** Open a server file in an editor tab (path is the absolute remote path). */
  onOpenRemoteFile: (absPath: string) => void
  onMsg: (type: 'ok' | 'err', text: string) => void
}

const CFG_KEY = 'studio.remote.cfg'

/**
 * Company-server workspace: the code stays on the company's own server (AWS,
 * Hetzner, anything with SSH) — Studio edits it in place, never cloning it to
 * the laptop. With Confidential mode on, server code may only be sent to the
 * AI providers the company allows; with export blocked, copying code out of
 * Studio is refused and audited, and violations can be reported.
 */
export function RemotePanel({ onStateChange, onOpenRemoteFile, onMsg }: Props): React.JSX.Element {
  const saved = ((): Partial<RemoteConfig & RemotePolicy & { webhook: string }> => {
    try {
      return JSON.parse(localStorage.getItem(CFG_KEY) || '{}')
    } catch {
      return {}
    }
  })()

  const [host, setHost] = useState(saved.host ?? '')
  const [user, setUser] = useState(saved.user ?? 'root')
  const [port, setPort] = useState(String(saved.port ?? 22))
  const [keyPath, setKeyPath] = useState(saved.keyPath ?? '~/.ssh/id_rsa')
  const [root, setRoot] = useState(saved.root ?? '')
  const [confidential, setConfidential] = useState(saved.confidential ?? true)
  const [allowExport, setAllowExport] = useState(saved.allowExport ?? false)
  const [webhook, setWebhook] = useState(saved.webhook ?? '')

  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * Runs one remote action with the busy flag held, and — the part that matters — always releases it.
   *
   * Every action in this panel is an IPC round-trip to a machine that may have gone away mid-session.
   * The shape here used to be `setBusy(true)` → `await` → `setBusy(false)`, so a *rejected* invoke
   * skipped the third line and left all twelve `disabled={busy}` controls dead, with nothing on
   * screen to say why. `finally` is the whole fix; the `catch` is what turns a silently dead panel
   * into a message the user can act on. `CrossRepoPanel` already documents this same rule.
   */
  const withBusy = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T | null> => {
      setBusy(true)
      try {
        return await work()
      } catch (e) {
        onMsg('err', e instanceof Error ? e.message : 'That action failed — the workspace may have disconnected.')
        return null
      } finally {
        setBusy(false)
      }
    },
    [onMsg]
  )
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<RemoteDirEntry[]>([])
  const [cmd, setCmd] = useState('')
  const [cmdOut, setCmdOut] = useState('')

  // --- ATOMIC Workspaces (two-tier codespaces) ---
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [wsView, setWsView] = useState<'list' | 'choose' | 'newCompany' | 'newCloud'>('list')
  const [wsSearch, setWsSearch] = useState('')
  const [wsName, setWsName] = useState('')
  const [wsRepo, setWsRepo] = useState('')
  const [wsTemplate, setWsTemplate] = useState('static-html')
  const [wsAllowNonEmpty, setWsAllowNonEmpty] = useState(false)
  const [cloudUrl, setCloudUrl] = useState('')
  const [cloudKey, setCloudKey] = useState('')
  const [cloudHasKey, setCloudHasKey] = useState(false)
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const [activeWs, setActiveWs] = useState<{ id: string; manifest: WorkspaceManifest | null } | null>(null)
  const [snaps, setSnaps] = useState<WsSnapshotInfo[]>([])
  const [snapName, setSnapName] = useState('')
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([])
  const [fwdPort, setFwdPort] = useState('')
  const [cloudRole, setCloudRole] = useState<string | null>(null)
  const [team, setTeam] = useState<TeamMember[]>([])
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor')
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [subscribe, setSubscribe] = useState<{ link: string | null; price: string } | null>(null)

  const refreshTeam = useCallback(async () => {
    setCloudRole(await window.studio.wsCloudRole())
    setTeam(await window.studio.wsTeamList())
    setSubscribe(await window.studio.wsSubscribeInfo())
  }, [])

  const invite = useCallback(async () => {
    if (!inviteName.trim()) return
    const res = await window.studio.wsTeamInvite(inviteName.trim(), inviteRole)
    if (res.ok && res.token) {
      setInviteToken(res.token)
      setInviteName('')
      void refreshTeam()
    } else onMsg('err', res.error ?? 'Invite failed.')
  }, [inviteName, inviteRole, onMsg, refreshTeam])

  const refreshSnaps = useCallback(async (wsId: string) => {
    setSnaps(await window.studio.wsSnapshots(wsId))
  }, [])

  const takeSnapshot = useCallback(async () => {
    if (!activeWs) return
    const res = await withBusy(() =>
      window.studio.wsSnapshot(activeWs.id, snapName.trim() || new Date().toLocaleString())
    )
    if (!res) return
    onMsg(res.ok ? 'ok' : 'err', res.ok ? 'Snapshot saved — restore it any time.' : res.error ?? 'Snapshot failed.')
    setSnapName('')
    if (res.ok) void refreshSnaps(activeWs.id)
  }, [activeWs, snapName, onMsg, refreshSnaps, withBusy])

  const restoreSnapshot = useCallback(
    async (snapId: string) => {
      if (!activeWs) return
      const res = await withBusy(() => window.studio.wsRestore(activeWs.id, snapId))
      if (!res) return
      onMsg(res.ok ? 'ok' : 'err', res.ok ? 'Workspace restored to that snapshot.' : res.error ?? 'Restore failed.')
    },
    [activeWs, onMsg, withBusy]
  )

  const forwardPort = useCallback(async () => {
    const port = parseInt(fwdPort, 10)
    if (!port) return
    const res = await withBusy(() => window.studio.tunnelOpen(port))
    if (!res) return
    if (res.ok && res.tunnel) {
      onMsg('ok', `Port ${port} is now available at http://localhost:${res.tunnel.localPort}`)
      setFwdPort('')
      setTunnels(await window.studio.tunnelList())
    } else onMsg('err', res.error ?? 'Could not forward the port.')
  }, [fwdPort, onMsg, withBusy])

  const closeTunnel = useCallback(async (id: number) => {
    await window.studio.tunnelClose(id)
    setTunnels(await window.studio.tunnelList())
  }, [])

  const refreshWs = useCallback(async () => {
    setWorkspaces(await window.studio.wsList())
    const cc = await window.studio.wsCloudConfig()
    setCloudUrl((cur) => cur || cc.baseUrl || '')
    setCloudHasKey(cc.hasKey)
  }, [])

  useEffect(() => {
    void refreshWs()
    void refreshTeam()
  }, [refreshWs, refreshTeam])

  const deleteWs = useCallback(
    async (w: Workspace) => {
      if (armedDelete !== w.id) {
        setArmedDelete(w.id)
        return
      }
      setArmedDelete(null)
      const res = await window.studio.wsDelete(w.id, w.kind === 'cloud')
      onMsg(res.ok ? 'ok' : 'err', res.ok
        ? w.kind === 'cloud'
          ? `Deleted ${w.name} (cloud copy moved to trash for 7 days).`
          : `Removed ${w.name} from the list — nothing on your server was deleted.`
        : res.error ?? 'Delete failed.')
      void refreshWs()
    },
    [armedDelete, onMsg, refreshWs]
  )

  const createCompanyWs = useCallback(async () => {
    const cfg: RemoteConfig = {
      host: host.trim(),
      user: user.trim(),
      port: parseInt(port, 10) || 22,
      keyPath: keyPath.trim().replace(/^~(?=\/)/, ''),
      root: root.trim().replace(/\/$/, '')
    }
    const policy: RemotePolicy = {
      confidential,
      allowExport,
      allowedProviders: ['ollama', 'atomic'],
      fraudWebhook: webhook.trim() || undefined
    }
    const res = await withBusy(() =>
      window.studio.wsCreateCompany({
        name: wsName.trim() || cfg.root.split('/').pop() || 'workspace',
        cfg,
        policy,
        repo: wsRepo.trim() || undefined,
        template: wsRepo.trim() ? undefined : wsTemplate,
        allowNonEmpty: wsAllowNonEmpty
      })
    )
    if (!res) return
    if (!res.ok) {
      onMsg('err', res.error ?? 'Provisioning failed.')
      return
    }
    onMsg('ok', `Workspace "${res.workspace?.name}" is ready on your server.`)
    setWsView('list')
    setWsName('')
    setWsRepo('')
    void refreshWs()
  }, [host, user, port, keyPath, root, confidential, allowExport, webhook, wsName, wsRepo, wsTemplate, wsAllowNonEmpty, onMsg, refreshWs, withBusy])

  const createCloudWs = useCallback(async () => {
    const res = await withBusy(async () => {
      if (cloudUrl.trim()) await window.studio.wsCloudSetup(cloudUrl.trim())
      if (cloudKey.trim()) {
        await window.studio.setApiKey('atomic-cloud', cloudKey.trim())
        setCloudKey('')
        setCloudHasKey(true)
      }
      return window.studio.wsCreateCloud({ name: wsName.trim() || 'my-workspace', template: wsTemplate })
    })
    if (!res) return
    if (!res.ok) {
      onMsg('err', res.error ?? 'Could not create the cloud workspace.')
      return
    }
    onMsg('ok', `Cloud workspace "${res.workspace?.name}" is ready.`)
    setWsView('list')
    setWsName('')
    void refreshWs()
  }, [cloudUrl, cloudKey, wsName, wsTemplate, onMsg, refreshWs, withBusy])

  const startApp = useCallback(async () => {
    if (!activeWs?.manifest?.startup) return
    const res = await withBusy(() => window.studio.wsExec(activeWs.id, activeWs.manifest!.startup!))
    if (!res) return
    setCmdOut(res.output || (res.ok ? '(no output)' : 'failed'))
  }, [activeWs, withBusy])

  const shownWs = workspaces.filter(
    (w) => !wsSearch.trim() || w.name.toLowerCase().includes(wsSearch.trim().toLowerCase())
  )

  const ago = (ts: number | null): string => {
    if (!ts) return 'never opened'
    const m = Math.round((Date.now() - ts) / 60000)
    if (m < 2) return 'just now'
    if (m < 60) return `${m} min ago`
    const h = Math.round(m / 60)
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
  }

  useEffect(() => {
    void window.studio.remoteState().then((s) => {
      setConnected(s.connected)
      if (s.connected && s.cfg) {
        setCwd(s.cfg.root)
        void list(s.cfg.root)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const list = useCallback(async (path: string) => {
    setEntries(await window.studio.remoteList(path))
    setCwd(path)
  }, [])

  const openWs = useCallback(
    async (id: string) => {
      const res = await withBusy(() => window.studio.wsOpen(id))
      if (!res) return
      if (!res.ok || !res.remote?.cfg) {
        onMsg('err', res.error ?? 'Could not open the workspace.')
        return
      }
      if (res.woke) onMsg('ok', 'Waking your workspace… connected.')
      else onMsg('ok', 'Workspace opened — the code stays on the server.')
      setActiveWs({ id, manifest: res.manifest ?? null })
      void refreshSnaps(id)
      setConnected(true)
      onStateChange(await window.studio.remoteState())
      void list(res.remote.cfg.root)
      void refreshWs()
    },
    [onMsg, onStateChange, list, refreshWs, refreshSnaps, withBusy]
  )

  const connect = useCallback(async () => {
    const cfg: RemoteConfig = {
      host: host.trim(),
      user: user.trim(),
      port: parseInt(port, 10) || 22,
      keyPath: keyPath.trim().replace(/^~(?=\/)/, ''),
      root: root.trim().replace(/\/$/, '') || '/'
    }
    const policy: RemotePolicy = {
      confidential,
      allowExport,
      allowedProviders: ['ollama', 'atomic'],
      fraudWebhook: webhook.trim() || undefined
    }
    const res = await withBusy(() => window.studio.remoteConnect(cfg, policy))
    if (!res) return
    if (!res.ok) {
      onMsg('err', res.error ?? 'Connection failed.')
      return
    }
    localStorage.setItem(CFG_KEY, JSON.stringify({ ...cfg, confidential, allowExport, webhook }))
    setConnected(true)
    onMsg('ok', `Connected to ${cfg.user}@${cfg.host} — the code stays on the server.`)
    onStateChange(await window.studio.remoteState())
    void list(cfg.root)
  }, [host, user, port, keyPath, root, confidential, allowExport, webhook, onMsg, onStateChange, list, withBusy])

  const disconnect = useCallback(async () => {
    await window.studio.remoteDisconnect()
    setConnected(false)
    setEntries([])
    setActiveWs(null)
    onStateChange({ connected: false })
  }, [onStateChange])

  const runCmd = useCallback(async () => {
    if (!cmd.trim()) return
    // Workspace sessions run through wsExec so workspace secrets are injected.
    const res = await withBusy(() =>
      activeWs ? window.studio.wsExec(activeWs.id, cmd.trim()) : window.studio.remoteExec(cmd.trim())
    )
    if (!res) return
    setCmdOut(res.output || (res.ok ? '(no output)' : 'failed'))
  }, [cmd, activeWs, withBusy])

  /* One entry point for both mouse and keyboard. The rows used to be `<div onClick>` with no role,
     no tabIndex and no key handler — mouse-only, which `.tree-row`'s own `:focus-visible` rule in
     styles.css could never fire against. The local FileTree has always done this correctly; this is
     the same shape. */
  const open = (e: RemoteDirEntry): void => {
    if (e.isDir) void list(`${cwd}/${e.name}`)
    else onOpenRemoteFile(`${cwd}/${e.name}`)
  }

  const parent = (p: string): string => p.split('/').slice(0, -1).join('/') || '/'

  return (
    <div className="remote-drawer panel-pane">
      <div className="logs-body remote-body">
        {/* ===== ATOMIC Workspaces home ===== */}
        {!connected && (
          <div className="ws-home">
            <div className="git-heading">
              Workspaces
              <input
                className="text-input ws-search"
                placeholder="Search…"
                value={wsSearch}
                onChange={(e) => setWsSearch(e.target.value)}
              />
              <span className="spacer" />
              <button className="btn btn-sm btn-primary" onClick={() => setWsView(wsView === 'choose' ? 'list' : 'choose')}>
                + New workspace
              </button>
            </div>

            {wsView === 'choose' && (
              <div className="ws-cards">
                {/* The card stays a plain container and the button inside it is the real control —
                    a whole card as one giant <button> can't legally hold the button it displays. */}
                <div className="ws-card" onClick={() => setWsView('newCompany')}>
                  <div className="ws-card-title">Your own server</div>
                  <div className="ws-price">Free · unlimited</div>
                  <p className="muted small">
                    Point Studio at any server you already pay for — we set up the workspace over a
                    secure connection in about 2 minutes. Your code stays on your machine and never
                    touches ATOMIC's servers. Free ATOMIC AI included.
                  </p>
                  <button type="button" className="btn btn-block" onClick={() => setWsView('newCompany')}>
                    Use my server
                  </button>
                </div>
                <div className="ws-card ws-card-cloud" onClick={() => setWsView('newCloud')}>
                  <div className="ws-card-title">ATOMIC Cloud</div>
                  <div className="ws-price">$9/month · flat</div>
                  <p className="muted small">
                    A ready-to-go computer in the cloud for one project — $9 a month, flat. Open your
                    laptop anywhere and it's exactly where you left it. No meters, no credits, no
                    surprise bills. Ever.
                  </p>
                  <button type="button" className="btn btn-primary btn-block" onClick={() => setWsView('newCloud')}>
                    Create cloud workspace
                  </button>
                </div>
              </div>
            )}

            {wsView === 'newCompany' && (
              <div className="remote-form ws-newform">
                <div className="git-heading">New workspace on your server</div>
                <div className="remote-grid">
                  <input className="text-input" placeholder="Workspace name" value={wsName} onChange={(e) => setWsName(e.target.value)} />
                  <input className="text-input" placeholder="User" value={user} onChange={(e) => setUser(e.target.value)} />
                  <input className="text-input" placeholder="Port" value={port} onChange={(e) => setPort(e.target.value)} />
                  <input className="text-input" placeholder="SSH key path" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />
                  <input className="text-input remote-wide" placeholder="Server address (e.g. 203.0.113.20 or my.aws.host)" value={host} onChange={(e) => setHost(e.target.value)} />
                  <input className="text-input remote-wide" placeholder="New workspace folder on the server (e.g. /srv/work/myapp)" value={root} onChange={(e) => setRoot(e.target.value)} />
                  <input className="text-input remote-wide" placeholder="Git repository to clone (optional, https://…)" value={wsRepo} onChange={(e) => setWsRepo(e.target.value)} />
                </div>
                {!wsRepo.trim() && (
                  <label className="settings-toggle">
                    Starter template:
                    <select className="text-input ws-template" value={wsTemplate} onChange={(e) => setWsTemplate(e.target.value)}>
                      <option value="static-html">Simple website (static-html)</option>
                      <option value="">Empty folder</option>
                    </select>
                  </label>
                )}
                <label className="settings-toggle">
                  <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} />
                  Confidential mode — server code may only use company-approved AI
                </label>
                <label className="settings-toggle">
                  <input type="checkbox" checked={!allowExport} onChange={(e) => setAllowExport(!e.target.checked)} />
                  Block copying / downloading source out of Studio (audited)
                </label>
                <label className="settings-toggle">
                  <input type="checkbox" checked={wsAllowNonEmpty} onChange={(e) => setWsAllowNonEmpty(e.target.checked)} />
                  Allow a non-empty folder (only if you know what's in it)
                </label>
                <div className="git-row">
                  <button className="btn btn-primary" onClick={createCompanyWs} disabled={busy || !host.trim() || !root.trim()}>
                    {busy ? 'Provisioning…' : 'Create workspace'}
                  </button>
                  <button className="btn" onClick={() => setWsView('choose')} disabled={busy}>Back</button>
                </div>
              </div>
            )}

            {wsView === 'newCloud' && (
              <div className="remote-form ws-newform">
                <div className="git-heading">New ATOMIC Cloud workspace</div>
                <p className="muted small">
                  $9/month flat — never metered, never credits, no surprise bills. Your ATOMIC Cloud
                  server address and access key come with your subscription.
                </p>
                <div className="remote-grid">
                  <input className="text-input remote-wide" placeholder="Workspace name" value={wsName} onChange={(e) => setWsName(e.target.value)} />
                  <input className="text-input remote-wide" placeholder="ATOMIC Cloud server (e.g. https://cloud.atomic.limited)" value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value)} />
                  <input
                    className="text-input remote-wide"
                    type="password"
                    placeholder={cloudHasKey ? 'Access key (saved — leave empty to keep)' : 'Access key'}
                    value={cloudKey}
                    onChange={(e) => setCloudKey(e.target.value)}
                  />
                </div>
                <div className="git-row">
                  <button className="btn btn-primary" onClick={createCloudWs} disabled={busy || !wsName.trim() || !cloudUrl.trim() || (!cloudHasKey && !cloudKey.trim())}>
                    {/* This button doesn't charge anything — the subscription is bought separately
                        and its key is pasted above. A price on the button implied a purchase that
                        isn't happening here. */}
                    {busy ? 'Creating…' : 'Create workspace'}
                  </button>
                  <button className="btn" onClick={() => setWsView('choose')} disabled={busy}>Back</button>
                </div>
              </div>
            )}

            {wsView === 'list' && cloudRole === 'owner' && (
              <div className="team-section">
                <div className="git-heading">
                  Team
                  <span className="muted small">share your cloud workspaces</span>
                </div>
                {team.map((m) => (
                  <div key={m.name} className="snap-row">
                    <span className="snap-name">{m.name}</span>
                    <span className={`ws-badge ${m.role === 'viewer' ? 'ws-badge-server' : 'ws-badge-cloud'}`}>{m.role}</span>
                    <button className="btn btn-sm" onClick={() => void window.studio.wsTeamRevoke(m.name).then(refreshTeam)}>
                      Revoke
                    </button>
                  </div>
                ))}
                <div className="git-row">
                  <input className="text-input" placeholder="Teammate name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} />
                  <select className="text-input ws-template" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'editor' | 'viewer')}>
                    <option value="editor">Can edit</option>
                    <option value="viewer">View only</option>
                  </select>
                  <button className="btn btn-sm btn-primary" onClick={invite} disabled={!inviteName.trim()}>
                    Invite
                  </button>
                </div>
                {inviteToken && (
                  <div className="ok-box invite-token">
                    Access key for your teammate (shown once): <code>{inviteToken}</code>
                    <button className="btn btn-sm" onClick={() => setInviteToken(null)}>Done</button>
                  </div>
                )}
              </div>
            )}
            {wsView === 'list' && cloudRole && cloudRole !== 'owner' && (
              <div className="muted small">Signed in to ATOMIC Cloud as <b>{cloudRole}</b>{cloudRole === 'viewer' ? ' — view-only access.' : '.'}</div>
            )}
            {wsView === 'list' && subscribe?.link && (
              <div className="git-row">
                <button className="btn btn-sm btn-primary" onClick={() => void window.studio.openExternal(subscribe.link!)}>
                  Subscribe — {subscribe.price}
                </button>
              </div>
            )}
            {wsView === 'list' && (
              <div className="muted small private-server-note">
                Need a whole private box? <b>Private ATOMIC Server</b> — $149/month flat, unlimited workspaces & teammates on dedicated hardware. Contact ATOMIC.
              </div>
            )}
            {wsView === 'list' && (
              <div className="ws-list">
                {shownWs.length === 0 && (
                  <div className="muted small">
                    No workspaces yet. Press <b>+ New workspace</b> — your own server is free and
                    unlimited, ATOMIC Cloud is $9/month flat.
                  </div>
                )}
                {shownWs.map((w) => (
                  <div key={w.id} className="ws-row">
                    <span className={`ws-badge ${w.kind === 'cloud' ? 'ws-badge-cloud' : 'ws-badge-server'}`}>
                      {w.kind === 'cloud' ? 'ATOMIC Cloud' : 'Your server'}
                    </span>
                    <span className="ws-name" title={`${w.cfg.user}@${w.cfg.host}:${w.cfg.root}`}>{w.name}</span>
                    <span className={`ws-state ws-state-${w.state}`}>{w.state}</span>
                    <span className="muted small ws-ago">{ago(w.lastOpened)}</span>
                    <span className="spacer" />
                    <button className="btn btn-sm btn-primary" onClick={() => void openWs(w.id)} disabled={busy}>
                      Open
                    </button>
                    <button className="btn btn-sm" onClick={() => void deleteWs(w)} disabled={busy}>
                      {armedDelete === w.id ? 'Confirm delete' : 'Delete'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!connected ? (
          <div className="remote-form">
            <div className="git-heading">Advanced: connect directly to a server folder (SSH)</div>
            <div className="remote-grid">
              <input className="text-input" placeholder="Server address (e.g. 203.0.113.20 or my.aws.host)" value={host} onChange={(e) => setHost(e.target.value)} />
              <input className="text-input" placeholder="User" value={user} onChange={(e) => setUser(e.target.value)} />
              <input className="text-input" placeholder="Port" value={port} onChange={(e) => setPort(e.target.value)} />
              <input className="text-input" placeholder="SSH key path" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />
              <input className="text-input remote-wide" placeholder="Project folder on the server (e.g. /var/www/app)" value={root} onChange={(e) => setRoot(e.target.value)} />
              <input className="text-input remote-wide" placeholder="Fraud-report webhook URL (optional)" value={webhook} onChange={(e) => setWebhook(e.target.value)} />
            </div>
            <label className="settings-toggle">
              <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} />
              Confidential mode — server code may only use company-approved AI (local/own hub)
            </label>
            <label className="settings-toggle">
              <input type="checkbox" checked={!allowExport} onChange={(e) => setAllowExport(!e.target.checked)} />
              Block copying / downloading source out of Studio (audited)
            </label>
            <button className="btn btn-primary" onClick={connect} disabled={busy || !host.trim() || !root.trim()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        ) : (
          <div className="remote-connected">
            <div className="remote-files">
              <div className="git-heading">
                <button className="btn btn-sm" onClick={() => void list(parent(cwd))} disabled={cwd === '/' || busy}><Icon name="arrow-up" size={11} /> Up</button>
                <span className="remote-cwd">{cwd}</span>
                <span className="spacer" />
                <button className="btn btn-sm" onClick={() => void window.studio.reportFraud('Manual report from Studio').then((r) => onMsg(r.ok ? 'ok' : 'err', r.delivered ? 'Report sent to your company.' : r.error ?? 'Logged locally (no webhook set).'))}>
                  <Icon name="flag" size={11} /> Report
                </button>
                <button className="btn btn-sm" onClick={disconnect}>Disconnect</button>
              </div>
              {entries.map((e) => (
                <div
                  key={e.name}
                  className="tree-row"
                  role="treeitem"
                  tabIndex={0}
                  aria-level={1}
                  title={e.name}
                  onClick={() => open(e)}
                  onKeyDown={(ev) => {
                    if (ev.key !== 'Enter' && ev.key !== ' ') return
                    ev.preventDefault()
                    open(e)
                  }}
                >
                  <span className="tree-icon" aria-hidden="true">
                    <Icon name={e.isDir ? 'folder' : 'file'} size={14} />
                  </span>
                  <span className="tree-name">{e.name}</span>
                </div>
              ))}
              {entries.length === 0 && <div className="muted small">Empty folder.</div>}
            </div>
            <div className="remote-exec">
              {activeWs && (
                <div className="ws-tools">
                  <div className="git-row">
                    <input
                      className="text-input"
                      placeholder="Snapshot name (optional)"
                      value={snapName}
                      onChange={(e) => setSnapName(e.target.value)}
                    />
                    <button className="btn btn-sm" onClick={takeSnapshot} disabled={busy} title="Save a restore point of the whole workspace">
                      Snapshot
                    </button>
                  </div>
                  {snaps.length > 0 && (
                    <div className="snap-list">
                      {snaps.slice(0, 5).map((sn) => (
                        <div key={sn.id} className="snap-row">
                          <span className="snap-name" title={sn.description}>{sn.name}</span>
                          <span className="muted small">{new Date(sn.ts).toLocaleString()}</span>
                          <button className="btn btn-sm" onClick={() => void restoreSnapshot(sn.id)} disabled={busy}>
                            Restore
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="git-row">
                    <input
                      className="text-input"
                      placeholder="Forward a port (e.g. 3000)"
                      value={fwdPort}
                      onChange={(e) => setFwdPort(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void forwardPort()}
                    />
                    <button className="btn btn-sm" onClick={forwardPort} disabled={busy || !fwdPort.trim()}>
                      Forward
                    </button>
                  </div>
                  {tunnels.map((t) => (
                    <div key={t.id} className="snap-row">
                      <span className="snap-name">localhost:{t.localPort} ← server:{t.remotePort}</span>
                      <button className="btn btn-sm" onClick={() => void closeTunnel(t.id)}>Close</button>
                    </div>
                  ))}
                </div>
              )}
              {activeWs?.manifest?.startup && (
                <div className="git-row">
                  <button className="btn btn-sm btn-primary" onClick={startApp} disabled={busy} title={activeWs.manifest.startup}>
                    <Icon name="play" size={11} /> Start app
                  </button>
                  <span className="muted small">{activeWs.manifest.framework ?? ''} · {activeWs.manifest.startup}</span>
                </div>
              )}
              <div className="git-row">
                <input
                  className="text-input"
                  placeholder="Run a command on the server (in the project folder)"
                  value={cmd}
                  onChange={(e) => setCmd(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void runCmd()}
                />
                <button className="btn btn-sm" onClick={runCmd} disabled={busy || !cmd.trim()}>Run</button>
              </div>
              {cmdOut && <pre className="remote-out">{cmdOut}</pre>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
