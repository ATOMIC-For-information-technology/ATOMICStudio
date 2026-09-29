import React, { useEffect, useState, useCallback } from 'react'
import { Icon } from './Icon'
import { DEVICES } from '../devices'
import { DeviceFrame, reloadAllPreviews } from './DeviceFrame'
import type { CanvasError, CanvasSelection, SimulatorDevice } from '../../../shared/types'

const ZOOM_STEPS = [50, 75, 100, 125, 150]

interface Props {
  url: string | null
  /** Idle/starting/running/error/stopped — so the empty state can say something honest, not just "no preview running". */
  status?: 'idle' | 'starting' | 'running' | 'error' | 'stopped'
  /** Start the dev server. Real bug this fixes: the empty state used to just be TEXT telling the user
   *  to press a different, easy-to-miss button elsewhere — now it's an actual button that does it. */
  onStart?: () => void
  /** Wording for that button — it follows the top bar's, which changes with the mode. */
  startLabel?: string
  preloadUrl: string
  pickMode: boolean
  onTogglePick: () => void
  onSelect: (sel: CanvasSelection) => void
  onError: (err: CanvasError) => void
}

type DeviceMode = 'desktop' | 'iphone' | 'ipad' | 'all'

/**
 * Tabbed/toolbar preview: pick a single device (Desktop/iPhone/iPad) or show all
 * at once, and open the live URL in a REAL iOS Simulator on macOS. Click-to-edit
 * still works via the DeviceFrame webview.
 */
