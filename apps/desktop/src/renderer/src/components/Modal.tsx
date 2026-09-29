import React, { useEffect, useRef } from 'react'
import { Icon } from './Icon'

/**
 * Everything that can hold focus, in DOM order. Used both to place first focus and to wrap Tab at
 * the edges — without the wrap, Tab walks straight out of the dialog and into the IDE behind it,
 * which is where every one of these overlays used to send a keyboard user.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface Props {
  /** The dialog's accessible name — what a screen reader announces on open. */
  label: string
  onClose: () => void
  /** False while an operation is in flight, so Esc/backdrop can't cancel it mid-way. */
  dismissible?: boolean
  className?: string
  backdropClassName?: string
  children: React.ReactNode
}

/**
 * A real dialog: announced as one, focus moved into it, Tab trapped inside it, Esc closes it, and
 * focus handed back to whatever opened it. Every overlay in Studio should use this — the pattern
 * was already right in the agent panel's artifact sheet and nowhere else.
 */
export function Modal({
  label,
  onClose,
  dismissible = true,
  className = 'modal',
  backdropClassName = 'modal-backdrop',
  children
}: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null
    const el = ref.current
    // A child with autoFocus has already claimed focus by now; don't yank it back to the top.
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? el).focus()
    }
    return () => restoreTo.current?.focus?.()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      if (!dismissible) return
      // Stop here: the window-level handler also listens for Esc (it closes the palette).
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const el = ref.current
    if (!el) return
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null)
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className={backdropClassName}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {/* A visible exit. Esc and clicking the dimmed area both work, but neither is discoverable —
            a non-coder faced with a dialog and no × concludes they are stuck. */}
        {dismissible && (
          <button type="button" className="modal-close" onClick={onClose} title="Close" aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        )}
        {children}
      </div>
    </div>
  )
}
