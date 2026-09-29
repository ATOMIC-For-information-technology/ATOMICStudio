import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, resolve, sep, extname } from 'node:path'
import { getApiKey } from './keyvault'
import { getAirGap } from './policy'
import { errMessage } from './util'
import {
  MEDIA_DIR,
  MEDIA_PROVIDERS,
  assetFileName,
  describeMediaError,
  estimateUsd,
  getMediaModel,
  getMediaProvider,
  registerMockMediaProvider,
  validatePrompt,
  acceptsSource,
  isUsableSourceImage,
  type MediaKind,
  type MediaReceipt,
  type MediaUsage
} from '../shared/media'

/**
 * Media generation engine — images and video on the client's own account.
 *
 * Every provider is reached over plain `fetch`; no SDKs were added for this feature, so it costs the
 * bundle nothing. Three things are true of every path through this file:
 *
 *  1. **The key never leaves main.** Same rule as chat: the renderer asks for a picture, main reads
 *     the vault. A prompt crosses the IPC boundary, a credential never does.
 *  2. **One choke point.** `generate()` is the only exported way to spend the client's money, so the
 *     air-gap check, the missing-key check and the spend cap are enforced in ONE place rather than
 *     five times across five adapters.
 *  3. **The file is the deliverable.** Bytes land in the project on disk with a JSON receipt beside
 *     them. Nothing lives only in renderer memory, so a crash or a reload never loses a paid-for asset.
 */

if (process.env.STUDIO_MOCK_MEDIA === '1') registerMockMediaProvider()

// ── Spend meter ────────────────────────────────────────────────────────────────────────────────────
// Separate from the token meter in providers.ts on purpose: media bills per FILE, in dollars, and
// folding it into a token count would produce a number that means nothing to anyone.

let usage: MediaUsage = { generations: 0, estUsd: 0, capUsd: 0 }

export function getMediaUsage(): MediaUsage {
  return { ...usage }
}
export function resetMediaUsage(): void {
  usage = { generations: 0, estUsd: 0, capUsd: usage.capUsd }
}
/** 0 = unlimited. Set in Settings → AI. */
export function setMediaCap(usd: number): void {
  usage.capUsd = Math.max(0, Number(usd) || 0)
}

// ── Wire helpers ───────────────────────────────────────────────────────────────────────────────────

/** A generation that returned bytes, or a reason it did not. Adapters never throw past this shape. */
interface AdapterResult {
  ok: boolean
  bytes?: Buffer
  ext?: string
  error?: string
}

export interface GenerateArgs {
  projectPath: string
  kind: MediaKind
  providerId: string
  model: string
  prompt: string
  /** Image size or aspect ratio, exactly as the provider spells it. */
  size?: string
  /** Video length in seconds. */
  seconds?: number
  /**
   * "Start from a photo": a project-relative image to edit (→ image) or animate (→ video).
   * Resolved and read in main, under the same path guard as everything else — the renderer names a
   * file inside the project, it never hands over bytes.
   */
  sourceFile?: string
  /** Progress lines for the UI — video takes minutes, so silence would read as a hang. */
  onProgress?: (note: string) => void
}

/** A starting picture, loaded once and handed to whichever adapter needs it in whichever shape. */
interface SourceImage {
  bytes: Buffer
  mime: string
  name: string
}

const mimeForImage = (file: string): string => {
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
}

const asDataUri = (src: SourceImage): string => `data:${src.mime};base64,${src.bytes.toString('base64')}`
/** Node's FormData wants a Blob; Buffer is not one. */
const asBlob = (src: SourceImage): Blob => new Blob([new Uint8Array(src.bytes)], { type: src.mime })

export interface GenerateResult {
  ok: boolean
  receipt?: MediaReceipt
  error?: string
}

/** Providers reject oversized uploads; catch it here so a doomed upload never costs time or money. */
const SOURCE_MAX_BYTES = 20 * 1024 * 1024

