import React from 'react'
import { key } from '../keys'
import { Icon } from './Icon'
import type { ModeSurface } from '../../../shared/mode'

export type SidebarView = 'explorer' | 'scm' | 'extensions' | 'media' | 'account' | null

interface Props {
  sidebarView: SidebarView
  onSidebarViewChange: (view: SidebarView) => void
  /** True while the bottom Terminal tab is the active panelTab — drives the CLI icon's active state. */
  terminalOpen: boolean
  onToggleTerminal: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  /** What this personality shows — Builder Mode has no code search, terminal or extensions. */
  surface: ModeSurface
  /** The Terminal needs an actual folder to run a shell in — without one, the icon is disabled
   *  rather than opening a panel that then redirects itself to something else. */
  hasProject: boolean
}

/**
 * The far-left icon rail — VS Code's Activity Bar. Clicking Explorer/Extensions
 * swaps the sidebar next to it; Search/CLI/Settings/Profile each open the real
 * existing surface for that feature (QuickOpen, the bottom Terminal tab, the
 * Settings modal) rather than duplicating them. Every icon does something real;
 * there is no placeholder here that doesn't lead somewhere working.
 *
 * Every button carries an explicit `aria-label`, and the glyph is `aria-hidden`: a <button> whose
 * only content is an emoji takes its accessible name from that emoji, so `title="Explorer"` was
 * being ignored and the control announced itself as "page facing up". The toggles also report
 * `aria-pressed`, because on/off was previously carried by a background tint alone.
 */
export function ActivityBar({
  sidebarView,
  onSidebarViewChange,
  terminalOpen,
  onToggleTerminal,
  onOpenSearch,
  onOpenSettings,
  surface,
  hasProject
}: Props): React.JSX.Element {
  const toggleView = (view: 'explorer' | 'scm' | 'extensions' | 'media' | 'account'): void => {
    onSidebarViewChange(sidebarView === view ? null : view)
  }

  return (
    <nav className="activity-bar" aria-label="Main">
      <button
        type="button"
        className={`ab-btn ${sidebarView === 'explorer' ? 'active' : ''}`}
        onClick={() => toggleView('explorer')}
        title={surface.labels.files}
        aria-label={surface.labels.files}
        aria-pressed={sidebarView === 'explorer'}
      >
        <Icon name="file-text" size={24} />
      </button>
      {surface.search && (
        <button
          type="button"
          className="ab-btn"
          onClick={onOpenSearch}
          title={`Search Everywhere (${key('P')})`}
          aria-label={`Search everywhere (${key('P')})`}
        >
          <Icon name="search" size={24} />
        </button>
      )}
      {/* Source Control is a sidebar VIEW, in VS Code's slot (after Search), not a bottom-panel tab:
          a 300px column the height of the window is the shape a change list and a pinned commit
          box want, and it is where a developer's hand already goes. Moved 2026-09-02. */}
      {surface.git && (
        <button
          type="button"
          className={`ab-btn ${sidebarView === 'scm' ? 'active' : ''}`}
          onClick={() => toggleView('scm')}
          title={`Source Control (${key('G', { shift: true })})`}
          aria-label={`Source Control (${key('G', { shift: true })})`}
          aria-pressed={sidebarView === 'scm'}
        >
          <Icon name="git-branch" size={24} />
        </button>
      )}
      {surface.extensions && (
        <button
          type="button"
          className={`ab-btn ${sidebarView === 'extensions' ? 'active' : ''}`}
          onClick={() => toggleView('extensions')}
          title="Extensions"
          aria-label="Extensions"
          aria-pressed={sidebarView === 'extensions'}
        >
          <Icon name="puzzle" size={24} />
        </button>
      )}
      {/* Create (images + video) is in BOTH modes on purpose: a non-coder building a landing page
          needs a hero image far more urgently than a developer does, so hiding it in Builder Mode
          would remove the feature from the person it helps most. */}
      <button
        type="button"
        className={`ab-btn ${sidebarView === 'media' ? 'active' : ''}`}
        onClick={() => toggleView('media')}
        title="Create images & video"
        aria-label="Create images and video"
        aria-pressed={sidebarView === 'media'}
      >
        <Icon name="image" size={24} />
      </button>
      {surface.terminal && (
        <button
          type="button"
          className={`ab-btn ${terminalOpen ? 'active' : ''}`}
          onClick={onToggleTerminal}
          disabled={!hasProject}
          title={hasProject ? 'Terminal' : 'Terminal — open a project first'}
          aria-label="Terminal"
          aria-pressed={terminalOpen}
        >
          <Icon name="terminal" size={24} />
        </button>
      )}
      <span className="ab-spacer" />
      {/* A sidebar view, NOT another route into the Settings modal — Profile and Settings
          previously both opened the same dialog on different tabs, which read as one
          feature duplicated across two icons. */}
      <button
        type="button"
        className={`ab-btn ${sidebarView === 'account' ? 'active' : ''}`}
        onClick={() => toggleView('account')}
        title="Account — who you're signed in as"
        aria-label="Account — who you're signed in as"
        aria-pressed={sidebarView === 'account'}
      >
        <Icon name="user" size={24} />
      </button>
      <button
        type="button"
        className="ab-btn"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
      >
        <Icon name="settings" size={24} />
      </button>
    </nav>
  )
}
