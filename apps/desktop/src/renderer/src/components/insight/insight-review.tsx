import React from 'react'
import { Icon } from '../Icon'
import { CheckRow } from './check-row'
import { InsightEmpty } from './insight-empty-state'
import { ApplyTokensPanel } from '../ApplyTokensPanel'
import { moreLine } from '../../../../shared/coverage'
import type { ActionItem } from '../../../../shared/actionplan'
import type { CheckId, CheckView, ReviewData } from './types'

interface Props {
  projectPath: string
  data: ReviewData
  checks: CheckView[]
  busy: boolean
  hasResults: boolean
  /** Developer Mode only — the design check and its token writer are the engineering half. */
  advanced: boolean
  canOpenFiles: boolean
  onRunAll: () => void
  onRunCheck: (id: CheckId) => void
  onOpenFileAtLine: (file: string, line?: number) => void
  onOpenFile: (path: string) => void
  onFixWithAi: (item: ActionItem) => void
  onGenerateTests: () => void
  onExportCompliance: () => void
  onTokensApplied: (written?: string[]) => void
  onCopy: (text: string) => void
}

/**
 * The project review: five checks, one workflow.
 *
 * The panel this replaces gave each check its own heading and its own full-strength primary button,
 * so five equally-loud "Check…" buttons competed down the page and none of them read as the thing
 * to press. There is one primary here — Run project review — and every individual check keeps a
 * quiet "Run again" beside its own result.
 *
 * The checks run in sequence rather than together. They read the same files, and firing five scans
 * at once is what made the old screen stall; results appear as each one lands.
 */
