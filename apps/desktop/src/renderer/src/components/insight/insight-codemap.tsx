import React, { useState } from 'react'
import { Icon } from '../Icon'
import { InsightSection } from './insight-section'
import { InsightEmpty } from './insight-empty-state'
import { CrossRepoPanel } from '../CrossRepoPanel'
import { findUnusedFiles } from '../../../../shared/orphans'
import { rankFragile } from '../../../../shared/fragile'
import { findCycles } from '../../../../shared/tangles'
import type { ActionItem } from '../../../../shared/actionplan'
import type { ProjectBrain, ProjectInsight } from '../../../../shared/types'
import type { ArchView } from './derive'
import type { CodeMapData } from './types'

interface Props {
  data: CodeMapData
  arch: ArchView | null
  brain: ProjectBrain | null
  insight: ProjectInsight | null
  canOpenFiles: boolean
  onOpenFile: (path: string) => void
  onFindRelated: (seed: string) => void
  onSetBaseline: () => void
  onFixWithAi: (item: ActionItem) => void
}

/**
 * Everything that can be rebuilt by reading the code and the git history.
 *
 * That is the line between this and Memory, and it is the reason they are separate destinations:
 * delete this whole screen and nothing is lost, because every fact on it is derivable. Memory holds
 * what re-reading the repository could never tell you.
 *
 * Four things are open by default — where the code starts, what it leans on, what it depends on,
 * and how to find related files. Everything else is a real analysis with real caveats that is
 * rarely why someone opened the screen, so it stays closed until asked for. That is also what keeps
 * the row count down: a closed section renders nothing.
 */
