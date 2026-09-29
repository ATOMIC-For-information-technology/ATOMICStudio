import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon'
import type { ConnectorInfo, ExtensionManifest, RegistryEntry } from '../../../shared/types'

interface Props {
  /** Air-Gapped Mode overrides everything here; the panel has to say so rather than look broken. */
  airGapped: boolean
  onMsg: (type: 'ok' | 'err', text: string) => void
}

/**
 * Connectors + installable extensions.
 *
 * This replaces the "coming soon" placeholder. Two honesty rules drive the whole layout:
 *
 *  1. **Nothing runs until the user says so.** An installed connector arrives disabled; enabling it
 *     starts the server and lists its tools; each tool is approved individually. The agent can only
 *     call approved tools, so "the model decided to" is never the reason something happened.
 *  2. **Installing is running someone else's code.** The GitHub path says that in those words before
 *     it clones anything. A soft, reassuring dialog there would be worse than having no feature.
 */
export function ConnectorsPanel({ airGapped, onMsg }: Props): React.JSX.Element {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([])
  const [installed, setInstalled] = useState<ExtensionManifest[]>([])
  const [registry, setRegistry] = useState<RegistryEntry[] | null>(null)
  const [registryError, setRegistryError] = useState('')
  const [busy, setBusy] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [confirmUrl, setConfirmUrl] = useState('')

  const refresh = useCallback(async () => {
    setConnectors(await window.studio.connectorList())
    setInstalled(await window.studio.extensionsList())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = useCallback(
    async (c: ConnectorInfo) => {
      setBusy(c.id)
      const res = await window.studio.connectorSetEnabled(c.id, !c.enabled)
      setBusy('')
      if (!res.ok) onMsg('err', res.error ?? `Could not start ${c.name}.`)
      else if (!c.enabled) onMsg('ok', `${c.name} started — ${res.tools?.length ?? 0} tools found. Approve the ones you want the AI to use.`)
      void refresh()
    },
    [onMsg, refresh]
  )

  const installFolder = useCallback(async () => {
    setBusy('folder')
    const res = await window.studio.extensionInstallFolder()
    setBusy('')
    if (res.ok && res.manifest) onMsg('ok', `Installed ${res.manifest.name}. It stays off until you turn it on.`)
    else if (res.error && res.error !== 'cancelled') onMsg('err', res.error)
    void refresh()
  }, [onMsg, refresh])

  const installGit = useCallback(async () => {
    const url = confirmUrl
    setConfirmUrl('')
    setBusy('git')
    const res = await window.studio.extensionInstallGit(url)
    setBusy('')
    if (res.ok && res.manifest) {
      setGitUrl('')
      onMsg('ok', `Installed ${res.manifest.name}. It stays off until you turn it on.`)
    } else if (res.error) onMsg('err', res.error)
    void refresh()
  }, [confirmUrl, onMsg, refresh])

  const loadRegistry = useCallback(async () => {
    setBusy('registry')
    const res = await window.studio.extensionRegistry()
    setBusy('')
    setRegistry(res.entries)
    setRegistryError(res.ok ? '' : res.error ?? 'Could not reach the registry.')
  }, [])

  return (
    <div className="settings-section connectors-panel">
      {airGapped && (
        <div className="warn-box">
          <Icon name="lock" size={11} /> Air-Gapped Mode is on, so connectors are disabled and nothing is downloaded.
          Turn it off to use them.
        </div>
      )}

      <div className="settings-subhead">Connectors</div>
      <p className="muted small">
        A connector gives the AI extra tools — your database, GitHub, a design file. Each tool is
        approved by you one at a time, and the AI can only use the ones you approved.
      </p>
      {connectors.length === 0 && <p className="muted small">Nothing installed yet.</p>}
      {connectors.map((c) => (
        <div key={c.id} className="connector-card">
          <div className="connector-head">
            <span className={`ws-badge ${c.running ? 'ws-badge-server' : ''}`}>
              {c.running ? <><Icon name="check" size={10} /> running</> : 'stopped'}
            </span>
            <b className="connector-name">{c.name}</b>
            <code className="run-cmd" title={c.command}>{c.command}</code>
            <span className="spacer" />
            <button className="btn btn-sm" disabled={busy === c.id || airGapped} onClick={() => void toggle(c)}>
              {busy === c.id ? '…' : c.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              className="btn btn-sm btn-danger"
              title={`Remove ${c.name}`}
              onClick={async () => {
                await window.studio.connectorRemove(c.id)
                onMsg('ok', `Removed ${c.name}.`)
                void refresh()
              }}
            >
              Remove
            </button>
          </div>
          {c.blockedByAirGap && <p className="muted small">On, but held back by Air-Gapped Mode.</p>}
          {c.running && c.tools.length > 0 && (
            <div className="connector-tools">
              {c.tools.map((t) => (
                <label key={t.name} className="settings-toggle connector-tool">
                  <input
                    type="checkbox"
                    checked={t.approved}
                    onChange={async (e) => {
                      await window.studio.connectorApproveTool(c.id, t.name, e.target.checked)
                      void refresh()
                    }}
                  />
                  <span>
                    <b>{t.name}</b> <span className="muted small">— {t.description || 'no description provided'}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {c.enabled && c.running && c.tools.length === 0 && (
            <p className="muted small">This connector started but offered no tools.</p>
          )}
        </div>
      ))}

      <div className="settings-subhead">Install</div>
      <div className="git-row">
        <button className="btn btn-sm" disabled={busy === 'folder'} onClick={() => void installFolder()}>
          {busy === 'folder' ? 'Installing…' : 'Install from folder…'}
        </button>
      </div>
      <div className="git-row">
        <input
          className="text-input"
          placeholder="https://github.com/owner/repo"
          value={gitUrl}
          onChange={(e) => setGitUrl(e.target.value)}
        />
        <button
          className="btn btn-sm"
          disabled={!gitUrl.trim() || busy === 'git' || airGapped}
          onClick={() => setConfirmUrl(gitUrl.trim())}
        >
          {busy === 'git' ? 'Installing…' : 'Install from GitHub'}
        </button>
      </div>
      {confirmUrl && (
        <div className="error-box install-confirm">
          <div className="dp-headline">This runs someone else's code on your computer.</div>
          <div className="dp-line">
            {confirmUrl} will be downloaded and can read and change your files, exactly like any program you install.
            Only continue if you trust whoever wrote it.
          </div>
          <div className="dp-actions">
            <button className="btn btn-sm btn-danger" onClick={() => void installGit()}>
              I trust it — install
            </button>
            <button className="btn btn-sm" onClick={() => setConfirmUrl('')}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="settings-subhead">Marketplace</div>
      <p className="muted small">
        A short list ATOMIC checks and publishes — not an open store. Anything else you install comes
        from a folder or a GitHub link above.
      </p>
      <div className="git-row">
        <button className="btn btn-sm" disabled={busy === 'registry' || airGapped} onClick={() => void loadRegistry()}>
          {busy === 'registry' ? 'Loading…' : registry ? 'Refresh list' : 'Browse'}
        </button>
      </div>
      {registryError && <p className="muted small">{registryError}</p>}
      {registry?.length === 0 && !registryError && <p className="muted small">The list is empty right now.</p>}
      {registry?.map((e) => (
        <div key={e.id} className="debt-row">
          <span className={`ws-badge ${e.installed ? 'ws-badge-server' : ''}`}>{e.installed ? 'installed' : e.publisher}</span>
          <span className="debt-detail">
            <b>{e.name}</b> <span className="muted small">— {e.description}</span>
          </span>
          {!e.installed && e.repo && (
            <button className="btn btn-sm" onClick={() => setConfirmUrl(e.repo)}>
              Install
            </button>
          )}
        </div>
      ))}

      {installed.length > 0 && (
        <>
          <div className="settings-subhead">Installed</div>
          {installed.map((m) => (
            <div key={m.id} className="debt-row">
              <span className="ws-badge">{m.kind}</span>
              <span className="debt-detail">
                <b>{m.name}</b> <span className="muted small">v{m.version} — {m.description || 'no description'}</span>
              </span>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const res = await window.studio.extensionUninstall(m.id)
                  onMsg(res.ok ? 'ok' : 'err', res.ok ? `Removed ${m.name}.` : res.error ?? 'Could not remove it.')
                  void refresh()
                }}
              >
                Uninstall
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
