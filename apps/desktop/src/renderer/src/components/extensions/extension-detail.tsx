import React, { useState } from 'react'
import { Icon } from '../Icon'
import type { ExtItem } from './types'
import { tileStyle } from './extension-row'

interface Props {
  item: ExtItem
  onClose: () => void
  onEnable: (item: ExtItem, on: boolean) => void
  onUninstall: (item: ExtItem) => void
  onApproveTool: (connectorId: string, tool: string, approved: boolean) => void
  onApplyTheme: (themeId: string) => void
  airGapped: boolean
  busy: boolean
}

type Tab = 'details' | 'features'

/**
 * The extension detail page — VS Code opens this in the editor area, not the sidebar, and so does
 * this: the sidebar is 300px of list, and a tool list with per-tool approval genuinely needs the
 * width.
 *
 * The FEATURES tab is where this product's safety model becomes visible rather than described. A
 * connector's tools are listed one per row with their own checkbox, because that is literally how
 * approval works here — the agent can call an approved tool and nothing else. A connector that is
 * off says so and offers the one action that changes it, rather than showing an empty list that
 * looks like a broken extension.
 */
export function ExtensionDetail({
  item,
  onClose,
  onEnable,
  onUninstall,
  onApproveTool,
  onApplyTheme,
  airGapped,
  busy
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('details')
  const c = item.connector
  const tools = c?.tools ?? []
  const approved = tools.filter((t) => t.approved).length

  return (
    <div className="ext-detail">
      <header className="ext-detail-head">
        <span className={`ext-tile ext-tile-lg ext-tile-${item.kind}`} style={tileStyle(item)} aria-hidden="true">
          {item.initials}
        </span>
        <div className="ext-detail-meta">
          <h2 className="ext-detail-name">{item.name}</h2>
          <div className="ext-detail-sub">
            <span className="ext-publisher">{item.publisher}</span>
            {item.version && <span className="ext-version">{item.version}</span>}
            {item.state && <span className={`ext-state ext-state-${item.tone ?? 'neutral'}`}>{item.state}</span>}
          </div>
          <p className="ext-detail-desc">{item.description || 'No description provided.'}</p>
          <div className="ext-detail-actions">
            {item.kind === 'connector' && c && (
              <>
                <button
                  className={`btn btn-sm ${c.enabled ? '' : 'btn-primary'}`}
                  disabled={busy || airGapped}
                  onClick={() => onEnable(item, !c.enabled)}
                  title={airGapped ? 'Air-Gapped Mode is on — connectors are held back.' : undefined}
                >
                  {busy ? '…' : c.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="btn btn-sm btn-danger-ghost" disabled={busy} onClick={() => onUninstall(item)}>
                  Uninstall
                </button>
              </>
            )}
            {item.kind === 'theme' && item.theme && (
              <button className="btn btn-sm btn-primary" onClick={() => onApplyTheme(item.theme!.id)}>
                Set colour theme
              </button>
            )}
            {item.kind === 'builtin' && item.toggle && !item.toggle.core && (
              <button
                className={`btn btn-sm ${item.toggle.on ? '' : 'btn-primary'}`}
                onClick={() => item.toggle!.set(!item.toggle!.on)}
              >
                {item.toggle.on ? 'Disable' : 'Enable'}
              </button>
            )}
          </div>
        </div>
        <button className="panel-close" onClick={onClose} title="Close" aria-label="Close extension details">
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="ext-detail-tabs" role="tablist" aria-label="Extension details">
        <button
          role="tab"
          aria-selected={tab === 'details'}
          className={`ext-detail-tab ${tab === 'details' ? 'active' : ''}`}
          onClick={() => setTab('details')}
        >
          Details
        </button>
        <button
          role="tab"
          aria-selected={tab === 'features'}
          className={`ext-detail-tab ${tab === 'features' ? 'active' : ''}`}
          onClick={() => setTab('features')}
        >
          Features{tools.length > 0 ? ` (${tools.length})` : ''}
        </button>
      </div>

      <div className="ext-detail-body">
        {tab === 'details' ? (
          <dl className="ext-facts">
            <dt>Kind</dt>
            <dd>
              {item.kind === 'connector'
                ? 'MCP connector — gives the AI extra tools'
                : item.kind === 'theme'
                  ? 'Colour theme — colours only, nothing in it runs'
                  : item.kind === 'builtin'
                    ? 'Built into Studio'
                    : 'Available from the ATOMIC registry'}
            </dd>
            {c && (
              <>
                <dt>Runs</dt>
                <dd>
                  <code className="run-cmd">{c.command}</code>
                </dd>
                <dt>Source</dt>
                <dd>{c.source}</dd>
                <dt>Tools approved</dt>
                <dd>
                  {approved} of {tools.length || '—'}
                </dd>
              </>
            )}
            {item.theme && (
              <>
                <dt>Family</dt>
                <dd>{item.theme.kind}</dd>
                <dt>Accent</dt>
                <dd>
                  <span className="ext-swatch" style={{ background: item.theme.tokens.accent }} aria-hidden="true" />
                  <code className="run-cmd">{item.theme.tokens.accent}</code>
                </dd>
              </>
            )}
            {item.kind === 'connector' && (
              <>
                <dt>Safety</dt>
                <dd>
                  This is code running on your computer with your own file permissions. It arrives disabled, and the
                  AI can only call the tools you approve one by one. Air-Gapped Mode turns all of it off.
                </dd>
              </>
            )}
          </dl>
        ) : item.kind !== 'connector' ? (
          <p className="muted small">
            {item.kind === 'theme'
              ? 'A colour theme has no tools and no code — it is a list of colours.'
              : 'This one has no separately approvable tools.'}
          </p>
        ) : !c?.enabled ? (
          <p className="muted small">
            <Icon name="ban" size={11} /> This connector is off, so its tools have not been listed yet. Enable it to
            see what it offers — nothing is approved automatically.
          </p>
        ) : tools.length === 0 ? (
          <p className="muted small">This connector started but offered no tools.</p>
        ) : (
          <>
            <p className="muted small">
              The AI can call a tool only after you tick it. Every call is written to the audit log.
            </p>
            <ul className="ext-tools">
              {tools.map((t) => (
                <li key={t.name}>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={t.approved}
                      onChange={(e) => onApproveTool(c.id, t.name, e.target.checked)}
                    />
                    <span>
                      <b>{t.name}</b>{' '}
                      <span className="muted small">— {t.description || 'no description provided'}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