/** Video generation is long. 10 minutes is generous for Veo/Sora/Kling and still bounded. */
const POLL_TIMEOUT_MS = 10 * 60_000
const POLL_EVERY_MS = 4_000
/** A single request that should be quick (image generation, status checks). */
const REQ_TIMEOUT_MS = 3 * 60_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * `fetch` with a hard timeout. Without this an adapter can hang forever on a provider that accepted
 * the connection and then went quiet, and the UI would show a spinner with no way out.
 */
async function req(url: string, init: RequestInit, timeoutMs = REQ_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/**
 * Raw provider bodies, for the live probe only (`STUDIO_MEDIA_DEBUG=1`). OFF by default and never
 * shown to a user: the friendly message is deliberately short and action-shaped, but fixing a
 * wire-shape mismatch needs the untruncated body the provider actually sent.
 */
function debugBody(label: string, status: number, body: string): void {
  if (process.env.STUDIO_MEDIA_DEBUG !== '1') return
  // eslint-disable-next-line no-console
  console.error(`\n[media:debug] ${label} responded ${status}\n${body.slice(0, 4000)}\n`)
}

/** Read a failed response's body once, log it for the probe, and hand back the friendly message. */
async function failure(label: string, res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  debugBody(label, res.status, body)
  return describeMediaError(label, res.status, body)
}

/** Download a finished asset URL (Replicate/fal/Veo all hand back a URL rather than inline bytes). */
async function fetchBytes(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  const res = await req(url, { headers })
  if (!res.ok) throw new Error(`Could not download the finished file (${res.status}).`)
  return Buffer.from(await res.arrayBuffer())
}

/** Extension from a URL or mime type, defaulted per kind so a file is never saved without one. */
function extFor(kind: MediaKind, hint?: string): string {
  const h = (hint ?? '').toLowerCase()
  if (h.includes('png')) return 'png'
  if (h.includes('jpeg') || h.includes('jpg')) return 'jpg'
  if (h.includes('webp')) return 'webp'
  if (h.includes('mp4')) return 'mp4'
  if (h.includes('webm')) return 'webm'
  return kind === 'video' ? 'mp4' : 'png'
}

/**
 * Poll a status endpoint until it reports done. Shared by every long-running provider so the timeout,
 * the cancel-on-timeout message and the progress cadence are identical across them.
 */
async function pollUntil<T>(
  label: string,
  check: () => Promise<{ done: boolean; failed?: string; value?: T }>,
  onProgress?: (note: string) => void
): Promise<T> {
  const started = Date.now()
  let ticks = 0
  for (;;) {
    const r = await check()
    if (r.failed) throw new Error(r.failed)
    if (r.done && r.value !== undefined) return r.value
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      throw new Error(`${label} is still running after 10 minutes, so Studio stopped waiting. It may still finish on the provider's side — check your account there before paying for another run.`)
    }
    ticks++
    if (ticks % 3 === 0) onProgress?.(`Still rendering… ${Math.round((Date.now() - started) / 1000)}s elapsed.`)
    await sleep(POLL_EVERY_MS)
  }
}

// ── Adapters ───────────────────────────────────────────────────────────────────────────────────────

