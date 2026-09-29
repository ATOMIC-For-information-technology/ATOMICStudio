import React, { useState } from 'react'
import type { TimelineStep } from './types'
import { Icon, type IconName } from '../Icon'

// One mark per tool. This column exists to tell tools apart at a glance, so no two share a mark —
// run_command and run_preview once both rendered ▶ and were indistinguishable here.
const TOOL_ICON: Record<string, IconName> = {
  list_files: 'list',
  read_file: 'file-text',
  search_files: 'search',
  run_command: 'play',
  write_file: 'pencil',
  apply_staged: 'upload',
  run_preview: 'monitor'
}

const PLURAL_VERB: Record<string, string> = {
  list_files: 'Indexed repository',
  read_file: 'Read',
  search_files: 'Searched',
  run_command: 'Ran',
  write_file: 'Wrote',
  apply_staged: 'Applied',
  run_preview: 'Started preview'
}

/** A pretty, human label for a tool step — pluralized when several identical calls grouped into one row. */
const label = (step: TimelineStep): string => {
  const d = step.detail
  const n = step.count ?? 1
  if (n > 1) {
    const verb = PLURAL_VERB[step.tool] ?? step.tool
    return step.tool === 'list_files' ? verb : `${verb} ${n} time${n === 1 ? '' : 's'}`
  }
  switch (step.tool) {
    case 'list_files': return 'Indexed repository'
    case 'read_file': return `Read ${d}`
    case 'search_files': return `Searched “${d}”`
    case 'run_command': return `Ran ${d}`
    case 'write_file': return `Wrote ${d}`
    case 'apply_staged': return `Applied ${d}`
    case 'run_preview': return 'Started preview'
    default: return step.tool
  }
}

/** "0:41" while a run's start time is known, else a plain local clock time. */
function formatStepTime(ts: number, startedAt: number | null): string {
  if (startedAt !== null) {
    const total = Math.max(0, Math.floor((ts - startedAt) / 1000))
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * One expandable step in the live execution timeline. Collapsed it shows a
 * status icon, a one-line summary, and a relative timestamp; expanding
 * reveals the step's detail, the files it touched, and its outcome.
 */
export function TimelineItem({ step, startedAt = null }: { step: TimelineStep; startedAt?: number | null }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // The filled dot means "in flight" here, in Workspace Health and on the teammate board — one
  // concept, one mark. It used to be ▶, which collided with the run_command/run_preview ▶ in the
  // tool column of this same row: an active command rendered "▶ Ran npm test ▶ 0:12 ▸".
  const icon: IconName = step.active ? 'dot' : step.ok ? 'check' : 'close'
  const cls = step.active ? 'running' : step.ok ? 'ok' : 'error'
  const grouped = (step.count ?? 1) > 1

  return (
    // tool-chip (+bad) is a legacy DOM hook the UI tests count — ap-tl-item rules
    // in styles.css neutralize the pill styling so the timeline look is unchanged.
    <div className={`ap-tl-item tool-chip ${step.ok ? '' : 'bad'} ${cls} ${step.active ? 'active' : ''}`}>
      <button type="button" className="ap-tl-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`ap-tl-icon ${step.active ? 'pulse' : ''}`}><Icon name={icon} size={step.active ? 9 : 12} /></span>
        <span className="ap-tl-label" title={label(step)}>{label(step)}</span>
        {grouped && <span className="ap-tl-count">×{step.count}</span>}
        <span className="ap-tl-tool">
          {TOOL_ICON[step.tool] ? <Icon name={TOOL_ICON[step.tool]} size={12} /> : '•'}
        </span>
        <span className="ap-tl-time">{formatStepTime(step.ts, startedAt)}</span>
        <span className={`ap-tl-caret ${open ? 'open' : ''}`}><Icon name="chevron-right" size={11} /></span>
      </button>
      {open && (
        <div className="ap-tl-detail">
          <div className="ap-tl-detail-row"><span className="ap-tl-k">Tool</span><span className="ap-tl-v">{step.tool}</span></div>
          {step.detail && <div className="ap-tl-detail-row"><span className="ap-tl-k">Target</span><span className="ap-tl-v mono">{step.detail}</span></div>}
          <div className="ap-tl-detail-row">
            <span className="ap-tl-k">Result</span>
            <span className={`ap-tl-v ${step.ok ? 'ok' : 'error'}`}>{step.active ? 'Running…' : step.ok ? 'Succeeded' : 'Failed'}</span>
          </div>
        </div>
      )}
    </div>
  )
}