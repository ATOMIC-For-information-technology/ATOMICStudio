import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon'
import { describeRole } from '../../../shared/roles'
import type { DeviceLoginPrompt, IdentityStatus } from '../../../shared/types'

/**
 * Company sign-in — the Settings surface for the on-prem identity provider.
 *
 * This whole component is INVISIBLE unless enterprise policy configures an IdP: `App` only renders
 * the Company tab when `identityStatus().required` is true, so a standalone seat never sees a
 * control that could not work. That is the same rule Builder Mode obeys — no dead controls — and
 * the reason the check lives at the tab, not here: a tab that opens an empty panel is itself the
 * dead control.
 *
 * WHY THE CODE IS SHOWN, NOT A LOGIN FORM: Studio never asks for a company password. The user
 * reads a short code, opens their OWN browser, and finishes there — so credentials and MFA only
 * ever meet a window whose address bar they can check. `main/identity.ts` explains the rest.
 */
export function CompanySignIn({ onMsg }: { onMsg: (type: 'ok' | 'err', text: string) => void }): React.JSX.Element {
  const [status, setStatus] = useState<IdentityStatus | null>(null)
  const [prompt, setPrompt] = useState<DeviceLoginPrompt | null>(null)
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    void window.studio.identityStatus().then(setStatus)
    // Sign-in can also complete from a restored session at launch, so the panel listens rather
    // than assuming it is the only thing that changes identity.
    return window.studio.onIdentityChanged(setStatus)
  }, [])

  const signIn = useCallback(async () => {
    setPrompt(null)
    const p = await window.studio.identityBeginLogin()
    if (!p.ok) {
      onMsg('err', p.error ?? 'Sign-in could not be started.')
      return
    }
    setPrompt(p)
    // Open the browser for them — but the code stays on screen either way, because an
    // openExternal that silently fails would otherwise leave a code with nowhere to type it.
    if (p.verificationUriComplete || p.verificationUri) {
      void window.studio.openExternal(p.verificationUriComplete ?? p.verificationUri!)
    }
    setWaiting(true)
    const res = await window.studio.identityCompleteLogin()
    setWaiting(false)
    setPrompt(null)
    if (res.ok && res.identity) onMsg('ok', `Signed in as ${res.identity.display}.`)
    else onMsg('err', res.error ?? 'Sign-in did not complete.')
    setStatus(await window.studio.identityStatus())
  }, [onMsg])

  const signOut = useCallback(async () => {
    setStatus(await window.studio.identityLogout())
    onMsg('ok', 'Signed out of the company server.')
  }, [onMsg])

  if (!status) return <div className="settings-section"><p className="muted small">Checking…</p></div>

  const who = status.identity
  const role = who ? describeRole(who.role) : null

  return (
    <div className="settings-section">
      <p className="muted small">
        Your company runs its own sign-in. Studio never sees your password — you finish in your own
        browser, and this machine keeps a pass that expires.
      </p>

      {who && role ? (
        <>
          <div className="key-row">
            <span className="key-label">
              Signed in <b className="key-ok"><Icon name="check" size={11} /></b>
            </span>
            <span className="signin-who">
              {who.display} <span className="signin-role">{role.title}</span>
            </span>
            <button className="btn btn-sm" onClick={() => void signOut()}>Sign out</button>
          </div>
          <p className="muted small">{role.tagline}</p>
          <ul className="signin-caps">
            {role.bullets.map((b) => <li key={b}>{b}</li>)}
          </ul>
          <p className="muted small">
            Your access pass expires at{' '}
            {new Date(who.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Studio
            renews it quietly while you work.
          </p>
        </>
      ) : prompt?.ok ? (
        <div className="signin-code-box">
          <p className="small">Enter this code in the browser window that just opened:</p>
          <div className="signin-code" aria-label="Your sign-in code">{prompt.userCode}</div>
          <p className="muted small">
            {prompt.verificationUri}
            {waiting && ' — waiting for you to finish…'}
          </p>
          <button className="btn btn-sm" onClick={() => void window.studio.openExternal(prompt.verificationUriComplete ?? prompt.verificationUri!)}>
            Open the page again
          </button>
        </div>
      ) : (
        <div className="key-row">
          <span className="key-label">Not signed in</span>
          <span className="muted small">You need to sign in to open company projects.</span>
          <button className="btn btn-sm btn-primary" onClick={() => void signIn()} disabled={waiting}>
            {waiting ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      )}

      {status.error && <p className="signin-error small">{status.error}</p>}
    </div>
  )
}
