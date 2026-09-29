import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../Icon'
import type { TimelineStep } from './types'
import { TimelineItem } from './timeline-item'
import { EmptyState } from './empty-state'

/** Steps beyond this many (newest kept) fold behind an "N earlier steps" row. */
const FOLD_AFTER = 12

/**
 * Section 2 — Live Execution Timeline. Replaces the old repetitive task cards:
 * every tool the agent runs becomes a vertical timeline item, newest at the
 * bottom, auto-scrolling while running. Each item expands for detail. Once a
 * run runs long, everything older than the newest 12 steps folds behind a
 * single toggle so the timeline never turns into an unbounded scroll.
 */
export function ExecutionTimeline({
  steps,
  busy,
  startedAt
}: {
  steps: TimelineStep[]
  busy: boolean
  startedAt?: number | null
}): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)
  const [showOlder, setShowOlder] = useState(false)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [steps.length, busy])

  if (steps.length === 0) {
    // The clock, not the compass — Active Context's empty state already uses the compass, and both sections
    // are empty (and therefore both visible) at the start of every session.
    return <EmptyState icon="clock" text="Execution steps will appear here as the agent works." />
  }

  const older = steps.length > FOLD_AFTER ? steps.slice(0, steps.length - FOLD_AFTER) : []
  const recent = steps.length > FOLD_AFTER ? steps.slice(steps.length - FOLD_AFTER) : steps

  return (
    <div className="ap-timeline">
      <div className="ap-timeline-rail" />
      {older.length > 0 && (
        <button type="button" className="ap-tl-fold" onClick={() => setShowOlder((o) => !o)}>
          <span className={`ap-tl-caret ${showOlder ? 'open' : ''}`}><Icon name="chevron-right" size={11} /></span>
          {showOlder ? `Hide ${older.length} earlier steps` : `${older.length} earlier steps`}
        </button>
      )}
      {showOlder && older.map((s) => <TimelineItem key={s.id} step={s} startedAt={startedAt ?? null} />)}
      {recent.map((s) => (
        <TimelineItem key={s.id} step={s} startedAt={startedAt ?? null} />
      ))}
      <div ref={endRef} />
    </div>
  )
}