async function openaiAdapter(a: GenerateArgs, key: string, label: string, src?: SourceImage): Promise<AdapterResult> {
  if (a.kind === 'image') {
    // Editing an existing picture is a DIFFERENT endpoint and a multipart body, not a flag on the
    // generate call — so this branches rather than adding a field.
    if (src) {
      const form = new FormData()
      form.append('model', a.model)
      form.append('prompt', a.prompt)
      form.append('image', asBlob(src), src.name)
      if (a.size) form.append('size', a.size)
      const edit = await req('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form
      })
      if (!edit.ok) return { ok: false, error: await failure(label, edit) }
      const ed = (await edit.json()) as { data?: { b64_json?: string; url?: string }[] }
      const one = ed.data?.[0]
      if (one?.b64_json) return { ok: true, bytes: Buffer.from(one.b64_json, 'base64'), ext: 'png' }
      if (one?.url) return { ok: true, bytes: await fetchBytes(one.url), ext: extFor('image', one.url) }
      return { ok: false, error: `${label} returned no edited image.` }
    }
    const res = await req('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: a.model, prompt: a.prompt, n: 1, ...(a.size ? { size: a.size } : {}) })
    })
    if (!res.ok) return { ok: false, error: await failure(label, res) }
    const data = (await res.json()) as { data?: { b64_json?: string; url?: string }[] }
    const first = data.data?.[0]
    if (first?.b64_json) return { ok: true, bytes: Buffer.from(first.b64_json, 'base64'), ext: 'png' }
    if (first?.url) return { ok: true, bytes: await fetchBytes(first.url), ext: extFor('image', first.url) }
    return { ok: false, error: `${label} returned no image.` }
  }

  // Video: create the job, then poll it, then download the rendered content. A reference frame has
  // to go up as multipart, so the body shape depends on whether one was given.
  let createBody: BodyInit
  let createHeaders: Record<string, string>
  if (src) {
    const form = new FormData()
    form.append('model', a.model)
    form.append('prompt', a.prompt)
    form.append('input_reference', asBlob(src), src.name)
    if (a.seconds) form.append('seconds', String(a.seconds))
    if (a.size) form.append('size', a.size)
    createBody = form
    createHeaders = { Authorization: `Bearer ${key}` } // fetch sets the multipart boundary itself
  } else {
    createBody = JSON.stringify({
      model: a.model,
      prompt: a.prompt,
      ...(a.seconds ? { seconds: String(a.seconds) } : {}),
      ...(a.size ? { size: a.size } : {})
    })
    createHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
  }
  const create = await req('https://api.openai.com/v1/videos', { method: 'POST', headers: createHeaders, body: createBody })
  if (!create.ok) return { ok: false, error: await failure(label, create) }
  const job = (await create.json()) as { id?: string; status?: string; error?: { message?: string } }
  if (!job.id) return { ok: false, error: `${label} did not start the video job.` }

  await pollUntil<true>(
    'The video',
    async () => {
      const s = await req(`https://api.openai.com/v1/videos/${job.id}`, { headers: { Authorization: `Bearer ${key}` } })
      if (!s.ok) return { done: false, failed: await failure(label, s) }
      const st = (await s.json()) as { status?: string; error?: { message?: string } }
      if (st.status === 'failed') return { done: false, failed: st.error?.message ?? `${label} failed to render the video.` }
      return st.status === 'completed' ? { done: true, value: true as const } : { done: false }
    },
    a.onProgress
  )

  const bytes = await fetchBytes(`https://api.openai.com/v1/videos/${job.id}/content`, { Authorization: `Bearer ${key}` })
  return { ok: true, bytes, ext: 'mp4' }
}

