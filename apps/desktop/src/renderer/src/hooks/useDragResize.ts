import { useCallback, useEffect, useRef, useState } from 'react'

interface Options {
  /** Current size (px) of the thing being resized. */
  value: number
  onChange: (next: number) => void
  min: number
  max: number
  /** Pointer movement since drag start (dx, dy) → a size delta. Lets one hook serve a column
   *  (dx, optionally inverted) and a row (dy, inverted) resizer alike. */
  toDelta: (dx: number, dy: number) => number
  /** Extra class toggled on <body> while dragging (e.g. to force a cursor + kill text selection). */
  bodyClass: string
  /**
   * A CSS custom property (e.g. `--left-w`) that the resized element sizes itself from.
   *
   * When set, a drag stops going through React entirely: each `pointermove` writes the new size
   * straight onto the document element and the browser re-lays-out that column alone. `onChange`
   * fires once, on release.
   *
   * This is the difference between a smooth divider and a stuttering one. Calling `onChange` per
   * move meant every pointer sample re-rendered App's ~1,470-line JSX return *and* fired a
   * synchronous `localStorage.setItem` — 60-120 blocking disk writes a second while the user drags.
   */
  liveVar?: string
}

/**
 * One resize lifecycle for every draggable divider in the workspace (left/right sidebar, bottom
 * panel). Fixes the class of bug where a drag "gets stuck": the preview column renders an Electron
 * `<webview>`, which is an out-of-process guest view — a plain `mousemove`/`mouseup` listener on
 * `window` never sees an event whose target was inside it, so releasing the mouse over the preview
 * left the divider following the pointer forever with no way to let go.
 *
 * `setPointerCapture` fixes this at the root: once a pointer is captured, the browser routes every
 * further event for that pointer to the capturing element regardless of what's under it — including
 * over a `<webview>` — instead of hit-testing find where to fire it.
 *
 * The lifecycle: pointerdown → capture + record the starting size → pointermove updates it →
 * pointerup ends the drag as-is. pointercancel, window blur, and Escape all end it too; Escape
 * specifically rewinds to the size the drag started at, the way every other cancel gesture in this
 * app works. Listeners exist only while a drag is in flight (they're added/removed with `dragging`),
 * so there's never a stale one left attached after a divider unmounts mid-drag.
 */
export function useDragResize({ value, onChange, min, max, toDelta, bodyClass, liveVar }: Options): {
  dragging: boolean
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
} {
  const start = useRef<{ x: number; y: number; v: number; pointerId: number; el: HTMLElement } | null>(null)
  const [dragging, setDragging] = useState(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  /** Last size written to `liveVar` this drag — what gets committed to React state on release. */
  const live = useRef<number | null>(null)

  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, Math.round(v))), [min, max])

  const end = useCallback(
    (restoreToStart: boolean) => {
      const s = start.current
      if (!s) return
      try {
        if (s.el.hasPointerCapture(s.pointerId)) s.el.releasePointerCapture(s.pointerId)
      } catch {
        /* element may already be gone */
      }
      if (restoreToStart) {
        // Escape/cancel rewinds to the starting size. Paint it back immediately as well as telling
        // React, or the column would sit at the dragged size until the re-render lands.
        if (liveVar) document.documentElement.style.setProperty(liveVar, `${s.v}px`)
        onChangeRef.current(s.v)
      } else if (liveVar && live.current !== null && live.current !== s.v) {
        // The one state update of the whole gesture: commit where the drag actually finished, so it
        // persists and every consumer (aria-valuenow, localStorage) catches up in a single render.
        onChangeRef.current(live.current)
      }
      live.current = null
      start.current = null
      setDragging(false)
    },
    [liveVar]
  )

  useEffect(() => {
    if (!dragging) return

    const onMove = (e: PointerEvent): void => {
      const s = start.current
      if (!s || e.pointerId !== s.pointerId) return
      const next = clamp(s.v + toDelta(e.clientX - s.x, e.clientY - s.y))
      if (liveVar) {
        // Straight to the DOM: no setState, no re-render, no localStorage write. The browser
        // re-lays-out the one column whose width changed and nothing else moves.
        live.current = next
        document.documentElement.style.setProperty(liveVar, `${next}px`)
      } else {
        onChangeRef.current(next)
      }
    }
    const onUp = (e: PointerEvent): void => {
      if (start.current && e.pointerId === start.current.pointerId) end(false)
    }
    const onCancel = (e: PointerEvent): void => {
      if (start.current && e.pointerId === start.current.pointerId) end(true)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') end(true)
    }
    // A drag that leaves the window (dragged past the edge, Cmd-Tab mid-drag) has no pointerup to
    // catch it — the app loses focus instead. Treat that as a release, not a cancel: the pointer
    // didn't move back, so there's nothing to rewind.
    const onBlur = (): void => end(false)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    document.body.classList.add(bodyClass)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
      document.body.classList.remove(bodyClass)
    }
  }, [dragging, clamp, toDelta, end, bodyClass, liveVar])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Only the primary button/touch/pen starts a drag — a right-click on the divider shouldn't.
      if (e.button !== 0) return
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      start.current = { x: e.clientX, y: e.clientY, v: value, pointerId: e.pointerId, el }
      setDragging(true)
    },
    [value]
  )

  return { dragging, onPointerDown }
}
