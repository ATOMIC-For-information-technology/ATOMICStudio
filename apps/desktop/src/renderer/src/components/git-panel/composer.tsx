import React, { useState } from 'react'
import { Icon } from '../Icon'
import { Menu } from './menu'
import type { MenuEntry } from './menu'

interface Props {
  value: string
  onChange: (v: string) => void
  branch: string
  stagedCount: number
  /** Staged rows outside the opened folder — a commit from here includes them. */
  outsideStaged: number
  /** Why Commit is disabled, in words, or null when it is enabled. */
  blocker: string | null
  busy: string | null
  onCommit: () => void
  menu: MenuEntry[]
  onMenu: (id: string) => void
}

/**
 * The commit composer — pinned above the change list, never below it.
 *
 * Its old position, under both file lists, put it below the fold on any working tree of a few
 * dozen files; in a 300px bottom panel with 185 changes it was simply unreachable without
 * scrolling past every row. It is now a fixed band between the header and the list: the list
 * scrolls, the composer does not.
 *
 * ⌘/Ctrl+Enter commits from inside the field. The button says exactly why it is disabled, in
 * words, right beside it — a dead primary button with no explanation is the panel's oldest
 * complaint. "Commit all" is a separate, explicit menu entry, never the default: it runs
 * `git add -A`, which is the very behaviour that was removed from plain Commit on 2026-08-31.
 */
export function Composer(p: Props): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const disabled = p.blocker !== null
  const committing = p.busy === 'commit'

  return (
    <div className="scm-composer">
      <textarea
        className="text-input scm-composer-input"
        rows={2}
        placeholder={`Message (⌘Enter to commit on ${p.branch || 'HEAD'})`}
        aria-label="Commit message"
        value={p.value}
        disabled={committing}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            if (!disabled) p.onCommit()
          }
        }}
      />
      <div className="scm-composer-row">
        <span className="scm-composer-meta" aria-live="polite">
          {p.stagedCount} staged
          {p.outsideStaged > 0 && (
            <span className="scm-composer-outside" title="Files staged elsewhere in this repository will be part of the same commit">
              {' '}+ {p.outsideStaged} outside this folder
            </span>
          )}
        </span>
        {disabled && !committing && <span className="scm-composer-hint muted">{p.blocker}</span>}
        <span className="spacer" />
        <div className="scm-composer-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary scm-commit-btn"
            disabled={disabled}
            title={p.blocker ?? `Commit ${p.stagedCount} staged file${p.stagedCount === 1 ? '' : 's'} (⌘Enter)`}
            onClick={p.onCommit}
          >
            {committing ? 'Committing…' : <><Icon name="check" size={11} /> Commit</>}
          </button>
          <div className="scm-menu-wrap">
            <button
              type="button"
              className="btn btn-sm scm-commit-more"
              aria-label="More commit actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Commit all, AI-written message, PR description, release notes"
              disabled={committing}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <Icon name="chevron-down" size={11} />
            </button>
            {menuOpen && <Menu entries={p.menu} onPick={p.onMenu} onClose={() => setMenuOpen(false)} ariaLabel="Commit actions" />}
          </div>
        </div>
      </div>
    </div>
  )
}
