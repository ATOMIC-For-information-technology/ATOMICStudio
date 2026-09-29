import React, { useCallback, useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'
import type { AgentEvent, DiffLine, ReplayEvent, ReplayKind } from '../../../shared/types'
import { foldReplay } from '../../../shared/replay'

interface Props {
  projectPath: string
  refreshKey: number
  onOpenFile: (file: string) => void
  /** Called with the files restored after a revert, so the IDE can refresh tabs. */
  onReverted?: (files: string[]) => void
}

// 'change' uses the pencil — the same write/edit mark as the timeline and the activity feed. It was
// ✏️ (U+270F U+FE0F), the only variation-selected glyph in the whole renderer, so it rendered
// as a full-colour emoji while every other icon in this list stayed monochrome.
const icon = (k: ReplayKind): IconName => (k === 'ai-edit' ? 'robot' : k === 'change' ? 'pencil' : k === 'checkpoint' ? 'clock' : 'play')
const fileName = (p: string): string => p.split('/').pop() ?? p
const when = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Development Replay — the project's story as one ordered timeline (AI edits,
 * manual changes, checkpoints, agent runs), newest first. Repaints live on agent
 * events and when the caller bumps refreshKey (tab open / after a save).
 */
export function ReplayPanel({ projectPath, refreshKey, onOpenFile, onReverted }: Props): React.JSX.Element | null {
  const [events, setEvents] = useState<ReplayEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [openDiff, setOpenDiff] = useState<number | null>(null)
  const [diffCache, setDiffCache] = useState<Record<number, DiffLine[]>>({})

  const toggleDiff = useCallback(async (stackIndex: number) => {
    if (openDiff === stackIndex) {
      setOpenDiff(null)
      return
    }
    setOpenDiff(stackIndex)
    if (!diffCache[stackIndex]) {
      const lines = await window.studio.undoDiff(stackIndex)
      setDiffCache((c) => ({ ...c, [stackIndex]: lines }))
    }
  }, [openDiff, diffCache])

  const refresh = useCallback(async () => {
    // The undo stack is session-global and its integer indices are REUSED after ANY pop —
    // an in-panel Revert, but also the top-bar / palette "Undo last change" (undoEdit),
    // which pops the stack without bumping refreshKey or routing through revertTo. A diff
    // cached under an index can therefore belong to a different change once we re-fold the
    // events. refresh() is the single point where that index→change mapping is recomputed,
    // so invalidate the cache (and any open diff) here — the ONLY place that covers every
    // pop path — so a stale diff can never render next to the wrong ↩ Revert button.
    setDiffCache({})
    setOpenDiff(null)
    const [ledger, history, state] = await Promise.all([
      window.studio.ledgerList(projectPath),
      window.studio.getUndoHistory(),
      window.studio.agentState()
    ])
    setEvents(foldReplay({ ledger, history, finished: state.finished ?? [], project: projectPath }))
  }, [projectPath])

  const revertTo = useCallback(
    async (stackIndex: number) => {
      setBusy(true)
      let res: Awaited<ReturnType<typeof window.studio.undoTo>>
      try {
        res = await window.studio.undoTo(stackIndex)
      } finally {
        setBusy(false) // never leave the button stuck disabled if the IPC ever rejects
      }
      void refresh() // re-folds events + clears the (now index-reused) diff cache
      if (res.restored.length) onReverted?.(res.restored)
    },
    [refresh, onReverted]
  )

  useEffect(() => {
    void refresh()
    return window.studio.onAgentEvent((ev: AgentEvent) => {
      if (ev.type === 'done' || ev.type === 'error' || ev.type === 'staged') void refresh()
    })
  }, [refresh, refreshKey])

  if (!events.length) return null
  return (
    <div className="replay-panel">
      <div className="settings-subhead">Project story ({events.length})</div>
      {events.slice(0, 40).map((e, i) => (
        <React.Fragment key={i}>
          <div className={`debt-row replay-${e.kind}`}>
            <span className={`ws-badge replay-badge-${e.kind}`}><Icon name={icon(e.kind)} size={11} /> {e.kind}</span>
            <span className="debt-detail" title={e.detail}>
              <b>{e.file ? fileName(e.title) : e.title}</b>
              {e.detail ? ` — ${e.detail}` : ''}
            </span>
            <span className="hist-time">{when(e.ts)}</span>
            {e.kind === 'change' && e.stackIndex != null ? (
              <>
                <button className="btn btn-sm" title="See what this change did" onClick={() => void toggleDiff(e.stackIndex!)}><Icon name={openDiff === e.stackIndex ? 'chevron-down' : 'chevron-right'} size={11} /> Diff</button>
                <button className="btn btn-sm" disabled={busy} title="Undo this change and everything after it" onClick={() => void revertTo(e.stackIndex!)}><Icon name="undo" size={11} /> Revert</button>
              </>
            ) : (
              e.file && <button className="btn btn-sm" onClick={() => onOpenFile(e.file!)}>Open</button>
            )}
          </div>
          {e.kind === 'change' && e.stackIndex != null && openDiff === e.stackIndex && (
            <pre className="diff-body">
              {(diffCache[e.stackIndex] ?? []).map((l, k) => (
                <div key={k} className={`dl dl-${l.kind}`}>
                  {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}
                  {l.text}
                </div>
              ))}
              {diffCache[e.stackIndex] && diffCache[e.stackIndex].length === 0 && <div className="muted">(no textual change)</div>}
            </pre>
          )}
        </React.Fragment>
      ))}
    </div>
  )
}
