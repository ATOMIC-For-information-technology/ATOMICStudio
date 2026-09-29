import React, { useEffect, useState } from 'react'
import { Icon } from '../Icon'
import type { AgentMode } from '../../../../shared/types'

interface Props {
  busy: boolean
  /** Conversation title (first request, truncated) — falls back to "Agent". */
  title: string
  mode: AgentMode
  /** Active run's start timestamp — drives the elapsed ticker while busy. */
  startedAt?: number | null
  onModeChange: (mode: AgentMode) => void
  onNewChat: () => void
}

/** Ticking "m:ss" elapsed label — re-renders once per second while a run is live. */
function useElapsed(startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [startedAt])
  if (startedAt === null) return null
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * How each mode presents itself, in the terminal idiom the CLI uses: a glyph, a lowercase
 * state phrase, and nothing else.
 *
 * `⏸` for the mode that holds back, `⏵⏵` for the one that proceeds on its own — the
 * pause/play reading is why those two glyphs carry it without needing a legend.
 *
 * Only two entries, and deliberately so. The CLI also ships auto / don't-ask /
 * bypass-permissions, but every one of those describes a *per-action permission prompt*
 * being auto-answered — and this agent has no such prompt to answer. Its `run` is already
 * restricted to read-only and build commands by `isAgentSafeCommand`, so a
 * "bypass permissions" state here would name a permission nothing ever asks for. The loop
 * branches on `req.mode` and nothing else (`agent.ts`), so two real modes exist and two show.
 */
const MODES: { id: AgentMode; glyph: string; label: string; hint: string }[] = [
  {
    id: 'plan',
    glyph: '⏸',
    label: 'plan mode on',
    hint: 'Reads, searches and proposes. Cannot write files, and cannot spend on image generation.'
  },
  {
    id: 'build',
    glyph: '⏵⏵',
    label: 'accept edits on',
    hint: 'Edits are written to disk as the agent works. A restore point is taken before the run, so the whole run undoes in one click.'
  }
]

/**
 * The fixed header: agent status + running indicator (with elapsed time while running),
 * conversation title, the mode control, and New Chat. Always visible (never scrolls).
 *
 * The mode control is one button that cycles, not a two-button segmented toggle. The toggle
 * it replaced was labelled "Build | Plan", which named neither what either mode permits nor
 * which one was in force — and its Plan tooltip claimed the agent "proposes diffs; you
 * approve before anything is written", which has not been true since Build mode began
 * applying writes directly. A single control stating the live mode in words cannot drift
 * from the mode the way two bare nouns did.
 *
 * Cycling is on click/Enter/Space rather than the CLI's Shift+Tab: in a windowed app
 * Shift+Tab is reverse focus traversal, and taking it would break keyboard navigation of the
 * whole panel to save one keystroke.
 */
export function AgentHeader({ busy, title, mode, startedAt, onModeChange, onNewChat }: Props): React.JSX.Element {
  const elapsed = useElapsed(busy ? startedAt ?? null : null)
  const idx = MODES.findIndex((m) => m.id === mode)
  const current = idx === -1 ? MODES[1] : MODES[idx]
  const next = MODES[((idx === -1 ? 1 : idx) + 1) % MODES.length]

  return (
    <header className="ap-header">
      <div className="ap-header-top">
        <span className="ap-header-title" title={title}>
          <Icon name="robot" size={14} /> {title}
        </span>
        <span className={`ap-running ${busy ? 'running' : 'ready'}`} title={`Agent status: ${busy ? 'Running' : 'Ready'}`}>
          <span className={`ap-running-dot ${busy ? 'pulse' : ''}`} />
          {busy ? 'Running' : 'Ready'}
          {elapsed !== null && <span className="ap-elapsed">{elapsed}</span>}
        </span>
      </div>
      <div className="ap-header-controls">
        <button
          type="button"
          className={`ap-mode-cycle mode-${current.id}`}
          onClick={() => onModeChange(next.id)}
          title={`${current.hint}\n\nClick to switch to: ${next.label}`}
          aria-label={`Mode: ${current.label}. Activate to switch to ${next.label}.`}
        >
          <span className="ap-mode-glyph" aria-hidden="true">{current.glyph}</span>
          <span className="ap-mode-label">{current.label}</span>
        </button>

        <button type="button" className="ap-icon-btn" onClick={onNewChat} disabled={busy} title="Start a new chat">
          ＋ New
        </button>
      </div>
    </header>
  )
}
