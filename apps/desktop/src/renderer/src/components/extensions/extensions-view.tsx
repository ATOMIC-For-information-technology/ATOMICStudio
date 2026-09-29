import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../Icon'
import { SidebarSection } from '../SidebarSection'
import { ExtensionRow } from './extension-row'
import { ExtensionDetail } from './extension-detail'
import { initialsFor, type ExtItem } from './types'
import { applyTheme } from '../../theme'
import type { ConnectorInfo, ExtensionManifest, RegistryEntry } from '../../../../shared/types'
import type { Theme } from '../../../../shared/theme'

interface Props {
  autocompleteOn: boolean
  onAutocompleteChange: (on: boolean) => void
  autoFixOn: boolean
  onAutoFixChange: (on: boolean) => void
  airGapped: boolean
  onToggleAirGap: () => void
  onMsg: (type: 'ok' | 'err', text: string) => void
  /**
   * Where the detail page goes. The sidebar hands it to the editor area (VS Code's own placement);
   * the Settings modal has no editor area, so it omits this and the view renders detail inline.
   */
  onOpenDetail?: (item: ExtItem | null) => void
  /** The row the editor area is currently showing, so the list can mark it selected. */
  selectedKey?: string | null
}

/**
 * The Extensions view — VS Code's shape over this product's real extension model.
 *
 * The shape is borrowed wholesale: a search field, collapsible sections with count badges, and rows
 * of icon-tile + name + version + description + publisher + action. What is *not* borrowed is the
 * promise. VS Code's list is a marketplace of executable extensions; this list is four honest
 * things — the MCP connectors actually installed, the colour themes actually available, the
 * built-in Studio features that can genuinely be turned on and off, and a short curated registry.
 * Nothing here implies a `.vsix` will install (PRODUCT.md rules that out, and a UI that suggests
 * otherwise would be the exact "claims something the app can't back up" failure this codebase
 * enforces against harder than any other rule).
 *
 * The BUILT-IN section is the one addition VS Code has no equivalent for, and it earns its place:
 * Tab Autocomplete, Self-healing Auto-fix and Air-Gapped Mode were previously three checkboxes in a
 * settings tab, which made Studio's own capabilities look less real than a third-party connector.
 * They are features with an on/off state and a description — which is what a row in this list is.
 */