async function geminiAdapter(a: GenerateArgs, key: string, label: string, src?: SourceImage): Promise<AdapterResult> {
  const base = 'https://generativelanguage.googleapis.com/v1beta'
  if (a.kind === 'image') {
    /* Google has two image surfaces that do not share a shape: Imagen answers on `:predict`, and the
       edit-capable Gemini image models answer on `:generateContent`. Branch on the MODEL, not the
       provider — a source image is only possible on the second. */
    if (src || !/imagen/i.test(a.model)) {
      const parts: unknown[] = [{ text: a.prompt }]
      if (src) parts.push({ inline_data: { mime_type: src.mime, data: src.bytes.toString('base64') } })
      const gc = await req(`${base}/models/${encodeURIComponent(a.model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
      })
      if (!gc.ok) return { ok: false, error: await failure(label, gc) }
      const data = (await gc.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }[] } }[]
      }
      // The REST API has shipped both camelCase and snake_case for this field; accept either rather
      // than returning "no image" for a response that plainly contains one.
      for (const part of data.candidates?.[0]?.content?.parts ?? []) {
        const inline = part.inlineData ?? part.inline_data
        const b64 = inline?.data
        if (b64) return { ok: true, bytes: Buffer.from(b64, 'base64'), ext: extFor('image', (inline as { mimeType?: string; mime_type?: string })?.mimeType ?? (inline as { mime_type?: string })?.mime_type) }
      }
      return { ok: false, error: `${label} returned no image.` }
    }
    const res = await req(`${base}/models/${encodeURIComponent(a.model)}:predict?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt: a.prompt }],
        parameters: { sampleCount: 1, ...(a.size ? { aspectRatio: a.size } : {}) }
      })
    })
    if (!res.ok) return { ok: false, error: await failure(label, res) }
    const data = (await res.json()) as { predictions?: { bytesBase64Encoded?: string; mimeType?: string }[] }
    const p = data.predictions?.[0]
    if (!p?.bytesBase64Encoded) return { ok: false, error: `${label} returned no image.` }
    return { ok: true, bytes: Buffer.from(p.bytesBase64Encoded, 'base64'), ext: extFor('image', p.mimeType) }
  }

  // Veo: a long-running operation, then a file URI that itself needs the key appended.
  const start = await req(`${base}/models/${encodeURIComponent(a.model)}:predictLongRunning?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [
        {
          prompt: a.prompt,
          // A supplied photo becomes the clip's first frame.
          ...(src ? { image: { bytesBase64Encoded: src.bytes.toString('base64'), mimeType: src.mime } } : {})
        }
      ],
      parameters: {
        sampleCount: 1,
        ...(a.size ? { aspectRatio: a.size } : {}),
        ...(a.seconds ? { durationSeconds: a.seconds } : {})
      }
    })
  })
  if (!start.ok) return { ok: false, error: await failure(label, start) }
  const op = (await start.json()) as { name?: string }
  if (!op.name) return { ok: false, error: `${label} did not start the video job.` }

  const uri = await pollUntil<string>(
    'The video',
    async () => {
      const s = await req(`${base}/${op.name}?key=${encodeURIComponent(key)}`, {})
      if (!s.ok) return { done: false, failed: await failure(label, s) }
      const st = (await s.json()) as {
        done?: boolean
        error?: { message?: string }
        response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[] } }
      }
      if (st.error?.message) return { done: false, failed: st.error.message }
      if (!st.done) return { done: false }
      const found = st.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
      return found ? { done: true, value: found } : { done: false, failed: `${label} finished but returned no video.` }
    },
    a.onProgress
  )

  const sep2 = uri.includes('?') ? '&' : '?'
  return { ok: true, bytes: await fetchBytes(`${uri}${sep2}key=${encodeURIComponent(key)}`), ext: extFor('video', uri) }
}

async function replicateAdapter(a: GenerateArgs, key: string, label: string, src?: SourceImage): Promise<AdapterResult> {
  const input: Record<string, unknown> = { prompt: a.prompt }
  if (a.size) input.aspect_ratio = a.size
  if (a.seconds) input.duration = a.seconds
  /* Replicate validates its input schema strictly, so the field name comes from the registry rather
     than a guess: `input_image` for Kontext, `start_image` for Kling. Data URIs are accepted in place
     of a hosted URL, which is what keeps this working with a purely local file. */
  if (src) {
    const field = getMediaModel(a.providerId, a.model)?.sourceKey
    if (!field) return { ok: false, error: `${label}'s "${a.model}" does not take a starting photo. Pick a model labelled "edit a photo" or "animate a photo".` }
    input[field] = asDataUri(src)
  }

  const create = await req(`https://api.replicate.com/v1/models/${a.model}/predictions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input })
  })
  if (!create.ok) return { ok: false, error: await failure(label, create) }
  const pred = (await create.json()) as { id?: string; urls?: { get?: string }; error?: string }
  const statusUrl = pred.urls?.get ?? (pred.id ? `https://api.replicate.com/v1/predictions/${pred.id}` : null)
  if (!statusUrl) return { ok: false, error: `${label} did not start the job.` }

  const out = await pollUntil<string>(
    a.kind === 'video' ? 'The video' : 'The image',
    async () => {
      const s = await req(statusUrl, { headers: { Authorization: `Bearer ${key}` } })
      if (!s.ok) return { done: false, failed: await failure(label, s) }
      const st = (await s.json()) as { status?: string; output?: string | string[]; error?: string }
      if (st.status === 'failed' || st.status === 'canceled') return { done: false, failed: st.error ?? `${label} could not finish this generation.` }
      if (st.status !== 'succeeded') return { done: false }
      const url = Array.isArray(st.output) ? st.output[0] : st.output
      return url ? { done: true, value: url } : { done: false, failed: `${label} finished but returned nothing.` }
    },
    a.onProgress
  )

  return { ok: true, bytes: await fetchBytes(out), ext: extFor(a.kind, out) }
}

