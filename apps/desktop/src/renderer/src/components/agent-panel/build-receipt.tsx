import React from 'react'
import { Icon } from '../Icon'
import type { BuildReceipt } from '../../../../shared/types'

interface Props {
  receipt: BuildReceipt
  /** Undo the whole run via its restore point. */
  onRollback: (rollbackId: string) => void
  rollingBack?: boolean
}

const fmtBytes = (n: number): string => {
  const abs = Math.abs(n)
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  if (abs < 1024) return `${sign}${abs} B`
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`
  return `${sign}${(abs / (1024 * 1024)).toFixed(1)} MB`
}

const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * The AI Build Receipt — what the run actually did, in evidence.
 *
 * Competitors end a run with a paragraph. This ends it with measurements: which files changed and by
 * how much, whether the checks passed, how long it took, what it cost, a screenshot of the feature
 * working, and a button that undoes all of it. For someone who cannot read the diff, this is the
 * only artifact that answers "did it work, and can I get back?".
 *
 * What is NOT here is deliberate: no performance or bundle delta, because measuring either honestly
 * means running the project's build and a benchmark. A number this app cannot stand behind would
 * undermine every number that sits next to it.
 */
export function BuildReceiptCard({ receipt, onRollback, rollingBack }: Props): React.JSX.Element {
  const { checks, files, tokens } = receipt
  const allPassed = checks.ran > 0 && checks.passed === checks.ran
  const anyFailed = checks.ran > 0 && checks.passed < checks.ran

  return (
    <div className="receipt">
      <div className="receipt-head">
        <span className={`receipt-verdict ${anyFailed ? 'bad' : allPassed ? 'good' : ''}`}>
          <Icon name={anyFailed ? 'alert' : allPassed ? 'check' : 'circle'} size={12} />
          {anyFailed ? 'Checks failed' : allPassed ? 'Checks passed' : 'Done'}
        </span>
        <span className="receipt-title" title={receipt.summary}>{receipt.summary}</span>
      </div>

      {receipt.snapshot && (
        <img className="receipt-shot" src={receipt.snapshot} alt="The preview after the agent used the app" />
      )}

      {files.length > 0 && (
        <div className="receipt-files">
          {files.map((f) => (
            <div key={f.path} className="receipt-file">
              <span className={`receipt-check ${f.verified === false ? 'bad' : f.verified ? 'good' : 'muted'}`}>
                <Icon name={f.verified === false ? 'close' : f.verified ? 'check' : 'circle'} size={10} />
              </span>
              <span className="receipt-path" title={f.error || f.path}>{f.path}</span>
              <span className="receipt-lines">
                <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
              </span>
              <span className="receipt-bytes">{fmtBytes(f.bytesDelta)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Every figure below was measured during the run. */}
      <div className="receipt-stats">
        <span title="Files this run changed on disk">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        <span title="Total size change of those files">{fmtBytes(receipt.bytesDelta)}</span>
        <span title="Syntax checks that ran after each edit">
          {checks.ran > 0 ? `${checks.passed}/${checks.ran} checks` : 'no checks'}
        </span>
        <span title="Wall-clock time from start to done">{fmtDuration(receipt.durationMs)}</span>
        <span title={`${tokens.requests} model request${tokens.requests === 1 ? '' : 's'}${tokens.model ? ` · ${tokens.model}` : ''}`}>
          ~{tokens.estTokens.toLocaleString()} tokens
        </span>
        {receipt.confidence !== null && (
          <span title="How many of the files it changed it had actually read first">
            {Math.round(receipt.confidence * 100)}% read-first
          </span>
        )}
      </div>

      <div className="receipt-actions">
        {receipt.rollbackId ? (
          <button
            className="btn btn-sm btn-danger"
            disabled={rollingBack}
            title="Put every file back to how it was before this run"
            onClick={() => onRollback(receipt.rollbackId as string)}
          >
            {rollingBack ? 'Rolling back…' : <><Icon name="undo" size={11} /> Undo this whole run</>}
          </button>
        ) : (
          /* Plan mode takes no restore point because it changes nothing — say so rather than
             showing a dead button. */
          <span className="muted small">Nothing to undo — this run only proposed changes.</span>
        )}
      </div>
    </div>
  )
}