export function ExtensionsView({
  autocompleteOn,
  onAutocompleteChange,
  autoFixOn,
  onAutoFixChange,
  airGapped,
  onToggleAirGap,
  onMsg,
  onOpenDetail,
  selectedKey
}: Props): React.JSX.Element {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([])
  const [installed, setInstalled] = useState<ExtensionManifest[]>([])
  const [themes, setThemes] = useState<Theme[]>([])
  const [activeThemeId, setActiveThemeId] = useState('')
  const [registry, setRegistry] = useState<RegistryEntry[] | null>(null)
  const [registryError, setRegistryError] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [confirmUrl, setConfirmUrl] = useState('')
  const [showInstall, setShowInstall] = useState(false)
  const [open, setOpen] = useState({ installed: true, themes: true, builtin: true, recommended: true })
  const [inlineKey, setInlineKey] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [c, i, t, active] = await Promise.all([
      window.studio.connectorList(),
      window.studio.extensionsList(),
      window.studio.themeList(),
      window.studio.themeGet()
    ])
    setConnectors(c)
    setInstalled(i)
    setThemes(t)
    setActiveThemeId(active.id)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggleSection = (k: keyof typeof open): void => setOpen((s) => ({ ...s, [k]: !s[k] }))

  /* ---- Rows ------------------------------------------------------------------------------ */

  const connectorItems = useMemo<ExtItem[]>(() => {
    // A connector and its manifest are two views of one installed thing; the manifest carries the
    // version and description, the connector carries the live state.
    const byId = new Map(installed.map((m) => [m.id, m]))
    return connectors.map((c) => {
      const m = byId.get(c.id)
      const approved = c.approvedTools.length
      return {
        key: `c:${c.id}`,
        id: c.id,
        name: c.name,
        publisher: m?.id ?? c.source,
        version: m?.version ? `v${m.version}` : '',
        description: m?.description ?? c.command,
        kind: 'connector' as const,
        initials: initialsFor(c.name),
        state: c.blockedByAirGap
          ? 'held back by Air-Gapped Mode'
          : c.enabled
            ? `${approved} of ${c.tools.length} tools approved`
            : 'disabled',
        tone: c.blockedByAirGap ? ('warn' as const) : c.enabled ? ('ok' as const) : ('neutral' as const),
        busy: busy === c.id,
        connector: c,
        manifest: m
      }
    })
  }, [connectors, installed, busy])

  const themeItems = useMemo<ExtItem[]>(
    () =>
      themes.map((t) => ({
        key: `t:${t.id}`,
        id: t.id,
        name: t.name,
        publisher: t.publisher,
        version: '',
        description: `${t.kind.replace('hc-', 'high contrast ')} colour theme`,
        kind: 'theme' as const,
        initials: initialsFor(t.name),
        state: t.id === activeThemeId ? 'active' : t.source === 'built-in' ? 'built-in' : 'installed',
        tone: t.id === activeThemeId ? ('ok' as const) : ('neutral' as const),
        theme: t
      })),
    [themes, activeThemeId]
  )

  const builtinItems = useMemo<ExtItem[]>(
    () => [
      {
        key: 'b:autocomplete',
        id: 'autocomplete',
        name: 'Tab Autocomplete',
        publisher: 'ATOMIC',
        version: '',
        description: 'Ghost-text code suggestions while you type.',
        kind: 'builtin' as const,
        initials: 'TA',
        state: autocompleteOn ? 'on' : 'off',
        tone: autocompleteOn ? ('ok' as const) : ('neutral' as const),
        toggle: { on: autocompleteOn, set: onAutocompleteChange }
      },
      {
        key: 'b:autofix',
        id: 'autofix',
        name: 'Self-healing Auto-fix',
        publisher: 'ATOMIC',
        version: '',
        description: 'Repairs preview errors caused by an AI edit, without being asked.',
        kind: 'builtin' as const,
        initials: 'SA',
        state: autoFixOn ? 'on' : 'off',
        tone: autoFixOn ? ('ok' as const) : ('neutral' as const),
        toggle: { on: autoFixOn, set: onAutoFixChange }
      },
      {
        key: 'b:airgap',
        id: 'airgap',
        name: 'Air-Gapped Mode',
        publisher: 'ATOMIC',
        version: '',
        description: 'Blocks all outbound AI traffic and uses only the local model.',
        kind: 'builtin' as const,
        initials: 'AG',
        state: airGapped ? 'blocking outbound AI' : 'off',
        tone: airGapped ? ('warn' as const) : ('neutral' as const),
        toggle: { on: airGapped, set: () => onToggleAirGap() }
      },
      {
        key: 'b:index',
        id: 'index',
        name: 'AI Project Index',
        publisher: 'ATOMIC',
        version: '',
        description: 'The background code map behind Search Everywhere and the agent.',
        kind: 'builtin' as const,
        initials: 'PI',
        state: 'always on',
        tone: 'neutral' as const,
        toggle: { on: true, core: true, set: () => {} }
      },
      {
        key: 'b:click',
        id: 'clicktoedit',
        name: 'Click-to-edit',
        publisher: 'ATOMIC',
        version: '',
        description: 'Select an element in the live preview and edit the code behind it.',
        kind: 'builtin' as const,
        initials: 'CE',
        state: 'always on',
        tone: 'neutral' as const,
        toggle: { on: true, core: true, set: () => {} }
      }
    ],
    [autocompleteOn, autoFixOn, airGapped, onAutocompleteChange, onAutoFixChange, onToggleAirGap]
  )

  const registryItems = useMemo<ExtItem[]>(
    () =>
      (registry ?? [])
        .filter((e) => !e.installed)
        .map((e) => ({
          key: `r:${e.id}`,
          id: e.id,
          name: e.name,
          publisher: e.publisher,
          version: '',
          description: e.description,
          kind: 'registry' as const,
          initials: initialsFor(e.name),
          state: 'not installed',
          tone: 'neutral' as const,
          registry: e
        })),
    [registry]
  )

  /**
   * Every row, in one list.
   *
   * The detail page is looked up out of this by key rather than being handed a copy of the row that
   * was clicked. That is not tidiness: a snapshot goes stale the moment the thing it describes
   * changes, and the first thing a user does on this page is enable a connector — which is exactly
   * when its tool list arrives. The snapshot version showed an empty Features tab forever.
   */
  const allItems = useMemo(
    () => [...connectorItems, ...themeItems, ...builtinItems, ...registryItems],
    [connectorItems, themeItems, builtinItems, registryItems]
  )
  const inlineDetail = inlineKey ? (allItems.find((i) => i.key === inlineKey) ?? null) : null

  // The editor-area detail lives in App's state, so it is pushed the fresh row for the same reason.
  useEffect(() => {
    if (!onOpenDetail || !selectedKey) return
    const fresh = allItems.find((i) => i.key === selectedKey)
    if (fresh) onOpenDetail(fresh)
  }, [allItems, selectedKey, onOpenDetail])

  const match = useCallback(
    (items: ExtItem[]) => {
      const q = query.trim().toLowerCase()
      if (!q) return items
      return items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.publisher.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q)
      )
    },
    [query]
  )

  /* ---- Actions ---------------------------------------------------------------------------- */

  const select = useCallback(
    (item: ExtItem) => {
      if (onOpenDetail) onOpenDetail(item)
      else setInlineKey(item.key)
    },
    [onOpenDetail]
  )

  const setEnabled = useCallback(
    async (item: ExtItem, on: boolean) => {
      if (!item.connector) return
      setBusy(item.id)
      const res = await window.studio.connectorSetEnabled(item.id, on)
      setBusy('')
      if (!res.ok) onMsg('err', res.error ?? `Could not start ${item.name}.`)
      else if (on) {
        onMsg('ok', `${item.name} started — ${res.tools?.length ?? 0} tools found. Approve the ones the AI may use.`)
      }
      await refresh()
    },
    [onMsg, refresh]
  )

  const uninstall = useCallback(
    async (item: ExtItem) => {
      setBusy(item.id)
      const res = await window.studio.extensionUninstall(item.id)
      // A connector installed by hand has no extension folder to remove; drop the running server too
      // so "uninstall" never leaves a live process behind a row that no longer exists.
      await window.studio.connectorRemove(item.id)
      setBusy('')
      onMsg(res.ok ? 'ok' : 'err', res.ok ? `Removed ${item.name}.` : (res.error ?? `Removed ${item.name}.`))
      if (onOpenDetail) onOpenDetail(null)
      setInlineKey(null)
      await refresh()
    },
    [onMsg, onOpenDetail, refresh]
  )

  const approveTool = useCallback(
    async (connectorId: string, tool: string, approved: boolean) => {
      await window.studio.connectorApproveTool(connectorId, tool, approved)
      await refresh()
    },
    [refresh]
  )

  const setThemeById = useCallback(
    async (id: string) => {
      applyTheme(await window.studio.themeSet(id))
      await refresh()
    },
    [refresh]
  )

  const installFolder = useCallback(async () => {
    setBusy('folder')
    const res = await window.studio.extensionInstallFolder()
    setBusy('')
    if (res.ok && res.manifest) onMsg('ok', `Installed ${res.manifest.name}. It stays off until you turn it on.`)
    else if (res.error && res.error !== 'cancelled') onMsg('err', res.error)
    await refresh()
  }, [onMsg, refresh])

  const installGit = useCallback(async () => {
    const url = confirmUrl
    setConfirmUrl('')
    setBusy('git')
    const res = await window.studio.extensionInstallGit(url)
    setBusy('')
    if (res.ok && res.manifest) {
      setGitUrl('')
      onMsg('ok', `Installed ${res.manifest.name}. It stays off until you turn it on.`)
    } else if (res.error) onMsg('err', res.error)
    await refresh()
  }, [confirmUrl, onMsg, refresh])

  const installTheme = useCallback(async () => {
    setBusy('theme')
    const res = await window.studio.themeInstallFile()
    setBusy('')
    if (res.ok && res.theme) {
      applyTheme(await window.studio.themeSet(res.theme.id))
      onMsg('ok', `Installed and applied "${res.theme.name}".`)
    } else if (res.error && res.error !== 'cancelled') onMsg('err', res.error)
    await refresh()
  }, [onMsg, refresh])

  const loadRegistry = useCallback(async () => {
    setBusy('registry')
    const res = await window.studio.extensionRegistry()
    setBusy('')
    setRegistry(res.entries)
    setRegistryError(res.ok ? '' : (res.error ?? 'Could not reach the registry.'))
  }, [])

  const shownConnectors = match(connectorItems)
  const shownThemes = match(themeItems)
  const shownBuiltins = match(builtinItems)
  const shownRegistry = match(registryItems)
  const nothing =
    shownConnectors.length + shownThemes.length + shownBuiltins.length + shownRegistry.length === 0

  return (
    <div className="ext-view">
      <div className="ext-search">
        <span className="ext-search-icon" aria-hidden="true">
          <Icon name="search" size={13} />
        </span>
        <input
          className="text-input"
          type="search"
          placeholder="Search extensions and themes"
          aria-label="Search extensions and themes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="ext-more"
          aria-expanded={showInstall}
          onClick={() => setShowInstall((v) => !v)}
          title="Install from a folder, a GitHub link, or a theme file"
          aria-label="Install options"
        >
          <Icon name="plus" size={13} />
        </button>
      </div>

      {showInstall && (
        <div className="ext-install">
          <button className="btn btn-sm" disabled={busy === 'folder'} onClick={() => void installFolder()}>
            {busy === 'folder' ? 'Installing…' : 'From a folder…'}
          </button>
          <button className="btn btn-sm" disabled={busy === 'theme'} onClick={() => void installTheme()}>
            {busy === 'theme' ? 'Reading…' : 'Colour theme file…'}
          </button>
          <div className="ext-install-git">
            <input
              className="text-input"
              placeholder="https://github.com/owner/repo"
              aria-label="GitHub repository to install from"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
            />
            <button
              className="btn btn-sm"
              disabled={!gitUrl.trim() || busy === 'git' || airGapped}
              onClick={() => setConfirmUrl(gitUrl.trim())}
            >
              {busy === 'git' ? 'Installing…' : 'Install'}
            </button>
          </div>
          {airGapped && (
            <p className="muted small">
              <Icon name="lock" size={11} /> Air-Gapped Mode is on, so nothing is downloaded and connectors stay off.
            </p>
          )}
        </div>
      )}

      {confirmUrl && (
        <div className="error-box install-confirm">
          <div className="dp-headline">This runs someone else's code on your computer.</div>
          <div className="dp-line">
            {confirmUrl} will be downloaded and can read and change your files, exactly like any program you install.
            Only continue if you trust whoever wrote it.
          </div>
          <div className="dp-actions">
            <button className="btn btn-sm btn-danger" onClick={() => void installGit()}>
              I trust it — install
            </button>
            <button className="btn btn-sm" onClick={() => setConfirmUrl('')}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="ext-sections" role="listbox" aria-label="Extensions">
        <SidebarSection
          title="Installed"
          open={open.installed}
          onToggle={() => toggleSection('installed')}
          count={shownConnectors.length || undefined}
        >
          {shownConnectors.length === 0 ? (
            <p className="ext-empty muted small">
              No connectors installed. A connector gives the AI extra tools — your database, GitHub, a design file.
            </p>
          ) : (
            shownConnectors.map((item) => (
              <ExtensionRow
                key={item.key}
                item={item}
                selected={(selectedKey ?? inlineKey) === item.key}
                onSelect={() => select(item)}
                action={{
                  label: item.connector?.enabled ? 'Disable' : 'Enable',
                  onRun: () => void setEnabled(item, !item.connector?.enabled),
                  disabled: airGapped
                }}
              />
            ))
          )}
        </SidebarSection>

        <SidebarSection
          title="Themes"
          open={open.themes}
          onToggle={() => toggleSection('themes')}
          count={shownThemes.length}
        >
          {shownThemes.map((item) => (
            <ExtensionRow
              key={item.key}
              item={item}
              selected={(selectedKey ?? inlineKey) === item.key}
              onSelect={() => select(item)}
              action={
                item.id === activeThemeId
                  ? undefined
                  : { label: 'Apply', onRun: () => void setThemeById(item.id) }
              }
            />
          ))}
        </SidebarSection>

        <SidebarSection
          title="Built in"
          open={open.builtin}
          onToggle={() => toggleSection('builtin')}
          count={shownBuiltins.length}
        >
          {shownBuiltins.map((item) => (
            <ExtensionRow
              key={item.key}
              item={item}
              selected={(selectedKey ?? inlineKey) === item.key}
              onSelect={() => select(item)}
            />
          ))}
        </SidebarSection>

        <SidebarSection
          title="Recommended"
          open={open.recommended}
          onToggle={() => toggleSection('recommended')}
          count={registry ? shownRegistry.length : undefined}
        >
          <p className="ext-empty muted small">
            A short list ATOMIC checks and publishes — not an open store.
          </p>
          {registry === null ? (
            <div className="ext-empty">
              <button className="btn btn-sm" disabled={busy === 'registry' || airGapped} onClick={() => void loadRegistry()}>
                {busy === 'registry' ? 'Loading…' : 'Browse the registry'}
              </button>
            </div>
          ) : (
            <>
              {registryError && <p className="ext-empty muted small">{registryError}</p>}
              {shownRegistry.length === 0 && !registryError && (
                <p className="ext-empty muted small">Everything on the list is already installed.</p>
              )}
              {shownRegistry.map((item) => (
                <ExtensionRow
                  key={item.key}
                  item={item}
                  selected={(selectedKey ?? inlineKey) === item.key}
                  onSelect={() => select(item)}
                  action={{
                    label: 'Install',
                    onRun: () => setConfirmUrl(item.registry?.repo ?? ''),
                    disabled: airGapped || !item.registry?.repo
                  }}
                />
              ))}
            </>
          )}
        </SidebarSection>

        {nothing && <p className="ext-empty muted small">Nothing matches “{query}”.</p>}
      </div>

      {inlineDetail && (
        <ExtensionDetail
          item={inlineDetail}
          onClose={() => setInlineKey(null)}
          onEnable={(i, on) => void setEnabled(i, on)}
          onUninstall={(i) => void uninstall(i)}
          onApproveTool={(id, tool, ok) => void approveTool(id, tool, ok)}
          onApplyTheme={(id) => void setThemeById(id)}
          airGapped={airGapped}
          busy={busy === inlineDetail.id}
        />
      )}
    </div>
  )
}