async function falAdapter(a: GenerateArgs, key: string, label: string, src?: SourceImage): Promise<AdapterResult> {
  const input: Record<string, unknown> = { prompt: a.prompt }
  if (a.size) input.image_size = a.size
  if (a.seconds) input.duration = String(a.seconds)
  if (src) {
    const field = getMediaModel(a.providerId, a.model)?.sourceKey
    if (!field) return { ok: false, error: `${label}'s "${a.model}" does not take a starting photo. Pick a model labelled "edit a photo" or "animate a photo".` }
    input[field] = asDataUri(src) // fal accepts a data URI wherever it documents an image_url
  }
  const auth = { Authorization: `Key ${key}` }

  const create = await req(`https://queue.fal.run/${a.model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(input)
  })
  if (!create.ok) return { ok: false, error: await failure(label, create) }
  const q = (await create.json()) as { request_id?: string; status_url?: string; response_url?: string }
  if (!q.status_url || !q.response_url) return { ok: false, error: `${label} did not queue the job.` }

  await pollUntil<true>(
    a.kind === 'video' ? 'The video' : 'The image',
    async () => {
      const s = await req(q.status_url!, { headers: auth })
      if (!s.ok) return { done: false, failed: await failure(label, s) }
      const st = (await s.json()) as { status?: string; error?: unknown }
      if (st.status === 'ERROR') return { done: false, failed: `${label} could not finish this generation.` }
      return st.status === 'COMPLETED' ? { done: true, value: true as const } : { done: false }
    },
    a.onProgress
  )

  const done = await req(q.response_url, { headers: auth })
  if (!done.ok) return { ok: false, error: await failure(label, done) }
  const body = (await done.json()) as {
    images?: { url?: string; content_type?: string }[]
    video?: { url?: string; content_type?: string }
  }
  const asset = a.kind === 'video' ? body.video : body.images?.[0]
  if (!asset?.url) return { ok: false, error: `${label} finished but returned no file.` }
  return { ok: true, bytes: await fetchBytes(asset.url), ext: extFor(a.kind, asset.content_type ?? asset.url) }
}

async function stabilityAdapter(a: GenerateArgs, key: string, label: string, src?: SourceImage): Promise<AdapterResult> {
  // No Stability model here declares source support, so this is belt-and-braces for a hand-typed
  // model id. Refusing is better than posting a photo to an endpoint that would ignore it and still
  // charge for the generation.
  if (src) return { ok: false, error: `${label} is set up here for making new pictures only. To edit or animate an existing photo, choose OpenAI, Google, Replicate or fal.ai.` }
  // Stability takes multipart, not JSON, and streams the image back as raw bytes.
  const form = new FormData()
  form.append('prompt', a.prompt)
  form.append('output_format', 'png')
  if (a.size) form.append('aspect_ratio', a.size)

  const res = await req(`https://api.stability.ai/v2beta/stable-image/generate/${a.model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, Accept: 'image/*' },
    body: form
  })
  if (!res.ok) return { ok: false, error: await failure(label, res) }
  return { ok: true, bytes: Buffer.from(await res.arrayBuffer()), ext: 'png' }
}

/**
 * Test double. Writes a real 1×1 PNG (or a tiny MP4 box) so everything downstream — saving, sizing,
 * the gallery thumbnail, the editor's binary-file handling — is exercised on genuine bytes rather
 * than on a string pretending to be a file.
 */
