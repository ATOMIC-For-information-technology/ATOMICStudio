/**
 * Media generation — images and video, on the CLIENT'S OWN account.
 *
 * Studio never resells generation and never proxies it through an ATOMIC key. Whoever is sitting at
 * the app brings the subscription they already pay for (OpenAI, Google, Replicate, fal.ai, Stability),
 * pastes the key once into the same encrypted vault the chat providers use, and every byte is billed
 * to them by their provider. That is the whole point of the feature: no markup, no middle-man, and no
 * shared quota that one noisy project can drain for everyone else.
 *
 * This module is PURE (no electron, no node, no DOM) so the renderer, the main process and the
 * headless tests all read exactly one table. Wire-level calling lives in `main/media.ts`.
 *
 * ── The model-id lesson, applied up front ────────────────────────────────────────────────────────
 * `providers.ts` carries a scar: Moonshot killed `kimi-latest` and a perfectly good key looked broken
 * for weeks because the model name was baked in. Image/video model names churn far FASTER than chat
 * ones. So every model here is a *suggestion* — the UI ships this curated list in a dropdown AND lets
 * the user type any model id the provider accepts. A stale default is then a ten-second fix by the
 * person using it, not a release we have to ship.
 */

export type MediaKind = 'image' | 'video'

export interface MediaModelDef {
  /** Exactly what goes on the wire as the model/slug. */
  id: string
  label: string
  kind: MediaKind
  /**
   * Rough USD per single generation, for the spend meter. An ESTIMATE we state as an estimate —
   * same honesty rule as the token meter: the promise is "you can never be surprised", not "this is
   * your invoice". Providers change prices without telling us.
   */
  approxUsd: number
  /** Image output sizes; first entry is the default. */
  sizes?: string[]
  /** Video lengths in seconds; first entry is the default. */
  durations?: number[]
  /**
   * This model can START FROM an existing picture — editing it (photo → photo) or animating it
   * (photo → video). Declared per model rather than per provider because it is genuinely per model:
   * FLUX 1.1 Pro cannot take a source image and FLUX Kontext exists for exactly that.
   *
   * Nothing infers this. A model that does not declare it is never offered a photo to start from,
   * so the picker can't produce a pairing the provider would reject.
   */
  acceptsSourceImage?: boolean
  /**
   * For the generic pass-through adapters (Replicate, fal.ai): the input field the source image goes
   * in. These APIs validate their input schema strictly, so guessing a common name would 422 rather
   * than degrade — and the name really does differ per model (`input_image` vs `start_image`).
   * OpenAI and Google need no key here: their adapters have a dedicated edit/animate endpoint.
   */
  sourceKey?: string
  note?: string
}

export interface MediaProviderDef {
  /**
   * Key-vault id. Deliberately the SAME id as the chat provider where the account is the same one —
   * a client who already pasted their OpenAI key for the agent gets images with nothing more to do.
   */
  id: string
  label: string
  /** Reuses a key the client may already have entered for chat. */
  sharesChatKey: boolean
  /** Where to get the key — shown as a real link, because "add an API key" is useless on its own. */
  keyUrl: string
  /** Which plan/credit this actually needs, in plain English. Wrong-plan is the #1 support question. */
  planNote: string
  models: MediaModelDef[]
}

/**
 * The curated set. Replicate and fal.ai are in here on purpose even though they overlap the others:
 * both are front-doors to hundreds of third-party models (Flux, Kling, Wan, SDXL…), so a client whose
 * preferred model isn't listed can still reach it by typing its slug — without us shipping an adapter.
 */
