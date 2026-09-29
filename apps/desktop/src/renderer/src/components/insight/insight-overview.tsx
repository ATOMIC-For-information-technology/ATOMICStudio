import React from 'react'
import { Icon } from '../Icon'
import { InsightEmpty } from './insight-empty-state'
import { formatChangedFiles } from '../../../../shared/worksafety'
import { moreLine } from '../../../../shared/coverage'
import type { ActionItem, ActionPlan, FixVerification } from '../../../../shared/actionplan'
import type { DiffLine } from '../../../../shared/types'
import { goTarget } from './derive'
import type { Health } from './derive'
import type { OverviewData, Verdict } from './types'
import type { AppPassport, SettingsCheckup } from '../../../../shared/passport'

interface Props {
  data: OverviewData
  verdict: Verdict
  plan: ActionPlan
  health: Health | null
  passport: AppPassport
  checkup: SettingsCheckup
  analytics: { score: number }[]
  explainText: string
  explainBusy: boolean
  backupBusy: boolean
  genTestMsg: string | null
  verifyResult: FixVerification | null
  restoreDiff: { file: string; inBackup: boolean; lines: DiffLine[] } | null
  restoreArmed: boolean
  canGenerateTests: boolean
  onPrimary: () => void
  onFixWithAi: (item: ActionItem) => void
  /** Show me the evidence for this row — see `goTarget`. Not offered when there is nowhere to go. */
  onGo: (item: ActionItem) => void
  onGenerateTests: () => void
  onExplain: () => void
  onCompare: (file: string) => void
  onArmRestore: (armed: boolean) => void
  onRestore: (file: string) => void
  onCloseDiff: () => void
  onCopyHandoff: () => void
}

/**
 * The first screen, and the one that has to answer four questions before the user reads anything:
 * is my work saved, is this ready to ship, what should I do next, what IS this project.
 *
 * One verdict, not three. The panel this replaces stacked Work Safety, Ship Readiness and a /100
 * Health score as three equally-loud cards, and because they answer different questions they
 * routinely disagreed — leaving the user to arbitrate. They are ordered here by what is
 * irreversible (see `deriveVerdict`), and the two that lost are still on screen, one line each,
 * beneath the one that won.
 *
 * The score keeps its place as a measurement among measurements. It is arithmetic over signals we
 * may not have gathered, so it can never outrank a blocker we actually found.
 */
