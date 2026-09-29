import React from 'react'
import type { Msg } from './types'

/**
 * A single conversational bubble. The chat stream holds only prose — user
 * requests, assistant explanations, summaries, errors, and blocked-command
 * warnings — never raw execution logs (those live in the timeline above).
 * Keeps the legacy msg-* classes the UI tests query.
 */
export function ConversationMessage({ msg }: { msg: Msg }): React.JSX.Element {
  switch (msg.role) {
    case 'user':
      return <div className="msg msg-user">{msg.text}</div>
    case 'assistant':
      return <div className="msg msg-ai">{msg.text}</div>
    case 'done':
      return <div className="msg msg-done">{msg.text}</div>
    case 'error':
      return <div className="msg msg-err">{msg.text}</div>
    case 'blocked':
      return (
        <div className="msg msg-warn">
          <code>{msg.command}</code> — blocked: the agent can't run shell commands here.
        </div>
      )
  }
}
