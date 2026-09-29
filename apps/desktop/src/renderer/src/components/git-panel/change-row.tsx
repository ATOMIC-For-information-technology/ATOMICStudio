import React from 'react'
import { Icon } from '../Icon'
import { splitRow } from './derive'
import { FileIcon } from '../FileIcon'
import type { ScmItem, ScmList } from './derive'

const LABEL: Record<string, string> = {
  new: 'new',
  modified: 'changed',
  deleted: 'deleted',
  renamed: 'renamed',
  conflicted: 'conflicted'
}

const ago = (ts: number): string => {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 2) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

export interface RowHandlers {
  onClick: (index: number, e: React.MouseEvent) => void
  onContextMenu: (index: number, e: React.MouseEvent) => void
  onToggleSection: (id: string) => void
  onSectionAction: (id: string) => void
  onOpen: (file: string) => void
  onDiscard: (file: string) => void
  onAct: (list: ScmList, file: string) => void
  onToggleCommit: (hash: string) => void
  onLoadMore: () => void
}

interface Props {
  item: ScmItem
  index: number
  focused: boolean
  selected: boolean
  pending: boolean
  busy: boolean
  h: RowHandlers
}

/**
 * One 22px row of the Source Control list, whatever it is: a section header with its count and
 * bulk action, a changed file, a commit, a commit's file, or a note.
 *
 * Hover actions are IN the layout at all times (opacity 0 → 1), so nothing reflows under the
 * pointer and the status letter never shifts. Every icon-only button has an accessible name and
 * a tooltip. Rows are `role="option"`, focusable by key from the windowed list, and carry
 * `aria-selected` so a screen reader hears the multi-selection as it grows.
 */
