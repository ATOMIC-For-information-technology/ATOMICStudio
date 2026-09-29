import React from 'react'
import { Icon } from '../Icon'

interface Props {
  conflicts: number
  merging: boolean
  rebasing: boolean
  busy: boolean
  onAbort: () => void
  onContinue: () => void
}

/**
 * The merge attention strip. The conflicted files themselves are rows in the list's
 * "Merge Conflicts" section, so this strip only says what is going on and offers the two
 * merge-level verbs.
 *
 * Deliberately NOT styled as an error. A merge that stops on a conflict is the normal path, not
 * a failure — git did exactly what it should. A red "merge failed" banner at the moment the user
 * needs to start working teaches them to fear merging. Tint + full-strength foreground per
 * DESIGN.md; never a solid status fill.
 */
export function ConflictBanner({ conflicts, merging, rebasing, busy, onAbort, onContinue }: Props): React.JSX.Element | null {
  if (!merging && !rebasing && conflicts === 0) return null
  const n = conflicts
  const what = rebasing ? 'Rebase in progress' : n === 0 ? 'Merge in progress' : `${n} file${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} your attention`
  return (
    <div className="scm-strip scm-strip-warn" role="status">
      <Icon name="alert" size={12} />
      <strong>{what}</strong>
      {n > 0 && <span className="muted">— open each file and pick which version to keep.</span>}
      <span className="spacer" />
      {rebasing ? (
        <span className="muted">Finish or abort it in the terminal.</span>
      ) : (
        <>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onAbort} title="Throw the whole merge away and go back">
            Abort merge
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || n > 0} onClick={onContinue} title={n > 0 ? 'Resolve every file first' : 'Finish the merge'}>
            Finish merge
          </button>
        </>
      )}
    </div>
  )
}
