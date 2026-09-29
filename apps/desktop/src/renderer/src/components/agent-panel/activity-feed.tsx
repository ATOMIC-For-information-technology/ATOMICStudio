import React from 'react'
import { Icon } from '../Icon'
import type { ActivityItem } from './types'
import { EmptyState } from './empty-state'

/**
 * Section 3a — Activity Feed. The "what has it achieved" lens: applied edits
 * and their verify outcomes read like commits landing, not like a log. The
 * Execution Timeline answers "what is it doing right now"; this answers
 * "what is now true" — same underlying facts, a different, calmer read.
 */
export function ActivityFeed({ items }: { items: ActivityItem[] }): React.JSX.Element {
  if (items.length === 0) {
    return <EmptyState icon="chart" text="Achievements will appear here as changes land." />
  }
  return (
    <div className="ap-activity">
      {items.map((it) => (
        <div key={it.id} className={`ap-activity-item ${it.ok ? 'ok' : 'error'}`}>
          <span className="ap-activity-icon"><Icon name={it.icon} size={13} /></span>
          <span className="ap-activity-text">{it.text}</span>
        </div>
      ))}
    </div>
  )
}
