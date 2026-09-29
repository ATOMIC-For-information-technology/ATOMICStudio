import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon'
import type { UndoHistoryEntry } from '../../../shared/types'

interface Props {
  /** Called with the restored files after a revert so the IDE can refresh. */
  onReverted: (files: string[]) => void
}

/**
 * P11 — the undo timeline. Every change Studio made this session (manual saves,
 * AI edits, agent applies, auto-fixes) in one list, newest first, with
 * "Revert to before this" at any point. The stack never touches the user's own
 * git history.
 */
export function HistoryPanel({ onReverted }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<UndoHistoryEntry[]>([])
  const [marks, setMarks] = useState<{ id: string; label: string; ts: number }[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void window.studio.getUndoHistory().then(setEntries)
    void window.studio.undoCheckpoints().then(setMarks)
  }, [])

  useEffect(refresh, [refresh])

  const restoreMark = useCallback(
    async (id: string) => {
      setBusy(true)
      let res: Awaited<ReturnType<typeof window.studio.restoreCheckpoint>>
      try {
        res = await window.studio.restoreCheckpoint(id)
      } finally {
        setBusy(false) // never leave the button stuck disabled if the IPC ever rejects
      }
      refresh()
      if (res.restored.length) onReverted(res.restored)
    },
    [refresh, onReverted]
  )

  const revertTo = useCallback(
    async (stackIndex: number) => {
      setBusy(true)
      let res: Awaited<ReturnType<typeof window.studio.undoTo>>
      try {
        res = await window.studio.undoTo(stackIndex)
      } finally {
        setBusy(false)
      }
      refresh()
      if (res.restored.length) onReverted(res.restored)
    },
    [refresh, onReverted]
  )

  const time = (ts: number): string =>
    new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  const fileName = (p: string): string => p.split('/').pop() ?? p

  return (
    <div className="history-drawer panel-pane">
      <div className="logs-body history-body">
        {marks.length > 0 && (
          <>
            <div className="settings-subhead">Time-Machine checkpoints</div>
            {marks.slice().reverse().map((m) => (
              <div key={m.id} className="hist-row hist-mark">
                <span className="hist-time"><Icon name="clock" size={11} /> {time(m.ts)}</span>
                <span className="hist-label" title={m.label}>{m.label}</span>
                <button className="btn btn-sm" disabled={busy} title="Restore the whole workspace to this point" onClick={() => void restoreMark(m.id)}>
                  <Icon name="undo" size={11} /> Restore
                </button>
              </div>
            ))}
            <div className="settings-subhead">Every change</div>
          </>
        )}
        {entries.length === 0 && (
          <div className="muted">No changes yet. Every save, AI edit, and agent apply will appear here — and can be rolled back.</div>
        )}
        {entries
          .map((e, stackIndex) => ({ ...e, stackIndex }))
          .reverse()
          .map((e) => (
            <div key={e.stackIndex} className="hist-row">
              <span className="hist-time">{time(e.ts)}</span>
              <span className="hist-label" title={`${e.label} — ${e.file}`}>
                {e.label} <span className="hist-file">({fileName(e.file)})</span>
              </span>
              <button
                className="btn btn-sm"
                disabled={busy}
                title="Undo this change and everything after it"
                onClick={() => revertTo(e.stackIndex)}
              >
                <Icon name="undo" size={11} /> Revert to before this
              </button>
            </div>
          ))}
      </div>
    </div>
  )
}
