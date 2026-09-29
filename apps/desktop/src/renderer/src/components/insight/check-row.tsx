import React from 'react'
import { Icon } from '../Icon'
import type { IconName } from '../Icon'
import type { CheckView } from './types'

/**
 * One row of the project review.
 *
 * The six states are the point of this component. `not-run` carries a dashed circle and the words
 * "Not checked" — never a green tick, never silence — because the panel this replaces showed an
 * unscanned check and a passing check identically, and a project that had never been reviewed read
 * as a clean one. Colour is never the only carrier: every state says itself in words.
 */
const MARK: Record<CheckView['phase'], { icon: IconName; cls: string }> = {
  'not-run': { icon: 'circle-dashed', cls: 'iv-check-idle' },
  loading: { icon: 'dot', cls: 'iv-check-busy' },
  ok: { icon: 'check', cls: 'iv-check-ok' },
  partial: { icon: 'alert', cls: 'iv-check-partial' },
  error: { icon: 'ban', cls: 'iv-check-error' }
}

export function CheckRow({
  check,
  onRun,
  children
}: {
  check: CheckView
  onRun: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  // A check that found something is "needs attention", which is a WARNING state, not a pass —
  // the phase alone cannot say that, because the scan itself succeeded.
  const attention = check.findings !== null && check.findings > 0 && (check.phase === 'ok' || check.phase === 'partial')
  const mark = attention ? { icon: 'alert' as IconName, cls: 'iv-check-warn' } : MARK[check.phase]
  return (
    <div className={`iv-check ${mark.cls}`}>
      <div className="iv-check-head">
        <span className="iv-check-mark" aria-hidden="true"><Icon name={mark.icon} size={13} /></span>
        <span className="iv-check-name">{check.label}</span>
        <span className="iv-check-status">{check.status}</span>
        {check.stale && <span className="iv-tag" title="The project changed after this ran">stale</span>}
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onRun} disabled={check.phase === 'loading'}>
          {check.phase === 'not-run' ? 'Run' : 'Run again'}
        </button>
      </div>
      <div className="iv-check-scope muted small">{check.scope}</div>
      {check.caveat && <div className="iv-caveat muted small"><Icon name="alert" size={10} /> {check.caveat}</div>}
      {check.error && <div className="iv-caveat iv-caveat-error small">Could not run: {check.error}</div>}
      {children && <div className="iv-check-body">{children}</div>}
    </div>
  )
}
