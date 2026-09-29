import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon'
import type { MemoryEntry, MemoryKind, MemoryStats } from '../../../shared/types'

interface Props {
  projectPath: string
  onMsg: (type: 'ok' | 'err', text: string) => void
  /** Show the kind filter row. Insight's Memory view uses it; other hosts get the plain list. */
  showFilter?: boolean
}

/** The kinds a person adds by hand, in the order they tend to think of them. */
const KINDS: { id: MemoryKind; label: string }[] = [
  { id: 'goal', label: 'Goal' },
  { id: 'forbidden', label: 'Never do this' },
  { id: 'business-rule', label: 'Business rule' },
  { id: 'decision', label: 'Decision' },
  { id: 'convention', label: 'Convention' },
  { id: 'design-rule', label: 'Design rule' },
  { id: 'file', label: 'Important file' },
  { id: 'bug', label: 'Known bug' },
  { id: 'debt', label: 'Tech debt' },
  { id: 'pending', label: 'Pending work' },
  { id: 'preference', label: 'Preference' },
  { id: 'idea', label: 'Idea' }
]

const LABEL: Record<MemoryKind, string> = {
  ...(Object.fromEntries(KINDS.map((k) => [k.id, k.label])) as Record<MemoryKind, string>),
  'ai-decision': 'AI decision'
}

/** Kinds that are always sent to the AI, whatever the task — worth showing, so the list isn't a guess. */
const ALWAYS: MemoryKind[] = ['forbidden', 'business-rule']

/**
 * Project Memory — what this project knows, and what the AI is told before every task.
 *
 * Two things this panel deliberately makes visible, because memory that works invisibly is memory
 * nobody can correct: **who wrote each item** (you or the AI), and **exactly what a given task would
 * load**, via the preview box — the same retrieval the agent runs, not an approximation of it.
 */