export const MEDIA_PROVIDERS: MediaProviderDef[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    sharesChatKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    planNote: 'Needs pay-as-you-go credit on the OpenAI platform account (a ChatGPT Plus subscription is NOT the same thing).',
    models: [
      {
        id: 'gpt-image-1',
        label: 'GPT Image 1',
        kind: 'image',
        approxUsd: 0.04,
        sizes: ['1024x1024', '1536x1024', '1024x1536'],
        acceptsSourceImage: true,
        note: 'Strong at text inside the image — good for UI mockups and posters. Can also edit a photo you already have.'
      },
      {
        id: 'sora-2',
        label: 'Sora 2',
        kind: 'video',
        approxUsd: 0.5,
        durations: [4, 8, 12],
        sizes: ['1280x720', '720x1280'],
        acceptsSourceImage: true,
        note: 'Generation runs for minutes; Studio polls and saves the MP4 when it lands. Can animate a photo you already have.'
      }
    ]
  },
  {
    id: 'gemini',
    label: 'Google (Gemini)',
    sharesChatKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    planNote: 'Needs a Google AI Studio key with billing enabled — Imagen and Veo are not on the free tier.',
    models: [
      {
        id: 'imagen-4.0-generate-001',
        label: 'Imagen 4',
        kind: 'image',
        approxUsd: 0.04,
        sizes: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        note: 'Sizes are aspect ratios, which is how Imagen takes them.'
      },
      {
        // Google's edit-capable image model. It answers on :generateContent (not Imagen's :predict),
        // which is why the adapter branches on the model name rather than on the provider.
        id: 'gemini-2.5-flash-image',
        label: 'Gemini 2.5 Flash Image (edit a photo)',
        kind: 'image',
        approxUsd: 0.04,
        acceptsSourceImage: true,
        note: 'The one to pick when changing a picture you already have — "make the walls blue", "remove the sign".'
      },
      {
        id: 'veo-3.0-generate-001',
        label: 'Veo 3',
        kind: 'video',
        approxUsd: 1.5,
        durations: [4, 6, 8],
        sizes: ['16:9', '9:16'],
        acceptsSourceImage: true,
        note: 'Long-running operation — expect a few minutes per clip. A photo becomes the first frame.'
      }
    ]
  },
  {
    id: 'replicate',
    label: 'Replicate',
    sharesChatKey: false,
    keyUrl: 'https://replicate.com/account/api-tokens',
    planNote: 'Needs a Replicate account with a payment method. Billed per second of compute.',
    models: [
      { id: 'black-forest-labs/flux-1.1-pro', label: 'FLUX 1.1 Pro', kind: 'image', approxUsd: 0.04, sizes: ['1:1', '16:9', '9:16', '3:2', '2:3'] },
      { id: 'black-forest-labs/flux-schnell', label: 'FLUX Schnell (cheap + fast)', kind: 'image', approxUsd: 0.003, sizes: ['1:1', '16:9', '9:16'] },
      {
        id: 'black-forest-labs/flux-kontext-pro',
        label: 'FLUX Kontext Pro (edit a photo)',
        kind: 'image',
        approxUsd: 0.04,
        sizes: ['1:1', '16:9', '9:16'],
        acceptsSourceImage: true,
        sourceKey: 'input_image'
      },
      { id: 'kwaivgi/kling-v2.1', label: 'Kling v2.1', kind: 'video', approxUsd: 0.5, durations: [5, 10], acceptsSourceImage: true, sourceKey: 'start_image' },
      { id: 'wan-video/wan-2.5-t2v', label: 'Wan 2.5', kind: 'video', approxUsd: 0.3, durations: [5, 10] }
    ]
  },
  {
    id: 'fal',
    label: 'fal.ai',
    sharesChatKey: false,
    keyUrl: 'https://fal.ai/dashboard/keys',
    planNote: 'Needs a fal.ai account with credit. Billed per generation.',
    models: [
      { id: 'fal-ai/flux/dev', label: 'FLUX Dev', kind: 'image', approxUsd: 0.025, sizes: ['square_hd', 'landscape_16_9', 'portrait_9_16', 'landscape_4_3'] },
      { id: 'fal-ai/flux-pro/v1.1', label: 'FLUX Pro 1.1', kind: 'image', approxUsd: 0.04, sizes: ['square_hd', 'landscape_16_9', 'portrait_9_16'] },
      {
        id: 'fal-ai/flux/dev/image-to-image',
        label: 'FLUX Dev (edit a photo)',
        kind: 'image',
        approxUsd: 0.025,
        sizes: ['square_hd', 'landscape_16_9', 'portrait_9_16'],
        acceptsSourceImage: true,
        sourceKey: 'image_url'
      },
      { id: 'fal-ai/kling-video/v2/master/text-to-video', label: 'Kling v2 Master', kind: 'video', approxUsd: 0.7, durations: [5, 10] },
      {
        id: 'fal-ai/kling-video/v2/master/image-to-video',
        label: 'Kling v2 Master (animate a photo)',
        kind: 'video',
        approxUsd: 0.7,
        durations: [5, 10],
        acceptsSourceImage: true,
        sourceKey: 'image_url'
      }
    ]
  },
  {
    id: 'stability',
    label: 'Stability AI',
    sharesChatKey: false,
    keyUrl: 'https://platform.stability.ai/account/keys',
    planNote: 'Needs Stability credits on the platform account.',
    models: [
      { id: 'core', label: 'Stable Image Core', kind: 'image', approxUsd: 0.03, sizes: ['1:1', '16:9', '9:16', '3:2', '2:3'] },
      { id: 'ultra', label: 'Stable Image Ultra', kind: 'image', approxUsd: 0.08, sizes: ['1:1', '16:9', '9:16'] }
    ]
  }
]

