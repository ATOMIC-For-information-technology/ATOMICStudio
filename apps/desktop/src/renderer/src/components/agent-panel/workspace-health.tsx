import React from 'react'
import type { StatusRow } from './types'
import { StatusBadge } from './status-badge'

/**
 * Section 7 — Workspace Health. A pinned grid of real health signals (Verify,
 * Agent, Queue, Preview, Git, Warnings). Ambient awareness above the input,
 * without stealing focus — consistent status dots unify the semantics across
 * every row (green ok / blue running / amber warning / red error / gray idle).
 */
export function WorkspaceHealth({ rows }: { rows: StatusRow[] }): React.JSX.Element {
  return (
    <div className="ap-health">
      {rows.map((r) => (
        <StatusBadge key={r.label} row={r} />
      ))}
    </div>
  )
}
