import { apiKeyFor, complete, getProvider } from './providers'
import { insightSummary, projectInsight } from './index-service'
import { audit } from './audit'
import type { ProjectInsight } from '../shared/types'

/**
 * Wave 1 AI features — all thin wrappers over the shared `complete()` layer, so
 * they work on every provider (incl. the free ATOMIC Hub) and add no new
 * dependencies. Nothing here writes to disk; each returns text for the UI.
 */

async function ask(providerId: string, model: string | undefined, system: string, user: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const p = providerId || 'atomic'
  if (!getProvider(p)) return { ok: false, error: `Unknown provider: ${p}` }
  const res = await complete({ providerId: p, model, apiKey: apiKeyFor(p), system, user })
  return res.ok ? { ok: true, text: res.text } : { ok: false, error: res.error }
}

// ---------------------------------------------------------------- Project Explainer

export async function explainProject(root: string, providerId: string, model?: string): Promise<{ ok: boolean; text?: string; insight?: ProjectInsight; error?: string }> {
  const facts = insightSummary(root)
  const insight = projectInsight(root)
  const res = await ask(
    providerId,
    model,
    'You are a senior engineer onboarding a NON-CODER to their own project. From the facts, write a short, plain-English explanation: what this project is, the main parts, how to run it, and the top 3 things worth cleaning up. No jargon, no code. Use short headed sections.',
    `PROJECT FACTS:\n${facts}`
  )
  audit('explain-project', root)
  return { ...res, insight }
}

// ---------------------------------------------------------------- Git Supercharge

export type GitDraftKind = 'commit' | 'pr' | 'release'

export async function draftGitText(kind: GitDraftKind, diff: string, providerId: string, model?: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const clipped = diff.length > 12_000 ? diff.slice(0, 12_000) + '\n… (diff truncated)' : diff
  const system =
    kind === 'commit'
      ? 'Write ONE concise conventional-commit message (a subject line under 72 chars, optionally a short body) describing the change. Return only the message.'
      : kind === 'pr'
        ? 'Write a pull-request description: a one-line summary, a short "What changed" bullet list, and a "Why" line. Plain English. Return only the description.'
        : 'Write friendly release notes for this change: a title and a short bullet list a non-technical user would understand. Return only the notes.'
  if (!clipped.trim()) return { ok: false, error: 'No staged/working changes to describe.' }
  const res = await ask(providerId, model, system, `CHANGES (git diff):\n${clipped}`)
  audit('git-draft', kind)
  return res
}

// ---------------------------------------------------------------- Smart Terminal

export async function explainOutput(output: string, providerId: string, model?: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const clipped = output.length > 8_000 ? output.slice(-8_000) : output
  if (!clipped.trim()) return { ok: false, error: 'Nothing in the terminal to explain yet.' }
  const res = await ask(
    providerId,
    model,
    'You explain terminal output to a NON-CODER. In plain English: what happened, whether it succeeded or failed, the root cause of any error, and the single most likely fix (as a command or a one-line instruction). Be concise. No jargon dumps.',
    `TERMINAL OUTPUT:\n${clipped}`
  )
  audit('explain-output', '')
  return res
}

