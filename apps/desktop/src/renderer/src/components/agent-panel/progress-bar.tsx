import React from 'react'

interface Props {
  /** 0..1 */
  value: number
  /** When true, shows an indeterminate shimmer (unknown total). */
  indeterminate?: boolean
}

/** Animated, softly-glowing progress bar. Purely presentational. */
export function ProgressBar({ value, indeterminate }: Props): React.JSX.Element {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    /* No aria-valuenow while indeterminate: the whole point of that state is that the total isn't
       known yet, and reporting 0% would be a number the app can't stand behind. */
    <div
      className={`ap-progress ${indeterminate ? 'indeterminate' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      aria-valuetext={indeterminate ? 'Working — time remaining unknown' : undefined}
    >
      <div className="ap-progress-fill" style={indeterminate ? undefined : { transform: `scaleX(${pct / 100})` }} />
    </div>
  )
}