export function MemoryPanel({ projectPath, onMsg, showFilter = false }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [kind, setKind] = useState<MemoryKind>('goal')
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<{ entries: MemoryEntry[]; omitted: number } | null>(null)
  const [task, setTask] = useState('')
  /* Filter, not a second list. "Decisions" used to be its own product beside Memory — but
     `main/memory.ts` already folds `listDecisions()` in as `kind: 'decision'`, so the two lists were
     the same rows twice. One list, filtered by kind, is the same feature without the duplicate. */
  const [only, setOnly] = useState<MemoryKind | 'all'>('all')

  const refresh = useCallback(async () => {
    if (!projectPath) return
    setEntries(await window.studio.memoryList(projectPath))
    setStats(await window.studio.memoryStats(projectPath))
  }, [projectPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* The agent writes memory while it works, so this list has to follow it. Without this the panel
     shows what memory looked like when it mounted — and the user, who has just watched the agent
     say "Remembered", sees no sign of it. Same pattern the Replay panel uses. */
  useEffect(() => {
    return window.studio.onAgentEvent((ev) => {
      if (ev.type === 'done' || ev.type === 'error') void refresh()
      else if (ev.type === 'tool' && ev.tool === 'remember') void refresh()
    })
  }, [refresh])

  const add = useCallback(async () => {
    const t = text.trim()
    if (!t) return
    const saved = await window.studio.memoryAdd(projectPath, { kind, text: t })
    setText('')
    if (!saved) onMsg('err', 'That memory was empty.')
    void refresh()
  }, [projectPath, kind, text, onMsg, refresh])

  return (
    <div className="memory-panel">
      <div className="settings-subhead">
        Project memory
        {stats && <span className="muted small"> · {stats.total} items{stats.stale ? ` · ${stats.stale} stale` : ''}</span>}
      </div>
      <p className="muted small">
        What this project knows — goals, rules, decisions, things never to do. The AI loads the
        relevant parts before every task, so you don't have to explain them again.
      </p>

      <div className="mem-add">
        <select className="text-input mem-kind" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <input
          className="text-input"
          placeholder="e.g. Never change prices without an approval record"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button className="btn btn-sm btn-primary" onClick={() => void add()} disabled={!text.trim()}>
          Remember
        </button>
      </div>

      {stats && (
        <label className="settings-toggle" title={`Writes ATOMIC-MEMORY.md into ${projectPath}`}>
          <input
            type="checkbox"
            checked={stats.syncToProject}
            onChange={async (e) => {
              await window.studio.memorySetSync(projectPath, e.target.checked)
              onMsg(
                'ok',
                e.target.checked
                  ? 'ATOMIC-MEMORY.md now lives in your project — commit it and your team shares this memory.'
                  : 'Studio will stop writing ATOMIC-MEMORY.md. The file already there is left alone.'
              )
              void refresh()
            }}
          />
          <span>
            Keep a copy in the project (<code>ATOMIC-MEMORY.md</code>) so it travels with your code
          </span>
        </label>
      )}

      {showFilter && entries.length > 0 && (
        <div className="mem-filters" role="group" aria-label="Filter memory by kind">
          <button type="button" className={`btn btn-sm ${only === 'all' ? 'toggled' : ''}`} aria-pressed={only === 'all'} onClick={() => setOnly('all')}>
            All ({entries.length})
          </button>
          {KINDS.filter((k) => entries.some((e) => e.kind === k.id)).map((k) => (
            <button
              key={k.id}
              type="button"
              className={`btn btn-sm ${only === k.id ? 'toggled' : ''}`}
              aria-pressed={only === k.id}
              onClick={() => setOnly(only === k.id ? 'all' : k.id)}
            >
              {k.label} ({entries.filter((e) => e.kind === k.id).length})
            </button>
          ))}
        </div>
      )}
      {entries.length === 0 && <p className="muted small">Nothing remembered yet.</p>}
      {entries.length > 0 && entries.filter((e) => only === 'all' || e.kind === only).length === 0 && (
        <p className="muted small">Nothing of that kind yet.</p>
      )}
      {entries.filter((e) => only === 'all' || e.kind === only).map((e) => (
        <div key={e.id} className={`debt-row mem-row ${e.stale ? 'mem-stale' : ''}`}>
          <span className={`ws-badge mem-${e.kind}`}>{LABEL[e.kind] ?? e.kind}</span>
          <span className="debt-detail" title={e.text}>
            {e.text}
            {e.source === 'agent' && (
              <span className="ws-badge mem-by-ai" title="Written by the AI while it worked">
                <Icon name="robot" size={10} /> AI
              </span>
            )}
            {ALWAYS.includes(e.kind) && <span className="muted small mem-always"> · always sent</span>}
            {e.stale && <span className="muted small"> · a file this mentions is gone</span>}
          </span>
          <button
            className="btn btn-sm"
            title={e.pinned ? 'Stop always sending this' : 'Always send this to the AI'}
            onClick={async () => {
              await window.studio.memoryPin(projectPath, e.id, !e.pinned)
              void refresh()
            }}
          >
            {e.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            className="btn btn-sm"
            title="Forget this"
            onClick={async () => {
              await window.studio.memoryForget(projectPath, e.id)
              void refresh()
            }}
          >
            Forget
          </button>
        </div>
      ))}

      {/* The honest version of "trust me, it's using your memory": run the real retrieval. */}
      <div className="settings-subhead">What would the AI load?</div>
      <div className="mem-add">
        <input
          className="text-input"
          placeholder="Type a task, e.g. add a discount field to checkout"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && task.trim()) setPreview(await window.studio.memoryPreview(projectPath, task))
          }}
        />
        <button
          className="btn btn-sm"
          disabled={!task.trim()}
          onClick={async () => setPreview(await window.studio.memoryPreview(projectPath, task))}
        >
          Preview
        </button>
      </div>
      {preview && (
        <div className="mem-preview">
          {preview.entries.length === 0 && <p className="muted small">Nothing would be loaded for that task.</p>}
          {preview.entries.map((e) => (
            <div key={e.id} className="mem-preview-row">
              <span className={`ws-badge mem-${e.kind}`}>{LABEL[e.kind] ?? e.kind}</span>
              <span className="debt-detail">{e.text}</span>
            </div>
          ))}
          {preview.omitted > 0 && (
            <p className="muted small">
              {preview.omitted} more didn&apos;t fit — memory is capped on purpose so it can never bloat the AI&apos;s
              context.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
