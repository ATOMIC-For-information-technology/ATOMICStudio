import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../Icon'
import type { BlastRadius, ConfigAdvisory, StagedSecretGuard } from '../../../../shared/types'
import type { AppliedFile, DiffFile } from './types'
import { EmptyState } from './empty-state'
import { DiffLines } from '../DiffLines'

/** Animates a number toward `target` over `duration`ms — used to count diff stats up/down on change. */
function useCountUp(target: number, duration = 350): number {
  const [display, setDisplay] = useState(target)
  const prevRef = useRef(target)

  useEffect(() => {
    const from = prevRef.current
    const to = target
    prevRef.current = target
    if (from === to) return
    let raf = 0
    const start = performance.now()
    const tick = (t: number): void => {
      const p = Math.min(1, (t - start) / duration)
      setDisplay(Math.round(from + (to - from) * p))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])

  return display
}

/** The +added / −removed line-count pair, counting up from its previous value on change. */
function DiffStats({ added, removed }: { added: number; removed: number }): React.JSX.Element {
  const a = useCountUp(added)
  const r = useCountUp(removed)
  return (
    <span className="diff-stats">
      <span className="add">+{a}</span> <span className="del">−{r}</span>
    </span>
  )
}

interface Props {
  files: DiffFile[]
  applied: AppliedFile[]
  /** Blast Radius per path, async-enriched by the container from the import graph. */
  blast: Record<string, BlastRadius>
  /** Wiring/Config advisory per path (package.json, .env, CI…). */
  config: Record<string, ConfigAdvisory>
  /** Secret Leak Guard hits per path — staged edits only, never carries the value. */
  secrets: Record<string, StagedSecretGuard>
  onApply: (ids: string[] | 'all') => void
  onReject: (ids: string[] | 'all') => void
}

/** Short blast-radius chip text; the full plain-English summary lives in the title. */
function blastText(b: BlastRadius): string {
  if (b.isEntry) return 'entry point'
  if (b.band === 'high') return `${b.reach} rely on it`
  if (b.band === 'medium') return b.dependents === 1 ? '1 file depends on it' : `${b.dependents} files depend on it`
  return 'low impact'
}

/** Blast Radius chip — shared by staged and applied cards. The full explanation
 *  is duplicated onto aria-label so it reaches screen readers, not just mouse hover. */
function BlastChip({ blast }: { blast: BlastRadius }): React.JSX.Element {
  return (
    <span className={`blast-chip blast-${blast.band}`} title={blast.summary} aria-label={blast.summary}>
      {blastText(blast)}
    </span>
  )
}

/** Wiring/Config chip — only on well-known plumbing files, never ordinary code. */
function WiringChip({ advisory }: { advisory: ConfigAdvisory }): React.JSX.Element | null {
  if (!advisory.sensitive) return null
  return (
    <span className="wiring-chip" title={advisory.why} aria-label={`${advisory.label} — ${advisory.why}`}>
      <Icon name="settings" size={11} /> {advisory.label}
    </span>
  )
}

/**
 * Section 6 — Diff Preview. Pending staged edits live in `.staged` (Apply /
 * Reject per file and for all — the existing staged-edit workflow); applied
 * edits move to `.staged.applied` with their verify badge. Both card kinds
 * carry the guardrail chips: confidence, blind-edit, blast radius, wiring —
 * and staged cards additionally show the Secret Leak Guard.
 */
export function DiffPreview({ files, applied, blast, config, secrets, onApply, onReject }: Props): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)

  if (files.length === 0 && applied.length === 0) {
    return <EmptyState icon="pencil" text="No changes yet — diffs will appear here once the agent edits files." />
  }

  return (
    <div className="ap-diff">
      {files.length > 0 && (
        <div className="staged">
          <div className="staged-head">
            Proposed changes ({files.length})
            <span className="spacer" />
            <button type="button" className="btn btn-sm" onClick={() => onApply('all')}>
              Apply all
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onReject('all')}>
              Reject all
            </button>
          </div>
          {files.map((f) => {
            const open = openId === f.id
            const b = blast[f.path]
            const cfg = config[f.path]
            const secret = secrets[f.path]
            return (
              <div key={f.id} className="diff-card">
                <button
                  type="button"
                  className="diff-title"
                  onClick={() => setOpenId(open ? null : f.id)}
                  aria-expanded={open}
                >
                  <span className="diff-caret"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} /></span>
                  <span className="diff-file" title={f.path}>{f.path}</span>
                  <span className={`conf-meter ${f.confidenceClass}`}>
                    {f.confidence}% <span className="conf-basis">{f.confidenceBasis}</span>
                  </span>
                  {f.blind && <span className="blindedit-chip"><Icon name="alert" size={10} /> didn't read first</span>}
                  {b && <BlastChip blast={b} />}
                  {cfg && <WiringChip advisory={cfg} />}
                  {secret && (
                    <span className="secret-chip" title={secret.message} aria-label={`possible secret — held for review — ${secret.message}`}>
                      <Icon name="lock" size={10} /> possible secret — held for review
                    </span>
                  )}
                  <DiffStats added={f.added} removed={f.removed} />
                </button>
                {open && <DiffLines lines={f.diff} />}
                <div className="diff-actions">
                  <button type="button" className="btn btn-sm" onClick={() => onApply([f.id])}>
                    Apply
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => onReject([f.id])}>
                    Reject
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {applied.length > 0 && (
        <div className="staged applied">
          <div className="staged-head">Recently applied ({applied.length})</div>
          {applied.map((a) => {
            const b = blast[a.path]
            const cfg = config[a.path]
            return (
              <div className="diff-card applied-card" key={a.key}>
                <div className="diff-title">
                  <span className="diff-file" title={a.path}>{a.path}</span>
                  {a.verify === 'verified' ? (
                    <span className="conf-meter conf-high"><Icon name="check" size={11} /> {a.confidence}% verified</span>
                  ) : a.verify === 'failed' ? (
                    <span className="conf-meter conf-low">{a.confidence}% check failed</span>
                  ) : (
                    <span className="conf-meter conf-mid">{a.confidence}% unchecked</span>
                  )}
                  {a.blind && <span className="blindedit-chip"><Icon name="alert" size={10} /> didn't read first</span>}
                  {b && <BlastChip blast={b} />}
                  {cfg && <WiringChip advisory={cfg} />}
                  <DiffStats added={a.added} removed={a.removed} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
