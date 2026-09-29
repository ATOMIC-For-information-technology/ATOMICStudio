import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import type { MediaKind, MediaProviderInfo, MediaReceipt, MediaUsage } from '../../../shared/types'
import { isUsableSourceImage } from '../../../shared/media'

interface Props {
  projectPath: string
  onMsg: (type: 'ok' | 'err', text: string) => void
  /** Opens Settings on the AI-keys section — the panel's own fix for its most common blocker. */
  onOpenSettings: () => void
}

/** Bytes as something a person reads, not a number they have to divide. */
function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Create — images and video, on YOUR account.
 *
 * Studio does not resell generation. Whoever uses this brings the service they already pay for, and
 * every picture is billed to them by that provider. That is why the panel leads with the account
 * situation (which provider, is there a key, what does this cost) instead of burying it: the first
 * question a non-coder has about an AI image button is "who is paying for this", and the answer has
 * to be visible before the button is pressed, not after.
 *
 * The model box is a dropdown AND a text field on purpose. Image/video model names change constantly
 * (see the `kimi-latest` scar in providers.ts); a curated list that goes stale must never become a
 * dead end, so anything the provider accepts can be typed in.
 */
export function MediaPanel({ projectPath, onMsg, onOpenSettings }: Props): React.JSX.Element {
  const [providers, setProviders] = useState<MediaProviderInfo[]>([])
  const [kind, setKind] = useState<MediaKind>('image')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('')
  const [seconds, setSeconds] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [items, setItems] = useState<MediaReceipt[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [usage, setUsage] = useState<MediaUsage | null>(null)

  const [sourceFile, setSourceFile] = useState('')

  /** Pictures already in this project that could be a starting point — the gallery, images only. */
  const sourceCapable = useMemo(() => items.filter((m) => m.kind === 'image' && isUsableSourceImage(m.file)), [items])

  /* "Start from a photo" only offers models that DECLARE they take one, so the picker can never
     produce a pairing the provider would reject. With a photo chosen, the service and model lists
     narrow to the capable ones rather than failing at submit time. */
  const usable = useMemo(
    () => providers.filter((p) => p.models.some((m) => m.kind === kind && (!sourceFile || m.acceptsSourceImage))),
    [providers, kind, sourceFile]
  )
  const provider = useMemo(() => usable.find((p) => p.id === providerId) ?? usable[0], [usable, providerId])
  const models = useMemo(
    () => provider?.models.filter((m) => m.kind === kind && (!sourceFile || m.acceptsSourceImage)) ?? [],
    [provider, kind, sourceFile]
  )
  const modelDef = useMemo(() => models.find((m) => m.id === model), [models, model])

  const refresh = useCallback(async () => {
    setProviders(await window.studio.mediaProviders())
    setUsage(await window.studio.mediaUsage())
    if (projectPath) setItems(await window.studio.mediaList(projectPath))
  }, [projectPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A long video render is minutes of nothing. Main narrates; the panel repeats it verbatim rather
  // than inventing a fake percentage.
  useEffect(() => window.studio.onMediaProgress((ev) => setNote(ev.note)), [])

  // Keep provider/model/size coherent whenever the kind or provider changes, so the form can never
  // sit in a combination that would be rejected on submit.
  useEffect(() => {
    if (!provider) return
    if (provider.id !== providerId) setProviderId(provider.id)
    const list = provider.models.filter((m) => m.kind === kind && (!sourceFile || m.acceptsSourceImage))
    if (!list.some((m) => m.id === model)) {
      const first = list[0]
      setModel(first?.id ?? '')
      setSize(first?.sizes?.[0] ?? '')
      setSeconds(first?.durations?.[0] ?? '')
    }
  }, [provider, providerId, kind, model, sourceFile])

  /* Thumbnails are read on demand, and only for what is on screen. Base64-ing every video in a busy
     project into the renderer would cost more memory than the gallery is worth. */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const it of items.slice(0, 24)) {
        if (thumbs[it.file] !== undefined) continue
        const r = await window.studio.mediaDataUrl(projectPath, it.file)
        if (cancelled) return
        setThumbs((t) => ({ ...t, [it.file]: r.ok && r.dataUrl ? r.dataUrl : '' }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [items, projectPath, thumbs])

  const pickModel = (id: string): void => {
    setModel(id)
    const def = models.find((m) => m.id === id)
    setSize(def?.sizes?.[0] ?? '')
    setSeconds(def?.durations?.[0] ?? '')
  }

  const generate = async (): Promise<void> => {
    if (!provider || busy) return
    setBusy(true)
    setNote('')
    try {
      const res = await window.studio.mediaGenerate({
        projectPath,
        kind,
        providerId: provider.id,
        model: model.trim(),
        prompt: prompt.trim(),
        ...(size ? { size } : {}),
        ...(seconds ? { seconds: Number(seconds) } : {}),
        ...(sourceFile ? { sourceFile } : {})
      })
      if (!res.ok || !res.receipt) {
        onMsg('err', res.error ?? 'Generation failed.')
        return
      }
      onMsg('ok', `Saved to ${res.receipt.file}`)
      await refresh()
    } finally {
      setBusy(false)
      setNote('')
    }
  }

  const remove = async (file: string): Promise<void> => {
    const res = await window.studio.mediaDelete(projectPath, file)
    if (!res.ok) {
      onMsg('err', res.error ?? 'Could not delete that file.')
      return
    }
    setThumbs((t) => {
      const next = { ...t }
      delete next[file]
      return next
    })
    await refresh()
  }

  const cost = modelDef ? `about $${modelDef.approxUsd.toFixed(3)}` : 'an unknown amount'

  return (
    <div className="media-panel" data-testid="media-panel">
      <div className="settings-subhead">
        <Icon name="image" size={14} /> Create images &amp; video
      </div>
      <p className="muted small">
        Generated on <strong>your own</strong> account — Studio adds nothing to the price and never sees your key. Files are
        saved into <code>assets/generated</code> inside this project.
      </p>

      <div className="media-kind" role="group" aria-label="What to create">
        <button
          type="button"
          className={`btn btn-sm ${kind === 'image' ? 'btn-primary' : ''}`}
          onClick={() => setKind('image')}
          aria-pressed={kind === 'image'}
          data-testid="media-kind-image"
        >
          Photo
        </button>
        <button
          type="button"
          className={`btn btn-sm ${kind === 'video' ? 'btn-primary' : ''}`}
          onClick={() => setKind('video')}
          aria-pressed={kind === 'video'}
          data-testid="media-kind-video"
        >
          Video
        </button>
      </div>

      <div className="media-form">
        <label className="media-field">
          <span className="muted small">Service</span>
          <select
            className="text-input"
            value={provider?.id ?? ''}
            onChange={(e) => setProviderId(e.target.value)}
            aria-label="Generation service"
            data-testid="media-provider"
          >
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.hasKey ? '' : ' — no key yet'}
              </option>
            ))}
          </select>
        </label>

        <label className="media-field">
          <span className="muted small">Model</span>
          <select className="text-input" value={models.some((m) => m.id === model) ? model : ''} onChange={(e) => pickModel(e.target.value)} aria-label="Model">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="">Something else (type it below)</option>
          </select>
        </label>

        {/* Always editable: a model name we ship can go stale between releases, and the person using
            Studio should never have to wait for us to fix that. */}
        <label className="media-field">
          <span className="muted small">Model id sent to {provider?.label ?? 'the service'}</span>
          <input className="text-input" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model id" data-testid="media-model" spellCheck={false} />
        </label>

        {!!modelDef?.sizes?.length && (
          <label className="media-field">
            <span className="muted small">Shape</span>
            <select className="text-input" value={size} onChange={(e) => setSize(e.target.value)} aria-label="Output size">
              {modelDef.sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}

        {kind === 'video' && !!modelDef?.durations?.length && (
          <label className="media-field">
            <span className="muted small">Length</span>
            <select className="text-input" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} aria-label="Video length in seconds">
              {modelDef.durations.map((d) => (
                <option key={d} value={d}>
                  {d} seconds
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Start from a photo. The list is what this project already has, because the overwhelmingly
          common case is "change the picture you just made" — and it keeps the whole flow inside the
          project with no file dialog and no upload of anything the user didn't generate here. */}
      {sourceCapable.length > 0 && (
        <label className="media-field media-source">
          <span className="muted small">Start from a photo (optional)</span>
          <select
            className="text-input"
            value={sourceFile}
            onChange={(e) => setSourceFile(e.target.value)}
            aria-label="Start from a photo"
            data-testid="media-source"
          >
            <option value="">Start from nothing — describe it instead</option>
            {sourceCapable.map((m) => (
              <option key={m.file} value={m.file}>
                {m.file.split('/').pop()}
              </option>
            ))}
          </select>
        </label>
      )}

      {!!sourceFile && (
        <div className="media-source-preview" data-testid="media-source-preview">
          {thumbs[sourceFile] ? <img className="media-source-thumb" src={thumbs[sourceFile]} alt="The photo this will start from" /> : null}
          <div>
            <p className="small">
              {kind === 'video' ? 'This photo becomes the first frame.' : 'This photo will be edited.'} Describe the change you want below.
            </p>
            <button className="btn btn-sm" onClick={() => setSourceFile('')}>
              Start from nothing instead
            </button>
          </div>
        </div>
      )}

      <textarea
        className="text-input media-prompt"
        rows={3}
        placeholder={
          sourceFile
            ? kind === 'video'
              ? 'Describe how it should move — "slow pan across the room".'
              : 'Describe the change — "make the walls blue", "remove the sign".'
            : kind === 'video'
              ? 'Describe the shot — what happens, and how it looks.'
              : 'Describe the picture you want.'
        }
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        aria-label="Describe what you want"
        data-testid="media-prompt"
      />

      {/* The account situation, stated before the money is spent rather than after. */}
      {provider && !provider.hasKey && (
        <div className="media-nokey" data-testid="media-nokey">
          <p className="small">
            No {provider.label} key on this computer yet. {provider.planNote}
          </p>
          <div className="media-nokey-actions">
            <button className="btn btn-sm btn-primary" onClick={onOpenSettings}>
              Add the key
            </button>
            {!!provider.keyUrl && (
              <button className="btn btn-sm" onClick={() => void window.studio.openExternal(provider.keyUrl)}>
                Where do I get one?
              </button>
            )}
          </div>
        </div>
      )}

      <div className="media-actions">
        <button
          className="btn btn-primary"
          onClick={() => void generate()}
          disabled={busy || !prompt.trim() || !model.trim() || !provider?.hasKey || !projectPath}
          data-testid="media-generate"
        >
          {busy ? 'Creating…' : sourceFile ? (kind === 'video' ? 'Animate this photo' : 'Edit this photo') : kind === 'video' ? 'Create video' : 'Create photo'}
        </button>
        <span className="muted small">
          {provider ? `Charged to your ${provider.label} account — ${cost} for this one.` : 'Pick a service.'}
        </span>
      </div>

      {busy && !!note && (
        <p className="muted small media-note" data-testid="media-note">
          {note}
        </p>
      )}

      {!!usage && usage.generations > 0 && (
        <p className="muted small" data-testid="media-usage">
          This session: {usage.generations} generated · about ${usage.estUsd.toFixed(2)} of your own credit
          {usage.capUsd > 0 ? ` · budget $${usage.capUsd.toFixed(2)}` : ''}
        </p>
      )}

      <div className="settings-subhead">In this project</div>
      {items.length === 0 && <p className="muted small">Nothing generated yet.</p>}
      <div className="media-grid">
        {items.map((it) => (
          <figure key={it.file} className="media-tile" data-testid="media-tile">
            {thumbs[it.file] ? (
              it.kind === 'video' ? (
                <video className="media-thumb" src={thumbs[it.file]} controls preload="metadata" />
              ) : (
                <img className="media-thumb" src={thumbs[it.file]} alt={it.prompt} />
              )
            ) : (
              <div className="media-thumb media-thumb-empty" aria-hidden="true">
                <Icon name={it.kind === 'video' ? 'play' : 'image'} size={20} />
              </div>
            )}
            <figcaption>
              <span className="media-prompt-line" title={it.prompt}>
                {it.prompt}
              </span>
              <span className="muted small">
                {it.providerLabel}
                {it.model ? ` · ${it.model}` : ''} · {human(it.bytes)}
                {it.approxUsd !== null ? ` · ~$${it.approxUsd.toFixed(3)}` : ''}
              </span>
              {/* Filename only. The full path wrapped over five lines in the sidebar and buried the
                  facts above it; it is still one hover (or one "Copy path") away. */}
              <span className="muted small media-path" title={it.file}>
                {it.file.split('/').pop()}
              </span>
            </figcaption>
            <div className="media-tile-actions">
              <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(it.file)} title="Copy the path to use in your app">
                Copy path
              </button>
              <button className="btn btn-sm" onClick={() => void remove(it.file)} title="Delete this file">
                Delete
              </button>
            </div>
          </figure>
        ))}
      </div>
    </div>
  )
}
