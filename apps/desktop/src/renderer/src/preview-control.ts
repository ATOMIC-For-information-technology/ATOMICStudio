import { getPreviewTarget } from './components/DeviceFrame'
import type { PreviewControlResult } from '../../shared/types'

/**
 * Performs the agent's preview actions against the live `<webview>`.
 *
 * Everything here reports honestly. "No element matched" is a failure the agent must see and react
 * to — the alternative is an agent that says it clicked Sign Up when nothing happened, which is the
 * single behaviour this product exists to not do.
 *
 * The injected script is deliberately plain DOM: it runs inside the user's app, which may be any
 * framework or none, so it can't depend on React internals (the click-to-edit preload already
 * handles source mapping separately).
 */

/** Find by CSS selector first, then by visible text — models reach for both. */
const FIND_FN = `
  function __atomicFind(target) {
    try { var bySel = document.querySelector(target); if (bySel) return bySel } catch (e) {}
    var wanted = String(target).trim().toLowerCase();
    var nodes = document.querySelectorAll('button, a, [role="button"], input[type="submit"], label, summary, [data-testid]');
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].innerText || nodes[i].value || '').trim().toLowerCase();
      if (t === wanted) return nodes[i];
    }
    for (var j = 0; j < nodes.length; j++) {
      var t2 = (nodes[j].innerText || nodes[j].value || '').trim().toLowerCase();
      if (t2 && t2.indexOf(wanted) !== -1) return nodes[j];
    }
    return null;
  }
`

const jsonify = (v: unknown): string => JSON.stringify(v)

export async function runPreviewControl(action: 'click' | 'type' | 'snap', arg: string, text?: string): Promise<PreviewControlResult> {
  const wv = getPreviewTarget()
  if (!wv) return { ok: false, error: 'The preview is not open — start it with run_preview first.' }

  try {
    if (action === 'snap') {
      /* The capture happens in MAIN, against this frame's guest webContents. `capturePage()` on the
         <webview> ELEMENT is not dependable here (it resolved to nothing in a real run, which is how
         the receipt silently arrived empty), whereas webContents.capturePage() is. The renderer's
         job is only to say WHICH frame — it is the side that knows which device frame is the one the
         agent is driving. */
      // An occluded frame may never produce a capture, so bring the Preview tab forward first —
      // and this is honest anyway: the user should SEE what the agent is doing to their app.
      document.dispatchEvent(new CustomEvent('studio:show-preview'))
      await new Promise((r) => setTimeout(r, 250))
      return { ok: true, text: 'Took a screenshot of the preview.', webContentsId: wv.getWebContentsId() }
    }

    if (action === 'click') {
      const code = `(function () {
        ${FIND_FN}
        var el = __atomicFind(${jsonify(arg)});
        if (!el) return { ok: false, why: 'no element matched' };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { ok: true, label: (el.innerText || el.value || el.tagName).toString().trim().slice(0, 60) };
      })()`
      const r = (await wv.executeJavaScript(code)) as { ok: boolean; why?: string; label?: string }
      return r.ok
        ? { ok: true, text: `Clicked "${r.label}" in the preview.` }
        : { ok: false, error: `Nothing in the preview matched "${arg}" (${r.why}).` }
    }

    // type
    const code = `(function () {
      ${FIND_FN}
      var el = document.querySelector(${jsonify(arg)}) || __atomicFind(${jsonify(arg)});
      if (!el) return { ok: false, why: 'no element matched' };
      if (!('value' in el)) return { ok: false, why: 'that element is not a text field' };
      el.focus();
      var setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, ${jsonify(text ?? '')});
      else el.value = ${jsonify(text ?? '')};
      // React and friends listen for these, not for the assignment above.
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`
    const r = (await wv.executeJavaScript(code)) as { ok: boolean; why?: string }
    return r.ok
      ? { ok: true, text: `Typed "${(text ?? '').slice(0, 40)}" into ${arg}.` }
      : { ok: false, error: `Could not type into "${arg}" (${r.why}).` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