export function InsightOverview(props: Props): React.JSX.Element {
  const { data, verdict, plan, health, passport, checkup, analytics } = props
  const safety = data.safety.data
  const top = plan.items.slice(0, 3)

  return (
    <div className="iv-overview">
      {/* ── the one verdict ─────────────────────────────────────────────────────────── */}
      <div className={`iv-verdict iv-band-${verdict.band}`}>
        <div className="iv-verdict-row">
          <span className={`iv-band-dot band-${verdict.band}`} aria-hidden="true"><Icon name="dot" size={14} /></span>
          <p className="iv-verdict-text">{verdict.headline}</p>
          {verdict.action && (
            <button type="button" className="btn btn-primary iv-primary" onClick={props.onPrimary} disabled={props.backupBusy} title={verdict.action.why}>
              {props.backupBusy && verdict.action.id === 'backup' ? 'Backing up…' : verdict.action.label}
            </button>
          )}
        </div>
        {/* The explanations, under the headline and above the three states. One of these is the
            reason the primary button is missing on a nested project — without it the card states a
            problem, withholds the control that would fix it, and says nothing about why. */}
        {verdict.notes.length > 0 && (
          <ul className="iv-verdict-notes">
            {verdict.notes.map((n) => (
              <li key={n} className="muted small">{n}</li>
            ))}
          </ul>
        )}
        <ul className="iv-support">
          {verdict.supporting.map((s) => (
            <li key={s.label} className="iv-support-row">
              <span className={`iv-support-dot band-${s.band}`} aria-hidden="true"><Icon name="dot" size={9} /></span>
              <span className="iv-support-label">{s.label}</span>
              <span className="iv-support-state">{s.state}</span>
            </li>
          ))}
        </ul>
      </div>

      {props.verifyResult && <div className={`verify-box verify-${props.verifyResult.status}`}>{props.verifyResult.headline}</div>}

      {/* ── do these next ───────────────────────────────────────────────────────────── */}
      <section className="iv-block">
        <h3 className="iv-h">Do these next</h3>
        {/* OUTSIDE the branch below, because generating tests is what empties it. The confirmation
            used to live in the non-empty arm, so a successful run removed the "add tests" item,
            left the plan with nothing in it, and took the receipt down with the work that earned
            it — the clearer the success, the more certainly it was hidden. A message about what
            the user just did does not belong to the plan's state at all. */}
        {props.genTestMsg && <p className="muted small">{props.genTestMsg}</p>}
        {top.length === 0 ? (
          <InsightEmpty
            icon="check"
            title="Nothing is waiting on you."
            detail={plan.items.length === 0 && data.insight.phase === 'not-run' ? 'Run a project review to be sure.' : 'Everything found so far is handled.'}
          />
        ) : (
          <>
            <p className="muted small iv-plan-summary">{plan.summary}</p>
            <ul className="iv-list action-plan">
              {top.map((it, i) => (
                <li key={i} className={`iv-row action-row iv-sev-${it.severity}`}>
                  <span className={`iv-sev ws-badge iv-sev-tag-${it.severity}`}>{it.severity}</span>
                  <span className="iv-row-text debt-detail"><b>{it.title}</b> — {it.detail}</span>
                  {/* Go before Fix with AI: looking is the cheaper, reversible option, so it reads
                      first. Rendered only when `goTarget` has somewhere real to send the reader. */}
                  {goTarget(it) && (
                    <button type="button" className="btn btn-sm" onClick={() => props.onGo(it)} title="Show me what this is about">
                      Go
                    </button>
                  )}
                  {(it.kind === 'security' || it.kind === 'debt' || it.kind === 'design' || it.kind === 'deps') && (
                    <button type="button" className="btn btn-sm" onClick={() => props.onFixWithAi(it)} title="Opens the agent with a ready-to-run instruction. You still press Send.">
                      Fix with AI
                    </button>
                  )}
                  {it.kind === 'tests' && props.canGenerateTests && (
                    <button type="button" className="btn btn-sm" onClick={props.onGenerateTests} title="Creates a test file for the file open in the editor">
                      Generate tests
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {plan.items.length > top.length && (
              <p className="muted small">{plan.items.length - top.length} more in Review.</p>
            )}
          </>
        )}
      </section>

      <div className="iv-cols">
        {/* ── what this project is ──────────────────────────────────────────────────── */}
        <section className="iv-block">
          <h3 className="iv-h">This project</h3>
          {health ? (
            <div className="iv-tiles">
              <span className="iv-tile">{health.files} files</span>
              <span className="iv-tile">{health.definitions} definitions</span>
              <span className="iv-tile">{health.debtCount} debt signals</span>
              <span className="iv-tile">{health.deps} dependencies</span>
              <span className="iv-tile">tests: {health.testsKnown === 'yes' ? 'found' : health.testsKnown === 'no' ? 'none found' : 'not sure'}</span>
              <span className="iv-tile">{health.secrets === null ? 'secrets: not checked' : `${health.secrets} secret${health.secrets === 1 ? '' : 's'}`}</span>
              <span className="iv-tile iv-tile-score" title="A rough score over the signals gathered so far. It cannot see what has not been checked, so it never outranks a real finding.">
                health {health.score}/100
              </span>
            </div>
          ) : (
            <InsightEmpty title="Not read yet." detail="The project index is still building." />
          )}
          {data.insight.caveat && <p className="iv-caveat muted small"><Icon name="alert" size={10} /> {data.insight.caveat}</p>}
          {analytics.length > 1 && (
            <div className="iv-spark health-spark" title={`Health across ${analytics.length} snapshots`}>
              <svg className="spark-svg" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
                <polyline
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  points={analytics.map((a, i) => `${(i / (analytics.length - 1)) * 100},${23 - (Math.max(0, Math.min(100, a.score)) / 100) * 22}`).join(' ')}
                />
              </svg>
              <span className="muted small">health over {analytics.length} days</span>
            </div>
          )}
          {(passport.builtWith.length > 0 || passport.startsAt.length > 0 || passport.stores.length > 0) && (
            <dl className="iv-facts app-passport">
              {passport.builtWith.length > 0 && (<><dt>Built with</dt><dd>{passport.builtWith.join(', ')}</dd></>)}
              {passport.startsAt.length > 0 && (<><dt>Starts at</dt><dd>{passport.startsAt.join(', ')}</dd></>)}
              {passport.stores.length > 0 && (<><dt>Stores</dt><dd>{passport.stores.join(', ')}</dd></>)}
            </dl>
          )}
          <div className="iv-actions">
            <button type="button" className="btn btn-sm" onClick={props.onExplain} disabled={props.explainBusy}>
              {props.explainBusy ? 'Reading your project…' : 'Explain this project'}
            </button>
            {(passport.builtWith.length > 0 || passport.startsAt.length > 0) && (
              <button type="button" className="btn btn-sm" onClick={props.onCopyHandoff} title="Copy a plain-text brief to paste to a developer or another AI">
                Copy handoff summary
              </button>
            )}
          </div>
          {props.explainText && <pre className="iv-explain insight-explain">{props.explainText}</pre>}
          {(checkup.needed.length > 0 || checkup.unused.length > 0) && (
            <div className="iv-checkup settings-checkup">
              <h4 className="iv-h4">Settings checkup</h4>
              {checkup.needed.map((name) => (
                <div key={name} className="iv-row"><span className="iv-sev iv-sev-tag-medium">needs</span><span className="iv-row-text debt-detail">{name}</span></div>
              ))}
              {checkup.unused.map((u) => (
                <div key={u.name} className="iv-row">
                  <span className="iv-sev ws-badge">unused</span>
                  <span className="iv-row-text debt-detail">{u.name}{u.hint && <span className="muted small"> — possible match: {u.hint}</span>}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── changes since the last backup ─────────────────────────────────────────── */}
        <section className="iv-block">
          <h3 className="iv-h">Since your last backup</h3>
          {data.safety.phase === 'error' && <p className="iv-caveat iv-caveat-error small">Could not read this project's git state.</p>}
          {safety && safety.changed.length === 0 && (
            <InsightEmpty icon="check" title="Nothing has changed since your last backup." />
          )}
          {safety && safety.changed.length > 0 && (
            <>
              <ul className="iv-list changed-files">
                {safety.changed.slice(0, 40).map((c) => (
                  <li key={c.file} className={`iv-row changed-row changed-${c.kind}`}>
                    <span className="iv-row-text debt-detail">{formatChangedFiles(c)}</span>
                    <button type="button" className="btn btn-sm" onClick={() => props.onCompare(c.file)} title="A read-only before/after against your last backup">
                      Compare
                    </button>
                  </li>
                ))}
              </ul>
              {moreLine(Math.min(safety.changed.length, 40), safety.total) && (
                <p className="muted small">{moreLine(Math.min(safety.changed.length, 40), safety.total)}</p>
              )}
              {data.safety.caveat && <p className="iv-caveat muted small"><Icon name="alert" size={10} /> {data.safety.caveat}</p>}
            </>
          )}
        </section>
      </div>

      {/* ── compare / restore, with its confirmation intact ───────────────────────────── */}
      {props.restoreDiff && (
        <section className="iv-block iv-restore restore-diff">
          <div className="iv-restore-head">
            <h3 className="iv-h">{props.restoreDiff.file} — now vs last backup</h3>
            <span className="spacer" />
            <button type="button" className="btn btn-sm" onClick={props.onCloseDiff}>Close</button>
            {props.restoreDiff.inBackup && !props.restoreArmed && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => props.onArmRestore(true)} title="Overwrite the current file with its last-backup version. This is undoable.">
                Restore to last backup
              </button>
            )}
            {props.restoreDiff.inBackup && props.restoreArmed && (
              <>
                <span className="muted small">Replace the current file? (you can Undo it)</span>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => props.onRestore(props.restoreDiff!.file)}>Yes, restore</button>
                <button type="button" className="btn btn-sm" onClick={() => props.onArmRestore(false)}>Cancel</button>
              </>
            )}
          </div>
          {!props.restoreDiff.inBackup && <p className="muted small">This file wasn&apos;t in your last backup, so there&apos;s nothing to restore it to.</p>}
          <pre className="diff-body restore-diff-body">
            {props.restoreDiff.lines.map((l, k) => (
              <div key={k} className={`dl dl-${l.kind}`}>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}{l.text}</div>
            ))}
          </pre>
        </section>
      )}
    </div>
  )
}
