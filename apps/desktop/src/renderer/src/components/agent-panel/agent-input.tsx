import React, { useEffect, useRef } from 'react'

interface Props {
  value: string
  busy: boolean
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
}

/**
 * Section 8 — Bottom Input. Pinned and never scrolls away. The prompt box grows
 * vertically; while a run is busy the send button becomes "Queue" (sending is
 * never blocked — the instruction waits behind the active run). No attach /
 * voice / context buttons: those capabilities don't exist in this app, so
 * there are no fake controls here.
 */
export function AgentInput({ value, busy, onChange, onSend, onStop }: Props): React.JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow the textarea up to a cap as the user types.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }, [value])

  const canSend = value.trim().length > 0

  return (
    <div className="agent-input ap-input">
      <textarea
        ref={taRef}
        className="text-input textarea ap-textarea"
        rows={2}
        placeholder="Describe what to build…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (canSend) onSend()
          }
        }}
      />
      <div className="ap-input-row">
        <button className="btn btn-primary btn-block" disabled={!canSend} onClick={onSend}>
          {busy ? 'Queue' : 'Start'}
        </button>
        <button className="btn ap-stop" disabled={!busy} onClick={onStop} title="Stop the current run">
          Stop
        </button>
      </div>
    </div>
  )
}
