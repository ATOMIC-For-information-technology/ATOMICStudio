import React from 'react'
import { Icon } from './Icon'

export type ReadinessStepState = 'checking' | 'installing' | 'ready' | 'failed'

export interface ReadinessStepView {
  id: string
  label: string
  state: ReadinessStepState
  error?: string
}

interface Props {
  steps: ReadinessStepView[]
  /** Only rendered when a step has actually failed — there's nothing to retry from 'ready'. */
  onRetry?: () => void
}

/**
 * A real step-by-step readiness/setup status, not a fake "please wait" spinner — every step here is
 * a genuine check (and, for a provider that needs one, a genuine install action) run by its caller,
 * not simulated. This component only renders whatever state its caller computed; the orchestration
 * (calling `check`, and `install` if a step has a real one) lives with whoever owns that provider's
 * setup, the same way Ollama's own start/install flow already lives in `SettingsPanel.tsx` +
 * `main/models.ts` rather than in some generic runner — a provider that's actually ready in one call
 * (like OpenCode Zen, a pure HTTPS API) has exactly one step and never shows an "installing" state,
 * because there is nothing to install.
 */
export function ReadinessWizard({ steps, onRetry }: Props): React.JSX.Element {
  const failed = steps.find((s) => s.state === 'failed')
  return (
    <div className="readiness-wizard">
      {steps.map((s) => (
        <div key={s.id} className={`readiness-step readiness-${s.state}`}>
          {s.state === 'ready' && <Icon name="check" size={12} />}
          {s.state === 'failed' && <Icon name="alert" size={12} />}
          {(s.state === 'checking' || s.state === 'installing') && <span className="readiness-spinner" aria-hidden="true" />}
          <span className="readiness-label">
            {s.label}
            {(s.state === 'checking' || s.state === 'installing') && '…'}
          </span>
        </div>
      ))}
      {failed && (
        <div className="readiness-error">
          <span className="muted small">{failed.error ?? 'Not ready.'}</span>
          {onRetry && (
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}
