import React from 'react'
import { Icon } from '../Icon'

interface Props {
  id: string
  title: string
  /** Small right-aligned hint (e.g. a count) shown in the header row. */
  hint?: string
  collapsed: boolean
  onToggle: (id: string) => void
  /** Always-pinned sections (Mission, Build Status) render without a caret. */
  collapsible?: boolean
  /**
   * One line saying what this section is for. Shown on hover of the whole header and behind an
   * information mark, and read out to a screen reader — asked for on 2026-09-03 ("there is so many
   * options and modules in the Agent Section i cannot understand them"). The panel should teach
   * itself rather than needing a document beside it.
   */
  info?: string
  children: React.ReactNode
}

/**
 * A bordered-free, spacing-led section with a smooth expand/collapse body.
 * The collapsed state is owned by the parent (via use-collapsed) so it persists.
 */
export function CollapsibleSection({ id, title, hint, collapsed, onToggle, collapsible = true, info, children }: Props): React.JSX.Element {
  return (
    <section className="ap-section" data-section={id}>
      <button
        type="button"
        className={`ap-section-head ${collapsible ? '' : 'ap-section-head-static'}`}
        onClick={collapsible ? () => onToggle(id) : undefined}
        aria-expanded={collapsible ? !collapsed : undefined}
        tabIndex={collapsible ? 0 : -1}
        title={info}
      >
        {collapsible && (
          <span className={`ap-caret ${collapsed ? '' : 'open'}`}>
            <Icon name="chevron-right" size={11} />
          </span>
        )}
        <span className="ap-section-title">{title}</span>
        {/* A nested <button> inside this header button would be invalid markup, so the mark is a
            span: the hover explanation is the header's own title, and the same words reach a
            screen reader through the description below. */}
        {info && <span className="ap-section-info" aria-hidden="true">?</span>}
        {info && <span className="sr-only"> — {info}</span>}
        {hint && <span className="ap-section-hint">{hint}</span>}
      </button>
      <div className={`ap-section-body ${collapsed ? 'collapsed' : ''}`}>
        <div className="ap-section-inner">{children}</div>
      </div>
    </section>
  )
}