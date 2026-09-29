import type { WorkflowStep } from './workflow-engine'
import { getProvider } from './providers'

/**
 * Tier-based routing — a port of the ATOMIC Hub's router.py idea, made
 * model-agnostic over Studio's providers. A step can pin an explicit
 * provider/model; otherwise its `tier` chooses one, defaulting to the free
 * ATOMIC Hub (Groq) for general work.
 */
const TIER_PROVIDER: Record<string, string> = {
  reason: 'anthropic', // deep reasoning → Claude
  fast: 'groq', // quick work → Groq
  vision: 'gemini', // images → Gemini
  local: 'ollama', // privacy/offline → local
  auto: 'atomic' // default → free ATOMIC Hub (Groq)
}

export function resolveProvider(step: WorkflowStep): { providerId: string; model?: string } {
  if (step.provider) return { providerId: step.provider, model: step.model }
  const providerId = TIER_PROVIDER[step.tier ?? 'auto'] ?? 'atomic'
  const model = step.model ?? getProvider(providerId)?.defaultModel
  return { providerId, model }
}