export function InsightReview(props: Props): React.JSX.Element {
  const { data, checks, advanced } = props
  const visible = advanced ? checks : checks.filter((c) => c.id !== 'design')
  const ranAny = props.hasResults

  return (
    <div className="iv-review">
      <div className="iv-review-head">
        <div>
          <h3 className="iv-h">Project review</h3>
          <p className="muted small">
            {ranAny ? 'Each check reports only what it read. Nothing here is assumed.' : 'Nothing has been checked yet — these all start from “not checked”, which is not the same as “passed”.'}
          </p>
        </div>
        <span className="spacer" />
        {/* Secondary, and only once there is something to export — a compliance report of an
            unreviewed project would be a document asserting nothing. */}
        {ranAny && (
          <button type="button" className="btn btn-sm" onClick={props.onExportCompliance} title="Save a shareable report (security + changes + audit)">
            <Icon name="download" size={11} /> Compliance report
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={props.onRunAll} disabled={props.busy}>
          {props.busy ? 'Reviewing…' : 'Run project review'}
        </button>
      </div>

      {visible.map((check) => (
        <CheckRow key={check.id} check={check} onRun={() => props.onRunCheck(check.id)}>
          {check.id === 'security' && data.security.data && (
            <>
              <p className={data.security.data.ok ? 'ok-box' : 'error-box'}>{data.security.data.verdict}</p>
              {moreLine(data.security.data.findings.length, data.security.data.findingsTotal ?? data.security.data.findings.length) && (
                <p className="muted small">{moreLine(data.security.data.findings.length, data.security.data.findingsTotal ?? data.security.data.findings.length)}</p>
              )}
              <ul className="iv-list">
                {data.security.data.findings.map((f, i) => (
                  <li key={i} className="iv-row">
                    <span className={`iv-sev ws-badge iv-sev-tag-${f.severity}`}>{f.severity}</span>
                    <span className="iv-row-text debt-detail" title={f.message}>
                      {f.message} <span className="muted small">{f.file}{f.line ? `:${f.line}` : ''}</span>
                    </span>
                    {f.line > 0 && props.canOpenFiles && (
                      <button type="button" className="btn btn-sm" onClick={() => props.onOpenFileAtLine(f.file, f.line)}>Open file</button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {check.id === 'dependency' && data.dependency.data && (
            <>
              <p className={data.dependency.data.ok ? 'ok-box' : 'error-box'}>{data.dependency.data.verdict}</p>
              <ul className="iv-list">
                {data.dependency.data.findings.map((f, i) => (
                  <li key={i} className="iv-row">
                    <span className={`iv-sev ws-badge iv-sev-tag-${f.severity}`}>{f.severity}</span>
                    <span className="iv-row-text debt-detail" title={f.message}>{f.message}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {check.id === 'runbook' && data.runbook.data && (
            <>
              <p className={data.runbook.data.ready === 'ready' ? 'ok-box' : 'error-box'}>{data.runbook.data.verdict}</p>
              <ul className="iv-list">
                {data.runbook.data.steps.map((s, i) => (
                  <li key={i} className="iv-row">
                    <span className={`iv-sev ws-badge iv-sev-tag-${s.severity}`}>{s.kind}</span>
                    <span className="iv-row-text debt-detail" title={s.detail}><b>{s.title}</b> — {s.detail}</span>
                    {s.command && (
                      <button type="button" className="btn btn-sm iv-cmd" title={`Copy: ${s.command}`} onClick={() => props.onCopy(s.command as string)}>
                        Copy command
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {check.id === 'design' && data.design.data && (
            <>
              <p className={data.design.data.ok ? 'ok-box' : 'error-box'}>{data.design.data.verdict}</p>
              <div className="iv-tiles">
                <span className="iv-tile">{data.design.data.hardcodedColors} hardcoded</span>
                <span className="iv-tile">{data.design.data.tokensUsed} token uses</span>
                <span className="iv-tile">{data.design.data.spacingScale.length} spacing values</span>
                <span className="iv-tile">{data.design.data.fontSizeScale.length} font sizes</span>
              </div>
              {data.design.data.palette.length > 0 && (
                <div className="iv-swatches">
                  {data.design.data.palette.slice(0, 16).map((c) => (
                    <span key={c.value} className={`design-swatch${c.isToken ? ' is-token' : ''}`} title={`${c.value} · ${c.count}×${c.isToken ? ' · token' : ''}`}>
                      <span className="swatch-dot" style={{ background: c.value }} />{c.value}
                    </span>
                  ))}
                </div>
              )}
              <ul className="iv-list">
                {data.design.data.nearDuplicates.map((p, i) => (
                  <li key={i} className="iv-row">
                    <span className="iv-sev ws-badge">near-dup</span>
                    <span className="iv-row-text debt-detail">
                      <span className="swatch-dot" style={{ background: p.a }} />{p.a} ≈ <span className="swatch-dot" style={{ background: p.b }} />{p.b} <span className="muted small">(Δ{p.distance})</span>
                    </span>
                  </li>
                ))}
              </ul>
              <ApplyTokensPanel design={data.design.data} projectPath={props.projectPath} onApplied={props.onTokensApplied} />
            </>
          )}

          {check.id === 'debt' && data.debt.data && (
            <>
              {data.debt.data.debt.length === 0 ? (
                <InsightEmpty icon="check" title="No debt signals in what was read." />
              ) : (
                <ul className="iv-list">
                  {data.debt.data.debt.map((d, i) => (
                    <li key={i} className="iv-row">
                      <span className={`iv-sev ws-badge debt-${d.kind}`}>{d.kind}</span>
                      <span className="iv-row-text debt-detail" title={d.detail}>{d.path === '(project)' ? d.detail : d.path}</span>
                      {d.path !== '(project)' && props.canOpenFiles && (
                        <button type="button" className="btn btn-sm" onClick={() => props.onOpenFile(d.path)}>Open file</button>
                      )}
                      {d.kind === 'untested' && props.canOpenFiles && (
                        <button type="button" className="btn btn-sm" onClick={props.onGenerateTests}>Generate tests</button>
                      )}
                      {d.path !== '(project)' && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => props.onFixWithAi({ severity: 'medium', kind: 'debt', title: `Clean up ${d.path}`, detail: d.detail, file: d.path })}
                        >
                          Fix with AI
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CheckRow>
      ))}
    </div>
  )
}
