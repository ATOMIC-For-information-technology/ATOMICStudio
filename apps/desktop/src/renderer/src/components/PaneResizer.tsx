import React, { useCallback } from 'react'
import { useDragResize } from '../hooks/useDragResize'

interface Props {
  /** Current height of the pane below the divider, in px. */
  size: number
  onChange: (size: number) => void
  min: number
  max: number
  label: string
  /** Height to snap to on double-click. Defaults to 300, the panel's usual default. */
  defaultSize?: number
  /** CSS custom property the pane sizes itself from — lets a drag skip React entirely. */
  liveVar?: string
}

/**
 * The horizontal divider between the editor and the bottom panel — drag it to trade space between
 * them, the way every editor does. Dragging UP grows the panel, so the delta is inverted.
 *
 * See `useDragResize` for the resize lifecycle (pointer capture so the drag survives the pointer
 * crossing the preview's `<webview>`, Escape-to-cancel, pointercancel/blur cleanup).
 */
export function PaneResizer({ size, onChange, min, max, label, defaultSize, liveVar }: Props): React.JSX.Element {
  const toDelta = useCallback((_dx: number, dy: number) => -dy, [])
  const { dragging, onPointerDown } = useDragResize({
    value: size,
    onChange,
    min,
    max,
    toDelta,
    bodyClass: 'resizing-v',
    liveVar
  })
  const clamp = useCallback((h: number): number => Math.max(min, Math.min(max, Math.round(h))), [min, max])

  return (
    <div
      className={`pane-resizer ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(clamp(defaultSize ?? 300))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 60 : 20
        if (e.key === 'ArrowUp') onChange(clamp(size + step))
        else if (e.key === 'ArrowDown') onChange(clamp(size - step))
        else if (e.key === 'Home') onChange(min)
        else if (e.key === 'End') onChange(max)
        else return
        e.preventDefault()
      }}
    >
      <span className="resizer-grip resizer-grip-h" aria-hidden="true" />
    </div>
  )
}
