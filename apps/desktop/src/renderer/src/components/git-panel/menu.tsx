import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../Icon'
import type { IconName } from '../Icon'

export interface MenuEntry {
  id: string
  label: string
  icon?: IconName
  disabled?: boolean
  /** Why it is disabled, or a keyboard hint — shown muted at the right. */
  hint?: string
  danger?: boolean
  /** A separator above this entry. */
  section?: boolean
}

interface Props {
  entries: MenuEntry[]
  onPick: (id: string) => void
  onClose: () => void
  ariaLabel: string
  /** Fixed screen position (context menu). Omitted: anchored under the trigger by CSS. */
  at?: { x: number; y: number }
}

/**
 * The one popover menu the Source Control view uses — for the header overflow, the commit
 * button's secondary actions, and a row's context menu.
 *
 * Square, 2px radius, hairline border, the true-overlay shadow (it IS floating, the one case the
 * Altitude Rule allows). Rows are 22px. Keyboard: arrows wrap, Home/End, Enter picks, Escape
 * closes and returns focus to whatever opened it. Clicking anywhere else closes it. Disabled
 * entries stay visible with their reason, because a control that vanishes teaches nothing.
 */
export function Menu({ entries, onPick, onClose, ariaLabel, at }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const enabled = entries.map((e, i) => (e.disabled ? -1 : i)).filter((i) => i >= 0)
  const [active, setActive] = useState<number>(enabled[0] ?? 0)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('[data-active="true"]')?.focus()
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc, true)
    return () => {
      document.removeEventListener('mousedown', onDoc, true)
      opener?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, [])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-active="true"]')?.focus()
  }, [active])

  const step = (dir: 1 | -1): void => {
    if (!enabled.length) return
    const pos = enabled.indexOf(active)
    const next = enabled[(pos + dir + enabled.length) % enabled.length]
    setActive(next)
  }

  return (
    <div
      ref={ref}
      className={`scm-menu${at ? ' scm-menu-fixed' : ''}`}
      role="menu"
      aria-label={ariaLabel}
      style={at ? { left: at.x, top: at.y } : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
        else if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
        else if (e.key === 'Home') { e.preventDefault(); setActive(enabled[0] ?? 0) }
        else if (e.key === 'End') { e.preventDefault(); setActive(enabled[enabled.length - 1] ?? 0) }
        else if (e.key === 'Tab') { e.preventDefault(); onClose() }
      }}
    >
      {entries.map((m, i) => (
        <React.Fragment key={m.id}>
          {m.section && i > 0 && <div className="scm-menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`scm-menu-item${m.danger ? ' scm-menu-danger' : ''}`}
            data-active={i === active ? 'true' : undefined}
            tabIndex={i === active ? 0 : -1}
            disabled={m.disabled}
            aria-disabled={m.disabled || undefined}
            title={m.disabled && m.hint ? m.hint : undefined}
            onMouseEnter={() => { if (!m.disabled) setActive(i) }}
            onClick={() => {
              if (m.disabled) return
              onPick(m.id)
              onClose()
            }}
          >
            <span className="scm-menu-icon">{m.icon && <Icon name={m.icon} size={12} />}</span>
            <span className="scm-menu-label">{m.label}</span>
            {m.hint && <span className="scm-menu-hint">{m.hint}</span>}
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}
