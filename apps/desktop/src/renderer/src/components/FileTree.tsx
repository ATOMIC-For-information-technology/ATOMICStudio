import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DirEntry } from '../../../shared/types'
import { Icon } from './Icon'
import { FileIcon } from './FileIcon'
import { Menu, WindowedList, type MenuEntry } from './git-panel'
import {
  ancestorsOf,
  collapseAll as collapseAllFolders,
  flatten,
  foldersToInvalidate,
  invalidate,
  toggleExpanded,
  typeAheadTarget,
  type TreeData,
  type VisibleRow
} from './explorer/model'

const ROW_H = 22
/** How long a typed run stays one type-ahead query, as in VS Code's lists. */
const TYPE_AHEAD_MS = 800

export interface ExplorerHandle {
  /** Expand every ancestor of a path and put the row on screen. */
  reveal: (relPath: string) => void
  collapseAll: () => void
  refresh: () => void
  /** Start an inline create beside the current selection. */
  startCreate: (kind: 'file' | 'dir') => void
}

interface Props {
  projectPath: string
  activeFile: string | null
  onOpenFile: (relPath: string) => void
  /** Delete a file/folder (the parent owns the confirm + Trash flow). */
  onDelete?: (relPath: string, isDir: boolean) => void
  /** Rename in place. Resolves false when the parent refused, so the row stays in edit. */
  onRename?: (relPath: string, nextName: string) => Promise<boolean>
  /** Create `relPath` as a file or a folder. Resolves false when the parent refused. */
  onCreate?: (relPath: string, kind: 'file' | 'dir') => Promise<boolean>
  /** Bumped by the shell when something wrote to the project from outside the app. */
  refreshKey: number
  /** Project-relative path → porcelain letter (`M`, `?`, `A`, `D`, `U`), from ONE shared snapshot. */
  decorations?: ReadonlyMap<string, string>
  /** Development instrumentation, read by the UI suite. Never shown. */
  onStats?: (s: { rows: number; mounted: number; rootMs: number }) => void
  handleRef?: React.MutableRefObject<ExplorerHandle | null>
}

/** Git letter → the class that tints the whole row, the way VS Code colours a decorated name. */
const DECOR_CLASS: Record<string, string> = {
  M: 'ex-git-modified',
  A: 'ex-git-added',
  R: 'ex-git-added',
  D: 'ex-git-deleted',
  '?': 'ex-git-untracked',
  U: 'ex-git-conflict'
}
const DECOR_TITLE: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  R: 'Renamed',
  D: 'Deleted',
  '?': 'Untracked',
  U: 'Conflict'
}

/**
 * The Explorer's file tree.
 *
 * Rebuilt 2026-09-02 against VS Code's own Explorer. What changed, and why each one mattered:
 *
 *  - **The tree is data, not component state.** `explorer/model.ts` holds one normalised record
 *    (cached listings, the expanded set, what is loading) and `flatten()` projects the visible
 *    rows. The old recursive `TreeNode` kept `open` and `children` in each node's own `useState`,
 *    so a refresh threw every folder's contents away, the tree could not be windowed, and
 *    expansion could not survive anything.
 *  - **Rows are windowed.** About thirty mounted rows whatever the project's size.
 *  - **Loading is lazy and targeted.** A folder is read when it opens and cached after that; a
 *    watcher event re-reads only the folders whose membership can actually have changed.
 *  - **Stale reads cannot land.** Every listing carries a generation, so a slow answer for a
 *    project that has since been closed is dropped rather than painted into the new tree.
 *  - **File-type icons come from a real icon THEME** (`FileIcon`), never the product icon set.
 */
