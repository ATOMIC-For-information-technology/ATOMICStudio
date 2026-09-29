import React from 'react'

/** Shimmering placeholder lines shown while content streams in. */
export function LoadingSkeleton({ lines = 3 }: { lines?: number }): React.JSX.Element {
  return (
    <div className="ap-skeleton">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="ap-skeleton-line" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  )
}