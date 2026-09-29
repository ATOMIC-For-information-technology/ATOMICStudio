import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { windowRange } from './derive'

interface Props<T extends { key: string }> {
  items: readonly T[]
  rowHeight: number
  overscan?: number
  /** The item that owns keyboard focus. When it changes it is scrolled into view and DOM-focused. */
  focusKey: string | null
  renderItem: (item: T, index: number) => React.ReactNode
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  /** The container itself was tabbed into with no row focused — the parent picks one. */
  onEnter?: () => void
  /** Development instrumentation: how many rows are mounted right now. */
  onMounted?: (count: number) => void
  ariaLabel: string
  className?: string
  /**
   * The container's ARIA role. A Source Control list is a `listbox`; the Explorer is a `tree`,
   * whose rows are `treeitem`s with `aria-level`/`aria-expanded`. Both are one-Tab-stop lists
   * with roving focus, so they share the widget and differ only in what they announce.
   */
  role?: 'listbox' | 'tree'
}

/**
 * A fixed-row-height windowed list. ~30 DOM rows for a 1,000-file tree.
 *
 * Deliberately not a dependency: every item here is exactly one 22px row (see `buildItems`), so
 * the whole problem is one multiplication, and a virtualisation library's measuring machinery
 * would be dead weight plus a bundle. `windowRange` does the arithmetic and is unit-tested.
 *
 * Focus model: the container is the tab stop; rows are focused programmatically by key. That is
 * what keeps keyboard focus on a row that scrolls out of the mounted window — the key survives,
 * the DOM node comes back when the row scrolls back in, and the next arrow press still works
 * because the handler lives on the container, not the row.
 */
export function WindowedList<T extends { key: string }>({
  items, rowHeight, overscan = 8, focusKey, renderItem, onKeyDown, onEnter, onMounted, ariaLabel, className, role = 'listbox'
}: Props<T>): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)
  const raf = useRef<number | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback(() => {
    if (raf.current !== null) return
    raf.current = requestAnimationFrame(() => {
      raf.current = null
      if (ref.current) setScrollTop(ref.current.scrollTop)
    })
  }, [])
  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current) }, [])

  const range = windowRange(scrollTop, height, rowHeight, items.length, overscan)

  /**
   * Bring the focused row on screen when focus MOVES — and only then.
   *
   * `items` is deliberately not a trigger. It changes whenever the list behind this one changes:
   * a folder finishing its lazy read, a file watcher tick, a git refresh. Scrolling on those meant
   * that scrolling away from the focused row and then having anything at all refresh underneath
   * you snapped the list straight back to that row — in a 2,000-file folder, back to the top.
   * (Found by the UI suite on 2026-09-02, which scrolled to the end and read `scrollTop` back as
   * 0 whenever the watcher happened to fire inside its window.) Following focus is what the user
   * asked for by pressing an arrow key; following it forever is not.
   */
  const scrolledTo = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || focusKey === null) return
    if (scrolledTo.current === focusKey) return
    const index = items.findIndex((it) => it.key === focusKey)
    // Not projected yet (the folder is still loading): leave the marker alone so the scroll still
    // happens on the render where the row finally exists.
    if (index < 0) return
    scrolledTo.current = focusKey
    const top = index * rowHeight
    const viewH = el.clientHeight
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + rowHeight > el.scrollTop + viewH) el.scrollTop = top + rowHeight - viewH
    setScrollTop(el.scrollTop)
  }, [focusKey, items, rowHeight])

  /**
   * Whether keyboard focus was inside the list at the last render. Read from
   * `document.activeElement`, NOT from focus events: Chromium does not dispatch focus/focusin
   * while the window itself is not the OS-focused window, so React's `onFocus` never fires there
   * although `element.focus()` still moves `activeElement` and key events still arrive. A flag
   * set from events looked right in a focused window and silently broke keyboard navigation in
   * an unfocused one (found by the UI suite on 2026-09-02, flaking with whatever the developer
   * was clicking on at the time).
   */
  const owned = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const active = document.activeElement
    if (el.contains(active)) {
      owned.current = true
      // Only steal focus when the list already owns it: a refresh must not yank the caret out of
      // the commit message because a row it had focused earlier changed identity.
      if (focusKey === null) return
      const row = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)
      // `!row.contains(active)`, NOT `active !== row`: a row can hold an inline editor (the
      // Explorer's F2 rename input lives inside the row it renames). With the identity test this
      // effect yanked focus from that input on the very render that mounted it — the input's
      // `onBlur` then committed and unmounted it, so F2 looked like it did nothing at all, and
      // intermittently worked depending on render order (found 2026-09-02).
      if (row && !row.contains(active)) row.focus({ preventScroll: true })
      return
    }
    if (!owned.current) return
    // Focus fell out of the list because its row went away (it was just staged and moved to the
    // other section, or scrolled out of the mounted window). Put it back on the container — or
    // the row, if it is mounted — but never if the user moved it somewhere real on purpose.
    if (active === document.body || active === null) {
      const row = focusKey === null ? null : el.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)
      ;(row ?? el).focus({ preventScroll: true })
    } else owned.current = false
  })

  useEffect(() => {
    onMounted?.(range.end - range.start)
  }, [range.start, range.end, onMounted])

  const slice: React.ReactNode[] = []
  for (let i = range.start; i < range.end; i++) slice.push(renderItem(items[i], i))

  return (
    <div
      ref={ref}
      className={className ?? 'scm-list'}
      role={role}
      aria-label={ariaLabel}
      aria-multiselectable={role === 'listbox' ? 'true' : undefined}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onEnter?.()
      }}
    >
      <div style={{ height: range.padTop }} aria-hidden="true" />
      {slice}
      <div style={{ height: range.padBottom }} aria-hidden="true" />
    </div>
  )
}
