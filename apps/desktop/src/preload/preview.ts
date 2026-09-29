// Preview bridge: injected as the <webview> preload for the live app.
// Handles hover-highlight + click-to-select in "pick" mode and reports the
// clicked element's source location (from the data-canvas-* stamps) back to the
// Studio shell via ipcRenderer.sendToHost.
import { ipcRenderer } from 'electron'

// This preload runs SANDBOXED inside the <webview> guest: it may only
// require('electron'), so it must stay fully self-contained — importing
// shared/ipc would emit a relative require("./chunks/…") that throws before
// the preload runs (which silently kills click-to-edit). The three channel
// names are duplicated here on purpose; keep them in sync with shared/ipc.ts.
const IPC = {
  canvasSelect: 'canvas:select',
  canvasError: 'canvas:error',
  canvasSetPicker: 'canvas:set-picker'
} as const

let picking = false
let overlay: HTMLDivElement | null = null

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay
  overlay = document.createElement('div')
  overlay.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:2147483647',
    'border:2px solid #3b82f6',
    'background:rgba(59,130,246,0.12)',
    'border-radius:3px',
    'transition:all 40ms ease',
    'display:none'
  ].join(';')
  document.body.appendChild(overlay)
  return overlay
}

function nearestStamp(el: Element | null): (Element & { dataset: DOMStringMap }) | null {
  let cur: Element | null = el
  while (cur && cur !== document.body) {
    if (cur instanceof HTMLElement && cur.dataset.canvasFile) return cur
    cur = cur.parentElement
  }
  return null
}

// ---- Universal React fallback (Next.js / CRA / any React 18 dev build) ----
// React dev builds attach a fiber node to each DOM element whose owner chain
// carries _debugSource {fileName, lineNumber}. Those fiber properties are JS
// expandos in the PAGE world — invisible from this isolated preload world — so
// the walk runs in an injected page-world script. The two worlds talk through
// what they DO share: a DOM attribute (picking on/off) and postMessage
// (structured-cloned selection back to us).

const FIBER_MSG = '__atomicFiberSelect'
const PICKING_ATTR = 'data-atomic-picking'

const PAGE_WORLD_PICKER = `(() => {
  if (window.__atomicFiberPickerInstalled) return
  window.__atomicFiberPickerInstalled = true

  function fiberName(f) {
    var t = f.type || f.elementType
    if (typeof t === 'string') return t
    if (typeof t === 'function') return t.displayName || t.name || 'component'
    return 'element'
  }

  // React 18 dev: __reactFiber$… → owner chain carries _debugSource.
  function fiberSource(el) {
    var key = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber$') === 0 })
    if (!key) return null
    var f = el[key]
    var hops = 0
    while (f && hops++ < 50) {
      var src = f._debugSource
      if (src && src.fileName) {
        return { file: src.fileName, line: src.lineNumber || 0, name: fiberName(f) }
      }
      f = f._debugOwner || f.return || null
    }
    return null
  }

  // Svelte dev: every element carries __svelte_meta.loc {file, line (0-based), column}.
  function svelteSource(el) {
    var m = el.__svelte_meta
    if (m && m.loc && m.loc.file) {
      return { file: m.loc.file, line: (m.loc.line || 0) + 1, name: el.tagName ? el.tagName.toLowerCase() : 'element' }
    }
    return null
  }

  // Vue 3 dev: elements carry __vueParentComponent; component.type.__file is the SFC path.
  function vueSource(el) {
    var c = el.__vueParentComponent
    var hops = 0
    while (c && hops++ < 50) {
      var t = c.type
      if (t && t.__file) {
        return { file: t.__file, line: 0, name: t.name || t.__name || 'component' }
      }
      c = c.parent
    }
    return null
  }

  function anySource(start) {
    var el = start
    while (el && el !== document.body) {
      var sel = svelteSource(el) || fiberSource(el) || vueSource(el)
      if (sel) return sel
      el = el.parentElement
    }
    return null
  }

  // Runtime errors live in the PAGE world; 'error' events do not cross the
  // isolated-world boundary (even UA-generated ones) — relay via postMessage.
  window.addEventListener('error', function (e) {
    window.postMessage({ __atomicErr: { message: e.message || String(e.error || 'Error'), stack: e.error && e.error.stack } }, '*')
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    window.postMessage({ __atomicErr: { message: r && r.message ? r.message : String(r), stack: r && r.stack } }, '*')
  })

  window.addEventListener('click', function (e) {
    if (document.documentElement.getAttribute('${PICKING_ATTR}') !== '1') return
    // Stamped elements are handled by the preload — only fill the gap.
    var cur = e.target
    while (cur && cur !== document.body) {
      if (cur.dataset && cur.dataset.canvasFile) return
      cur = cur.parentElement
    }
    var sel = anySource(e.target)
    if (!sel) return
    e.preventDefault()
    e.stopPropagation()
    window.postMessage({ ${FIBER_MSG}: sel }, '*')
  }, true)
})()`

