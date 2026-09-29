import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { key } from '../keys'
import type { GitServer, ModelCatalog, PreflightResult, ProviderInfo } from '../../../shared/types'
import { ExtensionsView } from './extensions'
import { ReadinessWizard, type ReadinessStepView } from './ReadinessWizard'
import { CompanySignIn } from './CompanySignIn'
import { GitServerRemedy } from './git-panel'
import { describeMode, modeSurface, type StudioMode } from '../../../shared/mode'
import { MEDIA_PROVIDERS } from '../../../shared/media'

/** Editor preferences, persisted by the shell and fed into Monaco. */
export interface EditorPrefs {
  fontSize: number
  wordWrap: boolean
  minimap: boolean
  tabSize: number
}

interface Props {
  providers: ProviderInfo[]
  providerId: string
  onProviderChange: (id: string) => void
  provider: ProviderInfo | undefined
  model: string
  onModelChange: (model: string) => void
  keyInput: string
  onKeyInputChange: (key: string) => void
  hasKey: boolean
  onSaveKey: () => void
  autocompleteOn: boolean
  onAutocompleteChange: (on: boolean) => void
  editorPrefs: EditorPrefs
  onEditorPrefsChange: (prefs: EditorPrefs) => void
  autoFixOn: boolean
  onAutoFixChange: (on: boolean) => void
  airGapped: boolean
  onToggleAirGap: () => void
  /** Builder or Developer — the surface the whole app wears (see `shared/mode.ts`). */
  mode: StudioMode
  onModeChange: (mode: StudioMode) => void
  /** Which tab to open on. Defaults to 'ai' — the Profile rail icon opens straight to 'keys'. */
  initialTab?: SettingsTab
  /** Toasts for the Extensions tab's install/enable outcomes. */
  onMsg: (type: 'ok' | 'err', text: string) => void
}

export type SettingsTab = 'mode' | 'ai' | 'keys' | 'company' | 'git' | 'editor' | 'extensions' | 'about'

/** Extra credentials that are not model providers but live in the same keychain. */
/**
 * Image/video services that are NOT also chat providers, derived from the media registry rather than
 * hand-listed here — otherwise adding a provider to `shared/media.ts` would give the Create panel an
 * "Add the key" button with nowhere to add it. Providers that share a chat account (OpenAI, Gemini)
 * are deliberately excluded: they already have a row above, and a second box for the same key is how
 * people end up with one service configured twice and neither of them right.
 */
const MEDIA_ONLY_KEYS: { id: string; label: string; hint: string }[] = MEDIA_PROVIDERS.filter(
  (p) => !p.sharesChatKey && p.id !== 'mock-media'
).map((p) => ({ id: p.id, label: p.label, hint: `API key for image/video generation — billed to your own ${p.label} account` }))

const EXTRA_KEYS: { id: string; label: string; hint: string }[] = [
  { id: 'github', label: 'GitHub', hint: 'personal access token (repo scope) — only for the GitHub forge; a self-hosted ATOMIC server uses your SSH key instead' },
  { id: 'atomic-cloud', label: 'ATOMIC Cloud', hint: 'workspace access key from your subscription' },
  ...MEDIA_ONLY_KEYS
]

/**
 * Settings — a real control center: AI model & behavior, one API-keys page for
 * every credential, editor preferences, and About. All keys stay in the OS
 * keychain; nothing sensitive is ever written to config files.
 */