async function mockAdapter(a: GenerateArgs, src?: SourceImage): Promise<AdapterResult> {
  await sleep(10)
  if (process.env.STUDIO_MOCK_MEDIA_FAIL === '1') return { ok: false, error: 'Mock media failure (test).' }
  // Record what the adapter was handed, so a test can prove the starting photo really reached the
  // wire layer rather than being dropped somewhere between the picker and here.
  if (process.env.STUDIO_MOCK_MEDIA_LOG) {
    try {
      writeFileSync(
        process.env.STUDIO_MOCK_MEDIA_LOG,
        JSON.stringify({ model: a.model, kind: a.kind, sourceBytes: src ? src.bytes.length : 0, sourceMime: src?.mime ?? '' }),
        'utf8'
      )
    } catch {
      /* best-effort test hook */
    }
  }
  if (a.kind === 'video') {
    // Minimal ftyp box — enough to be a non-empty, correctly-typed file on disk.
    const ftyp = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex')
    return { ok: true, bytes: Buffer.concat([ftyp, Buffer.alloc(512)]), ext: 'mp4' }
  }
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  return { ok: true, bytes: Buffer.from(png, 'base64'), ext: 'png' }
}

// ── The one entry point ────────────────────────────────────────────────────────────────────────────

/** Resolve a project-relative path, refusing anything that escapes the project root. */
function safeUnder(root: string, rel: string): string {
  const abs = resolve(root, rel)
  const rootResolved = resolve(root)
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) throw new Error('Path is outside the project folder.')
  return abs
}

