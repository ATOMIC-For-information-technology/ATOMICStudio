import React from 'react'
import type { ContextData } from './types'
import { EmptyState } from './empty-state'

/**
 * Section 3b — Active Context. Where the agent currently lives in the
 * project: workspace, current folder, current file, and how many files
 * depend on it (a count straight off the real blast-radius graph — never
 * invented file names). Replaces the old flat Active Files chip list, which
 * had no "where am I" signal at all.
 */
export function ActiveContext({ context }: { context: ContextData }): React.JSX.Element {
  if (!context.currentFile) {
    return <EmptyState icon="compass" text="Working context appears here once a file is touched." />
  }
  return (
    <div className="ap-context">
      <div className="ap-context-row">
        <span className="ap-context-k">Workspace</span>
        <span className="ap-context-v">{context.workspace}</span>
      </div>
      {context.folder && (
        <div className="ap-context-row">
          <span className="ap-context-k">Folder</span>
          <span className="ap-context-v mono">{context.folder}</span>
        </div>
      )}
      <div className="ap-context-row">
        <span className="ap-context-k">File</span>
        <span className="ap-context-v mono current">{context.currentFile}</span>
      </div>
      {context.dependents !== null && context.dependents > 0 && (
        <div className="ap-context-row">
          <span className="ap-context-k">Depended on by</span>
          <span className="ap-context-v">
            {context.dependents} file{context.dependents === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </div>
  )
}
