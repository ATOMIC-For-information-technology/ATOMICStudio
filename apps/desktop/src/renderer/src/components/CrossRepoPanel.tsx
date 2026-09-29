import React, { useState } from 'react'
import type { CrossRepoGraph } from '../../../shared/types'

/**
 * Cross-repo Knowledge Graph (zero-storage): on demand, aggregate code owners + churn hotspots
 * across the projects in the renderer's own recents list — so "who knows what" and "where the
 * risk concentrates" span the whole group, not just the open repo. No new registry is stored.
 */
export function CrossRepoPanel(): React.JSX.Element {
  const [graph, setGraph] = useState<CrossRepoGraph | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    setBusy(true)
    let recents: string[] = []
    try {
      // studio.recent is stored as {path,name,framework}[] (App.tsx) — pull the path off each
      // entry (tolerating a bare-string legacy shape too).
      const parsed = JSON.parse(localStorage.getItem('studio.recent') || '[]')
      if (Array.isArray(parsed))
        recents = parsed
          .map((r) => (typeof r === 'string' ? r : r && typeof r.path === 'string' ? r.path : ''))
          .filter((p: string) => !!p)
    } catch {
      recents = []
    }
    try {
      setGraph(await window.studio.kgCrossRepo(recents))
    } finally {
      setBusy(false) // never leave the button stuck disabled if the IPC ever rejects
    }
  }

  return (
    <div className="crossrepo">
      <div className="git-row">
        <span className="muted small">Owners + churn across your recent projects (not just this one):</span>
        <span className="spacer" />
        <button className="btn btn-sm" disabled={busy} onClick={() => void load()}>Across your projects</button>
      </div>
      {graph &&
        (graph.repos.length === 0 ? (
          <div className="muted small">No git projects in your recents to aggregate yet.</div>
        ) : (
          <div className="crossrepo-body">
            <div className="settings-subhead">Across {graph.repos.length} project{graph.repos.length === 1 ? '' : 's'} — {graph.owners.length} {graph.owners.length === 1 ? 'person' : 'people'}</div>
            {graph.owners.slice(0, 12).map((o) => (
              <div key={o.email || o.name} className="debt-row">
                <span className="ws-badge ws-badge-server" title={o.email || o.name}>{o.name}</span>
                <span className="debt-detail">{o.commits} commits · {o.repos} repo{o.repos === 1 ? '' : 's'}</span>
              </div>
            ))}
            {graph.hotspots.length > 0 && <div className="settings-subhead">Churn hotspots</div>}
            {graph.hotspots.slice(0, 10).map((h) => (
              <div key={h.file} className="debt-row">
                <span className="ws-badge" title={`${h.commits} commits · ${h.churn} lines churned`}>{h.churn}</span>
                <span className="debt-detail">{h.file}</span>
              </div>
            ))}
          </div>
        ))}
    </div>
  )
}
