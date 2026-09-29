import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../Icon'
import type { GitBranch } from '../../../../shared/types'

interface Props {
  current: string
  branches: GitBranch[]
  loading: boolean
  busy: boolean
  onSwitch: (branch: string) => void
  onCreate: (branch: string) => void
  onMerge: (branch: string) => void
  onDelete: (branch: string) => void
  onClose: () => void
}

const SAFE = /^[\w./-]+$/

/**
 * The branch quick pick — VS Code's "Checkout to…" shape, over this app's own verbs.
 *
 * Replaces a permanently visible "new branch name" field + a "merge from…" select + a delete
 * button that together cost two rows of every repository view for actions taken a few times a
 * week. Type to filter; Enter switches; typing a name no branch has turns the first row into
 * "Create branch …"; merge and delete are hover/keyboard actions on a row, and delete asks
 * inline first. The catalog is loaded when the picker opens, not on every refresh.
 */
export function BranchPicker(p: Props): React.JSX.Element {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    input.current?.focus()
    const onDoc = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) p.onClose()
    }
    document.addEventListener('mousedown', onDoc, true)
    return () => document.removeEventListener('mousedown', onDoc, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, [])

  const query = q.trim()
  const rows = useMemo(() => {
    const needle = query.toLowerCase()
    const list = p.branches.filter((b) => !needle || b.name.toLowerCase().includes(needle))
    // Current branch first, then the rest in git's order.
    return [...list.filter((b) => b.current), ...list.filter((b) => !b.current)]
  }, [p.branches, query])
  const canCreate = Boolean(query) && SAFE.test(query) && !p.branches.some((b) => b.name === query)
  const total = rows.length + (canCreate ? 1 : 0)

  useEffect(() => { setActive(0) }, [query])

  const pick = (i: number): void => {
    if (canCreate && i === 0) return p.onCreate(query)
    const b = rows[canCreate ? i - 1 : i]
    if (!b) return
    if (b.current) return p.onClose()
    p.onSwitch(b.name)
  }

  return (
    <div ref={root} className="scm-picker" role="dialog" aria-label="Switch branch">
      <input
        ref={input}
        className="text-input scm-picker-input"
        placeholder="Switch to a branch, or type a new name"
        aria-label="Branch name"
        value={q}
        disabled={p.busy}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); p.onClose() }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(total - 1, a + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
          else if (e.key === 'Enter') { e.preventDefault(); if (total > 0) pick(active) }
        }}
      />
      <div className="scm-picker-list" role="listbox" aria-label="Branches">
        {p.loading && p.branches.length === 0 && <div className="scm-picker-note muted small">Reading branches…</div>}
        {canCreate && (
          <div
            role="option"
            aria-selected={active === 0}
            className={`scm-picker-row${active === 0 ? ' scm-picker-active' : ''}`}
            onMouseEnter={() => setActive(0)}
            onClick={() => pick(0)}
          >
            <Icon name="plus" size={12} />
            <span className="scm-picker-name">Create branch <strong>{query}</strong></span>
            <span className="scm-picker-meta muted">from {p.current || 'HEAD'}</span>
          </div>
        )}
        {rows.map((b, i) => {
          const idx = canCreate ? i + 1 : i
          const meta = b.remote
            ? `${b.remote}${b.ahead ? ` ↑${b.ahead}` : ''}${b.behind ? ` ↓${b.behind}` : ''}`
            : 'no upstream'
          return (
            <div
              key={b.name}
              role="option"
              aria-selected={active === idx}
              className={`scm-picker-row${active === idx ? ' scm-picker-active' : ''}${b.current ? ' scm-picker-current' : ''}`}
              onMouseEnter={() => setActive(idx)}
              onClick={() => pick(idx)}
              title={b.current ? `${b.name} — current branch` : `Switch to ${b.name}`}
            >
              <Icon name={b.current ? 'check' : 'git-branch'} size={12} />
              <span className="scm-picker-name">{b.name}</span>
              <span className="scm-picker-meta muted">{meta}</span>
              {!b.current && confirmDelete !== b.name && (
                <span className="scm-picker-acts">
                  <button
                    type="button"
                    className="scm-icon-btn"
                    aria-label={`Merge ${b.name} into ${p.current}`}
                    title={`Merge ${b.name} into ${p.current}`}
                    disabled={p.busy}
                    onClick={(e) => { e.stopPropagation(); p.onMerge(b.name) }}
                  >
                    <Icon name="arrow-enter" size={12} />
                  </button>
                  <button
                    type="button"
                    className="scm-icon-btn scm-icon-danger"
                    aria-label={`Delete branch ${b.name}`}
                    title={`Delete branch ${b.name}`}
                    disabled={p.busy}
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(b.name) }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </span>
              )}
              {confirmDelete === b.name && (
                <span className="scm-picker-acts scm-picker-confirm" onClick={(e) => e.stopPropagation()}>
                  <span className="small">Delete?</span>
                  <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => { setConfirmDelete(null); p.onDelete(b.name) }}>Delete</button>
                  <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(null)}>Keep</button>
                </span>
              )}
            </div>
          )
        })}
        {!p.loading && total === 0 && (
          <div className="scm-picker-note muted small">
            {query ? (SAFE.test(query) ? 'No branch matches.' : 'Branch names use letters, digits, . / _ -') : 'No branches.'}
          </div>
        )}
      </div>
    </div>
  )
}
