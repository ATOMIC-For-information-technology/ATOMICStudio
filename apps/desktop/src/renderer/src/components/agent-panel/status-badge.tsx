import React from 'react'
import type { StatusRow } from './types'
import { Icon, type IconName } from '../Icon'

/* Pure status register: five marks, monochrome, coloured entirely by the row's state class. */
const ICON: Record<StatusRow['state'], IconName> = {
  ok: 'check',
  running: 'dot',
  idle: 'circle',
  error: 'close',
  warning: 'alert'
}

/** A small icon + label + value health chip used in the Workspace Health section. */
export function StatusBadge({ row }: { row: StatusRow }): React.JSX.Element {
  return (
    <div className={`ap-status ap-status-${row.state}`}>
      <span className={`ap-status-dot ${row.state === 'running' ? 'pulse' : ''}`}>
        <Icon name={ICON[row.state]} size={row.state === 'running' ? 9 : 12} />
      </span>
      <span className="ap-status-label">{row.label}</span>
      <span className="ap-status-value">{row.value}</span>
    </div>
  )
}