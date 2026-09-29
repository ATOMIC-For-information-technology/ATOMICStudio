import React from 'react'
import { Icon } from '../Icon'
import type { InsightDest } from './types'

interface Props {
  projectName: string
  /** When anything on screen was last computed — null before the first result lands. */
  lastAt: number | null
  busy: boolean
  dest: InsightDest
  /** Builder Mode ships Overview and Review only; the engineering half is Developer Mode. */
  destinations: { id: InsightDest; label: string }[]
  onDest: (d: InsightDest) => void
  onRefresh: () => void
  onClose: () => void
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

/**
 * The view's fixed chrome: what this is, which project it is about, when it last looked, and the
 * four destinations.
 *
 * The tab strip is a real `tablist` with roving focus — ←/→ walk it, Home/End jump — matching the
 * bottom panel's strip and the editor's, so one keyboard rule covers every tab bar in the app.
 */
export function InsightHeader({ projectName, lastAt, busy, dest, destinations, onDest, onRefresh, onClose }: Props): React.JSX.Element {
  const move = (e: React.KeyboardEvent, i: number): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const to =
      e.key === 'Home' ? 0
        : e.key === 'End' ? destinations.length - 1
          : (i + (e.key === 'ArrowRight' ? 1 : -1) + destinations.length) % destinations.length
    onDest(destinations[to].id)
    document.getElementById(`iv-tab-${destinations[to].id}`)?.focus()
  }

  return (
    <header className="iv-head">
      <div className="iv-head-top">
        <h2 className="iv-title">
          <Icon name="compass" size={15} /> Insight
        </h2>
        <span className="iv-project" title={projectName}>{projectName}</span>
        <span className="spacer" />
        <span className="iv-when muted small" aria-live="polite">
          {busy ? 'Analysing…' : lastAt ? `Last analysed ${ago(lastAt)}` : 'Not analysed yet'}
        </span>
        <button type="button" className="iv-icon-btn" onClick={onRefresh} disabled={busy} title="Re-read this project" aria-label="Refresh Insight">
          <Icon name="refresh" size={13} />
        </button>
        <button type="button" className="iv-icon-btn" onClick={onClose} title="Close Insight" aria-label="Close Insight">
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="iv-tabs" role="tablist" aria-label="Insight views">
        {destinations.map((d, i) => (
          <button
            key={d.id}
            id={`iv-tab-${d.id}`}
            role="tab"
            type="button"
            aria-selected={dest === d.id}
            aria-controls="iv-panel"
            tabIndex={dest === d.id ? 0 : -1}
            className={`iv-tab ${dest === d.id ? 'active' : ''}`}
            onClick={() => onDest(d.id)}
            onKeyDown={(e) => move(e, i)}
          >
            {d.label}
          </button>
        ))}
      </div>
    </header>
  )
}