/**
 * Test-only deterministic provider, mirroring `STUDIO_MOCK_AI` in providers.ts: writes a real (tiny)
 * PNG/MP4 from a fixture instead of calling the network, so the GUI test can drive the whole feature
 * offline. Never registered in a normal run, so it cannot appear in a real user's dropdown.
 */
export function registerMockMediaProvider(): void {
  if (MEDIA_PROVIDERS.some((p) => p.id === 'mock-media')) return
  MEDIA_PROVIDERS.push({
    id: 'mock-media',
    label: 'Mock media (tests)',
    sharesChatKey: false,
    keyUrl: '',
    planNote: 'Test double.',
    models: [
      { id: 'mock-image', label: 'Mock image', kind: 'image', approxUsd: 0.01, sizes: ['1024x1024'] },
      { id: 'mock-edit', label: 'Mock edit', kind: 'image', approxUsd: 0.01, sizes: ['1024x1024'], acceptsSourceImage: true, sourceKey: 'image_url' },
      { id: 'mock-video', label: 'Mock video', kind: 'video', approxUsd: 0.02, durations: [4] },
      { id: 'mock-animate', label: 'Mock animate', kind: 'video', approxUsd: 0.02, durations: [4], acceptsSourceImage: true, sourceKey: 'image_url' }
    ]
  })
}

export function getMediaProvider(id: string): MediaProviderDef | undefined {
  return MEDIA_PROVIDERS.find((p) => p.id === id)
}

export function getMediaModel(providerId: string, modelId: string): MediaModelDef | undefined {
  return getMediaProvider(providerId)?.models.find((m) => m.id === modelId)
}

/** Providers that can produce this kind at all — drives the picker so it never offers a dead pairing. */
export function providersFor(kind: MediaKind): MediaProviderDef[] {
  return MEDIA_PROVIDERS.filter((p) => p.models.some((m) => m.kind === kind))
}

export function modelsFor(providerId: string, kind: MediaKind): MediaModelDef[] {
  return getMediaProvider(providerId)?.models.filter((m) => m.kind === kind) ?? []
}

/**
 * Can this exact pairing start from an existing photo? Used to gate the "Start from a photo" control,
 * so it is never offered for a model that would reject it — and to refuse in the engine, so a stale
 * renderer or a hand-typed model id can't get past the UI.
 */
export function acceptsSource(providerId: string, modelId: string): boolean {
  return getMediaModel(providerId, modelId)?.acceptsSourceImage === true
}

/** Providers offering at least one model that can start from a photo, for the given output kind. */
export function sourceCapableProviders(kind: MediaKind): MediaProviderDef[] {
  return MEDIA_PROVIDERS.filter((p) => p.models.some((m) => m.kind === kind && m.acceptsSourceImage))
}

/** Image types we will hand to a provider as a starting picture. */
export const SOURCE_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp'] as const

