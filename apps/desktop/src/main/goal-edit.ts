import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { snapshot, canUndo } from './undo'
import { apiKeyFor, complete } from './providers'
import { stripFences } from './ai-edit'
import { runWorkflow } from './workflow-engine'
import { resolveProvider } from './routing'
import { polishWorkflow } from './goals'
import type { GoalEditRequest, GoalEditResult } from '../shared/types'

/**
 * Run the multi-model "goal" workflow that edits a file (Groq drafts → Claude
 * finalizes, per polishWorkflow), then snapshot + write the finalized file.
 * Extracted from the IPC handler so registerIpc stays thin and this flow is
 * unit-testable. Pure over its `req`; closes over no window/process state.
 */
export async function runGoalEdit(req: GoalEditRequest): Promise<GoalEditResult> {
  const abs = isAbsolute(req.file) ? req.file : join(req.projectPath, req.file)
  if (!existsSync(abs)) return { ok: false, error: `File not found: ${req.file}`, canUndo: canUndo(), steps: [] }
  const original = readFileSync(abs, 'utf8')

  const wf = polishWorkflow(req.file, req.instruction, req.elementName, original)
  const run = await runWorkflow(wf, {
    resolveProvider,
    complete: async ({ providerId, model, system, user }) =>
      complete({ providerId, model, apiKey: apiKeyFor(providerId), system, user })
  })

  const steps = run.order.map((id) => ({
    id,
    provider: run.results[id].provider,
    model: run.results[id].model,
    ok: run.results[id].ok
  }))

  const final = run.results.finalize
  if (!run.ok || !final?.ok || !final.text) {
    const err = Object.values(run.results).find((r) => !r.ok)?.error
    return { ok: false, error: err ?? 'The workflow did not complete.', canUndo: canUndo(), steps }
  }
  const content = stripFences(final.text).trim()
  if (!content || content === original.trim()) {
    return { ok: false, error: 'No change was produced.', canUndo: canUndo(), steps }
  }
  snapshot(abs, `goal: ${req.instruction} (${req.file})`)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content + '\n', 'utf8')
  return { ok: true, file: req.file, canUndo: canUndo(), steps }
}