export function PreviewPane({ url, status, onStart,
  startLabel, preloadUrl, pickMode, onTogglePick, onSelect, onError }: Props): React.JSX.Element {
  const [mode, setMode] = useState<DeviceMode>('desktop')
  const [sims, setSims] = useState<SimulatorDevice[]>([])
  const [simOpen, setSimOpen] = useState(false)
  const [simMsg, setSimMsg] = useState<string | null>(null)
  const [simBusy, setSimBusy] = useState(false)
  /** null = "Fit" — the auto-fit scale every frame already computes. A number is an explicit
   *  percent the user picked, which overrides that per-device auto-fit uniformly across frames. */
  const [zoom, setZoom] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    window.studio.listSimulators().then(setSims).catch(() => setSims([]))
  }, [])

  const openInSim = useCallback(
    async (udid: string, name: string) => {
      if (!url) return
      setSimOpen(false)
      setSimBusy(true)
      setSimMsg(`Booting ${name}…`)
      const res = await window.studio.openInSimulator(udid, url)
      setSimBusy(false)
      setSimMsg(res.ok ? `Opened in ${name}. Check the Simulator window.` : res.error ?? 'Simulator failed.')
      setTimeout(() => setSimMsg(null), 6000)
    },
    [url]
  )

  const shown = mode === 'all' ? DEVICES : DEVICES.filter((d) => d.id === mode)

  const zoomIndex = zoom == null ? -1 : ZOOM_STEPS.indexOf(zoom)
  const zoomOut = useCallback(
    () => setZoom(ZOOM_STEPS[Math.max(0, (zoomIndex === -1 ? ZOOM_STEPS.indexOf(100) : zoomIndex) - 1)]),
    [zoomIndex]
  )
  const zoomIn = useCallback(
    () => setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, (zoomIndex === -1 ? ZOOM_STEPS.indexOf(100) : zoomIndex) + 1)]),
    [zoomIndex]
  )
  const refresh = useCallback(() => {
    reloadAllPreviews()
    setRefreshing(true)
    setTimeout(() => setRefreshing(false), 500)
  }, [])

  return (
    <div className="preview-pane">
      <div className="preview-toolbar">
        {url && (
          <button
            className={`btn btn-sm ${pickMode ? 'toggled' : ''}`}
            onClick={onTogglePick}
            title="Click an element in the preview, then describe a change"
          >
            {pickMode ? 'Click an element…' : 'Select element'}
          </button>
        )}
        <div className="seg">
          {(['desktop', 'iphone', 'ipad', 'all'] as DeviceMode[]).map((m) => (
            <button
              key={m}
              className={`seg-btn ${mode === m ? 'active' : ''}`}
              onClick={() => setMode(m)}
            >
              {m === 'desktop' ? <><Icon name="monitor" size={12} /> Desktop</>
                : m === 'iphone' ? <><Icon name="phone" size={12} /> iPhone</>
                : m === 'ipad' ? <><Icon name="tablet" size={12} /> iPad</>
                : <><Icon name="devices" size={12} /> All</>}
            </button>
          ))}
        </div>
        <div className="preview-url">{url ?? 'no preview running'}</div>
        <div className="preview-actions">
          <button
            className={`preview-action-btn ${refreshing ? 'spinning' : ''}`}
            onClick={refresh}
            disabled={!url}
            title="Refresh the preview"
            aria-label="Refresh the preview"
          >
            <Icon name="refresh" size={13} />
          </button>
          <button
            className="preview-action-btn"
            onClick={() => url && void window.studio.openExternal(url)}
            disabled={!url}
            title="Open in your default browser"
            aria-label="Open in your default browser"
          >
            <Icon name="external-link" size={13} />
          </button>
          <div className="zoom-group" role="group" aria-label="Zoom preview">
            <button className="zoom-btn" onClick={zoomOut} disabled={zoomIndex === 0} title="Zoom out" aria-label="Zoom out">
              <Icon name="minus" size={11} />
            </button>
            <span className="zoom-label">{zoom == null ? 'Fit' : `${zoom}%`}</span>
            <button
              className="zoom-btn"
              onClick={zoomIn}
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <Icon name="plus" size={11} />
            </button>
            <button
              className={`zoom-btn zoom-fit ${zoom == null ? 'active' : ''}`}
              onClick={() => setZoom(null)}
              title="Fit to canvas"
            >
              Fit
            </button>
          </div>
        </div>
        <div className="sim-menu">
          <button
            className="btn btn-sm"
            disabled={!url || simBusy}
            onClick={() => setSimOpen((v) => !v)}
            title="Open the running app in a real iOS Simulator (macOS + Xcode)"
          >
            {simBusy ? 'Opening…' : <><Icon name="phone" size={12} /> iOS Simulator <Icon name="chevron-down" size={11} /></>}
          </button>
          {simOpen && (
            <div className="sim-dropdown">
              {sims.length === 0 ? (
                <div className="sim-empty">
                  No simulators found.
                  <br />
                  Install Xcode, then open it once.
                </div>
              ) : (
                sims.map((s) => (
                  <button
                    type="button"
                    key={s.udid}
                    className="sim-item"
                    onClick={() => openInSim(s.udid, s.name)}
                  >
                    <span className={`sim-dot ${s.state === 'Booted' ? 'on' : ''}`} />
                    {/* The dot's colour is the whole difference between a booted simulator and a
                        cold one — say it, don't only paint it. */}
                    <span className="sr-only">{s.state === 'Booted' ? 'Running — ' : 'Not running — '}</span>
                    {s.name} <span className="sim-runtime">{s.runtime}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {simMsg && <div className="sim-msg">{simMsg}</div>}

      <div className={`preview-body ${mode === 'all' ? 'row' : 'single'}`}>
        {url ? (
          shown.map((d) => (
            <DeviceFrame
              key={d.id}
              device={d}
              url={url}
              preloadUrl={preloadUrl}
              pickMode={pickMode}
              onSelect={onSelect}
              onError={d.id === 'desktop' || mode !== 'all' ? onError : undefined}
              zoom={zoom}
            />
          ))
        ) : (
          <div className="canvas-empty">
            <div className="canvas-empty-card">
              <h2>Live preview</h2>
              <p>
                {status === 'starting'
                  ? 'Starting…'
                  : status === 'error'
                    ? 'The last attempt to start failed — click below to try again.'
                    : 'Click below to see your app here — on desktop, phone, or a real iOS Simulator.'}
              </p>
              {onStart && status !== 'starting' && (
                <button className="btn btn-primary" onClick={onStart}>
                  {startLabel ?? 'Run preview'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
