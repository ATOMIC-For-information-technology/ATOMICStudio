import React from 'react'
import { Icon, type IconName } from './Icon'
import { formatRelativeDate } from '../format'
import { key } from '../keys'
import type { RecentProject } from '../App'

interface Props {
  recents: RecentProject[]
  onOpenProject: () => void
  onNewProject: () => void
  onOpenRecent: (path: string) => void
  onCloneRepo: () => void
  onOpenWorkspaces: () => void
}

/** One row shape for the Recent list — icon, label, and a trailing relative date. */
function ListRow({
  icon,
  label,
  hint,
  title,
  onClick
}: {
  icon?: IconName
  label: string
  hint?: string
  title?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className="welcome-list-row" title={title} onClick={onClick}>
      {icon && <Icon name={icon} size={14} className="welcome-list-icon" />}
      <span className="welcome-list-label">{label}</span>
      {hint && <span className="muted small welcome-list-hint">{hint}</span>}
    </button>
  )
}

/**
 * One of the three ways in. `primary` is what gives the card its accent icon, and exactly one card
 * may carry it — DESIGN.md's one-accent rule is about rarity ("on a calm screen it should be the
 * only thing with real color"), so three accented icons would read as three competing primaries.
 */
function StartCard({
  icon,
  title,
  desc,
  hint,
  primary = false,
  onClick
}: {
  icon: IconName
  title: string
  desc: string
  hint?: string
  primary?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className={`welcome-card ${primary ? 'welcome-card-primary' : ''}`} onClick={onClick}>
      <Icon name={icon} size={20} className="welcome-card-icon" />
      <span className="welcome-card-title">{title}</span>
      <span className="welcome-card-desc">{desc}</span>
      {hint && <span className="welcome-card-hint">{hint}</span>}
    </button>
  )
}

/**
 * The center workspace when no project is open. Replaces what used to be a normal — but entirely
 * empty — Preview pane and tab strip: no device controls, no zoom, no "no preview running" text,
 * nothing that can't currently do anything. This is the primary surface instead of an afterthought,
 * so it answers "what is this app, and what do I do next" in the first second.
 *
 * **Reshaped 2026-09-03 from a VS Code Welcome tab into three intent cards.** The list-of-links
 * shape it replaced had three measured problems, all visible in one screenshot:
 *
 *  1. It filled about 40% of the pane and left the rest empty, because a four-item list is short
 *     and the content was pinned to the top.
 *  2. "Open Project ⌘O" appeared on screen FOUR times — sidebar button, Start row, Shortcuts row,
 *     title-bar action. The Shortcuts column existed only to restate rows that were already there.
 *  3. That Shortcuts column was four static <div>s styled exactly like the clickable rows beside
 *     them. The previous version of this file already flagged the risk in a comment; the fix is not
 *     a subtler style, it is not shipping four things that look pressable and aren't.
 *
 * So Start became three cards that name an *intent* ("open a project", "start something new",
 * "connect to a workspace") rather than a verb on a file, Clone dropped to a text link because it
 * is by far the rarest of the four, and Shortcuts is gone: the one key worth teaching here is the
 * command palette, which is the door to everything else.
 *
 * Deliberately NOT restated in the footer: the AI provider and the Builder/Developer mode. Both are
 * already in the status bar, 22px below — repeating them here would recreate the duplication this
 * screen was reshaped to remove.
 *
 * Every action is real, not a placeholder: Open/New Project call back into the exact same functions
 * the top toolbar uses; Clone/Connect open the exact same GitHub/Workspaces panels the Tools button
 * already does (there's no separate no-project version of either).
 */
export function WelcomeScreen({
  recents,
  onOpenProject,
  onNewProject,
  onOpenRecent,
  onCloneRepo,
  onOpenWorkspaces
}: Props): React.JSX.Element {
  return (
    <div className="welcome-screen">
      <div className="welcome-head">
        <span className="welcome-mark" aria-hidden="true" />
        <div>
          <h1 className="welcome-title">ATOMIC Studio</h1>
          {/* States the wedge, not a slogan. Every clause is something the app actually does: the
              agent reads and runs (gated by `isAgentSafeCommand`), edits in Build mode, and a
              restore point is taken before the run so the whole run undoes in one click (agent.ts). */}
          <p className="welcome-sub">
            An IDE where the agent can read, run and edit your project — and undo the whole run in one click.
          </p>
        </div>
      </div>

      <div className="welcome-cards">
        <StartCard
          icon="folder-open"
          title="Open a project"
          desc="Point Studio at a folder already on this computer."
          hint={key('O')}
          primary
          onClick={onOpenProject}
        />
        <StartCard
          icon="plus"
          title="Start something new"
          desc="Scaffold an empty project, then describe what you want built."
          onClick={onNewProject}
        />
        <StartCard
          icon="globe"
          title="Connect to a workspace"
          desc="Edit a folder on a server over SSH, or an ATOMIC workspace."
          onClick={onOpenWorkspaces}
        />
      </div>

      <p className="welcome-clone">
        <Icon name="git-branch" size={13} className="welcome-list-icon" />
        <span>
          Have a repository URL?{' '}
          <button type="button" className="welcome-linklike" onClick={onCloneRepo}>
            Clone a repository…
          </button>
        </span>
      </p>

      <div className="welcome-recent">
        <div className="welcome-section-head">Recent</div>
        {recents.length > 0 ? (
          recents.map((r) => (
            <ListRow
              key={r.path}
              icon="folder"
              label={r.name}
              hint={formatRelativeDate(r.lastOpened)}
              title={r.path}
              onClick={() => onOpenRecent(r.path)}
            />
          ))
        ) : (
          /* The app's established empty-state treatment — a quiet dashed outline, not a loud box
             (the same idle-hero rule the other empty states use). It names what will fill it, so
             the space reads as "nothing yet" rather than "something failed". */
          <div className="welcome-recents-empty">
            <span className="welcome-recents-empty-title">Nothing here yet</span>
            <span className="welcome-recents-empty-sub">
              Folders you open appear here, most recent first.
            </span>
          </div>
        )}
      </div>

      <p className="welcome-foot">
        <kbd className="welcome-kbd">{key('P', { shift: true })}</kbd>
        Everything else lives in the command palette.
      </p>
    </div>
  )
}
