import React, { useId, useState } from 'react'
import { Icon } from '../Icon'

interface Props {
  title: string
  /** An extra class on the body — the X-ray cards keep the names the rest of the app knows them by. */
  bodyClass?: string
  /** What this section is for, one line. Also the header's tooltip. */
  info?: string
  /** A count or short fact, shown right-aligned in the header. */
  hint?: string
  /** Advanced analysis starts closed; the four default sections do not. */
  defaultOpen?: boolean
  children: React.ReactNode
}

/**
 * One collapsible block inside a destination.
 *
 * Used for progressive disclosure in Code Map, where the advanced analyses (drift, fragile files,
 * circular imports, unused files, ownership, cross-repo) are real but rarely the reason someone
 * opened the screen. They stay closed until asked for — which is also what keeps them from
 * rendering hundreds of rows nobody looked at.
 */
export function InsightSection({ title, info, hint, defaultOpen = false, bodyClass, children }: Props): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <section className="iv-section">
      <h3 className="iv-section-h">
        <button
          type="button"
          className="iv-section-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={id}
          title={info}
        >
          <span className={`iv-caret ${open ? 'open' : ''}`} aria-hidden="true">
            <Icon name="chevron-right" size={11} />
          </span>
          <span className="iv-section-title">{title}</span>
          {info && <span className="sr-only"> — {info}</span>}
          {hint && <span className="iv-section-hint">{hint}</span>}
        </button>
      </h3>
      {open && (
        <div className={`iv-section-body ${bodyClass ?? ''}`} id={id}>
          {children}
        </div>
      )}
    </section>
  )
}