export function isUsableSourceImage(file: string): boolean {
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  return (SOURCE_IMAGE_EXT as readonly string[]).includes(ext)
}

/**
 * The cost shown BEFORE the button is pressed. A typed-in custom model has no price in our table, so
 * we return null and the UI says "unknown" rather than inventing a comfortable-looking number.
 */
export function estimateUsd(providerId: string, modelId: string): number | null {
  return getMediaModel(providerId, modelId)?.approxUsd ?? null
}

/** Where generated media lands inside the user's project. One folder, so it is obvious and deletable. */
export const MEDIA_DIR = 'assets/generated'

const MAX_PROMPT = 4000

/** Null when the prompt is usable; otherwise the plain-English reason, ready to show as-is. */
export function validatePrompt(prompt: string): string | null {
  const p = prompt.trim()
  if (!p) return 'Describe what you want to see first — the prompt is empty.'
  if (p.length > MAX_PROMPT) return `That prompt is ${p.length.toLocaleString()} characters; the limit is ${MAX_PROMPT.toLocaleString()}.`
  return null
}

/**
 * A readable, collision-proof filename built from the prompt itself, so a folder of 40 generations is
 * still browsable six months later. `seq` disambiguates two generations inside the same millisecond.
 */
export function assetFileName(prompt: string, ext: string, at: number, seq = 0): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'generated'
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${slug}-${stamp}${seq ? `-${seq}` : ''}.${ext}`
}

/** One saved generation. Written next to the file as `<file>.json` so the asset explains itself. */
export interface MediaReceipt {
  id: string
  kind: MediaKind
  prompt: string
  providerId: string
  providerLabel: string
  model: string
  /** Project-relative, always POSIX-separated. */
  file: string
  bytes: number
  ms: number
  /** Null when the model was typed by hand and we have no price for it. */
  approxUsd: number | null
  createdAt: number
  size?: string
  seconds?: number
  /** The picture this one was made FROM, when it was an edit or an animation. */
  sourceFile?: string
}

/**
 * Turn a provider's HTTP failure into something a non-coder can act on. Studio's users are not going
 * to read a JSON error body, and "402" tells them nothing about what to do next.
 */
export function describeMediaError(providerLabel: string, status: number, body: string): string {
  const snippet = body.trim().slice(0, 200)
  if (status === 401 || status === 403) {
    return `${providerLabel} rejected the API key. Check it in Settings → AI keys, and make sure the key belongs to an account with access to this model.`
  }
  if (status === 402) {
    return `${providerLabel} says this account has no credit left. Top it up on ${providerLabel}, then try again — nothing was charged.`
  }
  if (status === 404) {
    return `${providerLabel} does not know the model you asked for. Model names change often — pick another from the list, or type the exact id from ${providerLabel}'s docs.`
  }
  if (status === 429) {
    /* 429 is TWO different problems wearing one status code, and the advice for them is opposite.
       Google returns 429/RESOURCE_EXHAUSTED for "your prepay credits are gone" — telling that user to
       "wait a moment and try again" (as this did, until a live key proved otherwise) sends them into
       a loop that can never succeed. Read the body: money problems say so in words. */
    if (/credit|billing|prepay|depleted|insufficient|balance|quota exceeded|exhausted/i.test(body)) {
      return `${providerLabel} says this account is out of credit. Top it up in your ${providerLabel} billing settings — waiting will not clear this. Nothing was charged.`
    }
    return `${providerLabel} is rate-limiting this account right now. Wait a moment and try again.`
  }
  if (status >= 500) {
    return `${providerLabel} had a server error (${status}). That is their end, not yours — try again shortly.`
  }
  return `${providerLabel} refused the request (${status})${snippet ? `: ${snippet}` : '.'}`
}

/** The spend-meter line for media, kept separate from tokens because media bills per FILE, not per token. */
export interface MediaUsage {
  generations: number
  estUsd: number
  /** 0 = unlimited. Once estUsd reaches it, the next generation is refused BEFORE it runs. */
  capUsd: number
}
