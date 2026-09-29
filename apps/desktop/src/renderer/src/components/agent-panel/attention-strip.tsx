import React from 'react'
import { Icon } from '../Icon'
import type { AttentionItem } from './types'

interface Props {
  items: AttentionItem[]
  /** Scrolls the Diff section into view (expanding it first if collapsed). */
  onReview: () => void
}

/**
 * The attention strip — one amber line per thing that needs the user's eyes
 * (staged approvals, held secrets, blocked commands, failed checks), pinned
 * under the hero. Renders NOTHING when the list is empty: zero footprint.
 */
export function AttentionStrip({ items, onReview }: Props): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="ap-attention">
      {items.map((it) => (
        <div key={it.kind} className={`ap-attention-item ap-attention-${it.kind}`}>
          <span className="ap-attention-icon"><Icon name={it.icon} size={13} /></span>
          <span className="ap-attention-text">{it.text}</span>
          <button type="button" className="ap-attention-action" onClick={onReview}>
            Review
          </button>
        </div>
      ))}
    </div>
  )
}
