import React, { useEffect, useMemo, useRef, useState } from 'react'

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  run: () => void
}

interface Props {
  actions: PaletteAction[]
  onClose: () => void
}

/**
 * ⌘⇧P command palette — every Studio action, one keystroke away, with plain
 * fuzzy filtering (word-prefix matching keeps it predictable for non-coders).
 */
export function CommandPalette({ actions, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => restoreTo.current?.focus?.()
  }, [])

  /* The list scrolls; the highlight didn't. Past the ~12th match the selection walked off the
     bottom and the palette looked frozen — and this is the only keyboard route to a file. */
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [index, query])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter((a) => a.label.toLowerCase().includes(q))
  }, [actions, query])

  useEffect(() => setIndex(0), [query])

  const runAt = (i: number): void => {
    const a = shown[i]
    if (!a) return
    onClose()
    a.run()
  }

  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        /* The field is the only focusable thing in here, so trapping Tab just means keeping it —
           otherwise Tab walks out of an open palette and into the IDE behind it. */
        onKeyDown={(e) => {
          if (e.key === 'Tab') e.preventDefault()
        }}
      >
        {/* The combobox pattern: focus stays in the field while ↑/↓ move a highlight in the list
            below, and aria-activedescendant is what tells a screen reader which row that is. */}
        <input
          ref={inputRef}
          className="text-input palette-input"
          placeholder="Type a command…  (Esc to close)"
          value={query}
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls="palette-list"
          aria-activedescendant={shown[index] ? `palette-item-${shown[index].id}` : undefined}
          aria-autocomplete="list"
          aria-label="Type a command"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, shown.length - 1))
            else if (e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0))
            else if (e.key === 'Enter') runAt(index)
          }}
        />
        <div className="palette-list" id="palette-list" role="listbox" aria-label="Commands" ref={listRef}>
          {shown.length === 0 && <div className="muted small palette-empty">No matching command.</div>}
          {shown.map((a, i) => (
            <div
              key={a.id}
              id={`palette-item-${a.id}`}
              role="option"
              aria-selected={i === index}
              className={`palette-item ${i === index ? 'active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => runAt(i)}
            >
              <span className="palette-label">{a.label}</span>
              {a.hint && <span className="palette-hint">{a.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
