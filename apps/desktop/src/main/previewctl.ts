import { BrowserWindow, webContents } from 'electron'
import { IPC } from '../shared/ipc'
import type { PreviewControlAction, PreviewControlResult } from '../shared/types'

/**
 * Lets the agent USE the app it just built.
 *
 * Antigravity's headline is browser control plus a narrated summary of what the agent did. This is
 * the same capability pointed somewhere more useful: the user's own running preview, which Studio
 * already instruments (`preload/preview.ts` maps a click back to the source that drew it, and relays
 * runtime errors). So the agent can click the button it just added, type into the field, and take a
 * screenshot — and the run ends with evidence the feature works rather than a description of a diff.
 *
 * The webview lives in the renderer, so this is a request/response bridge: main asks, the renderer
 * performs it against the live `<webview>`, and answers. Every request times out — a preview that is
 * not running, or a page still loading, must fail honestly instead of hanging the agent's turn.
 */

interface Pending {
  resolve: (r: PreviewControlResult) => void
  timer: NodeJS.Timeout
}

const pending = new Map<number, Pending>()
let seq = 0

const TIMEOUT_MS = 15_000

export function request(action: PreviewControlAction, arg: string, text?: string): Promise<PreviewControlResult> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) {
    return Promise.resolve({ ok: false, error: 'No window is open.' })
  }
  const id = ++seq
  return new Promise<PreviewControlResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, error: 'The preview did not respond — is it running?' })
    }, TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    win.webContents.send(IPC.previewControl, { id, action, arg, text })
  })
}

/**
 * Called by the renderer with the outcome. Unknown ids are ignored (a late answer after a timeout).
 *
 * The screenshot is taken HERE, against the frame the renderer named, because `capturePage()` on the
 * <webview> element is not dependable. It is raced against its own deadline: `webContents.capturePage()`
 * can simply never settle when the frame is occluded — which it is whenever the user is looking at the
 * editor rather than the Preview tab. That hung an agent turn forever, with the step stuck mid-flight
 * and nothing to cancel it. Nothing in this app is allowed to wait on a promise that may never resolve.
 */
const CAPTURE_MS = 8000

export async function settle(id: number, result: PreviewControlResult): Promise<void> {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  // The timer stays armed until we have actually resolved — clearing it first is what turned a
  // hanging capture into a hanging agent.
  const finish = (r: PreviewControlResult): void => {
    clearTimeout(p.timer)
    p.resolve(r)
  }

  if (result.ok && result.webContentsId != null) {
    /* Capture the WINDOW, falling back from the guest frame.
       Capturing the <webview> guest on its own is unreliable — it returned an error every time in a
       real run, because a guest that the compositor considers occluded may never produce a frame.
       The window always can, and the shot is better evidence anyway: it shows the change inside the
       app, in context, rather than a disembodied rectangle. */
    const guest = webContents.fromId(result.webContentsId)
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if ((!guest || guest.isDestroyed()) && !win) {
      finish({ ok: false, error: 'The preview frame went away before it could be captured.' })
      return
    }
    try {
      const capture = win && !win.isDestroyed() ? win.webContents.capturePage() : guest!.capturePage()
      const img = await Promise.race([capture, new Promise<null>((r) => setTimeout(() => r(null), CAPTURE_MS))])
      if (!img) {
        finish({ ok: false, error: 'The preview did not produce a screenshot in time (is the Preview tab visible?).' })
        return
      }
      const dataUrl = img.toDataURL()
      // An empty capture is a real outcome (page still painting), never something to pass off.
      if (!dataUrl || dataUrl.length < 1024) {
        finish({ ok: false, error: 'The preview had nothing to capture yet.' })
        return
      }
      finish({ ok: true, text: result.text, dataUrl })
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    return
  }
  finish(result)
}
