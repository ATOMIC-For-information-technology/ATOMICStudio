import React, { useEffect, useRef } from 'react'
import type { Device } from '../devices'
import { IPC } from '../../../shared/ipc'
import type { CanvasError, CanvasSelection } from '../../../shared/types'

interface Props {
  device: Device
  url: string | null
  preloadUrl: string
  pickMode: boolean
  onSelect: (sel: CanvasSelection) => void
  onError?: (err: CanvasError) => void
  /** Percent scale override (e.g. 75, 100, 150) from the preview toolbar's zoom control.
   *  Undefined/null falls back to the auto-fit scale every frame has always used. */
  zoom?: number | null
}

/** Minimal shape of the <webview> APIs we use (avoids needing Electron types here). */
type WebviewEl = HTMLElement & {
  src: string
  send: (channel: string, ...args: unknown[]) => void
  addEventListener: (type: string, cb: (e: unknown) => void) => void
  removeEventListener: (type: string, cb: (e: unknown) => void) => void
  executeJavaScript: (code: string) => Promise<unknown>
  getWebContentsId: () => number
  isLoading: () => boolean
  reload: () => void
}

/** Every mounted preview frame, so the toolbar's Refresh button can reload all of them (desktop,
 *  and whichever phone/tablet frames are showing in "All") without each DeviceFrame needing its own
 *  ref threaded back up through PreviewPane. */
const liveFrames = new Set<WebviewEl>()
export function reloadAllPreviews(): void {
  for (const wv of liveFrames) {
    try {
      wv.reload()
    } catch {
      /* not attached yet */
    }
  }
}

/**
 * The frame the agent drives when it wants to USE the app it just changed.
 *
 * Only the desktop frame registers: in "All devices" mode three frames show the same page, and
 * clicking a button in all three at once is not what anyone means by "click the button".
 */
let controlTarget: WebviewEl | null = null
export function getPreviewTarget(): WebviewEl | null {
  return controlTarget
}

/**
 * One device-framed live preview. Uses a <webview> with the preview preload so
 * we can pick elements inside the running app. Scaled to fit the canvas while
 * keeping the device's logical resolution.
 */
export function DeviceFrame({ device, url, preloadUrl, pickMode, onSelect, onError, zoom }: Props): React.JSX.Element {
  const webviewRef = useRef<WebviewEl | null>(null)
  const readyRef = useRef(false)

  useEffect(() => {
    const wv = webviewRef.current
    if (wv && url) {
      try {
        wv.src = url
      } catch {
        /* not attached yet */
      }
    }
  }, [url])

  // Register the desktop frame as the agent's control target for as long as it is mounted.
  useEffect(() => {
    if (device.id !== 'desktop') return
    controlTarget = webviewRef.current
    return () => {
      if (controlTarget === webviewRef.current) controlTarget = null
    }
  }, [device.id])

  // Make this frame reachable from the toolbar's Refresh button for as long as it's mounted.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    liveFrames.add(wv)
    return () => {
      liveFrames.delete(wv)
    }
  }, [])

  // Attach webview event listeners once.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onReady = () => {
      readyRef.current = true
      wv.send(IPC.canvasSetPicker, pickMode)
    }
    const onIpc = (e: unknown) => {
      const msg = e as { channel: string; args: unknown[] }
      if (msg.channel === IPC.canvasSelect) onSelect(msg.args[0] as CanvasSelection)
      else if (msg.channel === IPC.canvasError) onError?.(msg.args[0] as CanvasError)
    }
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('ipc-message', onIpc)
    return () => {
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('ipc-message', onIpc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push pick-mode changes into the running app.
  useEffect(() => {
    const wv = webviewRef.current
    if (wv && readyRef.current) wv.send(IPC.canvasSetPicker, pickMode)
  }, [pickMode])

  const maxRenderHeight = 560
  // A zoom override replaces the auto-fit entirely — the canvas already scrolls (.preview-body
  // {overflow:auto}), so there's no ceiling to respect once the user has picked a size themselves.
  const scale = zoom != null ? zoom / 100 : Math.min(1, maxRenderHeight / device.height)

  return (
    <div className="device" data-kind={device.kind} data-pick={pickMode ? 'on' : 'off'}>
      <div className="device-label">
        {device.label} · {device.width}×{device.height}
      </div>
      <div
        className="device-screen"
        style={{ width: device.width * scale, height: device.height * scale }}
      >
        <div
          className="device-screen-inner"
          style={{ width: device.width, height: device.height, transform: `scale(${scale})` }}
        >
          {url ? (
            <webview
              ref={webviewRef as never}
              src={url}
              preload={preloadUrl}
              style={{ width: device.width, height: device.height, border: '0' }}
              allowpopups="true"
            />
          ) : (
            <div className="device-empty">Preview will appear here</div>
          )}
        </div>
      </div>
    </div>
  )
}
