import React from 'react'
import { MemoryPanel } from '../MemoryPanel'
import { ReplayPanel } from '../ReplayPanel'
import { InsightSection } from './insight-section'
import { InsightEmpty } from './insight-empty-state'
import type { MemoryData } from './types'

interface Props {
  projectPath: string
  data: MemoryData
  changeToken: number
  canOpenFiles: boolean
  onOpenFile: (path: string) => void
  onMsg: (type: 'ok' | 'err', text: string) => void
  onReverted: (files: string[]) => void
}

/**
 * What this project knows that reading it could never tell you.
 *
 * That is the whole distinction from Code Map: an architecture graph can be rebuilt by parsing
 * imports, and a goal, a business rule or a forbidden change cannot be recovered from any amount
 * of source. Deleting Code Map would lose nothing; deleting this would lose everything the team
 * decided.
 *
 * Decisions are NOT a separate product here. `main/memory.ts` already folds `listDecisions()` into
 * the memory list as `kind: 'decision'` — deduped by a stable id — so the old "Project decisions"
 * section was the same rows rendered a second time, twenty lines below the first. Old records in
 * `decisions.json` are still read on every list, so nothing was migrated and nothing was dropped;
 * they are simply one filter chip in the single list now.
 *
 * History sits underneath because it is the record of what happened, not the knowledge itself.
 */
export function InsightMemory(props: Props): React.JSX.Element {
  const ledger = props.data.ledger.data ?? []
  return (
    <div className="iv-memory">
      <MemoryPanel projectPath={props.projectPath} onMsg={props.onMsg} showFilter />

      <div className="iv-history">
        <h3 className="iv-h">History</h3>
        <p className="muted small">What has already happened to this project — as opposed to what it knows.</p>

        <InsightSection title="What the AI changed" info="Every file the agent wrote, with the reason it gave at the time." hint={ledger.length ? String(ledger.length) : undefined}>
          {props.data.ledger.phase === 'error' ? (
            <InsightEmpty icon="ban" title="Could not read the change ledger." detail={props.data.ledger.error} />
          ) : ledger.length === 0 ? (
            <InsightEmpty title="The AI has not changed anything in this project yet." />
          ) : (
            <ul className="iv-list">
              {ledger.slice(0, 12).map((e, i) => (
                <li key={i} className="iv-row">
                  <span className="iv-sev ws-badge">{e.model}</span>
                  <span className="iv-row-text debt-detail" title={`${e.file} — ${e.why}`}><b>{e.file}</b> — {e.why}</span>
                  {props.canOpenFiles && <button type="button" className="btn btn-sm" onClick={() => props.onOpenFile(e.file)}>Open file</button>}
                </li>
              ))}
            </ul>
          )}
        </InsightSection>

        <InsightSection title="Development replay" info="The project's story as a timeline — edits, checkpoints and agent runs, with the ones that can be rolled back marked.">
          <ReplayPanel
            projectPath={props.projectPath}
            refreshKey={props.changeToken}
            onOpenFile={props.onOpenFile}
            onReverted={props.onReverted}
          />
        </InsightSection>
      </div>
    </div>
  )
}