export async function generate(a: GenerateArgs): Promise<GenerateResult> {
  const provider = getMediaProvider(a.providerId)
  if (!provider) return { ok: false, error: `Unknown media provider: ${a.providerId}` }

  const badPrompt = validatePrompt(a.prompt)
  if (badPrompt) return { ok: false, error: badPrompt }
  if (!a.model.trim()) return { ok: false, error: 'Pick a model first.' }
  if (!a.projectPath) return { ok: false, error: 'Open a project first — generated files are saved inside it.' }

  // Air-Gapped Mode: there is no on-device image or video model here, so unlike chat there is no
  // local fallback to offer. Say that plainly instead of failing with a network error.
  const isMock = provider.id === 'mock-media'
  if (!isMock) {
    let airGap = false
    try {
      airGap = getAirGap()
    } catch {
      airGap = false // a policy read must never break a paid action
    }
    if (airGap) {
      return {
        ok: false,
        error: 'Air-Gapped Mode is on, and image/video generation always runs on the provider’s servers — there is no offline option. Turn it off in Settings → AI to use this.'
      }
    }
  }

  const key = isMock ? 'mock' : getApiKey(provider.id)
  if (!key) {
    return {
      ok: false,
      error: `No ${provider.label} API key yet. Add one in Settings → AI keys — it is billed to your own ${provider.label} account. ${provider.planNote}`
    }
  }

  // Spend cap checked BEFORE the request, using this generation's own estimate, so one expensive
  // video cannot sail past the ceiling and only get refused on the next click.
  const est = estimateUsd(a.providerId, a.model)
  if (usage.capUsd > 0 && usage.estUsd + (est ?? 0) >= usage.capUsd) {
    return {
      ok: false,
      error: `This would pass your media budget for the session (about $${usage.capUsd.toFixed(2)}). Raise it in Settings → AI to keep generating.`
    }
  }

  /* "Start from a photo", resolved and read HERE — before a single request goes out. A missing file,
     an unreadable one, a wrong file type, or a model that cannot take one are all mistakes that must
     cost nothing, so every one of them is caught on this side of the network call. */
  let src: SourceImage | undefined
  if (a.sourceFile) {
    if (!acceptsSource(a.providerId, a.model)) {
      return {
        ok: false,
        error: `“${a.model}” cannot start from a photo. Pick a model labelled “edit a photo” or “animate a photo”, or clear the starting picture.`
      }
    }
    if (!isUsableSourceImage(a.sourceFile)) {
      return { ok: false, error: `A starting picture has to be a PNG, JPG or WebP — “${a.sourceFile.split('/').pop()}” is not.` }
    }
    try {
      const abs = safeUnder(a.projectPath, a.sourceFile)
      const st = statSync(abs)
      if (!st.isFile()) throw new Error('not a file')
      if (st.size > SOURCE_MAX_BYTES) {
        return { ok: false, error: `That starting picture is ${Math.round(st.size / (1024 * 1024))} MB. Providers reject anything over ${SOURCE_MAX_BYTES / (1024 * 1024)} MB — use a smaller one.` }
      }
      src = { bytes: readFileSync(abs), mime: mimeForImage(a.sourceFile), name: a.sourceFile.split('/').pop() || 'source.png' }
    } catch {
      return { ok: false, error: `Studio could not read the starting picture (${a.sourceFile}). It may have been moved or deleted.` }
    }
  }

  const started = Date.now()
  a.onProgress?.(
    src
      ? a.kind === 'video'
        ? 'Sending your photo to be animated — video usually takes a few minutes.'
        : 'Sending your photo to be edited…'
      : a.kind === 'video'
        ? 'Sending the request — video usually takes a few minutes.'
        : 'Sending the request…'
  )

  let out: AdapterResult
  try {
    if (isMock) out = await mockAdapter(a, src)
    else if (provider.id === 'openai') out = await openaiAdapter(a, key, provider.label, src)
    else if (provider.id === 'gemini') out = await geminiAdapter(a, key, provider.label, src)
    else if (provider.id === 'replicate') out = await replicateAdapter(a, key, provider.label, src)
    else if (provider.id === 'fal') out = await falAdapter(a, key, provider.label, src)
    else if (provider.id === 'stability') out = await stabilityAdapter(a, key, provider.label, src)
    else out = { ok: false, error: `No adapter for ${provider.label}.` }
  } catch (e) {
    out = { ok: false, error: errMessage(e) }
  }

  if (!out.ok || !out.bytes) return { ok: false, error: out.error ?? 'The provider returned nothing.' }

  // Save into the project. A generation the user paid for is written to disk before anything else
  // happens, so a renderer crash between here and the reply cannot lose it.
  let receipt: MediaReceipt
  try {
    const dirAbs = safeUnder(a.projectPath, MEDIA_DIR)
    mkdirSync(dirAbs, { recursive: true })
    const at = Date.now()
    let name = assetFileName(a.prompt, out.ext ?? extFor(a.kind), at)
    for (let seq = 1; existsSync(join(dirAbs, name)); seq++) name = assetFileName(a.prompt, out.ext ?? extFor(a.kind), at, seq)
    const abs = join(dirAbs, name)
    writeFileSync(abs, out.bytes)

    receipt = {
      id: `${at}-${name}`,
      kind: a.kind,
      prompt: a.prompt.trim(),
      providerId: provider.id,
      providerLabel: provider.label,
      model: a.model,
      file: `${MEDIA_DIR}/${name}`,
      bytes: out.bytes.length,
      ms: at - started,
      approxUsd: est,
      createdAt: at,
      ...(a.size ? { size: a.size } : {}),
      ...(a.seconds ? { seconds: a.seconds } : {}),
      ...(a.sourceFile ? { sourceFile: a.sourceFile } : {})
    }
    // The sidecar is what makes an asset self-explaining six months later: which prompt, which model,
    // what it cost. Best-effort — a failed sidecar must never discard the image itself.
    try {
      writeFileSync(`${abs}.json`, JSON.stringify(receipt, null, 2), 'utf8')
    } catch {
      /* the asset is what matters */
    }
  } catch (e) {
    return { ok: false, error: `The provider produced the file but Studio could not save it: ${errMessage(e)}` }
  }

  usage.generations += 1
  usage.estUsd += est ?? 0
  return { ok: true, receipt }
}

/**
 * Which service the AGENT should use when it creates an image mid-task and the user hasn't named one.
 *
 * Resolved from the key vault rather than from a constant: the right default is whichever service
 * this client has actually set up, so a shop that only ever pastes a Replicate token never sees the
 * agent fail against OpenAI. With no keys at all we still return the first provider, so the refusal
 * message can name a real service and tell them where to get a key.
 */