export function SettingsPanel({
  providers,
  providerId,
  onProviderChange,
  provider,
  model,
  onModelChange,
  keyInput,
  onKeyInputChange,
  hasKey,
  onSaveKey,
  autocompleteOn,
  onAutocompleteChange,
  editorPrefs,
  onEditorPrefsChange,
  autoFixOn,
  onAutoFixChange,
  airGapped,
  onToggleAirGap,
  mode,
  onModeChange,
  initialTab,
  onMsg
}: Props): React.JSX.Element {
  const surface = modeSurface(mode)
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'ai')
  const [cap, setCap] = useState<string>(() => localStorage.getItem('studio.spendCapK') || '')
  const [mediaCap, setMediaCap] = useState<string>(() => localStorage.getItem('studio.mediaCapUsd') || '')
  useEffect(() => {
    void window.studio.mediaSetCap(parseFloat(mediaCap) || 0)
    localStorage.setItem('studio.mediaCapUsd', mediaCap)
  }, [mediaCap])
  useEffect(() => {
    const tokens = (parseInt(cap, 10) || 0) * 1000
    void window.studio.setSpendCap(tokens)
    localStorage.setItem('studio.spendCapK', cap)
  }, [cap])
  /** Does this seat's company run an identity provider? Decides whether the Company tab EXISTS. */
  const [identityRequired, setIdentityRequired] = useState(false)
  useEffect(() => {
    void window.studio.identityStatus().then((st) => setIdentityRequired(st.required))
  }, [])

  // Self-hosted git provisioning (2026-09-03): where "Publish this folder" puts new repositories.
  const [gs, setGs] = useState<GitServer>({ host: '', sshUser: 'git', root: '', port: 22, keyPath: '' })
  const [pre, setPre] = useState<PreflightResult | null>(null)
  const [testing, setTesting] = useState(false)
  // A managed seat's server is set by the organisation — SHOWN, always, never hidden, just disabled.
  // Hiding it would leave the user unable to answer "where does my code go?".
  const [gsManaged, setGsManaged] = useState(false)
  useEffect(() => {
    if (tab !== 'git') return
    void window.studio.gitServerConfig().then((r) => {
      if (r.server) setGs(r.server)
      setGsManaged(r.managed)
    })
  }, [tab])
  const testServer = async (): Promise<void> => {
    setTesting(true)
    try {
      const r = await window.studio.gitServerTest(gs)
      // 'key-refused' means the server already has Studio's key — the remedy still needs to SHOW
      // it (so the user can check it's really installed), but `preflight()` doesn't carry it, and
      // offering a second "Create key" button here would suggest making a new one. Read the
      // existing key back instead: `gitServerKey()` never overwrites one that's already on disk.
      if (r.remedy?.kind === 'key-refused') {
        const k = await window.studio.gitServerKey()
        setPre({ ...r, remedy: { ...r.remedy, publicKey: k.publicKey } })
      } else {
        setPre(r)
      }
    } finally {
      setTesting(false)
    }
  }
  const saveServer = async (): Promise<void> => {
    const r = await window.studio.gitServerSave(gs)
    onMsg(r.ok ? 'ok' : 'err', r.ok ? 'Git server saved.' : r.error ?? 'Could not save.')
  }
  const createGsKey = async (): Promise<void> => {
    const k = await window.studio.gitServerKey()
    setGs((g) => ({ ...g, keyPath: k.path }))
    setPre((p) => (p?.remedy ? { ...p, remedy: { ...p.remedy, publicKey: k.publicKey } } : p))
  }
  const [keyStates, setKeyStates] = useState<Record<string, boolean>>({})
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  // Air-gapped local model catalog — loaded only when the local provider is picked.
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [starting, setStarting] = useState(false)
  const [startErr, setStartErr] = useState('')
  // Every model actually present on this machine, curated or not — feeds the override field's
  // suggestion list so the user doesn't have to remember exact names.
  const installedModelNames = catalog
    ? [...catalog.models.filter((m) => m.installed).map((m) => m.name), ...catalog.others.map((m) => m.name)]
    : []
  useEffect(() => {
    if (providerId !== 'ollama') {
      setCatalog(null)
      return
    }
    let cancelled = false // a slow `ollama list` must not set state after we switch away
    void window.studio.modelCatalog().then((c) => {
      if (!cancelled) setCatalog(c)
    })
    return () => {
      cancelled = true
    }
  }, [providerId])
  // OpenCode Zen's live model catalog — same shape of effect as the Ollama one above, just fetched
  // over HTTPS instead of shelled out to a CLI. `opencodeRetryToken` lets the Retry button re-run it.
  const [opencodeModels, setOpencodeModels] = useState<{ id: string; free: boolean }[] | null>(null)
  const [opencodeErr, setOpencodeErr] = useState<string | undefined>(undefined)
  const [opencodeChecking, setOpencodeChecking] = useState(false)
  const [opencodeRetryToken, setOpencodeRetryToken] = useState(0)
  // Whether the "Other… (type a model id)" option is active — set automatically the first time the
  // catalog loads if the current model override isn't one of the listed ids, so a value someone
  // already typed (or a stale/removed model id) never silently vanishes behind the dropdown.
  const [opencodeCustom, setOpencodeCustom] = useState(false)
  useEffect(() => {
    if (providerId !== 'opencode') {
      setOpencodeModels(null)
      setOpencodeErr(undefined)
      setOpencodeChecking(false)
      return
    }
    let cancelled = false
    setOpencodeChecking(true)
    setOpencodeErr(undefined)
    void window.studio.opencodeModels().then((res) => {
      if (cancelled) return
      setOpencodeChecking(false)
      if (res.ok) setOpencodeModels(res.models)
      else setOpencodeErr(res.error)
    })
    return () => {
      cancelled = true
    }
  }, [providerId, opencodeRetryToken])
  useEffect(() => {
    if (!opencodeModels) return
    setOpencodeCustom(model !== '' && !opencodeModels.some((m) => m.id === model))
    // Only re-derive this when a fresh catalog arrives — not on every keystroke in the custom field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opencodeModels])
  const opencodeSteps: ReadinessStepView[] =
    providerId === 'opencode'
      ? [
          {
            id: 'reach-zen',
            label: 'Reach OpenCode Zen',
            state: opencodeChecking ? 'checking' : opencodeErr ? 'failed' : 'ready',
            error: opencodeErr
          }
        ]
      : []
  // Live `ollama pull` progress: track the term id per model and show the latest line.
  const [pullIds, setPullIds] = useState<Record<string, number>>({})
  const [pullLine, setPullLine] = useState<Record<string, string>>({})
  // A ref mirror of the active pull ids, so the mount-stable termLine listener can match
  // synchronously: the id is live the instant modelPull returns (no await-window gap) and
  // there's no unsubscribe/resubscribe race dropping lines when a pull starts.
  const pullIdRef = useRef<Record<string, number>>({})
  // Names the user cancelled — so the terminal system line (a SIGKILL close reports the
  // unfriendly `exit ?`) is shown as a plain "cancelled" instead.
  const cancelledRef = useRef<Set<string>>(new Set())
  // Latest provider, readable inside the mount-stable listener: a pull that finishes AFTER
  // the user leaves the local provider must not resurrect the on-device catalog.
  const providerIdRef = useRef(providerId)
  providerIdRef.current = providerId
  // Rehydrate on (re)mount: a pull started before Settings was closed still runs in main,
  // so re-seed its "Pulling…"/Cancel state and progress resumes via the listener below.
  useEffect(() => {
    void window.studio.listActivePulls().then((active) => {
      if (!active || !Object.keys(active).length) return
      pullIdRef.current = { ...pullIdRef.current, ...active }
      setPullIds((p) => ({ ...active, ...p })) // a pull started since mount (in p) wins
    })
  }, [])
  useEffect(() => {
    return window.studio.onTermLine((ev) => {
      const name = Object.keys(pullIdRef.current).find((n) => pullIdRef.current[n] === ev.id)
      if (!name) return
      const text = ev.line.text.trim()
      // execStream streams progress on stdout/stderr and emits exactly ONE terminal line on
      // the 'system' stream — `exit N`, `⏱ timed out…`, `error: …`, or `failed to start: …`.
      // ANY system line ends the pull (so a spawn failure or a cancel never sticks at
      // "Pulling…"); only `exit 0` counts as success.
      if (ev.line.stream === 'system') {
        delete pullIdRef.current[name]
        setPullIds((p) => {
          const n = { ...p }
          delete n[name]
          return n
        })
        const ok = /^exit 0\b/.test(text)
        const cancelled = cancelledRef.current.delete(name) // true if we killed it
        setPullLine((p) => ({ ...p, [name]: ok ? 'installed' : cancelled ? 'cancelled' : text }))
        // Flip the row to installed — but only if the local catalog is still on screen (the
        // user may have switched provider mid-pull; don't resurrect it under another provider).
        if (ok && providerIdRef.current === 'ollama') void window.studio.modelCatalog().then((c) => c && setCatalog(c))
      } else {
        setPullLine((p) => ({ ...p, [name]: text }))
      }
    })
  }, [])

  const allKeyIds = [...providers.filter((p) => p.needsKey).map((p) => p.id), ...EXTRA_KEYS.map((k) => k.id)]

  const refreshKeys = useCallback(async () => {
    const states: Record<string, boolean> = {}
    for (const id of allKeyIds) states[id] = await window.studio.hasApiKey(id)
    setKeyStates(states)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers])

  useEffect(() => {
    if (tab === 'keys') void refreshKeys()
  }, [tab, refreshKeys])

  const saveKeyFor = useCallback(
    async (id: string) => {
      const v = (keyDrafts[id] ?? '').trim()
      if (!v) return
      // Never tick "saved" on faith. A refusal here means the vault could not be opened, and
      // pretending otherwise is what makes a user paste the same key over and over.
      const res = await window.studio.setApiKey(id, v)
      if (!res?.ok) {
        onMsg('err', res?.error ?? 'Studio could not save that key.')
        return
      }
      setKeyDrafts((d) => ({ ...d, [id]: '' }))
      setKeyStates((s) => ({ ...s, [id]: true }))
    },
    [keyDrafts, onMsg]
  )

  const prefs = editorPrefs
  const setPref = (patch: Partial<EditorPrefs>): void => onEditorPrefsChange({ ...prefs, ...patch })

  return (
    <div className="settings">
      <div className="settings-title">Settings</div>
      <div className="seg seg-sm settings-tabs">
        {(
          [
            ['mode', 'Mode'],
            ['ai', 'AI'],
            ['keys', 'API Keys'],
            // Only on a seat whose company configured an identity provider. A standalone install
            // has no roles and nothing to sign in to, so the tab does not exist rather than
            // opening an empty panel — the same no-dead-controls rule Builder Mode obeys.
            ...(identityRequired ? ([['company', 'Company']] as [SettingsTab, string][]) : []),
            // Git server config configures something Builder Mode's window never shows — no file
            // tree, no terminal, no git — same `surface.git` gate as the Source Control sidebar.
            ...(surface.git ? ([['git', 'Git server']] as [SettingsTab, string][]) : []),
            // The editor preferences and the extension toggles are both code surfaces: in Builder
            // Mode they would configure something the window doesn't show.
            ...(surface.code ? ([['editor', 'Editor']] as [SettingsTab, string][]) : []),
            ...(surface.extensions ? ([['extensions', 'Extensions']] as [SettingsTab, string][]) : []),
            ['about', 'About']
          ] as [SettingsTab, string][]
        ).map(([id, label]) => (
          <button key={id} className={`seg-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'mode' && (
        <div className="settings-section mode-settings">
          <p className="muted small">
            Two ways to use Studio, same engine underneath. Everything you build is saved, undoable and
            recoverable in both — only what is on screen changes.
          </p>
          {(['builder', 'developer'] as StudioMode[]).map((m) => {
            const d = describeMode(m)
            const active = mode === m
            return (
              <button
                key={m}
                type="button"
                className={`mode-card${active ? ' active' : ''}`}
                aria-pressed={active}
                onClick={() => onModeChange(m)}
              >
                <div className="mode-card-head">
                  <b>{d.title}</b>
                  {active && <span className="ws-badge">Current</span>}
                </div>
                <div className="muted small">{d.tagline}</div>
                <ul className="mode-card-list">
                  {d.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </button>
            )
          })}
        </div>
      )}

      {tab === 'ai' && (
        <div className="settings-section">
          <label className="settings-field">
            AI model
            <select className="text-input" value={providerId} onChange={(e) => onProviderChange(e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            Model override
            {providerId === 'opencode' ? (
              <>
                <ReadinessWizard steps={opencodeSteps} onRetry={() => setOpencodeRetryToken((t) => t + 1)} />
                {opencodeModels && !opencodeCustom && (
                  <select
                    className="text-input"
                    value={model === '' ? '' : opencodeModels.some((m) => m.id === model) ? model : '__custom__'}
                    onChange={(e) => {
                      if (e.target.value === '__custom__') {
                        setOpencodeCustom(true)
                        return
                      }
                      onModelChange(e.target.value)
                    }}
                  >
                    <option value="">Default ({provider?.defaultModel ?? 'big-pickle'})</option>
                    <optgroup label="Free">
                      {opencodeModels
                        .filter((m) => m.free)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.id}
                          </option>
                        ))}
                    </optgroup>
                    <optgroup label="Paid — needs a key">
                      {opencodeModels
                        .filter((m) => !m.free)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.id}
                          </option>
                        ))}
                    </optgroup>
                    <option value="__custom__">Other… (type a model id)</option>
                  </select>
                )}
                {opencodeModels && opencodeCustom && (
                  <div className="opencode-custom-row">
                    <input
                      className="text-input"
                      type="text"
                      placeholder={`default: ${provider?.defaultModel ?? '—'}`}
                      value={model}
                      onChange={(e) => onModelChange(e.target.value)}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setOpencodeCustom(false)
                        onModelChange('')
                      }}
                    >
                      Back to list
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Still free text — a local install can hold anything, and typing a name Studio
                    doesn't know about must keep working. The list is a shortcut, not a gate. */}
                <input
                  className="text-input"
                  type="text"
                  list={installedModelNames.length ? 'installed-models' : undefined}
                  placeholder={`default: ${provider?.defaultModel ?? '—'}`}
                  value={model}
                  onChange={(e) => onModelChange(e.target.value)}
                />
                {installedModelNames.length > 0 && (
                  <datalist id="installed-models">
                    {installedModelNames.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                )}
              </>
            )}
          </label>
          {provider?.needsKey && !hasKey && (
            <div className="settings-field">
              <input
                className="text-input"
                type="password"
                placeholder={`${provider.label} API key`}
                value={keyInput}
                onChange={(e) => onKeyInputChange(e.target.value)}
              />
              <button className="btn btn-primary btn-block" onClick={onSaveKey}>
                Save key
              </button>
            </div>
          )}
          {provider?.needsKey && hasKey && <p className="muted small"><Icon name="check" size={11} /> Key saved — manage all keys in the API Keys tab.</p>}
          {!provider?.needsKey && <p className="muted small">Local model — no key needed, and nothing leaves this machine.</p>}
          {catalog && catalog.state !== 'ready' && (
            <div className={`ollama-gate ${catalog.state === 'stopped' ? 'warn-box' : 'ext-marketplace-soon'}`}>
              {catalog.state === 'stopped' ? (
                <>
                  <div className="dp-headline">Ollama is installed but not running.</div>
                  <p className="muted small">On-device models need its server up. Studio can start it for you.</p>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={starting}
                    onClick={async () => {
                      setStarting(true)
                      const state = await window.studio.ollamaStart()
                      setStarting(false)
                      // Re-read rather than assume: startOllama reports the state it actually
                      // reached, and the catalog is the thing the rest of this panel renders from.
                      if (state === 'ready') void window.studio.modelCatalog().then((c) => c && setCatalog(c))
                      else setStartErr('Ollama did not come up. Try running "ollama serve" in the Terminal tab.')
                    }}
                  >
                    {starting ? 'Starting…' : 'Start Ollama'}
                  </button>
                  {startErr && <p className="muted small">{startErr}</p>}
                </>
              ) : (
                <>
                  <div className="dp-headline">Ollama isn't installed yet.</div>
                  <p className="muted small">
                    It's the free program that runs AI models on your own machine — Studio never installs it for
                    you. Paste this in a terminal, then reopen this tab:
                  </p>
                  <div className="git-row">
                    <code className="run-cmd" title={catalog.install.command}>{catalog.install.command}</code>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        const c = navigator.clipboard
                        if (c) void c.writeText(catalog.install.command).catch(() => {})
                      }}
                    >
                      Copy
                    </button>
                    <button className="btn btn-sm" onClick={() => void window.studio.openExternal(catalog.install.url)}>
                      Download page
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {catalog && (
            <div className="model-catalog">
              <div className="settings-subhead">
                On-device models
                <span className="muted small"> · this machine has {catalog.totalMemoryGb} GB RAM</span>
              </div>
              {catalog.models.map((m) => (
                <div key={m.name} className="debt-row">
                  <span className={`ws-badge ${m.installed ? 'ws-badge-server' : ''}`}>{m.installed ? <><Icon name="check" size={10} /> installed</> : m.size}</span>
                  <span className="debt-detail" title={m.useCase}>
                    <b>{m.name}</b> <span className="muted small">— {m.useCase}</span>
                    {/* Advisory, never a block: the machine is the user's to judge, and a model
                        that's tight on RAM still runs, just slowly. */}
                    {!m.fitsMemory && (
                      <span className="ws-badge badge-warn model-tight" title={`Wants about ${m.needsGb} GB; this machine has ${catalog.totalMemoryGb} GB`}>
                        <Icon name="alert" size={10} /> tight on RAM
                      </span>
                    )}
                  </span>
                  {!m.installed && (
                    <>
                      {pullLine[m.name] && <span className="muted small pull-progress">{pullLine[m.name]}</span>}
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={!!pullIds[m.name] || !catalog.available}
                        title={catalog.available ? 'Download this model now' : 'Ollama not detected'}
                        onClick={async () => {
                          cancelledRef.current.delete(m.name) // clear any stale flag from a prior cancel race
                          const res = await window.studio.modelPull(m.name)
                          if (res.ok && res.id != null) {
                            pullIdRef.current[m.name] = res.id // live immediately — before the first term line can arrive
                            setPullIds((p) => ({ ...p, [m.name]: res.id as number }))
                          }
                        }}
                      >
                        {pullIds[m.name] ? 'Pulling…' : 'Pull'}
                      </button>
                      {pullIds[m.name] != null && (
                        <button
                          className="btn btn-sm"
                          title="Stop this download"
                          onClick={() => {
                            const id = pullIds[m.name]
                            if (id == null) return
                            cancelledRef.current.add(m.name) // label the terminal line "cancelled"
                            void window.studio.termKill(id) // SIGKILLs the pull; the system line un-sticks the button
                          }}
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        className="btn btn-sm"
                        title={m.pullCommand}
                        onClick={() => {
                          const c = navigator.clipboard
                          if (c) void c.writeText(m.pullCommand).catch(() => {}) // guard: unfocused/insecure context
                        }}
                      >
                        Copy pull
                      </button>
                    </>
                  )}
                </div>
              ))}
              {/* Everything else `ollama list` reports. These already work as a model override —
                  they were simply invisible here, which made the curated six look like the only
                  models Studio could run. */}
              {catalog.others.length > 0 && (
                <>
                  <div className="settings-subhead">Also installed on this machine</div>
                  {catalog.others.map((m) => (
                    <div key={m.name} className="debt-row">
                      <span className="ws-badge ws-badge-server"><Icon name="check" size={10} /> installed</span>
                      <span className="debt-detail"><b>{m.name}</b></span>
                      <button className="btn btn-sm" title="Use this model" onClick={() => onModelChange(m.name)}>
                        Use
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          <label className="settings-toggle">
            <input type="checkbox" checked={autocompleteOn} onChange={(e) => onAutocompleteChange(e.target.checked)} />
            Autocomplete while typing (press Tab to accept)
          </label>
          <label className="settings-field">
            AI budget cap (thousands of tokens per session — blank = no cap)
            <input
              className="text-input settings-num"
              data-testid="cap-tokens"
              type="number"
              min={0}
              placeholder="e.g. 500"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
          </label>
          <p className="muted small">Zero-Surprise Billing: the AI pauses at your cap instead of running past it. On ATOMIC Cloud everything is $9/mo flat — the AI's own retries never cost extra.</p>
          {/* Images and video bill per FILE, in dollars, on the user's own provider account — so they
              get their own ceiling rather than being folded into a token count that would mean
              nothing to anyone. The refusal messages in media.ts point here by name. */}
          <label className="settings-field">
            Image &amp; video budget (US$ per session — blank = no cap)
            <input
              className="text-input settings-num"
              data-testid="cap-media-usd"
              type="number"
              min={0}
              step="0.5"
              placeholder="e.g. 5"
              value={mediaCap}
              onChange={(e) => setMediaCap(e.target.value)}
            />
          </label>
          <p className="muted small">
            Photos and video are generated on your own OpenAI / Google / Replicate / fal.ai / Stability account and billed there —
            ATOMIC Studio adds nothing to the price. Add those keys under “API keys”.
          </p>
        </div>
      )}

      {tab === 'keys' && (
        <div className="settings-section">
          <p className="muted small">
            All keys are stored encrypted in your Mac's keychain — never in files, never synced.
          </p>
          {providers
            .filter((p) => p.needsKey)
            .map((p) => (
              <div key={p.id} className="key-row">
                <span className="key-label">
                  {p.label} {keyStates[p.id] && <b className="key-ok"><Icon name="check" size={11} /></b>}
                </span>
                <input
                  className="text-input"
                  type="password"
                  placeholder={keyStates[p.id] ? 'saved — paste to replace' : 'API key'}
                  value={keyDrafts[p.id] ?? ''}
                  onChange={(e) => setKeyDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                />
                <button className="btn btn-sm" onClick={() => void saveKeyFor(p.id)} disabled={!(keyDrafts[p.id] ?? '').trim()}>
                  Save
                </button>
              </div>
            ))}
          <div className="settings-subhead">Services</div>
          {EXTRA_KEYS.map((k) => (
            <div key={k.id} className="key-row" title={k.hint}>
              <span className="key-label">
                {k.label} {keyStates[k.id] && <b className="key-ok"><Icon name="check" size={11} /></b>}
              </span>
              <input
                className="text-input"
                type="password"
                placeholder={keyStates[k.id] ? 'saved — paste to replace' : k.hint}
                value={keyDrafts[k.id] ?? ''}
                onChange={(e) => setKeyDrafts((d) => ({ ...d, [k.id]: e.target.value }))}
              />
              <button className="btn btn-sm" onClick={() => void saveKeyFor(k.id)} disabled={!(keyDrafts[k.id] ?? '').trim()}>
                Save
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'company' && <CompanySignIn onMsg={onMsg} />}

      {tab === 'git' && (
        <div className="settings-section">
          <p className="muted small">
            Where <strong>Publish this folder</strong> puts new repositories. Your SSH key is the only
            credential — Studio never reads or sends it.
          </p>
          {gsManaged && <p className="muted small">Your organisation manages this setting.</p>}
          <label className="settings-row">
            <span>Server address</span>
            <input
              data-test="git-server-host"
              className="text-input"
              disabled={gsManaged}
              value={gs.host}
              onChange={(e) => setGs({ ...gs, host: e.target.value })}
              placeholder="git.example.com"
            />
          </label>
          <label className="settings-row">
            <span>SSH user</span>
            <input
              data-test="git-server-user"
              className="text-input"
              disabled={gsManaged}
              value={gs.sshUser}
              onChange={(e) => setGs({ ...gs, sshUser: e.target.value })}
              placeholder="git"
            />
          </label>
          <label className="settings-row">
            <span>Repository folder</span>
            <input
              data-test="git-server-root"
              className="text-input"
              disabled={gsManaged}
              value={gs.root}
              onChange={(e) => setGs({ ...gs, root: e.target.value })}
              placeholder="/srv/atomic/git"
            />
          </label>
          <label className="settings-row">
            <span>Port</span>
            <input
              data-test="git-server-port"
              className="text-input"
              disabled={gsManaged}
              value={String(gs.port ?? 22)}
              onChange={(e) => setGs({ ...gs, port: Number(e.target.value) || 22 })}
            />
          </label>

          <div className="gs-actions">
            <button type="button" className="btn" onClick={() => void testServer()} disabled={!gs.host.trim() || testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {!gsManaged && (
              <button type="button" className="btn btn-primary" onClick={() => void saveServer()} disabled={!gs.host.trim()}>
                Save
              </button>
            )}
          </div>

          {pre && (
            <ul className="gs-ladder">
              {pre.steps.map((s) => (
                <li key={s.id} className={`gs-step ${s.ok ? 'ok' : 'bad'}`} data-ok={String(s.ok)}>
                  <Icon name={s.ok ? 'check' : 'close'} size={13} />
                  <span>{s.detail}</span>
                </li>
              ))}
            </ul>
          )}
          {pre?.remedy && <GitServerRemedy remedy={pre.remedy} host={gs.host} onCreateKey={createGsKey} />}
        </div>
      )}

      {tab === 'editor' && (
        <div className="settings-section">
          <label className="settings-field">
            Font size
            <input
              className="text-input settings-num"
              type="number"
              min={10}
              max={24}
              value={prefs.fontSize}
              onChange={(e) => setPref({ fontSize: Math.min(24, Math.max(10, parseInt(e.target.value, 10) || 13)) })}
            />
          </label>
          <label className="settings-field">
            Tab size
            <input
              className="text-input settings-num"
              type="number"
              min={2}
              max={8}
              value={prefs.tabSize}
              onChange={(e) => setPref({ tabSize: Math.min(8, Math.max(2, parseInt(e.target.value, 10) || 2)) })}
            />
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={prefs.wordWrap} onChange={(e) => setPref({ wordWrap: e.target.checked })} />
            Wrap long lines
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={prefs.minimap} onChange={(e) => setPref({ minimap: e.target.checked })} />
            Show code minimap
          </label>
        </div>
      )}

      {tab === 'extensions' && (
        <ExtensionsView
          autocompleteOn={autocompleteOn}
          onAutocompleteChange={onAutocompleteChange}
          autoFixOn={autoFixOn}
          onAutoFixChange={onAutoFixChange}
          airGapped={airGapped}
          onToggleAirGap={onToggleAirGap}
          onMsg={onMsg}
        />
      )}

      {tab === 'about' && (
        <div className="settings-section">
          <p className="settings-about-title">ATOMIC Studio</p>
          <p className="muted small">
            The AI IDE for non-coders — click-to-edit live previews, a diff-approved AI agent,
            session-wide undo, and two-tier Workspaces (your server free · ATOMIC Cloud $9/mo flat).
          </p>
          <p className="muted small">
            Shortcuts: {key('K')} edit selection · Tab accept suggestion · {key('S')} save · {key('P', { shift: true })} commands · {key('N')} new window
          </p>
          <p className="muted small">© ATOMIC (atomic.limited)</p>
        </div>
      )}
    </div>
  )
}
