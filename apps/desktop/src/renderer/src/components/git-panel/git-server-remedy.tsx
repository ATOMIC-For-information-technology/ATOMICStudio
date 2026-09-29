import React from 'react'
import type { RemedyKind } from '../../../../shared/types'

interface Props {
  remedy: { kind: RemedyKind; publicKey?: string; command?: string }
  /** The address the failed preflight tried — 'unreachable' is the one kind with nothing else to show. */
  host: string
  /** Creates (or, if one already exists, just returns) Studio's dedicated automation key. */
  onCreateKey: () => void | Promise<void>
}

const copy = (text: string): void => {
  const c = navigator.clipboard
  if (c) void c.writeText(text).catch(() => {})
}

/** The public key plus the one line to install it, shared by 'no-key' and 'key-refused' — they
 *  differ only in whether a "Create key" button is offered (see the doc comment below). */
function KeyBlock({
  publicKey,
  offerCreate,
  onCreateKey
}: {
  publicKey: string | undefined
  offerCreate: boolean
  onCreateKey: () => void | Promise<void>
}): React.JSX.Element {
  return (
    <>
      <p>Studio's key has no passphrase — it is a dedicated automation key, not your own identity.</p>
      {offerCreate && (
        <button type="button" className="btn btn-sm" onClick={() => void onCreateKey()}>
          Create key
        </button>
      )}
      {publicKey && (
        <>
          <div className="git-row">
            <code className="run-cmd gs-key">{publicKey}</code>
            <button type="button" className="btn btn-sm" onClick={() => copy(publicKey)}>
              Copy
            </button>
          </div>
          <p>
            Add this line to <code>~/.ssh/authorized_keys</code> on the server.
          </p>
        </>
      )}
    </>
  )
}

/**
 * One branch per `RemedyKind` — eight distinct situations, eight distinct pieces of advice. The
 * preflight steps above this already say WHAT failed; this says what to do about it.
 *
 * Two rules that matter more than anything else here (see git-provision.ts's `preflight()`):
 *  - `host-key-changed` never suggests touching `known_hosts`. The server's identity changing can
 *    mean it was rebuilt, or that the connection is being intercepted — the honest answer is "find
 *    out which before proceeding," not a command that makes the warning go away.
 *  - `no-key` offers to create a key; `key-refused` does not. If the server already has Studio's
 *    key and is still refusing it, a second key would not help — it would just be confusing.
 */
export function GitServerRemedy({ remedy, host, onCreateKey }: Props): React.JSX.Element {
  switch (remedy.kind) {
    case 'unreachable':
      return (
        <div className="warn-box gs-remedy">
          <p>
            Could not reach <b>{host}</b>. Check the address, and whether a firewall between here and
            the server is blocking the connection.
          </p>
        </div>
      )
    case 'no-key':
      return (
        <div className="warn-box gs-remedy">
          <KeyBlock publicKey={remedy.publicKey} offerCreate onCreateKey={onCreateKey} />
        </div>
      )
    case 'key-refused':
      return (
        <div className="warn-box gs-remedy">
          <p>
            The server already has Studio's key and refused it. Check that the line below is really
            in <code>~/.ssh/authorized_keys</code> there — creating another key would not help.
          </p>
          <KeyBlock publicKey={remedy.publicKey} offerCreate={false} onCreateKey={onCreateKey} />
        </div>
      )
    case 'host-key-changed':
      return (
        <div className="warn-box gs-remedy">
          <p>
            The server's identity changed since Studio last connected here. That can mean the host
            was rebuilt — or that this connection is being intercepted. Find out which before
            proceeding.
          </p>
        </div>
      )
    case 'not-writable':
      return (
        <div className="warn-box gs-remedy">
          <p>Create the folder on the server, then test the connection again:</p>
          <div className="git-row">
            <code className="run-cmd gs-key">{remedy.command}</code>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => remedy.command && copy(remedy.command)}
            >
              Copy
            </button>
          </div>
        </div>
      )
    case 'no-git':
      return (
        <div className="warn-box gs-remedy">
          <p>Install git on the server — Studio cannot publish repositories without it there.</p>
        </div>
      )
    // The two MANAGED-seat outcomes. Neither offers a key or a command: on a managed server the
    // developer has no shell to run one in, and the fix is a person rather than a terminal.
    case 'not-signed-in':
      return (
        <div className="warn-box gs-remedy">
          <p>
            Studio reached <b>{host}</b> but is not signed in to your company server, so it cannot
            create repositories there. Sign in from Settings and try again.
          </p>
        </div>
      )
    case 'not-permitted':
      return (
        <div className="warn-box gs-remedy">
          <p>
            You are signed in, but your role on this server does not create repositories. Ask an
            administrator to grant it, or to create the repository for you.
          </p>
        </div>
      )
  }
}
