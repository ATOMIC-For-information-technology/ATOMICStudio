import React from 'react'
import { Icon } from '../Icon'
import { DiffLines } from '../DiffLines'
import type { GitDiffMode, GitFileDiff } from '../../../../shared/types'

interface Props {
  file: string
  mode: GitDiffMode
  loading: boolean
  diff: GitFileDiff | null
  onOpen: () => void
  onClose: () => void
}

const COMPARES: Record<GitDiffMode, string> = {
  staged: 'Index ↔ HEAD',
  unstaged: 'Working tree ↔ Index',
  untracked: 'New file',
  conflict: 'Conflict'
}

/**
 * The diff for one row, in the mode its list implies.
 *
 * The header names the comparison in words, because the whole point of the 2026-09-02 change is
 * that a staged row and an unstaged row of the same `MM` file show DIFFERENT things — and a
 * reader has to be able to tell which one they are looking at. Binary, oversized and conflicted
 * files each get a sentence instead of an empty box: an empty pane reads as a bug, not an answer.
 */
export function DiffView({ file, mode, loading, diff, onOpen, onClose }: Props): React.JSX.Element {
  const stats = diff && !diff.binary && mode !== 'conflict' && (
    <span className="diff-stats">
      <span className="add">+{diff.added}</span> <span className="del">−{diff.removed}</span>
    </span>
  )
  return (
    <div className="scm-detail" role="region" aria-label={`Diff of ${file}`}>
      <div className="scm-detail-head">
        <span className="scm-detail-file" title={file}>{file}</span>
        <span className="scm-detail-mode" title="What is being compared">{COMPARES[mode]}</span>
        {!loading && stats}
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onOpen} title="Open this file in the editor">
          <Icon name="external-link" size={11} /> Open
        </button>
        <button type="button" className="scm-icon-btn" onClick={onClose} aria-label="Close the diff" title="Close (Esc)">
          <Icon name="close" size={12} />
        </button>
      </div>
      <div className="scm-detail-body">
        {loading ? (
          <div className="muted small scm-detail-note">Reading the diff…</div>
        ) : !diff || diff.error ? (
          <div className="muted small scm-detail-note">{diff?.error ?? 'No diff available.'}</div>
        ) : mode === 'conflict' ? (
          <div className="small scm-detail-note">
            {diff.conflictHunks === 0
              ? 'No conflict markers left in this file — mark it resolved when you are happy with it.'
              : `${diff.conflictHunks} conflict ${diff.conflictHunks === 1 ? 'hunk' : 'hunks'} to resolve. Open the file: the editor shows both sides and lets you pick.`}
          </div>
        ) : diff.binary ? (
          <div className="muted small scm-detail-note">Binary file — nothing to show line by line.</div>
        ) : diff.lines.length === 0 ? (
          <div className="muted small scm-detail-note">
            {mode === 'untracked' ? 'This file is empty.' : mode === 'staged' ? 'The index matches HEAD for this file.' : 'The working tree matches the index for this file.'}
          </div>
        ) : (
          <>
            <DiffLines lines={diff.lines} className="diff-body scm-detail-lines" />
            {diff.truncated && (
              <div className="muted small scm-detail-note">Showing the first part only — the file is large. Open it in the editor for the rest.</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
