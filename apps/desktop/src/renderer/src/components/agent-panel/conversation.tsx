import React, { useEffect, useRef } from 'react'
import type { Msg } from './types'
import { ConversationMessage } from './conversation-message'
import { EmptyState } from './empty-state'
import { LoadingSkeleton } from './loading-skeleton'

/**
 * Section 5 — Chat. Sits BELOW the execution timeline. Holds only prose
 * (requests, explanations, questions, decisions). Streams a skeleton while the
 * assistant composes a reply. Auto-scrolls to the latest message.
 */
export function Conversation({ messages, streaming }: { messages: Msg[]; streaming: boolean }): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages.length, streaming])

  if (messages.length === 0 && !streaming) {
    return <EmptyState icon="chat" text="Ask for a change and the assistant's explanation will appear here." />
  }

  return (
    <div className="ap-conversation">
      {messages.map((m, i) => (
        <ConversationMessage key={i} msg={m} />
      ))}
      {streaming && <LoadingSkeleton lines={2} />}
      <div ref={endRef} />
    </div>
  )
}