export function ScmRow({ item, index, focused, selected, pending, busy, h }: Props): React.JSX.Element {
  const common = { 'data-key': item.key, 'data-index': index, tabIndex: -1 as const }

  if (item.kind === 'section') {
    const bulk = item.id === 'unstaged' ? 'Stage all' : item.id === 'staged' ? 'Unstage all' : null
    return (
      <div
        {...common}
        role="option"
        aria-selected={false}
        aria-expanded={!item.collapsed}
        className={`scm-row scm-section${focused ? ' scm-focus' : ''}`}
        onClick={(e) => { h.onClick(index, e); h.onToggleSection(item.id) }}
      >
        <Icon name={item.collapsed ? 'chevron-right' : 'chevron-down'} size={11} />
        <span className="scm-section-title">{item.title}</span>
        <span className="scm-count" title={item.countExact ? `${item.count}` : `at least ${item.count} — the list was cut off`}>
          {item.count}{item.countExact ? '' : '+'}
        </span>
        <span className="spacer" />
        {bulk && item.count > 0 && (
          <span className="scm-acts">
            <button
              type="button"
              className="scm-act"
              aria-label={`${bulk} (${item.count})`}
              title={bulk}
              disabled={busy}
              onClick={(e) => { e.stopPropagation(); h.onSectionAction(item.id) }}
            >
              <Icon name={item.id === 'unstaged' ? 'plus' : 'minus'} size={11} />
            </button>
          </span>
        )}
      </div>
    )
  }

  if (item.kind === 'row') {
    const { name, dir } = splitRow(item.row.file)
    const r = item.row
    const list = item.list
    const untracked = r.code === '?'
    const canDiscard = list === 'unstaged' && !untracked
    const actLabel = list === 'staged' ? `Unstage ${r.file}` : list === 'unstaged' ? `Stage ${r.file}` : `Mark ${r.file} resolved`
    return (
      <div
        {...common}
        role="option"
        aria-selected={selected}
        className={`scm-row scm-file${selected ? ' scm-sel' : ''}${focused ? ' scm-focus' : ''}${pending ? ' scm-pending' : ''}`}
        title={`${r.file}${r.orig ? ` (was ${r.orig})` : ''} — ${LABEL[r.kind]}. Enter: diff · Space: ${list === 'staged' ? 'unstage' : list === 'unstaged' ? 'stage' : 'resolve'} · ⌘Enter: open`}
        onClick={(e) => h.onClick(index, e)}
        onContextMenu={(e) => h.onContextMenu(index, e)}
      >
        {/* Same theme as the Explorer and the tabs — a file that is `.ts` in the tree is `.ts` here. */}
        <FileIcon name={splitRow(r.file).name} className="scm-file-icon" />
        <span className="scm-leaf">{name}</span>
        {dir && <span className="scm-dir">{dir}</span>}
        {r.orig && <span className="scm-dir" title={`renamed from ${r.orig}`}>← {r.orig}</span>}
        <span className="spacer" />
        <span className="scm-acts">
          <button
            type="button"
            className="scm-act"
            aria-label={`Open ${r.file} in the editor`}
            title="Open in editor"
            onClick={(e) => { e.stopPropagation(); h.onOpen(r.file) }}
          >
            <Icon name="external-link" size={11} />
          </button>
          {canDiscard && (
            <button
              type="button"
              className="scm-act scm-act-danger"
              aria-label={`Discard changes to ${r.file}`}
              title="Discard changes — recoverable from Undo"
              disabled={busy || pending}
              onClick={(e) => { e.stopPropagation(); h.onDiscard(r.file) }}
            >
              <Icon name="undo" size={11} />
            </button>
          )}
          <button
            type="button"
            className="scm-act"
            aria-label={actLabel}
            title={actLabel}
            disabled={busy || pending}
            onClick={(e) => { e.stopPropagation(); h.onAct(list, r.file) }}
          >
            <Icon name={list === 'staged' ? 'minus' : list === 'unstaged' ? 'plus' : 'check'} size={11} />
          </button>
        </span>
        <span className={`scm-status scm-kind-${r.kind}`} title={LABEL[r.kind]} aria-label={LABEL[r.kind]}>
          {r.code}
        </span>
      </div>
    )
  }

  if (item.kind === 'commit') {
    const c = item.commit
    return (
      <div
        {...common}
        role="option"
        aria-selected={false}
        aria-expanded={item.open}
        className={`scm-row scm-commit${focused ? ' scm-focus' : ''}`}
        title={`${c.hash} — ${c.subject}`}
        onClick={(e) => { h.onClick(index, e); h.onToggleCommit(c.hash) }}
      >
        <Icon name={item.open ? 'chevron-down' : 'chevron-right'} size={11} />
        {/* The ABBREVIATION is shown and the full hash is what we hold: `title` carries the id a
            user would copy, and every action addresses `c.hash`, never these seven characters. */}
        <code className="scm-hash">{c.short}</code>
        <span className="scm-subject">{c.subject}</span>
        <span className="scm-dir">{c.author} · {ago(c.ts)}</span>
      </div>
    )
  }

  if (item.kind === 'more') {
    return (
      <div
        {...common}
        role="option"
        aria-selected={false}
        className={`scm-row scm-more${focused ? ' scm-focus' : ''}`}
        onClick={(e) => { h.onClick(index, e); if (!item.loading) h.onLoadMore() }}
      >
        <span className="scm-more-label">{item.loading ? 'Loading…' : 'Load more commits'}</span>
      </div>
    )
  }

  if (item.kind === 'commit-file') {
    return (
      <div {...common} role="option" aria-selected={false} className={`scm-row scm-commit-file${focused ? ' scm-focus' : ''}`} onClick={(e) => h.onClick(index, e)}>
        <code className="scm-commit-file-text">{item.text}</code>
      </div>
    )
  }

  return (
    <div {...common} role="option" aria-selected={false} className={`scm-row scm-note scm-note-${item.tone}${focused ? ' scm-focus' : ''}`} onClick={(e) => h.onClick(index, e)}>
      {item.tone === 'warn' && <Icon name="alert" size={11} />}
      <span>{item.text}</span>
    </div>
  )
}
