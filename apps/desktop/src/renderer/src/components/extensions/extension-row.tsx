import React from 'react'
import { Icon } from '../Icon'
import type { ExtItem } from './types'

interface Props {
  item: ExtItem
  selected: boolean
  onSelect: () => void
  /** The row's one primary action. Absent for rows whose only action is the toggle. */
  action?: { label: string; onRun: () => void; danger?: boolean; disabled?: boolean }
}

/**
 * One extension row — VS Code's exact anatomy: a square icon tile, then name and version on the
 * first line, description on the second, publisher and state on the third, with the action button
 * appearing on hover or when the row is selected.
 *
 * The icon tile carries two derived letters rather than artwork. That is deliberate and it is the
 * honest option: no extension in this product ships an icon, and a generic puzzle glyph repeated
 * forty times down a list is worse than nothing — it looks like a placeholder because it is one.
 * Initials at least distinguish two rows at a glance.
 */
/**
 * A theme's tile is painted in that theme's own canvas and accent. It is the one row kind that can
 * honestly show you what it is before you click it, and generating it from the tokens means an
 * imported theme has a correct tile the moment it lands.
 */
export function tileStyle(item: ExtItem): React.CSSProperties | undefined {
  if (item.kind !== 'theme' || !item.theme) return undefined
  const t = item.theme.tokens
  return { background: t.bg, color: t.accent, borderColor: t.border }
}

export function ExtensionRow({ item, selected, onSelect, action }: Props): React.JSX.Element {
  return (
    <div
      className={`ext-row ${selected ? 'selected' : ''}`}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <span className={`ext-tile ext-tile-${item.kind}`} style={tileStyle(item)} aria-hidden="true">
        {item.initials}
      </span>
      <div className="ext-body">
        <div className="ext-line1">
          <span className="ext-name" title={item.name}>
            {item.name}
          </span>
          {item.version && <span className="ext-version">{item.version}</span>}
        </div>
        <div className="ext-desc" title={item.description}>
          {item.description || 'No description provided.'}
        </div>
        <div className="ext-line3">
          <span className="ext-publisher" title={item.publisher}>
            {item.publisher}
          </span>
          {item.state && <span className={`ext-state ext-state-${item.tone ?? 'neutral'}`}>{item.state}</span>}
          {item.toggle ? (
            item.toggle.core ? (
              <span className="ext-core-mark" title="Core module — always on">
                <Icon name="lock" size={10} /> core
              </span>
            ) : (
              <button
                type="button"
                className={`btn btn-sm ext-action ${item.toggle.on ? '' : 'btn-primary'}`}
                onClick={(e) => {
                  e.stopPropagation()
                  item.toggle!.set(!item.toggle!.on)
                }}
              >
                {item.toggle.on ? 'Disable' : 'Enable'}
              </button>
            )
          ) : action ? (
            <button
              type="button"
              className={`btn btn-sm ext-action ${action.danger ? 'btn-danger-ghost' : 'btn-primary'}`}
              disabled={action.disabled || item.busy}
              onClick={(e) => {
                e.stopPropagation()
                action.onRun()
              }}
            >
              {item.busy ? '…' : action.label}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
