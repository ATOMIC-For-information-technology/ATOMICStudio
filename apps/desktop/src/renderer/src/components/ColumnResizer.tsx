import React, { useCallback } from 'react'
import { useDragResize } from '../hooks/useDragResize'

interface Props {
  /** Current width of the column being resized, in px. */
  width: number
  onChange: (width: number) => void
  min: number
  max: number
  /** 'left' grows with the pointer, 'right' grows against it (the dock on the far side). */
  side: 'left' | 'right'
  label: string
  /** Width to snap to on double-click. Defaults to the side's usual default (300 left, 360 right). */
  defaultWidth?: number
  /** CSS custom property the column sizes itself from — lets a drag skip React entirely. */
  liveVar?: string
}

/**
 * The drag handle between two columns — see `useDragResize` for the resize lifecycle itself
 * (pointer capture, Escape-to-cancel, cleanup). This component is just the visible handle: a real
 * separator for the keyboard (←/→ nudge, Home/End jump to the limits), a wider invisible hit area
 * than its 1px seam, and a double-click reset to the default width.
 */
export function ColumnResizer({ width, onChange, min, max, side, label, defaultWidth, liveVar }: Props): React.JSX.Element {
  const toDelta = useCallback((dx: number) => (side === 'left' ? dx : -dx), [side])
  const { dragging, onPointerDown } = useDragResize({
    value: width,
    onChange,
    min,
    max,
    toDelta,
    bodyClass: 'resizing',
    liveVar
  })
  const clamp = useCallback((w: number): number => Math.max(min, Math.min(max, Math.round(w))), [min, max])

  return (
    <div
      className={`col-resizer ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(clamp(defaultWidth ?? (side === 'left' ? 300 : 360)))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 16
        if (e.key === 'ArrowLeft') onChange(clamp(width + (side === 'left' ? -step : step)))
        else if (e.key === 'ArrowRight') onChange(clamp(width + (side === 'left' ? step : -step)))
        else if (e.key === 'Home') onChange(min)
        else if (e.key === 'End') onChange(max)
        else return
        e.preventDefault()
      }}
    >
      <span className="resizer-grip" aria-hidden="true" />
    </div>
  )
}
