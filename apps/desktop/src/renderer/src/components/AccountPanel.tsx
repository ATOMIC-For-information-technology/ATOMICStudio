import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon'
import type { GhUser, ProviderInfo } from '../../../shared/types'

interface Props {
  providers: ProviderInfo[]
  /** Opens the Tools → GitHub panel, where the real token sign-in lives. */
  onConnectGitHub: () => void
  /** Builder Mode has no GitHub panel, so "Connect GitHub…" would lead nowhere. */
  showGit?: boolean
  /** Opens Settings on the API Keys tab. */
  onManageKeys: () => void
}

/**
 * Account — who this app is currently connected AS.
 *
 * ATOMIC Studio deliberately has no account of its own yet (no OAuth, no user
 * database — see DEVLOG). Rather than fake a sign-in screen, this panel shows the
 * real connections that DO exist: the GitHub identity fetched from GitHub's own
 * /user endpoint, and which AI providers have a key in the OS keychain. Every row
 * is live state, never a placeholder.
 */
export function AccountPanel({ providers, onConnectGitHub, onManageKeys, showGit = true }: Props): React.JSX.Element {
  const [gh, setGh] = useState<GhUser | null>(null)
  const [ghLoading, setGhLoading] = useState(true)
  const [keyed, setKeyed] = useState<Record<string, boolean>>({})

  const refresh = useCallback(async () => {
    setGhLoading(true)
    try {
      setGh(await window.studio.ghUser())
    } catch {
      setGh(null)
    }
    setGhLoading(false)
    const states: Record<string, boolean> = {}
    for (const p of providers.filter((x) => x.needsKey)) {
      states[p.id] = await window.studio.hasApiKey(p.id)
    }
    setKeyed(states)
  }, [providers])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // "Sign out" = clear the stored credential. hasApiKey() treats an empty string as
  // absent, so this genuinely disconnects rather than just hiding the row.
  const disconnectGitHub = async (): Promise<void> => {
    await window.studio.setApiKey('github', '')
    await refresh()
  }

  const connected = providers.filter((p) => p.needsKey && keyed[p.id])
  const notConnected = providers.filter((p) => p.needsKey && !keyed[p.id])

  return (
    <div className="account-panel">
      {showGit && (<>
      <div className="settings-subhead">GitHub</div>
      {ghLoading ? (
        <p className="muted small">Checking…</p>
      ) : gh ? (
        <div className="account-id">
          <div className="account-id-row">
            <span className="account-dot ok" aria-hidden="true"><Icon name="dot" size={9} /></span>
            <span className="account-name">{gh.name || gh.login}</span>
          </div>
          <div className="muted small account-sub">@{gh.login}</div>
          <button className="btn btn-sm btn-block" onClick={() => void disconnectGitHub()}>
            Sign out
          </button>
        </div>
      ) : (
        <div className="account-id">
          <div className="account-id-row">
            <span className="account-dot" aria-hidden="true"><Icon name="circle" size={10} /></span>
            <span className="muted">Not connected</span>
          </div>
          <button className="btn btn-sm btn-block" onClick={onConnectGitHub}>
            Connect GitHub…
          </button>
        </div>
      )}
      </>)}

      <div className="settings-subhead">AI providers</div>
      {connected.length === 0 && <p className="muted small">No provider keys saved yet.</p>}
      {connected.map((p) => (
        <div key={p.id} className="account-row">
          <span className="account-dot ok" aria-hidden="true"><Icon name="dot" size={9} /></span>
          <span className="account-row-name">{p.label}</span>
          <span className="muted small">connected</span>
        </div>
      ))}
      {notConnected.length > 0 && (
        <p className="muted small account-note">
          {notConnected.length} more provider{notConnected.length === 1 ? '' : 's'} available without a key saved.
        </p>
      )}
      <button className="btn btn-sm btn-block" onClick={onManageKeys}>
        Manage keys…
      </button>

      <div className="settings-subhead">ATOMIC Studio account</div>
      <p className="muted small">
        There isn&apos;t one yet — Studio runs entirely on this machine and signs in only to the services above.
        Sign-in with Google, GitHub or email is planned, not built.
      </p>
    </div>
  )
}