export function InsightCodeMap(props: Props): React.JSX.Element {
  const { data, arch } = props
  const [seed, setSeed] = useState('')
  const pack = data.context.data

  const orphans = findUnusedFiles(data.arch.data)
  const fragile = rankFragile(props.brain?.hotspots ?? [], props.insight?.debt ?? [])
  const rawTangles = findCycles(data.arch.data?.edges ?? [])
  // A truncated graph can hide loops, so the card inherits the map's own incompleteness — otherwise
  // "no tangles" would be a clean bill of health issued on evidence we never had.
  const tangles = data.arch.data?.partial ? { ...rawTangles, partial: true } : rawTangles

  if (data.arch.phase === 'loading' && !arch) {
    return <p className="muted small" aria-live="polite">Reading this project&apos;s imports…</p>
  }
  if (data.arch.phase === 'error') {
    return <InsightEmpty icon="ban" title="Could not read this project's structure." detail={data.arch.error} />
  }

  return (
    <div className="iv-codemap">
      {data.arch.caveat && <p className="iv-caveat muted small"><Icon name="alert" size={10} /> {data.arch.caveat}</p>}
      {/* Re-opening this destination now re-reads a stale graph, so this is the case that survives:
          the project changed while the reader was still LOOKING at the screen. Every card below is
          a statement about the imports — "nobody imports it", "no tangles" — and none of them may
          be read as current once the files underneath have moved. Say so, rather than let someone
          find out by deleting a file that something started importing a minute ago. */}
      {data.arch.stale && (
        <p className="iv-caveat muted small">
          <Icon name="alert" size={10} /> This project changed after these were read — refresh to see them as they are now.
        </p>
      )}

      {/* ── default content ─────────────────────────────────────────────────────────── */}
      <section className="iv-block">
        <h3 className="iv-h">Where this project starts</h3>
        {arch && arch.entries.length > 0 ? (
          <div className="iv-chips">
            {arch.entries.slice(0, 8).map((n) => (
              <button key={n.path} type="button" className="iv-chip arch-chip" title={n.path} onClick={() => props.onOpenFile(n.path)}>
                <Icon name="play" size={10} /> {n.path.split('/').pop()}
              </button>
            ))}
          </div>
        ) : (
          <InsightEmpty title="No entry point identified." detail="Nothing here looked like a main, index or app entry file." />
        )}
      </section>

      <section className="iv-block arch-map">
        <h3 className="iv-h arch-map-h">Core modules {arch && <span className="muted small">· {arch.fileCount} files · {arch.edgeCount} links</span>}</h3>
        {arch && arch.modules.length > 0 ? (
          <ul className="iv-list">
            {arch.modules.map((n) => (
              <li key={n.path} className="iv-row arch-row">
                <span className={`iv-sev ws-badge lang-${n.language}`}>{n.language}</span>
                <span className="iv-row-text debt-detail" title={n.path}>{n.path} <span className="muted small">· {n.symbols} defs · {n.refs} refs</span></span>
                {props.canOpenFiles && <button type="button" className="btn btn-sm" onClick={() => props.onOpenFile(n.path)}>Open file</button>}
              </li>
            ))}
          </ul>
        ) : (
          <InsightEmpty title="No module graph yet." />
        )}
      </section>

      {arch && arch.deps.length > 0 && (
        <section className="iv-block">
          <h3 className="iv-h">Depends on</h3>
          <div className="iv-chips">
            {arch.deps.map((d) => (
              <span key={d.name} className="iv-chip arch-chip iv-chip-static" title={`${d.count} import${d.count === 1 ? '' : 's'}`}>{d.name} <b>{d.count}</b></span>
            ))}
          </div>
        </section>
      )}

      <section className="iv-block">
        <h3 className="iv-h">Find related files</h3>
        <div className="iv-find ctx-find">
          <input
            className="text-input"
            placeholder="A file (src/App.tsx) or a topic (auth)…"
            aria-label="File or topic to find related files for"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') props.onFindRelated(seed) }}
          />
          <button type="button" className="btn btn-sm" onClick={() => props.onFindRelated(seed)} disabled={!seed.trim()}>Find related</button>
        </div>
        {data.context.phase === 'loading' && <p className="muted small" aria-live="polite">Searching…</p>}
        {pack && (
          <>
            <p className="muted small">{pack.files.length} file{pack.files.length === 1 ? '' : 's'} relevant to “{pack.seed}” ({pack.seedKind})</p>
            <ul className="iv-list">
              {pack.files.map((f) => (
                <li key={f.path} className="iv-row ctx-row">
                  <span className={`iv-sev ws-badge ctx-${f.reason}`}>{f.reason}</span>
                  <span className="iv-row-text debt-detail" title={f.symbols.join(', ')}>{f.path}</span>
                  {props.canOpenFiles && <button type="button" className="btn btn-sm" onClick={() => props.onOpenFile(f.path)}>Open file</button>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ── advanced, closed until asked for ────────────────────────────────────────── */}
      <InsightSection
        title="Architecture drift"
        info="How the dependency graph has moved since you froze a baseline. Without a baseline there is nothing to compare against — that is not the same as no drift."
        hint={data.drift.data?.hasBaseline ? undefined : 'no baseline'}
      >
        <div className="iv-actions">
          <button type="button" className="btn btn-sm" onClick={props.onSetBaseline} title="Freeze the current architecture as the reference point">
            {data.drift.data?.hasBaseline ? 'Reset baseline to now' : 'Set baseline'}
          </button>
        </div>
        {data.drift.caveat && <p className="iv-caveat muted small"><Icon name="alert" size={10} /> {data.drift.caveat}</p>}
        {!data.drift.data?.hasBaseline ? (
          <InsightEmpty title="No baseline yet." detail="Set one and future changes are measured from it." />
        ) : (
          (() => {
            const d = data.drift.data
            const total = d.modules.added.length + d.modules.removed.length + d.edges.added.length + d.edges.removed.length + d.externalDeps.added.length + d.externalDeps.removed.length
            if (total === 0) return <p className="ok-box">No drift — the architecture matches its baseline.</p>
            return (
              <ul className="iv-list">
                {d.modules.added.map((m) => <li key={`m+${m}`} className="iv-row"><span className="iv-sev drift-add">+module</span><span className="iv-row-text debt-detail">{m}</span></li>)}
                {d.modules.removed.map((m) => <li key={`m-${m}`} className="iv-row"><span className="iv-sev drift-rem">−module</span><span className="iv-row-text debt-detail">{m}</span></li>)}
                {d.externalDeps.added.map((x) => <li key={`d+${x}`} className="iv-row"><span className="iv-sev drift-add">+dep</span><span className="iv-row-text debt-detail">{x}</span></li>)}
                {d.externalDeps.removed.map((x) => <li key={`d-${x}`} className="iv-row"><span className="iv-sev drift-rem">−dep</span><span className="iv-row-text debt-detail">{x}</span></li>)}
                {d.edges.added.slice(0, 20).map((e, i) => <li key={`e+${i}`} className="iv-row"><span className="iv-sev drift-add">+link</span><span className="iv-row-text debt-detail">{e.from} → {e.to}</span></li>)}
                {d.edges.removed.slice(0, 20).map((e, i) => <li key={`e-${i}`} className="iv-row"><span className="iv-sev drift-rem">−link</span><span className="iv-row-text debt-detail">{e.from} → {e.to}</span></li>)}
              </ul>
            )
          })()
        )}
      </InsightSection>

      <InsightSection
        bodyClass="fragile-card"
        title="Handle with care"
        info="Files that change often AND carry debt signals — the ones most likely to break when touched."
        hint={fragile.files.length ? String(fragile.files.length) : undefined}
      >
        {fragile.needsGit && <p className="muted small">Connect git history for the full picture.</p>}
        {fragile.noOverlap && <p className="muted small">None of your busiest files carry debt — showing the messiest instead.</p>}
        {fragile.files.length === 0 ? (
          <InsightEmpty icon="check" title="Your busiest files look clean." />
        ) : (
          <ul className="iv-list">
            {fragile.files.slice(0, 12).map((f) => (
              <li key={f.path} className="iv-row">
                <span className="iv-sev iv-sev-tag-medium">fragile</span>
                <span className="iv-row-text debt-detail" title={f.path}>{f.path} <span className="muted small">· {f.debt.join(', ')}{f.commits ? ` · ${f.commits} changes` : ''}</span></span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => props.onFixWithAi({ severity: 'medium', kind: 'debt', title: `Clean up ${f.path}`, detail: (f.debt.join(', ') || 'churny file') + '.', file: f.path })}
                >
                  Fix with AI
                </button>
              </li>
            ))}
          </ul>
        )}
      </InsightSection>

      <InsightSection
        bodyClass="tangle-card"
        title="Tangled files"
        info="Files that import each other in a circle. A truncated graph can hide loops, so this says when it could not see everything."
        hint={tangles.cycles.length ? String(tangles.cycles.length) : undefined}
      >
        {tangles.cycles.length === 0 ? (
          <InsightEmpty
            icon={tangles.partial ? 'circle-dashed' : 'check'}
            title={tangles.partial ? 'No loops in the part we could read.' : 'No loops — nothing depends on itself in a circle.'}
            detail={tangles.partial ? 'Some of this project was too large to check fully.' : undefined}
          />
        ) : (
          <ul className="iv-list">
            {tangles.cycles.map((c, i) => (
              <li key={i} className="iv-row">
                <span className="iv-sev iv-sev-tag-medium">loop</span>
                <span className="iv-row-text debt-detail">{c.files.join(' → ')} → {c.files[0]}</span>
              </li>
            ))}
          </ul>
        )}
      </InsightSection>

      <InsightSection
        bodyClass="orphans-card"
        title="Possibly unused"
        info="Files nothing appears to import. Read-only — this never deletes anything, and a partial graph can be wrong about it."
        hint={orphans.files.length ? String(orphans.files.length) : undefined}
      >
        {orphans.partial && <p className="iv-caveat muted small"><Icon name="alert" size={10} /> Partial view — some of these ARE used. Always check before deleting.</p>}
        {orphans.files.length === 0 ? (
          <InsightEmpty
            icon={orphans.partial ? 'circle-dashed' : 'check'}
            title={orphans.partial ? 'Not enough of this project could be read to judge.' : 'Nothing looks obviously unused.'}
          />
        ) : (
          <ul className="iv-list">
            {orphans.files.slice(0, 20).map((f) => (
              <li key={f.path} className="iv-row">
                <span className="iv-sev ws-badge">review</span>
                <span className="iv-row-text debt-detail" title={f.path}>{f.path} <span className="muted small">· {orphans.partial ? 'no importer found (project too big to check fully)' : 'nobody imports it'}</span></span>
                {props.canOpenFiles && <button type="button" className="btn btn-sm" onClick={() => props.onOpenFile(f.path)}>Open file</button>}
              </li>
            ))}
          </ul>
        )}
      </InsightSection>

      <InsightSection
        title="Who knows this code"
        info="Who has committed to each file, by commit count. Needs git history."
        hint={data.owners.data?.length ? String(data.owners.data.length) : undefined}
      >
        {!data.owners.data || data.owners.data.length === 0 ? (
          <InsightEmpty title="No authorship to show." detail="This project has no git history to read." />
        ) : (
          <ul className="iv-list">
            {data.owners.data.slice(0, 12).map((o) => (
              <li key={o.file} className="iv-row">
                <span className="iv-sev ws-badge" title={o.authors.map((a) => `${a.name} (${a.commits})`).join(', ')}>{o.authors[0]?.name ?? '—'}</span>
                <span className="iv-row-text debt-detail">{o.file}</span>
                {props.canOpenFiles && <button type="button" className="btn btn-sm" onClick={() => props.onOpenFile(o.file)}>Open file</button>}
              </li>
            ))}
          </ul>
        )}
      </InsightSection>

      <InsightSection title="Across your projects" info="Shared dependencies and patterns across the projects you have opened recently.">
        <CrossRepoPanel />
      </InsightSection>
    </div>
  )
}
