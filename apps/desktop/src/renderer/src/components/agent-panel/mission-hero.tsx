import React from 'react'
import { Icon } from '../Icon'
import { ProgressBar } from './progress-bar'
import type { MissionPhase } from './types'

interface Props {
  /** The mission objective (2-line clamped in the hero). */
  objective: string
  phase: MissionPhase
  /** 0..1 overall progress once edits exist, else null (indeterminate). */
  progress: number | null
  /** True while a run is in flight — drives the indeterminate shimmer. */
  running: boolean
  /** The live tool call in flight ("read_file: src/main.tsx"), null when idle or between steps. */
  currentTask: string | null
  currentFile: string | null
  /** staged + applied edits this session. */
  filesChanged: number
  /** Rounded mean confidence across staged + applied edits, null when no edits. */
  confidence: number | null
}

/**
 * The Mission hero — the panel's visual center, pinned directly under the
 * Multi-Agent Board. Larger type, the honest phase pill, an animated progress
 * bar (determinate once edits exist, a shimmer while the first run is still
 * exploring), and a chip row of real facts: current file, files changed,
 * mean confidence. Idle collapses to a calm empty hero, not a loud box.
 */
export function MissionHero({ objective, phase, progress, running, currentTask, currentFile, filesChanged, confidence }: Props): React.JSX.Element {
  if (phase === 'Idle') {
    return (
      <div className="ap-hero ap-hero-idle">
        <span className="ap-hero-idle-icon"><Icon name="target" size={15} /></span>
        <span className="ap-hero-idle-text">No active mission — describe what you want built below.</span>
      </div>
    )
  }

  // Progress hides when idle; shimmers while running before the first edit;
  // becomes the determinate applied/(applied+staged) proxy once edits exist.
  const showProgress = running || progress !== null

  return (
    <div className="ap-hero">
      <div className="ap-hero-kicker">Mission</div>
      <div className="ap-hero-title" title={objective}>{objective || '—'}</div>
      {currentTask && (
        <div className="ap-hero-task" title={currentTask}>
          <Icon name="play" size={11} /> {currentTask}
        </div>
      )}

      <div className="ap-hero-phase-row">
        <span className={`ap-hero-phase phase-${phase.toLowerCase()}`}>{phase}</span>
        {showProgress && (
          <div className="ap-hero-progress">
            <ProgressBar value={progress ?? 0} indeterminate={progress === null} />
            {progress !== null && <span className="ap-hero-pct">{Math.round(progress * 100)}%</span>}
          </div>
        )}
      </div>

      <div className="ap-hero-chips">
        {currentFile && (
          // The file mark sits OUTSIDE the ellipsised text, not inside it — when it was part of the
          // truncated string it consumed ~2 characters of an already-tight chip, eating into
          // the filename, which is the only part worth reading.
          <span className="ap-hero-chip ap-hero-file" title={currentFile}>
            <span className="ap-hero-file-icon" aria-hidden="true"><Icon name="file-text" size={13} /></span>
            <span className="ap-hero-file-name">{currentFile}</span>
          </span>
        )}
        {filesChanged > 0 && (
          <span className="ap-hero-chip" title="Files changed this session (staged + applied)">
            {filesChanged} file{filesChanged === 1 ? '' : 's'}
          </span>
        )}
        {confidence !== null && (
          <span className="ap-hero-chip" title="Mean confidence across staged + applied edits">
            conf {confidence}%
          </span>
        )}
      </div>
    </div>
  )
}
