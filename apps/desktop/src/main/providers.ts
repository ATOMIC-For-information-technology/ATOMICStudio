import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { readFileSync, writeFileSync } from 'node:fs'
import { getApiKey } from './keyvault'
import { getAirGap } from './policy'
import { errMessage } from './util'

/**
 * Model-agnostic provider layer. Anthropic uses its own SDK; every other
 * provider (OpenAI, Groq, Gemini, local Ollama) speaks the OpenAI chat API, so
 * one OpenAI-compatible client with a per-provider baseURL covers them all.
 */
export type ProviderKind = 'anthropic' | 'openai' | 'atomic-hub' | 'mock'

export interface ProviderDef {
  id: string
  label: string
  kind: ProviderKind
  baseURL?: string
  defaultModel: string
  needsKey: boolean
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'atomic', label: 'ATOMIC AI Hub (free Groq)', kind: 'atomic-hub', baseURL: 'https://ai.atomic.limited', defaultModel: 'hub-auto', needsKey: true },
  { id: 'groq', label: 'Groq (fast)', kind: 'openai', baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', needsKey: true },
  { id: 'anthropic', label: 'Claude (Anthropic)', kind: 'anthropic', defaultModel: 'claude-sonnet-4-6', needsKey: true },
  { id: 'openai', label: 'OpenAI', kind: 'openai', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', needsKey: true },
  { id: 'gemini', label: 'Google Gemini', kind: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'gemini-2.0-flash', needsKey: true },
  // Moonshot AI (Kimi) — OpenAI-compatible. `kimi-latest` was the alias that auto-tracked their newest
  // flagship, but Moonshot discontinued it on 2026-01-28 (their own docs redirect callers to kimi-k3) —
  // it now 404s outright, which reads as a broken/unpaid key when it's really just a dead model name.
  // Pin whichever current model you want in Settings if this default goes stale again.
  { id: 'kimi', label: 'Kimi (Moonshot AI)', kind: 'openai', baseURL: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k3', needsKey: true },
  { id: 'ollama', label: 'Local (Ollama)', kind: 'openai', baseURL: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder', needsKey: false },
  // OpenCode Zen — a real hosted gateway from the OpenCode team, OpenAI-compatible, with a genuinely
  // free no-key model tier (confirmed against opencode.ai/docs/zen). Unlike 'atomic' above (whose
  // "free" label is about ATOMIC proxying Groq, not about skipping a key — it still needs one), this
  // is the one cloud provider in this list that actually needs zero setup, same as local Ollama. The
  // free tier is documented as rotating as OpenCode adds/removes capacity; if this model starts
  // 404ing, check opencode.ai/docs/zen for the current free list (same class of staleness as the Kimi
  // note above) — the user can always override the model in Settings in the meantime.
  /* defaultModel is `laguna-s-2.1-free`, not `big-pickle`: big-pickle's free quota is exhausted and
     answers every request with FreeUsageLimitError, so the one provider that needs no signup greeted
     a brand-new user with a rate-limit error. Verified 2026-08-23 by calling both. If this one dries
     up too, any other id in OPENCODE_FREE_IDS is a drop-in — and the error below now says so. */
  { id: 'opencode', label: 'OpenCode Zen (free)', kind: 'openai', baseURL: 'https://opencode.ai/zen/v1', defaultModel: 'laguna-s-2.1-free', needsKey: false }
]

// Test-only deterministic provider: replays scripted replies from the JSON file
// named by STUDIO_MOCK_SCRIPT, one per complete() call. Never registered in a
// normal run, so it can't appear in the Settings dropdown for real users.
if (process.env.STUDIO_MOCK_AI === '1') {
  PROVIDERS.push({ id: 'mock', label: 'Mock (tests)', kind: 'mock', defaultModel: 'scripted', needsKey: false })
}

// Ids OpenCode Zen documents as free (opencode.ai/docs/zen) — the /v1/models endpoint itself carries
// no tier field, so this is the only source for the free/paid label shown in Settings. Same staleness
// caveat as the Kimi default above: if OpenCode's free set changes, update it here.
const OPENCODE_FREE_IDS = new Set([
  'big-pickle',
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'hy3-free',
  'laguna-s-2.1-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'x-preview-f-free',
  'muse-spark-1.2-contributor-free'
])

/**
 * The full live OpenCode Zen model catalog (free and paid) — a plain HTTPS call, not a CLI, not the
 * `opencode` tool. Settings' model picker for this provider is built entirely from this, replacing
 * the free-text field with a real dropdown instead of guessing/hardcoding the list.
 */
export async function opencodeModels(): Promise<
  { ok: true; models: { id: string; free: boolean }[] } | { ok: false; error: string }
> {
  try {
    const res = await fetch('https://opencode.ai/zen/v1/models')
    if (!res.ok) return { ok: false, error: `OpenCode Zen returned ${res.status}` }
    const body = (await res.json()) as { data: { id: string }[] }
    return { ok: true, models: body.data.map((m) => ({ id: m.id, free: OPENCODE_FREE_IDS.has(m.id) })) }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/** Resolve the API key for a provider, or null if it needs none (or is unknown). */
export function apiKeyFor(providerId: string): string | null {
  return getProvider(providerId)?.needsKey ? getApiKey(providerId) : null
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CompleteArgs {
  providerId: string
  model?: string
  apiKey?: string | null
  system: string
  /** Single-turn prompt. Ignored when `messages` is provided. */
  user?: string
  /** Full multi-turn transcript (agent loop). Takes precedence over `user`. */
  messages?: ChatMessage[]
}

export interface CompleteResult {
  ok: boolean
  text?: string
  error?: string
  /** The exact model that produced this response (Model Receipt). */
  model?: string
}

/**
 * Zero-Surprise Billing — a session usage ledger + a hard cap. Token counts are
 * ESTIMATES (chars/4) so the meter works uniformly across every provider, incl.
 * the free hub; the promise is "you can never be surprised", not exact billing.
 */
export interface Usage {
  requests: number
  estTokens: number
  byModel: Record<string, { requests: number; estTokens: number }>
  lastModel: string | null
  capTokens: number
}

let usage: Usage = { requests: 0, estTokens: 0, byModel: {}, lastModel: null, capTokens: 0 }

export function getUsage(): Usage {
  return { ...usage, byModel: { ...usage.byModel } }
}
export function resetUsage(): void {
  usage = { requests: 0, estTokens: 0, byModel: {}, lastModel: null, capTokens: usage.capTokens }
}
/** 0 = unlimited. Once estTokens reaches the cap, complete() refuses. */
export function setSpendCap(tokens: number): void {
  usage.capTokens = Math.max(0, Math.floor(tokens) || 0)
}
const estTokensOf = (s: string): number => Math.ceil(s.length / 4)
function recordUsage(model: string, promptChars: number, replyChars: number): void {
  const est = estTokensOf('x'.repeat(promptChars + replyChars))
  usage.requests += 1
  usage.estTokens += est
  usage.lastModel = model
  const m = usage.byModel[model] ?? { requests: 0, estTokens: 0 }
  usage.byModel[model] = { requests: m.requests + 1, estTokens: m.estTokens + est }
}

export async function complete(args: CompleteArgs): Promise<CompleteResult> {
  const p = getProvider(args.providerId)
  if (!p) return { ok: false, error: `Unknown provider: ${args.providerId}` }
  // Air-Gapped Mode: block every OUTBOUND provider — only the local model (Ollama)
  // and the test mock are allowed. Check local FIRST so getAirGap() (which touches
  // userData) is never reached under the mock in tests, and so a blocked call is
  // never metered/dispatched. This is the single choke point every AI path funnels
  // through (agent, ai-edit, insight, workflow), so hiding providers in the UI is
  // not enough — enforcement lives here.
  const isLocal = p.kind === 'mock' || p.id === 'ollama' || !!p.baseURL?.includes('localhost') || !!p.baseURL?.includes('127.0.0.1')
  if (!isLocal) {
    let airGap = false
    try {
      airGap = getAirGap()
    } catch {
      airGap = false // never let a policy read crash the AI path
    }
    if (airGap) return { ok: false, error: 'Air-Gapped Mode is on: only the local model (Ollama) is allowed — outbound AI is blocked. Turn it off in Settings → AI.' }
  }
  if (p.needsKey && !args.apiKey) return { ok: false, error: `No API key set for ${p.label}. Add one in Settings.` }
  const model = args.model || p.defaultModel
  const messages: ChatMessage[] = args.messages ?? [{ role: 'user', content: args.user ?? '' }]

  // Hard cap: refuse rather than run past the ceiling (mock excluded from the
  // meter). The prompt size is KNOWN now, so include it — a single big request
  // can't blow past the cap and only get refused on the *next* call.
  const metered = p.kind !== 'mock'
  const promptChars = args.system.length + messages.reduce((n, m) => n + m.content.length, 0)
  if (metered && usage.capTokens > 0 && usage.estTokens + estTokensOf('x'.repeat(promptChars)) >= usage.capTokens) {
    return { ok: false, error: `This request would exceed your AI budget cap (~${usage.capTokens.toLocaleString()} tokens this session). Raise it in Settings → AI to continue.` }
  }

  try {
    if (p.kind === 'mock') {
      // Test hook: capture the exact SYSTEM prompt sent, so tests can verify
      // prompt injection (persona / house-style / decisions ordering).
      if (process.env.STUDIO_MOCK_SYSTEM_LOG) {
        try {
          writeFileSync(process.env.STUDIO_MOCK_SYSTEM_LOG, args.system, 'utf8')
        } catch {
          /* best-effort capture */
        }
      }
      const script = process.env.STUDIO_MOCK_SCRIPT
      if (!script) return { ok: false, error: 'STUDIO_MOCK_SCRIPT not set' }
      const replies = JSON.parse(readFileSync(script, 'utf8')) as string[]
      // Cursor lives in a sidecar file so rewriting the script restarts the
      // sequence — each test scenario begins at reply 0.
      const idxFile = script + '.idx'
      let idx = 0
      try {
        idx = parseInt(readFileSync(idxFile, 'utf8'), 10) || 0
      } catch {
        /* first call for this script */
      }
      writeFileSync(idxFile, String(idx + 1), 'utf8')
      // Mock is not metered (tests), but still reports the model for receipts.
      return { ok: true, text: replies[Math.min(idx, replies.length - 1)], model }
    }

    if (p.kind === 'anthropic') {
      const client = new Anthropic({ apiKey: args.apiKey! })
      const msg = await client.messages.create({
        model,
        max_tokens: 8192,
        system: args.system,
        messages
      })
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      recordUsage(model, promptChars, text.length)
      return { ok: true, text, model }
    }

    if (p.kind === 'atomic-hub') {
      // ATOMIC AI Hub: POST /v1/chat with X-Api-Key; body {messages, system}; returns {reply}.
      const res = await fetch(`${p.baseURL}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': args.apiKey! },
        body: JSON.stringify({ system: args.system, messages })
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return { ok: false, error: `ATOMIC Hub error ${res.status}: ${body.slice(0, 200)}` }
      }
      const data = (await res.json()) as { reply?: string; error?: string }
      if (data.error) return { ok: false, error: `ATOMIC Hub: ${data.error}` }
      recordUsage(model, promptChars, (data.reply ?? '').length)
      return { ok: true, text: data.reply ?? '', model }
    }

    /* OpenAI-compatible (OpenAI / Groq / Gemini / Ollama / OpenCode Zen)
     *
     * The SDK requires *some* apiKey string, so a keyless provider gets the `not-needed` placeholder
     * — but the header itself must then be dropped, not sent with that placeholder inside it.
     *
     * Real failure this fixes: OpenCode Zen is the one provider in the catalog that needs no signup
     * at all, and it was unusable. Sending `Authorization: Bearer not-needed` made Zen answer
     * `AuthError: Invalid API key.`, which surfaced in the agent panel as a flat "401 Invalid API
     * key." — telling a user who has no key that their key is wrong. The identical request with no
     * Authorization header succeeds. Ollama never caught this because it ignores auth entirely.
     *
     * A `null` header value is how this SDK is told to omit a header rather than send it empty. */
    const keyless = !p.needsKey && !args.apiKey
    const client = new OpenAI({
      apiKey: args.apiKey || 'not-needed',
      baseURL: p.baseURL,
      ...(keyless ? { defaultHeaders: { Authorization: null } } : {})
    })
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'system' as const, content: args.system }, ...messages]
    })
    const text = res.choices[0]?.message?.content ?? ''
    recordUsage(model, promptChars, text.length)
    return { ok: true, text, model }
  } catch (e) {
    const raw = errMessage(e)
    /* A free model that has run out of quota is the likeliest failure for the one provider needing no
       signup, and the provider's own wording ("Rate limit exceeded. Please try again later.") tells
       the user to wait — when the actual fix is to pick a different free model, which works
       immediately. Name that instead of echoing it. */
    if (p.id === 'opencode' && /FreeUsageLimit|rate limit/i.test(raw)) {
      const others = [...OPENCODE_FREE_IDS].filter((m) => m !== model).slice(0, 3).join(', ')
      return {
        ok: false,
        error: `The free model "${model}" is at its usage limit right now. Pick another free model in Settings > AI — ${others} are free too. Nothing is wrong with your setup, and no key is needed.`
      }
    }
    return { ok: false, error: raw }
  }
}
