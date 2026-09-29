import React, { useMemo, useState } from 'react'
import { Icon } from './Icon'
import type { DesignReview, DiffLine, TokenApplyPlan } from '../../../shared/types'
import { extractTokens } from '../../../shared/design-tokens'

interface Props {
  design: DesignReview
  projectPath: string
  /** Bump the IDE's refresh key + re-run the review after a successful apply. */
  /** The files that were actually rewritten — the caller must re-read any open tab for them, or a
   *  stale buffer would silently write the old content back on the next save. */
  onApplied: (writtenFiles: string[]) => void
}

/**
 * Design tokens: the suggested :root block (copyable) plus a SAFE, preview-first Apply.
 * "Preview apply" plans a per-file hex→var(--token) rewrite (writes nothing); the user
 * unchecks any file, picks where the :root block lands, then Apply writes the opted-in
 * files under one checkpoint (revert in one click via Time-Machine / Undo).
 */
export function ApplyTokensPanel({ design, projectPath, onApplied }: Props): React.JSX.Element | null {
  const tok = useMemo(() => extractTokens(design), [design])
  const [plans, setPlans] = useState<TokenApplyPlan[] | null>(null)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [target, setTarget] = useState('')
  const [openDiff, setOpenDiff] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  if (!tok.tokens.length) return null

  const preview = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const p = await window.studio.planApplyTokens(projectPath, tok.tokens)
      setPlans(p)
      setChecked(Object.fromEntries(p.map((x) => [x.file, true]))) // all opted-in by default
      // Default the :root block into the file with the most replacements (else a new sheet).
      setTarget(p.length ? [...p].sort((a, b) => b.replacements - a.replacements)[0].file : 'tokens.css')
    } finally {
      setBusy(false) // never leave the button stuck disabled if the IPC ever rejects
    }
  }

  const apply = async (): Promise<void> => {
    const files = Object.keys(checked).filter((f) => checked[f])
    setBusy(true)
    let res: Awaited<ReturnType<typeof window.studio.applyTokens>>
    try {
      res = await window.studio.applyTokens(projectPath, files, tok.tokens, tok.css, target || 'tokens.css')
    } finally {
      setBusy(false)
    }
    if (res.ok) {
      setResult(`Applied to ${res.filesWritten} file${res.filesWritten === 1 ? '' : 's'} — undo in one click.`)
      setPlans(null)
      onApplied([...files, target || 'tokens.css'])
    } else {
      setResult(`Apply failed: ${res.error ?? 'unknown error'}`)
    }
  }

  const totalReplacements = (plans ?? []).filter((p) => checked[p.file]).reduce((n, p) => n + p.replacements, 0)

  return (
    <div className="design-tokens">
      <div className="git-row">
        <span className="muted small">Suggested tokens ({tok.tokens.length}) — adopt these to stop hardcoding colors:</span>
        <span className="spacer" />
        <button className="btn btn-sm" title="Copy the :root tokens block" onClick={() => { const c = navigator.clipboard; if (c) void c.writeText(tok.css).catch(() => {}) }}>Extract tokens</button>
        <button className="btn btn-sm btn-primary" disabled={busy} title="Preview which files would change" onClick={() => void preview()}>Preview apply</button>
      </div>
      <pre className="token-block">{tok.css}</pre>

      {result && <div className="apply-result muted small">{result}</div>}

      {plans && (
        <div className="apply-preview">
          {plans.length === 0 ? (
            <div className="muted small">No hardcoded hex colors to replace in the stylesheets.</div>
          ) : (
            <>
              <div className="settings-subhead">Preview — {plans.length} file{plans.length === 1 ? '' : 's'}, {totalReplacements} replacement{totalReplacements === 1 ? '' : 's'}</div>
              {plans.map((p) => (
                <React.Fragment key={p.file}>
                  <div className="debt-row apply-row">
                    <label className="apply-check">
                      <input type="checkbox" checked={!!checked[p.file]} onChange={(e) => setChecked((c) => ({ ...c, [p.file]: e.target.checked }))} />
                    </label>
                    <span className="debt-detail apply-file"><b>{p.file}</b> <span className="muted small">— {p.replacements} replacement{p.replacements === 1 ? '' : 's'}</span></span>
                    <button className="btn btn-sm" onClick={() => setOpenDiff((d) => (d === p.file ? null : p.file))}><Icon name={openDiff === p.file ? 'chevron-down' : 'chevron-right'} size={11} /> Diff</button>
                  </div>
                  {openDiff === p.file && (
                    <pre className="diff-body">
                      {p.diff.map((l: DiffLine, k) => (
                        <div key={k} className={`dl dl-${l.kind}`}>
                          {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}
                          {l.text}
                        </div>
                      ))}
                    </pre>
                  )}
                </React.Fragment>
              ))}
              <div className="git-row apply-actions">
                <label className="muted small">Add :root block to:
                  <select className="text-input apply-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                    {plans.map((p) => <option key={p.file} value={p.file}>{p.file}</option>)}
                    <option value="tokens.css">tokens.css (new file)</option>
                  </select>
                </label>
                <span className="spacer" />
                <button className="btn btn-sm" disabled={busy} onClick={() => { setPlans(null); setOpenDiff(null) }}>Cancel</button>
                <button className="btn btn-sm btn-primary" disabled={busy || totalReplacements === 0} title="Rewrite the opted-in files (one-click undo)" onClick={() => void apply()}>Apply tokens</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
