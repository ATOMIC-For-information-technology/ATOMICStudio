import React, { useEffect, useRef, useState } from 'react'
import { FileIcon } from './FileIcon'
import { Icon, type IconName } from './Icon'
import type { IndexHit } from '../../../shared/types'

interface Props {
  projectPath: string
  onOpen: (relPath: string, line?: number) => void
  onClose: () => void
}

/**
 * ⌘P Search Everywhere — files, functions/classes/components, and imports,
 * served from the background AI project index (instant, no disk scan).
 */
export function QuickOpen({ projectPath, onOpen, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<IndexHit[]>([])
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => restoreTo.current?.focus?.()
  }, [])

  /* Keep the highlighted hit visible — the list scrolls, so arrowing down used to lose it. */
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [index, hits])

  useEffect(() => {
    const mine = ++seq.current
    if (!query.trim()) {
      setHits([])
      return
    }
    void window.studio.indexSearch(projectPath, query).then((h) => {
      if (seq.current === mine) {
        setHits(h)
        setIndex(0)
      }
    })
  }, [query, projectPath])

  const openAt = (i: number): void => {
    const h = hits[i]
    if (!h) return
    const line = h.kind === 'symbol' ? parseInt(h.detail.match(/line (\d+)/)?.[1] ?? '', 10) || undefined : undefined
    onClose()
    onOpen(h.path, line)
  }

  const icon = (k: IndexHit['kind']): IconName => (k === 'file' ? 'file-text' : k === 'symbol' ? 'braces' : 'arrow-enter')

  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose}>
      <div
        className="palette quickopen"
        role="dialog"
        aria-modal="true"
        aria-label="Search everywhere"
        onClick={(e) => e.stopPropagation()}
        /* Same as the command palette: one focusable field, so Tab stays inside it. */
        onKeyDown={(e) => {
          if (e.key === 'Tab') e.preventDefault()
        }}
      >
        <input
          ref={inputRef}
          className="text-input palette-input"
          placeholder="Search files, functions, imports…  (Esc to close)"
          value={query}
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="quickopen-list"
          aria-activedescendant={hits[index] ? `quickopen-item-${index}` : undefined}
          aria-autocomplete="list"
          aria-label="Search files, functions and imports"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, hits.length - 1))
            else if (e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0))
            else if (e.key === 'Enter') openAt(index)
          }}
        />
        <div className="palette-list" id="quickopen-list" role="listbox" aria-label="Search results" ref={listRef}>
          {query.trim() && hits.length === 0 && <div className="muted small palette-empty">Nothing matched.</div>}
          {!query.trim() && <div className="muted small palette-empty">Everything in your project is indexed — start typing.</div>}
          {hits.map((h, i) => (
            <div
              key={`${h.kind}:${h.path}:${h.detail}`}
              id={`quickopen-item-${i}`}
              role="option"
              aria-selected={i === index}
              className={`palette-item ${i === index ? 'active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => openAt(i)}
            >
              {/* A FILE hit shows the file-icon theme's glyph, the same one the Explorer and the
                  tab strip draw. A symbol or import hit is not a file, so it keeps the product
                  mark — the two icon systems stay separate even inside one list. */}
              {h.kind === 'file' ? (
                <FileIcon name={h.path.slice(h.path.lastIndexOf('/') + 1)} className="qo-icon" />
              ) : (
                <span className="qo-icon" aria-hidden="true"><Icon name={icon(h.kind)} size={13} /></span>
              )}
              <span className="palette-label">{h.detail}</span>
              <span className="palette-hint">{h.path}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