function installPagePicker(): void {
  const s = document.createElement('script')
  s.textContent = PAGE_WORLD_PICKER
  document.documentElement.appendChild(s)
  s.remove()
}

window.addEventListener('message', (e: MessageEvent) => {
  /**
   * ONLY this window's own page-world script may speak here.
   *
   * The legitimate sender is PAGE_WORLD_PICKER, which `installPagePicker` appends to this very
   * document — so `e.source === window` holds for every honest message. Without this line the
   * handler accepts `message` from ANY frame, and the previewed app is the user's own code
   * embedding whatever it likes: a third-party iframe (an ad, a remote widget) could forge a
   * `__atomicFiberSelect` to make Studio open a file of its choosing, or forge `__atomicErr` to
   * write arbitrary text into Studio's error surface. The error half had no `picking` gate at
   * all, so it was reachable at any time, not only during a pick.
   */
  if (e.source !== window) return

  const data = e.data as Record<string, unknown> | null
  const sel = data?.[FIBER_MSG] as { file: string; line: number; name: string } | undefined
  // A path stays untrusted input even after the source check. The real containment is
  // fs-service resolving every path against the project root and throwing if it escapes; a
  // bounded, null-byte-free string is just the cheapest way to keep obvious junk out of IPC.
  if (picking && sel && typeof sel.file === 'string' && sel.file.length <= 1024 && !sel.file.includes('\0')) {
    ipcRenderer.sendToHost(IPC.canvasSelect, { file: sel.file, line: Number(sel.line) || 0, name: String(sel.name || 'element') })
  }
  const err = data?.__atomicErr as { message?: string; stack?: string } | undefined
  if (err && typeof err.message === 'string') {
    reportError(err.message, err.stack)
  }
})

function moveOverlay(el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  const o = ensureOverlay()
  o.style.display = 'block'
  o.style.left = `${r.left}px`
  o.style.top = `${r.top}px`
  o.style.width = `${r.width}px`
  o.style.height = `${r.height}px`
}

function onMove(e: MouseEvent): void {
  if (!picking) return
  const stamped = nearestStamp(e.target as Element)
  if (stamped) moveOverlay(stamped as HTMLElement)
  else if (e.target instanceof HTMLElement && e.target !== document.body) moveOverlay(e.target)
  else if (overlay) overlay.style.display = 'none'
}

function onClick(e: MouseEvent): void {
  if (!picking) return
  // Stamped attributes (exact JSX element) are read here; unstamped React apps
  // (Next.js/CRA) are handled by the injected page-world fiber picker.
  const stamped = nearestStamp(e.target as Element)
  if (!stamped) return
  e.preventDefault()
  e.stopPropagation()
  ipcRenderer.sendToHost(IPC.canvasSelect, {
    file: stamped.dataset.canvasFile,
    line: Number(stamped.dataset.canvasLine || '0'),
    name: stamped.dataset.canvasName || 'element'
  })
}

function setPicking(on: boolean): void {
  picking = on
  if (!on && overlay) overlay.style.display = 'none'
  document.body.style.cursor = on ? 'crosshair' : ''
  // Mirror to a DOM attribute — the one channel the page-world picker can read.
  document.documentElement.setAttribute(PICKING_ATTR, on ? '1' : '0')
}

ipcRenderer.on(IPC.canvasSetPicker, (_e, on: boolean) => setPicking(on))

window.addEventListener('mousemove', onMove, true)
window.addEventListener('click', onClick, true)
window.addEventListener('DOMContentLoaded', () => {
  ensureOverlay()
  installPagePicker()
})

// --- Error capture (feeds ATOMIC Studio's auto-fix) ---
let lastReported = ''
function reportError(message: string, stack?: string): void {
  const text = (message + (stack ? '\n' + stack : '')).slice(0, 4000)
  if (!text.trim() || text === lastReported) return
  lastReported = text
  ipcRenderer.sendToHost(IPC.canvasError, { message, stack })
}

window.addEventListener('error', (e) => {
  reportError(e.message || String(e.error), e.error && e.error.stack)
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  reportError(r && r.message ? r.message : String(r), r && r.stack)
})

// Vite renders a <vite-error-overlay> element for compile/HMR errors — surface its text.
const observer = new MutationObserver(() => {
  const overlayEl = document.querySelector('vite-error-overlay')
  if (overlayEl) {
    const msg = (overlayEl.shadowRoot?.querySelector('.message')?.textContent || overlayEl.textContent || '').trim()
    if (msg) reportError('[build] ' + msg)
  }
})
window.addEventListener('DOMContentLoaded', () => {
  observer.observe(document.documentElement, { childList: true, subtree: true })
})