export function defaultImageChoice(): { providerId: string; model: string } {
  const imageCapable = MEDIA_PROVIDERS.filter((p) => p.models.some((m) => m.kind === 'image'))
  const withKey = imageCapable.find((p) => (p.id === 'mock-media' ? process.env.STUDIO_MOCK_MEDIA === '1' : !!getApiKey(p.id)))
  const chosen = withKey ?? imageCapable[0]
  return { providerId: chosen?.id ?? '', model: chosen?.models.find((m) => m.kind === 'image')?.id ?? '' }
}

/**
 * Everything generated in this project, newest first, read back from the sidecars on disk rather than
 * from memory — so the gallery survives a restart and still shows work from previous sessions.
 * A file whose sidecar is missing or mangled still appears (with what we can see of it), because the
 * asset existing is the fact that matters; the metadata is a bonus.
 */
export function listMedia(projectPath: string): MediaReceipt[] {
  let dirAbs: string
  try {
    dirAbs = safeUnder(projectPath, MEDIA_DIR)
  } catch {
    return []
  }
  if (!existsSync(dirAbs)) return []

  const out: MediaReceipt[] = []
  let names: string[]
  try {
    names = readdirSync(dirAbs)
  } catch {
    return []
  }

  for (const name of names) {
    if (name.endsWith('.json')) continue
    const abs = join(dirAbs, name)
    let bytes = 0
    let mtime = 0
    try {
      const st = statSync(abs)
      if (!st.isFile()) continue
      bytes = st.size
      mtime = st.mtimeMs
    } catch {
      continue
    }
    const ext = extname(name).slice(1).toLowerCase()
    const kind: MediaKind = ext === 'mp4' || ext === 'webm' || ext === 'mov' ? 'video' : 'image'
    let receipt: MediaReceipt = {
      id: `${Math.round(mtime)}-${name}`,
      kind,
      prompt: '(no record of the prompt for this file)',
      providerId: '',
      providerLabel: 'Unknown',
      model: '',
      file: `${MEDIA_DIR}/${name}`,
      bytes,
      ms: 0,
      approxUsd: null,
      createdAt: Math.round(mtime)
    }
    try {
      const raw = JSON.parse(readFileSync(`${abs}.json`, 'utf8')) as Partial<MediaReceipt>
      // Trust disk for the physical facts; trust the sidecar for the story behind them.
      receipt = { ...receipt, ...raw, file: receipt.file, bytes, kind: raw.kind ?? kind }
    } catch {
      /* sidecar missing or mangled — the file itself is still real */
    }
    out.push(receipt)
  }
  return out.sort((x, y) => y.createdAt - x.createdAt)
}

/** Delete one generated asset and its sidecar. Refuses anything outside `assets/generated`. */
export function deleteMedia(projectPath: string, relFile: string): { ok: boolean; error?: string } {
  try {
    if (!relFile.startsWith(`${MEDIA_DIR}/`)) return { ok: false, error: 'Only files Studio generated can be removed here.' }
    const abs = safeUnder(projectPath, relFile)
    rmSync(abs, { force: true })
    rmSync(`${abs}.json`, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

/**
 * A generated file as a `data:` URL, for the gallery thumbnail and the agent's screenshot pane.
 * Capped: a 40 MB video must not be base64'd into the renderer just to draw a tile.
 */
const INLINE_MAX = 8 * 1024 * 1024
export function readMediaDataUrl(projectPath: string, relFile: string): { ok: boolean; dataUrl?: string; error?: string } {
  try {
    const abs = safeUnder(projectPath, relFile)
    const st = statSync(abs)
    if (st.size > INLINE_MAX) return { ok: false, error: 'too-large' }
    const ext = extname(abs).slice(1).toLowerCase()
    const mime =
      ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    return { ok: true, dataUrl: `data:${mime};base64,${readFileSync(abs).toString('base64')}` }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}
