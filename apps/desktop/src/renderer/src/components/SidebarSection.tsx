import React from 'react'
import { Icon } from './Icon'

interface Props {
  /** Rendered uppercase by CSS; pass it in normal case so screen readers do not spell it out. */
  title: string
  open: boolean
  onToggle: () => void
  /** The badge on the right. Omitted (not zero) when a count would be meaningless. */
  count?: number
  /** Icon actions that belong to this section — VS Code reveals them on hover over the header. */
  actions?: React.ReactNode
  children: React.ReactNode
}

/**
 * The collapsible sidebar section — the twisty, uppercase label and count badge that organises
 * every VS Code side view, at its real 22px height.
 *
 * It is a real `<button>` carrying `aria-expanded`, because a `<div onClick>` masquerading as a
 * disclosure is precisely the Critical bug this codebase's last accessibility review found and
 * fixed; a new component is not a licence to reintroduce it. The caret rotates rather than swapping
 * between two glyphs — one concept, one mark.
 */
export function SidebarSection({ title, open, onToggle, count, actions, children }: Props): React.JSX.Element {
  const bodyId = `sb-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <>
      {/* The header row is a <div> only so the action buttons can live inside it without nesting a
          button in a button (invalid, and it makes the twisty unreachable by keyboard). The twisty
          itself is the real control and carries the whole label. */}
      <div className="sb-section-row">
        <button type="button" className="sb-section" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className="sb-section-caret">
            <Icon name="chevron-down" size={12} />
          </span>
          <span className="sb-section-label">{title}</span>
        </button>
        {actions && <span className="sb-section-actions">{actions}</span>}
        {count !== undefined && <span className="sb-section-count">{count}</span>}
      </div>
      {open && (
        <div className="sb-section-body" id={bodyId}>
          {children}
        </div>
      )}
    </>
  )
}
