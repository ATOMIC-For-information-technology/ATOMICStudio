/**
 * Workflow engine — run a DAG of AI steps, combining models.
 *
 * Ports the ATOMIC AI Hub's workflow.py (sequential chaining + inject_from +
 * stop_on_error) AND implements the `parallel` behaviour that was declared but
 * unimplemented there: steps whose dependencies are all satisfied run
 * concurrently. Each step can target a specific provider/model, or leave it to
 * tier-based routing (a port of router.py). Pure module — no Electron — so the
 * caller injects the `complete` function (real provider layer, or a stub in tests).
 */

import { errMessage } from './util'

export type Tier = 'reason' | 'fast' | 'vision' | 'local' | 'auto'

export interface WorkflowStep {
  id: string
  prompt: string
  system?: string
  provider?: string
  model?: string
  tier?: Tier
  dependsOn?: string[]
  injectFrom?: string[]
}

export interface Workflow {
  name: string
  steps: WorkflowStep[]
  stopOnError?: boolean
}

export interface StepResult {
  id: string
  ok: boolean
  text?: string
  error?: string
  provider: string
  model?: string
}

export type CompleteFn = (args: {
  providerId: string
  model?: string
  system: string
  user: string
}) => Promise<{ ok: boolean; text?: string; error?: string }>

export interface RunContext {
  complete: CompleteFn
  /** Map a step (its tier/provider hints) to a concrete provider+model. */
  resolveProvider: (step: WorkflowStep) => { providerId: string; model?: string }
  /** Named inputs available to prompts via {{input}} placeholders. */
  inputs?: Record<string, string>
  onStep?: (result: StepResult) => void
}

export interface WorkflowRun {
  ok: boolean
  results: Record<string, StepResult>
  order: string[]
}

const DEFAULT_SYSTEM = 'You are a helpful assistant working as one step in a larger workflow.'

/** Validate the DAG (unique ids, known deps, no cycles). Throws on error. */
function validate(wf: Workflow): void {
  const ids = new Set<string>()
  for (const s of wf.steps) {
    if (ids.has(s.id)) throw new Error(`Duplicate step id: ${s.id}`)
    ids.add(s.id)
  }
  for (const s of wf.steps) {
    for (const d of s.dependsOn ?? []) {
      if (!ids.has(d)) throw new Error(`Step ${s.id} depends on unknown step ${d}`)
    }
  }
  // Cycle detection via DFS.
  const state = new Map<string, 0 | 1 | 2>() // 0=unseen 1=active 2=done
  const byId = new Map(wf.steps.map((s) => [s.id, s]))
  const visit = (id: string): void => {
    const st = state.get(id) ?? 0
    if (st === 2) return
    if (st === 1) throw new Error(`Cycle detected at step ${id}`)
    state.set(id, 1)
    for (const d of byId.get(id)!.dependsOn ?? []) visit(d)
    state.set(id, 2)
  }
  for (const s of wf.steps) visit(s.id)
}

/** Substitute {{id}} placeholders with prior step outputs and named inputs. */
function buildPrompt(step: WorkflowStep, results: Record<string, StepResult>, inputs: Record<string, string>): string {
  let prompt = step.prompt
  const all: Record<string, string> = { ...inputs }
  for (const [id, r] of Object.entries(results)) all[id] = r.text ?? ''
  prompt = prompt.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key) => all[key] ?? '')

  // injectFrom: prepend the named steps' outputs as context.
  const inject = (step.injectFrom ?? [])
    .map((id) => (results[id]?.text ? `--- Output of "${id}" ---\n${results[id].text}\n` : ''))
    .join('\n')
  return inject ? `${inject}\n${prompt}` : prompt
}

export async function runWorkflow(wf: Workflow, ctx: RunContext): Promise<WorkflowRun> {
  validate(wf)
  const inputs = ctx.inputs ?? {}
  const results: Record<string, StepResult> = {}
  const order: string[] = []
  const byId = new Map(wf.steps.map((s) => [s.id, s]))
  const done = new Set<string>()
  const failed = new Set<string>()
  let aborted = false

  const ready = (): WorkflowStep[] =>
    wf.steps.filter(
      (s) => !done.has(s.id) && !failed.has(s.id) && (s.dependsOn ?? []).every((d) => done.has(d))
    )

  while (!aborted) {
    const batch = ready()
    if (batch.length === 0) break

    // Run this wave concurrently (the "parallel" behaviour).
    await Promise.all(
      batch.map(async (step) => {
        const { providerId, model } = ctx.resolveProvider(step)
        const user = buildPrompt(step, results, inputs)
        let res: StepResult
        try {
          const out = await ctx.complete({ providerId, model, system: step.system ?? DEFAULT_SYSTEM, user })
          res = { id: step.id, ok: out.ok, text: out.text, error: out.error, provider: providerId, model }
        } catch (e) {
          res = { id: step.id, ok: false, error: errMessage(e), provider: providerId, model }
        }
        results[step.id] = res
        order.push(step.id)
        ctx.onStep?.(res)
        if (res.ok) done.add(step.id)
        else {
          failed.add(step.id)
          if (wf.stopOnError !== false) aborted = true
        }
      })
    )
  }

  // Steps still blocked (unmet deps due to a failure) are left out of results.
  const ok = wf.steps.every((s) => results[s.id]?.ok)
  return { ok, results, order }
}
