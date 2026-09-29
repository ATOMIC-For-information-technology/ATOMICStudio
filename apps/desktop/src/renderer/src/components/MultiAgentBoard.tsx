import React, { useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'
import type { AgentState, AgentTask } from '../../../shared/types'

// `running` is the filled dot (not an hourglass) for two reasons: it matches the running mark the
// Workspace Health strip and the Execution Timeline use, so one concept reads the same
// across all three surfaces of this panel; and the dot is monochrome, so the
// `.task-running .task-icon { color: var(--amber) }` rule actually applies to it — a
// colour emoji ignores CSS `color` outright, so the amber never rendered.
const statusIcon = (s: AgentTask['status']): IconName =>
  s === 'running' ? 'dot' : s === 'done' ? 'check' : s === 'error' ? 'close' : s === 'cancelled' ? 'ban' : s === 'queued' ? 'circle-dashed' : 'stop'

const STATUS_VERB: Record<AgentTask['status'], string> = {
  running: 'Working',
  queued: 'Queued',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
  stopped: 'Stopped'
}

/** "just now" / "3m ago" / "2h ago" — a relative read on when a run last moved, never a raw timestamp. */
function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

/**
 * One teammate card: status verb, the task itself, an indeterminate
 * progress bar while running, and turns/staged facts plus a relative "last
 * activity" — turning a flat task list into a roster. Every field comes
 * straight off AgentTask; nothing here is invented.
 */
function TeammateCard({
  task,
  now
}: {
  task: AgentTask
  now: number
}): React.JSX.Element {
  const lastActivity = task.endedAt ?? task.startedAt

  return (
    <div className={`agent-task task-${task.status}`}>
      <span className="task-icon">
        <Icon name={statusIcon(task.status)} size={task.status === 'running' ? 9 : 12} />
      </span>
      <div className="task-body">
        <div className="task-top">
          <span className="task-verb">{STATUS_VERB[task.status]}</span>
          <span className="task-time">{relativeTime(lastActivity, now)}</span>
        </div>
        <span className="task-instruction" title={task.summary || task.error || task.instruction}>
          {task.instruction}
        </span>
        {task.status === 'running' && (
          <div className="task-bar">
            <div className="task-bar-fill indeterminate" />
          </div>
        )}
        {task.status !== 'queued' && (
          <span className="task-meta">
            turn {task.turns}
            {task.stagedCount > 0 ? ` · ${task.stagedCount} staged` : ''}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Multi-Agent Board — a compact, collapsible roster of agent runs: the live
 * one (with a ticking turn count), anything queued behind it, and a bounded
 * history of recently-finished runs with their outcome.
 *
 * `state` is passed down from AgentPanel (which already holds it as `snap`)
 * rather than fetched here via a second onAgentEvent subscription + its own
 * agentState() poll — two independent components deciding when to refetch
 * the same snapshot, on different event-type filters, was a duplication that
 * would silently drift the moment either filter was updated without the other.
 */
export function MultiAgentBoard({
  state
}: {
  state: AgentState | null
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Relative "last activity" labels stay fresh while the roster is visible.
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(t)
  }, [open])

  if (!state) return null
  const active = state.active && state.active.status === 'running' ? state.active : null
  const queued = state.queuedTasks ?? []
  const finished = state.finished ?? []
  if (!active && queued.length === 0 && finished.length === 0) return null

  return (
    <div className="agent-board">
      <button
        className="agent-board-head"
        onClick={() => setOpen((o) => !o)}
        title="Agent runs: live, queued, and recently finished"
        aria-expanded={open}
      >
        <span className="agent-board-caret"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} /></span>
        Agent tasks
        <span className="agent-board-count">{active ? '1 running · ' : ''}{finished.length} recent</span>
      </button>
      {open && (
        <div className="agent-board-list">
          {active && <TeammateCard task={active} now={now} />}
          {/* queued tasks have no real runId yet (backend stamps a shared -1 sentinel
              until they're promoted), so the array index is the only key available. */}
          {queued.map((t, i) => (
            <TeammateCard key={`q${i}`} task={t} now={now} />
          ))}
          {finished.map((t, i) => (
            <TeammateCard key={`f${t.runId}-${i}`} task={t} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
