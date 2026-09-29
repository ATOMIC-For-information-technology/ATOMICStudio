import React from 'react'
import { Icon } from '../Icon'
import type { GitView, RemoteView } from './derive'

interface Props {
  view: GitView
  remote: RemoteView
  busy: string | null
  pickerOpen: boolean
  onBranch: () => void
  onRefresh: () => void
  onFetch: () => void
  onPull: () => void
  onPush: () => void
  onPublish: () => void
  onOverflow: () => void
  overflowOpen: boolean
  /** Stamped by the panel so the button element can anchor the overflow menu. */
  children?: React.ReactNode
}

/**
 * The sticky Source Control header: identity on the left, verbs on the right, 22px tall.
 *
 * Every verb is an icon button with an accessible name AND a tooltip, and a verb that cannot
 * work right now is disabled with the reason in its tooltip rather than hidden — the no-dead-
 * controls rule cuts both ways. Push becomes Publish when the branch has no upstream, because
 * plain `git push` fails there and a button that reliably errors is worse than none.
 */
export function ScmHeader(p: Props): React.JSX.Element {
  const v = p.view
  const anyBusy = !!p.busy
  const noRemote = p.remote.state === 'no-remote'
  const canPull = !noRemote && !!v.upstream && !v.merging && !v.rebasing
  const publish = !noRemote && !v.upstream && !v.detached

  const branchLabel = v.detached ? 'detached HEAD' : v.branch || (v.initial ? 'no commits yet' : 'HEAD')
  return (
    <div className="scm-head">
      <button
        type="button"
        className="scm-branch"
        aria-haspopup="dialog"
        aria-expanded={p.pickerOpen}
        title={v.detached ? 'Detached HEAD — check out a branch to commit on one' : `On ${branchLabel} — switch, create, merge or delete branches`}
        disabled={anyBusy || v.merging}
        onClick={p.onBranch}
      >
        <Icon name="git-branch" size={12} />
        <span className="scm-branch-name">{branchLabel}</span>
        <Icon name="chevron-down" size={10} />
      </button>

      {v.upstream ? (
        <span className="scm-track" title={`Tracking ${v.upstream}`}>
          {v.ahead > 0 && <span className="scm-track-ahead"><Icon name="arrow-up" size={10} />{v.ahead}</span>}
          {v.behind > 0 && <span className="scm-track-behind"><Icon name="arrow-down" size={10} />{v.behind}</span>}
          {v.ahead === 0 && v.behind === 0 && <span className="muted">up to date</span>}
        </span>
      ) : (
        <span className="scm-track muted" title={noRemote ? 'No remote is configured' : 'This branch has no upstream yet — Publish sets one'}>
          {v.initial ? '' : noRemote ? 'no remote' : v.detached ? '' : 'no upstream'}
        </span>
      )}

      <span className="spacer" />

      <button type="button" className="scm-icon-btn" aria-label="Refresh" title="Refresh (re-read git status)" disabled={p.busy === 'refresh'} onClick={p.onRefresh}>
        <Icon name="refresh" size={12} />
      </button>
      <button
        type="button"
        className="scm-icon-btn"
        aria-label="Fetch"
        title={noRemote ? 'Fetch — no remote configured' : `Fetch from ${p.remote.host} without changing your files`}
        disabled={anyBusy || noRemote}
        onClick={p.onFetch}
      >
        <Icon name="download" size={12} />
      </button>
      <button
        type="button"
        className="scm-icon-btn"
        aria-label="Pull"
        title={noRemote ? 'Pull — no remote configured' : !v.upstream ? 'Pull — this branch has no upstream yet' : v.merging ? 'Pull — finish the merge first' : `Pull ${v.behind ? `${v.behind} new commit${v.behind === 1 ? '' : 's'}` : 'the latest'} from ${p.remote.host}`}
        disabled={anyBusy || !canPull}
        onClick={p.onPull}
      >
        <Icon name="arrow-down" size={12} />
      </button>
      {publish ? (
        <button
          type="button"
          className="scm-icon-btn scm-icon-accent"
          aria-label="Publish branch"
          title={`Publish ${v.branch} to ${p.remote.host} (push -u)`}
          disabled={anyBusy}
          onClick={p.onPublish}
        >
          <Icon name="upload" size={12} />
        </button>
      ) : (
        <button
          type="button"
          className={`scm-icon-btn${v.ahead > 0 ? ' scm-icon-accent' : ''}`}
          aria-label="Push"
          title={noRemote ? 'Push — no remote configured. Use Connect… below or the ⋯ menu.' : v.detached ? 'Push — check out a branch first' : `Push ${v.ahead ? `${v.ahead} commit${v.ahead === 1 ? '' : 's'}` : ''} to ${p.remote.host}`}
          disabled={anyBusy || noRemote || v.detached}
          onClick={p.onPush}
        >
          <Icon name="arrow-up" size={12} />
        </button>
      )}
      <div className="scm-menu-wrap">
        <button
          type="button"
          className="scm-icon-btn"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={p.overflowOpen}
          title="More actions"
          onClick={p.onOverflow}
        >
          <Icon name="ellipsis" size={12} />
        </button>
        {p.children}
      </div>
    </div>
  )
}
