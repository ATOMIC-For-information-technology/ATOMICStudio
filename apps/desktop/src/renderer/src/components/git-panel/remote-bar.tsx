import React, { useState } from 'react'
import { Icon } from '../Icon'
import type { RemoteView } from './derive'
import type { ForgeRepo } from '../../../../shared/types'

interface Props {
  remote: RemoteView
  branch: string
  /** The server's name, for saying where the code is going in words rather than a URL. */
  serverName: string
  /** Repos this person may see on that server. Empty until asked for. */
  repos: ForgeRepo[]
  reposLoaded: boolean
  busy: string | null
  /** The strip was opened from the overflow menu ("Connect to a server…"). */
  open: boolean
  onOpen: () => void
  onCloseForm: () => void
  onLoadRepos: () => void
  /** Point `origin` at this URL and push the current branch with an upstream. */
  onConnect: (url: string) => void
  /** A remote exists but this branch has never been pushed — `push -u`. */
  onPublish: () => void
}

/**
 * Where this project's code goes — shown ONLY when the answer is "nowhere yet".
 *
 * A connected project says so in the header's Push button tooltip and nowhere else; the strip
 * exists for the two states that need a decision. `no-upstream` is called out separately rather
 * than folded into "connected", because plain `git push` does not merely no-op there — it FAILS
 * ("the current branch has no upstream branch"), and a Push button that reliably errors on a
 * fresh branch is worse than no button. Publish sends `push -u`, which is the thing meant.
 */
export function RemoteBar(p: Props): React.JSX.Element | null {
  const [url, setUrl] = useState('')
  const [manual, setManual] = useState(false)
  const [picked, setPicked] = useState('')
  const working = p.busy === 'connect' || p.busy === 'publish'

  if (p.remote.state === 'connected') return null

  if (p.remote.state === 'no-upstream') {
    return (
      <div className="scm-strip scm-strip-warn" role="status">
        <Icon name="upload" size={12} />
        <span>
          <strong>{p.branch}</strong> has never been sent to <span title={p.remote.url}>{p.remote.host}</span>.
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-primary" disabled={!!p.busy} onClick={p.onPublish}>
          {p.busy === 'publish' ? 'Publishing…' : `Publish ${p.branch}`}
        </button>
      </div>
    )
  }

  if (!p.open) {
    return (
      <div className="scm-strip scm-strip-warn" role="status">
        <Icon name="alert" size={12} />
        <span>Not connected to a server — nothing you commit leaves this machine.</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={p.onOpen}>Connect…</button>
      </div>
    )
  }

  return (
    <div className="scm-strip scm-strip-warn scm-strip-form" role="group" aria-label="Connect to a server">
      {!manual ? (
        <>
          <select
            className="text-input scm-select"
            value={picked}
            aria-label={`Repository on ${p.serverName}`}
            disabled={working}
            onChange={(e) => setPicked(e.target.value)}
            onFocus={() => {
              // Ask the server the first time the picker is touched, not on every panel render:
              // the catalog is a REST round trip that most sessions never need.
              if (!p.reposLoaded) p.onLoadRepos()
            }}
          >
            <option value="">
              {p.reposLoaded ? `choose a repo on ${p.serverName}…` : `load repos from ${p.serverName}…`}
            </option>
            {p.repos.map((r) => (
              <option key={r.fullName} value={r.cloneUrl}>{r.fullName}</option>
            ))}
          </select>
          <button type="button" className="btn btn-sm btn-primary" disabled={!picked || working} onClick={() => p.onConnect(picked)}>
            {p.busy === 'connect' ? 'Connecting…' : 'Connect & push'}
          </button>
          <button type="button" className="btn btn-sm" disabled={working} onClick={() => setManual(true)}>
            Use a URL
          </button>
        </>
      ) : (
        <>
          <input
            className="text-input"
            placeholder="ssh://git@your-server/srv/atomic/git/project.git"
            aria-label="Remote URL"
            value={url}
            disabled={working}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && url.trim() && !working) p.onConnect(url.trim())
            }}
          />
          <button type="button" className="btn btn-sm btn-primary" disabled={!url.trim() || working} onClick={() => p.onConnect(url.trim())}>
            {p.busy === 'connect' ? 'Connecting…' : 'Connect & push'}
          </button>
          <button type="button" className="btn btn-sm" disabled={working} onClick={() => setManual(false)}>
            Back
          </button>
        </>
      )}
      <button type="button" className="scm-icon-btn" disabled={working} onClick={p.onCloseForm} aria-label="Close connect" title="Close">
        <Icon name="close" size={12} />
      </button>
      {p.repos.length === 0 && p.reposLoaded && !manual && (
        <span className="muted small scm-strip-note">
          {p.serverName} listed no repositories you can push to. An administrator creates one, or paste the URL.
        </span>
      )}
    </div>
  )
}
