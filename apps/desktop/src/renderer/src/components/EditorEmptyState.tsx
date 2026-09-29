import React from 'react'
import { Icon } from './Icon'
import { key } from '../keys'

interface Shortcut {
  id: string
  label: string
  keys: string
  run: () => void
  /** Present when the action cannot run right now; shown as the tooltip and disables the row. */
  unavailable?: string
}

interface Props {
  onOpenAgent: () => void
  onShowCommands: () => void
  onToggleTerminal: () => void
  /** The Terminal needs a folder to run a shell in; without one the row says so rather than lying. */
  hasProject: boolean
  /** Builder Mode has no terminal at all — the row is dropped, not shown disabled. */
  showTerminal: boolean
}

/**
 * The editor with no document open.
 *
 * Deliberately NOT the `WelcomeScreen`: that is the no-PROJECT launcher (open, new, clone,
 * recents) and it keeps that job. This is the state an IDE shows when a workspace is open and the
 * editor area has nothing in it — a watermark and the two or three keystrokes worth knowing.
 *
 * Every row runs a REAL command the app already has, and a row that cannot run right now is
 * disabled with the reason in its tooltip rather than looking clickable and doing nothing. The key
 * caps come from `keys.ts`, so they read ⌘⇧P on macOS and Ctrl+Shift+P elsewhere and cannot drift
 * from the menu — the shortcut is not written down twice.
 *
 * The mark is the product's own atom from `Icon.tsx` at watermark contrast: `currentColor` so it
 * follows the theme, one low opacity, no white tile, no glow, no gradient, no animation, and
 * `aria-hidden` because it is decoration. It is the one signature element on this surface.
 */
export function EditorEmptyState({ onOpenAgent, onShowCommands, onToggleTerminal, hasProject, showTerminal }: Props): React.JSX.Element {
  const rows: Shortcut[] = [
    { id: 'agent', label: 'Open Agent Chat', keys: key('A', { shift: true }), run: onOpenAgent },
    { id: 'commands', label: 'Show All Commands', keys: key('P', { shift: true }), run: onShowCommands }
  ]
  if (showTerminal) {
    rows.push({
      id: 'terminal',
      label: 'Toggle Terminal',
      keys: key('J'),
      run: onToggleTerminal,
      unavailable: hasProject ? undefined : 'Open a project first — a terminal needs a folder to run in'
    })
  }

  return (
    <div className="ees" role="region" aria-label="Editor">
      <div className="ees-inner">
        <Icon name="atom" size={168} className="ees-mark" />
        <ul className="ees-rows">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="ees-row"
                disabled={r.unavailable !== undefined}
                title={r.unavailable}
                onClick={r.run}
              >
                <span className="ees-label">{r.label}</span>
                {/* The key cap is decoration for a screen reader: the button's own name carries the
                    action, and hearing "command shift P" spelled out helps nobody. */}
                <span className="ees-keys" aria-hidden="true">{r.keys}</span>
                {r.unavailable && <span className="sr-only">{` — ${r.unavailable}`}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
