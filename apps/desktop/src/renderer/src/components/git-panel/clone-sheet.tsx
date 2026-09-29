import React from 'react'
import { Icon } from '../Icon'
import type { ForgeInfo, ForgeRepo } from '../../../../shared/types'

interface Props {
  forges: ForgeInfo[]
  activeId: string
  repos: ForgeRepo[]
  showRepos: boolean
  busy: string | null
  tokenInput: string
  /** The raw clone URL being typed. Kept here rather than in a prompt() — see GitPanel. */
  urlInput: string
  /** True when a company IdP is configured but nobody has signed in yet. */
  needsSignIn: boolean
  onPick: (id: string) => void
  onTokenChange: (v: string) => void
  onSignIn: () => void
  onLoadRepos: () => void
  onClone: (repo: ForgeRepo) => void
  onUrlChange: (v: string) => void
  onCloneUrl: () => void
  /** Present when the sheet was opened from a command and can be put away again. */
  onClose?: () => void
}

/**
 * Where repositories come from — shown on demand, never as the top of every repo view.
 *
 * Until 2026-09-02 this bar sat permanently above the branch, the changes and the commit form,
 * so a person committing their tenth change of the day was still looking at "Load repos from
 * GitHub". It now lives in the no-repository empty state and behind the "Clone repository…"
 * command in the header's overflow menu.
 *
 * The self-hosted server is listed FIRST and a raw URL field is always present, because the
 * product's claim is that your code need not leave your building — an interface where the cloud
 * option is the default path quietly contradicts that. A cloud forge that is not signed in still
 * shows its sign-in, but it is never the only way in.
 */
export function CloneSheet(p: Props): React.JSX.Element {
  const active = p.forges.find((f) => f.id === p.activeId)
  const needsToken = active?.kind === 'cloud' && !active.signedIn

  return (
    <div className="scm-clone" role="group" aria-label="Clone a repository">
      <div className="scm-clone-head">
        <span className="scm-kicker">Clone repository</span>
        {p.forges.length > 1 && (
          <select
            className="text-input scm-select"
            value={p.activeId}
            aria-label="Repository source"
            onChange={(e) => p.onPick(e.target.value)}
          >
            {p.forges.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}{f.kind === 'self-hosted' ? ' (self-hosted)' : ''}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        {p.onClose && (
          <button type="button" className="scm-icon-btn" onClick={p.onClose} aria-label="Close clone" title="Close">
            <Icon name="close" size={12} />
          </button>
        )}
      </div>

      <div className="scm-clone-row">
        <input
          className="text-input"
          placeholder="ssh://git@host/srv/atomic/git/repo.git"
          aria-label="Clone URL"
          value={p.urlInput}
          onChange={(e) => p.onUrlChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && p.urlInput.trim()) p.onCloneUrl() }}
        />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={p.onCloneUrl}
          disabled={!p.urlInput.trim() || p.busy === 'clone-url'}
          title="Clone any git URL, including ssh:// on your own server"
        >
          {p.busy === 'clone-url' ? 'Cloning…' : 'Clone'}
        </button>
      </div>

      {active?.kind === 'self-hosted' && !active.signedIn && (
        /* TWO different reasons look identical here, and telling someone to add a config file
           when the real fix is to sign in sends them to the wrong place entirely. */
        p.needsSignIn ? (
          <p className="muted small">
            Sign in to your company server to see its repositories — <strong>Settings → Company</strong>.
            An <code>ssh://</code> address above works without it.
          </p>
        ) : (
          <p className="muted small">
            No ATOMIC server configured yet. Add <code>atomic-forge.json</code> to your Studio data folder,
            or paste an <code>ssh://</code> address above.
          </p>
        )
      )}

      {needsToken && (
        <div className="scm-clone-row">
          <input
            className="text-input"
            type="password"
            placeholder="personal access token"
            aria-label={`${active?.name ?? 'Forge'} personal access token`}
            value={p.tokenInput}
            onChange={(e) => p.onTokenChange(e.target.value)}
          />
          <button type="button" className="btn btn-sm btn-primary" onClick={p.onSignIn} disabled={!p.tokenInput.trim()}>
            Sign in
          </button>
        </div>
      )}

      {active?.signedIn && (
        <>
          <button type="button" className="btn btn-sm scm-clone-load" onClick={p.onLoadRepos} disabled={p.busy === 'repos'}>
            {p.busy === 'repos' ? 'Loading…' : p.showRepos ? 'Refresh list' : `Browse ${active.name}`}
          </button>
          {p.showRepos && (
            <div className="scm-clone-repos" role="list">
              {p.repos.length === 0 && <div className="muted small">No repositories found.</div>}
              {p.repos.slice(0, 50).map((r) => (
                <div key={r.fullName} className="scm-clone-repo" role="listitem">
                  <Icon name={r.private ? 'lock' : 'globe'} size={11} />
                  <span className="scm-clone-repo-name" title={r.description || r.cloneUrl}>{r.fullName}</span>
                  <button type="button" className="btn btn-sm" disabled={p.busy === r.fullName} onClick={() => p.onClone(r)}>
                    {p.busy === r.fullName ? 'Cloning…' : 'Clone'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
