import React from 'react'
import { Icon, type IconName } from '../Icon'

/** Gentle placeholder for sections that have nothing to show yet. */
export function EmptyState({ icon = 'circle-dashed', text }: { icon?: IconName; text: string }): React.JSX.Element {
  return (
    <div className="ap-empty">
      <span className="ap-empty-icon">
        <Icon name={icon} size={14} />
      </span>
      <span className="ap-empty-text">{text}</span>
    </div>
  )
}
