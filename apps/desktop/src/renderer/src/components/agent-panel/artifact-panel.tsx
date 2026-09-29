import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../Icon'
import type { Artifact } from './types'
import { ArtifactCard } from './artifact-card'
import { EmptyState } from './empty-state'

/**
 * Section 4 — Artifacts. A grid of compact reusable cards. Clicking one slides
 * in a side sheet showing the full body, keeping the chat stream clean.
 */
export function ArtifactPanel({ artifacts }: { artifacts: Artifact[] }): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)
  const open = artifacts.find((a) => a.id === openId) ?? null
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  // Modal basics the sheet was missing: move focus in on open (and back to
  // the panel on close), and let Escape close it — the overlay click alone
  // isn't reachable from the keyboard.
  useEffect(() => {
    if (!open) return
    closeBtnRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="ap-artifacts-wrap">
      {artifacts.length === 0 ? (
        <EmptyState icon="archive" text="Reports and plans the agent produces will appear here as cards." />
      ) : (
        <div className="ap-artifacts">
          {artifacts.map((a) => (
            <ArtifactCard key={a.id} artifact={a} onOpen={(x) => setOpenId(x.id)} />
          ))}
        </div>
      )}

      {open && (
        <div className="ap-sheet-overlay" onClick={() => setOpenId(null)}>
          <aside
            className="ap-sheet"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={open.title}
          >
            <div className="ap-sheet-head">
              <span className="ap-sheet-icon"><Icon name={open.icon} size={16} /></span>
              <span className="ap-sheet-title">{open.title}</span>
              {/* The close mark, not the failure mark — they were × and ✕, one keystroke apart. */}
              <button ref={closeBtnRef} type="button" className="ap-icon-btn" onClick={() => setOpenId(null)} title="Close" aria-label="Close"><Icon name="close" size={14} /></button>
            </div>
            <div className="ap-sheet-body">
              {open.image && (
                /* The screenshot IS the evidence, so it leads. alt says what it is rather than
                   describing pixels nobody can verify. */
                <img className="ap-sheet-shot" src={open.image} alt="The preview after the agent used the app" />
              )}
              <pre className="ap-sheet-pre">{open.body}</pre>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}