function FileTreeImpl({
  projectPath, activeFile, onOpenFile, onDelete, onRename, onCreate, refreshKey, decorations, onStats, handleRef
}: Props): React.JSX.Element {
  const [children, setChildren] = useState<ReadonlyMap<string, DirEntry[]>>(() => new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set())
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ path: string; value: string } | null>(null)
  const [creating, setCreating] = useState<{ parent: string; kind: 'file' | 'dir'; value: string } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ row: VisibleRow; x: number; y: number } | null>(null)
  const [rootMs, setRootMs] = useState(0)

  /**
   * Bumped whenever the project changes or a full refresh starts. A listing that comes back
   * carrying an older generation is dropped: switching projects while a big folder was still
   * being read used to paint the previous project's files into the new tree.
   */
  const generation = useRef(0)
  const mountedRows = useRef(0)

  const load = useCallback(
    async (path: string): Promise<void> => {
      const gen = generation.current
      setLoading((prev) => {
        const next = new Set(prev)
        next.add(path)
        return next
      })
      const t0 = performance.now()
      const kids = await window.studio.listDir(projectPath, path, 'explorer')
      if (gen !== generation.current) return
      if (path === '') setRootMs(Math.round(performance.now() - t0))
      setChildren((prev) => {
        const next = new Map(prev)
        next.set(path, kids)
        return next
      })
      setLoading((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    },
    [projectPath]
  )

  // Project switch: drop everything and read the ROOT only. Nothing else is read until it is
  // opened, so the sidebar is interactive as soon as one directory listing lands — it never
  // waits on descendants, and it never walks a dependency tree.
  useEffect(() => {
    generation.current++
    setChildren(new Map())
    setExpanded(new Set())
    setLoading(new Set())
    setFocusKey(null)
    setSelected(null)
    setEditing(null)
    setCreating(null)
    void load('')
  }, [projectPath, load])

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const childrenRef = useRef(children)
  childrenRef.current = children

  /**
   * A refresh re-reads only what is ON SCREEN — the root plus every expanded folder — and keeps
   * the expanded set, the selection and the focus. Nothing is dropped first, so the tree never
   * blanks and repopulates.
   */
  const refresh = useCallback(() => {
    generation.current++
    void load('')
    for (const p of expandedRef.current) void load(p)
  }, [load])

  const firstRefresh = useRef(true)
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false
      return
    }
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is a signal, not data
  }, [refreshKey])

  const data: TreeData = useMemo(() => ({ children, expanded, loading }), [children, expanded, loading])
  const rows = useMemo(() => flatten(data), [data])
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  useEffect(() => {
    onStats?.({ rows: rows.length, mounted: mountedRows.current, rootMs })
  }, [rows.length, rootMs, onStats])

  const openFolder = useCallback(
    (row: VisibleRow, open?: boolean) => {
      const want = open ?? !row.expanded
      setExpanded((prev) => toggleExpanded(prev, row.path, want))
      if (want && !childrenRef.current.has(row.path)) void load(row.path)
    },
    [load]
  )

  const activate = useCallback(
    (row: VisibleRow) => {
      setSelected(row.key)
      setFocusKey(row.key)
      if (row.isDir) openFolder(row)
      else onOpenFile(row.path)
    },
    [openFolder, onOpenFile]
  )

  /* ── reveal / collapse / create, exposed to the shell ──────────────────────────────────── */
  const reveal = useCallback(
    async (relPath: string) => {
      const gen = generation.current
      for (const dir of ancestorsOf(relPath)) {
        setExpanded((prev) => toggleExpanded(prev, dir, true))
        if (!childrenRef.current.has(dir)) {
          await load(dir)
          if (gen !== generation.current) return
        }
      }
      setSelected(relPath)
      setFocusKey(relPath)
    },
    [load]
  )

  const selectionRef = useRef<string | null>(null)
  selectionRef.current = selected ?? focusKey

  useEffect(() => {
    if (!handleRef) return
    const handle: ExplorerHandle = {
      reveal: (p) => void reveal(p),
      collapseAll: () => setExpanded(collapseAllFolders()),
      refresh,
      startCreate: (kind) => {
        const row = rowsRef.current.find((r) => r.key === selectionRef.current)
        const parent = row ? (row.isDir ? row.path : row.path.slice(0, Math.max(0, row.path.lastIndexOf('/')))) : ''
        if (row?.isDir && !row.expanded) openFolder(row, true)
        setCreating({ parent, kind, value: '' })
      }
    }
    handleRef.current = handle
    return () => {
      if (handleRef.current === handle) handleRef.current = null
    }
  }, [handleRef, reveal, refresh, openFolder])

  /* ── watcher-driven, targeted invalidation ────────────────────────────────────────────── */
  useEffect(() => {
    return window.studio.onFsChanged((paths) => {
      const folders = foldersToInvalidate(paths)
      // Only re-read folders that are actually visible: an edit deep inside a collapsed tree
      // costs nothing until that folder is opened.
      const visible = folders.filter((f) => f === '' || expandedRef.current.has(f))
      if (visible.length === 0) return
      setChildren((prev) => invalidate(prev, visible))
      for (const f of visible) void load(f)
    })
  }, [load])

  /* ── inline rename / create ───────────────────────────────────────────────────────────── */
  const commitRename = useCallback(async () => {
    if (!editing || !onRename) return setEditing(null)
    const name = editing.value.trim()
    const original = editing.path.slice(editing.path.lastIndexOf('/') + 1)
    if (!name || name === original) return setEditing(null)
    const ok = await onRename(editing.path, name)
    if (ok) setEditing(null)
  }, [editing, onRename])

  const commitCreate = useCallback(async () => {
    if (!creating || !onCreate) return setCreating(null)
    const name = creating.value.trim()
    if (!name) return setCreating(null)
    const full = creating.parent ? `${creating.parent}/${name}` : name
    const ok = await onCreate(full, creating.kind)
    if (ok) setCreating(null)
  }, [creating, onCreate])

  /* ── keyboard ─────────────────────────────────────────────────────────────────────────── */
  const typeAhead = useRef({ query: '', at: 0 })

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (editing || creating) return
      const list = rowsRef.current
      const i = list.findIndex((r) => r.key === focusKey)
      const row = i >= 0 ? list[i] : undefined
      const move = (to: number): void => {
        const target = list[Math.max(0, Math.min(list.length - 1, to))]
        if (!target) return
        e.preventDefault()
        setFocusKey(target.key)
        setSelected(target.key)
      }
      switch (e.key) {
        case 'ArrowDown': return move(i + 1)
        case 'ArrowUp': return move(i - 1)
        case 'PageDown': return move(i + 12)
        case 'PageUp': return move(i - 12)
        case 'Home': return move(0)
        case 'End': return move(list.length - 1)
        case 'ArrowRight': {
          if (!row) return
          e.preventDefault()
          if (row.isDir && !row.expanded) openFolder(row, true)
          else if (row.isDir) move(i + 1)
          return
        }
        case 'ArrowLeft': {
          if (!row) return
          e.preventDefault()
          if (row.isDir && row.expanded) return openFolder(row, false)
          // Not an open folder: focus the PARENT, which is the nearest row above at a smaller
          // depth — VS Code's behaviour, and the reason ← reads as "go out one level".
          for (let k = i - 1; k >= 0; k--) {
            if (list[k].depth < row.depth) return move(k)
          }
          return
        }
        case 'Enter':
        case ' ': {
          if (!row) return
          e.preventDefault()
          if (row.isDir) openFolder(row)
          else onOpenFile(row.path)
          return
        }
        case 'F2': {
          if (!row || !onRename) return
          e.preventDefault()
          setEditing({ path: row.path, value: row.name })
          return
        }
        case 'Delete':
        case 'Backspace': {
          if (!row || !onDelete) return
          e.preventDefault()
          onDelete(row.path, row.isDir)
          return
        }
        case 'Escape': {
          typeAhead.current = { query: '', at: 0 }
          return
        }
        default:
      }
      // Type navigation: printable single characters only, so every app shortcut still reaches
      // the shell rather than being eaten by the tree.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const now = Date.now()
        const q = now - typeAhead.current.at < TYPE_AHEAD_MS ? typeAhead.current.query + e.key : e.key
        typeAhead.current = { query: q, at: now }
        const target = typeAheadTarget(list, i, q)
        if (target >= 0) {
          e.preventDefault()
          setFocusKey(list[target].key)
          setSelected(list[target].key)
        }
      }
    },
    [editing, creating, focusKey, openFolder, onOpenFile, onRename, onDelete]
  )

  /* ── context menu ─────────────────────────────────────────────────────────────────────── */
  const ctxEntries: MenuEntry[] = useMemo(() => {
    const row = ctxMenu?.row
    if (!row) return []
    const out: MenuEntry[] = []
    if (row.isDir) {
      out.push({ id: 'toggle', label: row.expanded ? 'Collapse' : 'Expand', icon: row.expanded ? 'chevron-down' : 'chevron-right' })
    } else {
      out.push({ id: 'open', label: 'Open', icon: 'external-link' })
    }
    out.push({ id: 'new-file', label: 'New File…', icon: 'file-plus', section: true, disabled: !onCreate })
    out.push({ id: 'new-folder', label: 'New Folder…', icon: 'folder-plus', disabled: !onCreate })
    out.push({ id: 'rename', label: 'Rename…', icon: 'pencil', section: true, hint: 'F2', disabled: !onRename })
    out.push({ id: 'delete', label: 'Delete', icon: 'trash', danger: true, hint: '⌫', disabled: !onDelete })
    out.push({ id: 'copy-path', label: 'Copy Path', icon: 'file', section: true })
    return out
  }, [ctxMenu, onCreate, onRename, onDelete])

  const onCtx = useCallback(
    (id: string) => {
      const row = ctxMenu?.row
      if (!row) return
      const parent = row.isDir ? row.path : row.path.slice(0, Math.max(0, row.path.lastIndexOf('/')))
      switch (id) {
        case 'open': return onOpenFile(row.path)
        case 'toggle': return openFolder(row)
        case 'new-file':
          if (row.isDir && !row.expanded) openFolder(row, true)
          return setCreating({ parent, kind: 'file', value: '' })
        case 'new-folder':
          if (row.isDir && !row.expanded) openFolder(row, true)
          return setCreating({ parent, kind: 'dir', value: '' })
        case 'rename': return setEditing({ path: row.path, value: row.name })
        case 'delete': return onDelete?.(row.path, row.isDir)
        case 'copy-path': return void navigator.clipboard?.writeText(row.path)
        default:
      }
    },
    [ctxMenu, onOpenFile, openFolder, onDelete]
  )

  /* ── rows ─────────────────────────────────────────────────────────────────────────────── */
  const renderRow = useCallback(
    (row: VisibleRow, index: number): React.ReactNode => {
      const isActive = !row.isDir && activeFile === row.path
      const isSelected = selected === row.key
      const isFocused = focusKey === row.key
      const decor = decorations?.get(row.path)
      const decorClass = decor ? DECOR_CLASS[decor] ?? '' : ''
      const renaming = editing?.path === row.path

      return (
        <div
          key={row.key}
          data-key={row.key}
          data-index={index}
          tabIndex={-1}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={row.isDir ? row.expanded : undefined}
          aria-selected={isSelected || undefined}
          className={`ex-row${isSelected ? ' ex-sel' : ''}${isActive ? ' ex-active' : ''}${isFocused ? ' ex-focus' : ''}${decorClass ? ` ${decorClass}` : ''}`}
          /* Indentation is padding on a FULL-WIDTH row, never a margin or a nested container:
             the hover and selection backgrounds have to run the whole width of the sidebar. */
          style={{ paddingLeft: 4 + row.depth * 8, ['--ex-depth' as string]: row.depth }}
          title={row.path}
          onClick={() => activate(row)}
          onContextMenu={(e) => {
            e.preventDefault()
            setSelected(row.key)
            setFocusKey(row.key)
            setCtxMenu({ row, x: e.clientX, y: e.clientY })
          }}
        >
          <span className="ex-twisty" aria-hidden="true">
            {row.isDir && <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} size={12} />}
          </span>
          <FileIcon name={row.name} isDir={row.isDir} expanded={row.expanded} parentName={row.parentName} />
          {renaming ? (
            <input
              className="ex-rename"
              autoFocus
              aria-label={`Rename ${row.name}`}
              value={editing.value}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => void commitRename()}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') void commitRename()
                else if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span className="ex-name">{row.label}</span>
          )}
          {row.isSymlink && <span className="ex-link" title="Symbolic link" aria-label="Symbolic link">↗</span>}
          {/* A FIXED trailing slot: the decoration appears and disappears without moving the name. */}
          <span className={`ex-decor${decor ? ' ex-decor-on' : ''}`} title={decor ? DECOR_TITLE[decor] : undefined}>
            {decor === '?' ? 'U' : decor ?? ''}
          </span>
        </div>
      )
    },
    [activeFile, selected, focusKey, decorations, editing, activate, commitRename]
  )

  const items = useMemo(() => rows.map((r) => ({ key: r.key, row: r })), [rows])
  const onMounted = useCallback((n: number) => {
    mountedRows.current = n
  }, [])

  return (
    <div className="ex-tree">
      {creating && (
        <div className="ex-row ex-creating" style={{ paddingLeft: 4 }}>
          <span className="ex-twisty" aria-hidden="true" />
          <FileIcon name={creating.value || 'x'} isDir={creating.kind === 'dir'} />
          <input
            className="ex-rename"
            autoFocus
            placeholder={creating.kind === 'file' ? 'New file name' : 'New folder name'}
            aria-label={creating.kind === 'file' ? 'New file name' : 'New folder name'}
            value={creating.value}
            onChange={(e) => setCreating({ ...creating, value: e.target.value })}
            onBlur={() => void commitCreate()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') void commitCreate()
              else if (e.key === 'Escape') setCreating(null)
            }}
          />
        </div>
      )}
      {rows.length === 0 ? (
        <div className="ex-empty muted small">{loading.has('') ? 'Reading…' : 'No files'}</div>
      ) : (
        <WindowedList
          items={items}
          rowHeight={ROW_H}
          overscan={8}
          focusKey={focusKey}
          ariaLabel="Project files"
          role="tree"
          className="ex-scroll"
          onKeyDown={onKeyDown}
          onEnter={() => {
            if (!focusKey && rows.length) setFocusKey(rows[0].key)
          }}
          onMounted={onMounted}
          renderItem={(it, index) => renderRow((it as { key: string; row: VisibleRow }).row, index)}
        />
      )}
      {ctxMenu && (
        <Menu
          entries={ctxEntries}
          onPick={onCtx}
          onClose={() => setCtxMenu(null)}
          ariaLabel="File actions"
          at={{ x: ctxMenu.x, y: ctxMenu.y }}
        />
      )}
    </div>
  )
}

/** Memoised: the shell re-renders on every dev-server log line, and the tree must not re-project
 *  its rows for a change that has nothing to do with the filesystem. */
export const FileTree = React.memo(FileTreeImpl)
