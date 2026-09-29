import type { Workflow } from './workflow-engine'

/**
 * Preset "goals" — named multi-model workflows a non-coder can run with one
 * click. The final step's id is always `finalize` and it must return the
 * complete updated file (which the caller writes).
 */
export function polishWorkflow(file: string, instruction: string, elementName: string | undefined, original: string): Workflow {
  const where = elementName ? ` (the user clicked a <${elementName}> element)` : ''
  return {
    name: 'Polish with 2 models',
    stopOnError: true,
    steps: [
      {
        id: 'draft',
        tier: 'fast', // Groq — quick, concrete proposal
        system: 'You are a senior UI engineer. Propose a concrete, specific improvement in a few bullet points. Do not write the full file.',
        prompt: `File: ${file}${where}\nGoal: ${instruction}\n\nCURRENT FILE:\n${original}`
      },
      {
        id: 'finalize',
        tier: 'reason', // Claude — careful full-file rewrite
        dependsOn: ['draft'],
        injectFrom: ['draft'],
        system:
          'You apply an approved improvement to a source file for a non-coder. ' +
          'Preserve style, imports and formatting. Return ONLY the complete updated file — no explanations, no markdown fences.',
        prompt: `Apply the proposed improvement to accomplish: ${instruction}\n\nCURRENT FILE:\n${original}`
      }
    ]
  }
}
