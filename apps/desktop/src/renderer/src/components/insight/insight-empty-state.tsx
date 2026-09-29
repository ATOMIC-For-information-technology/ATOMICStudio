import React from 'react'
import { Icon } from '../Icon'
import type { IconName } from '../Icon'

interface Props {
  icon?: IconName
  /** What is not here — stated as a fact, never as a failure. */
  title: string
  /** Why, and what would change it. */
  detail?: string
  action?: { label: string; run: () => void }
}

/**
 * The state a section is in before it has anything to say.
 *
 * Deliberately NOT silence. The panel this replaces rendered nothing for "we never looked" and
 * nothing for "we looked and found none", so an unscanned project read as a clean one. Every empty
 * state here says which of the two it is, and offers the action that would answer the question.
 */
export function InsightEmpty({ icon = 'circle-dashed', title, detail, action }: Props): React.JSX.Element {
  return (
    <div className="iv-empty">
      <span className="iv-empty-icon" aria-hidden="true"><Icon name={icon} size={15} /></span>
      <div className="iv-empty-text">
        <div className="iv-empty-title">{title}</div>
        {detail && <div className="muted small">{detail}</div>}
      </div>
      {action && (
        <button type="button" className="btn btn-sm" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  )
}
