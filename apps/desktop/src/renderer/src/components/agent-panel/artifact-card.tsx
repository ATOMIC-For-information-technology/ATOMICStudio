import React from 'react'
import { Icon } from '../Icon'
import type { Artifact } from './types'

/**
 * One reusable artifact card (Section 4). Replaces giant AI messages: instead of
 * dumping a long report into the chat, the agent produces a compact card that
 * opens a side sheet with the full body.
 */
export function ArtifactCard({ artifact, onOpen }: { artifact: Artifact; onOpen: (a: Artifact) => void }): React.JSX.Element {
  return (
    <button type="button" className="ap-artifact" onClick={() => onOpen(artifact)} title={`Open ${artifact.title}`}>
      <span className="ap-artifact-icon"><Icon name={artifact.icon} size={16} /></span>
      <span className="ap-artifact-text">
        <span className="ap-artifact-title">{artifact.title}</span>
        <span className="ap-artifact-summary">{artifact.summary}</span>
      </span>
      <span className="ap-artifact-open">Open ›</span>
    </button>
  )
}