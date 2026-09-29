import React from 'react'
import { Icon } from '../Icon'
import { repoNameError } from '../../../../shared/gitnames'
import type { PublishPlan, PublishResult } from '../../../../shared/types'

interface Props {
  name: string
  onNameChange: (v: string) => void
  /**
   * Null the INSTANT the name changes (structural, not just while planning) and until a response
   * for that exact name comes back — so a stale or out-of-order re-plan can never be displayed
   * beside a name it wasn't for, and Create can never fire for a name whose command isn't the one
   * on screen.
   */
  plan: PublishPlan | null
  /** True while a (side-effect-free) re-plan is in flight after the name changed. */
  planning: boolean
  /** Set when the CURRENT name's re-plan came back with an error — shown instead of the generic
   *  "enter a name" hint, since a name was in fact entered. */
  planError: string | null
  /** True while `gitPublishRun` is in flight — the only call in this file with side effects. */
  busy: boolean
  result: PublishResult | null
  onConfirm: () => void
  onClose: () => void
}

/**
 * "Publish this folder" — turns a plain directory into a repository on the user's own server.
 *
 * The product promise this screen exists to keep: Studio shows the LITERAL action it will take on
 * the server before taking it — `plan.command`, verbatim, in a `<pre>`, always visible above the
 * confirm button, never behind a disclosure. `onConfirm` is the only path to `gitPublishRun`; this
 * component never calls it itself on open, on a name keystroke, or on blur.
 *
 * On a MANAGED seat that action is a control-plane API call rather than a shell command, because a
 * managed server's git account has no shell to run one in. The `<pre>` says so rather than showing
 * a `git init --bare` that would never run — a screen whose whole job is honesty cannot show the
 * wrong mechanism.
 *
 * `pushed: false` is a SUCCESS (an empty folder legitimately gets `origin` wired with nothing to
 * push) and is worded as such, never as a bare "Done" and never as an error. A failure's `error`
 * is shown exactly as the main process phrased it — "already exists… clone it instead" is the one
 * most people will see, and rewording it into something vaguer would undo the whole point of it.
 */
export function PublishSheet({ name, onNameChange, plan, planning, planError, busy, result, onConfirm, onClose }: Props): React.JSX.Element {
  const nameError = repoNameError(name)
  const succeeded = result?.ok === true
  // `!planning` matters as much as the others: without it, Create stays clickable for the ~400ms
  // a re-plan is in flight, and `gitPublishRun` could fire for a name whose `<pre>` still shows
  // the PREVIOUS name's command — the exact mismatch this screen exists to prevent.
  const canConfirm = !nameError && !!plan && plan.preflight.ok && !busy && !planning && !succeeded

  return (
    <div className="scm-clone ps-sheet" role="group" aria-label="Publish this folder">
      <div className="scm-clone-head">
        <span className="scm-kicker">Publish this folder</span>
        <span className="spacer" />
        <button type="button" className="scm-icon-btn" onClick={onClose} aria-label="Close publish" title="Close">
          <Icon name="close" size={12} />
        </button>
      </div>

      <label className="scm-clone-row">
        <input
          className="text-input"
          placeholder="repository-name"
          aria-label="Repository name"
          autoFocus
          disabled={busy || succeeded}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
        />
      </label>
      {nameError && <p className="ps-hint muted small">{nameError}</p>}

      {plan && (
        <ul className="gs-ladder">
          {plan.preflight.steps.map((s) => (
            <li key={s.id} className={`gs-step ${s.ok ? 'ok' : 'bad'}`} data-ok={String(s.ok)}>
              <Icon name={s.ok ? 'check' : 'close'} size={13} />
              <span>{s.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {plan && !plan.preflight.ok && !result && (
        <p className="ps-hint muted small">Fix this in Settings → Git server, then reopen this sheet.</p>
      )}

      {/* The command, verbatim from the main process — never reconstructed here, and never
          shown for a name that has not actually been planned (a stale command for a different
          name would be worse than none). */}
      {plan && !nameError ? (
        <>
          <pre className="ps-command">{plan.command}</pre>
          {plan.managed && (
            <p className="ps-hint muted small">
              Your organisation&rsquo;s server creates this for you — Studio never runs commands on it.
            </p>
          )}
        </>
      ) : (
        <p className="ps-hint muted small">
          {planning ? 'Checking the server…' : planError ? planError : 'Enter a name to see the exact command.'}
        </p>
      )}

      {result && (
        <div className={`scm-strip ${result.ok ? 'ps-strip-ok' : 'scm-strip-warn'}`} role="status">
          {result.ok
            ? result.pushed
              ? `Published — origin is ${result.url}.`
              : `origin is set — nothing to push yet. (${result.url})`
            : result.error}
        </div>
      )}

      <div className="gs-actions">
        <button type="button" className="btn btn-sm" onClick={onClose}>
          {succeeded ? 'Close' : 'Cancel'}
        </button>
        {!succeeded && (
          <button type="button" className="btn btn-sm btn-primary" disabled={!canConfirm} onClick={onConfirm}>
            {busy ? 'Creating…' : 'Create repository'}
          </button>
        )}
      </div>
    </div>
  )
}
