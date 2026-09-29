import { readFileSync, existsSync } from 'node:fs'
import { join, isAbsolute, resolve, sep } from 'node:path'
import { apiKeyFor, complete, getProvider } from './providers'
import { remotePolicy } from './remote'
import { audit } from './audit'
import type {
  AutocompleteRequest,
  AutocompleteResult,
  EditRequest,
  EditResult,
  InlineEditRequest,
  InlineEditResult
} from '../shared/types'

/**
 * Ask the selected model to apply a plain-English change to the source file
 * behind a clicked element, and return the complete rewritten file. The caller
 * snapshots (undo) and writes the result.
 */
export async function editFile(req: EditRequest): Promise<EditResult> {
  const providerId = req.provider || 'groq'
  const provider = getProvider(providerId)
  if (!provider) return { ok: false, error: `Unknown provider: ${providerId}` }

  const abs = resolve(isAbsolute(req.file) ? req.file : join(req.projectPath, req.file))
  // Confine every AI edit to the opened project — selections can carry absolute
  // paths (React fiber _debugSource), and we never write outside the project.
  const root = resolve(req.projectPath)
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { ok: false, error: 'That element belongs to a file outside the opened project.' }
  }
  if (!existsSync(abs)) return { ok: false, error: `File not found: ${req.file}` }
  const original = readFileSync(abs, 'utf8')

  const system =
    'You are ATOMIC Studio, an AI that edits a single source file for a non-coder. ' +
    'The user pointed at an on-screen element and described a change in plain English. ' +
    'Apply the change directly and minimally. Preserve the file\'s existing style, imports, ' +
    'and formatting. Return ONLY the complete, updated file contents — no explanations, ' +
    'no markdown fences.'

  const user =
    `File: ${req.file}\n` +
    (req.elementName ? `The user clicked a <${req.elementName}> element near line ${req.line}.\n` : '') +
    `Requested change: ${req.instruction}\n\n` +
    `----- CURRENT FILE -----\n${original}\n----- END FILE -----`

  const res = await complete({
    providerId,
    model: req.model,
    apiKey: apiKeyFor(providerId),
    system,
    user
  })
  if (!res.ok) return { ok: false, error: res.error }

  const cleaned = stripFences(res.text ?? '').trim()
  if (!cleaned) return { ok: false, error: 'The model returned an empty result.' }
  if (cleaned === original.trim()) {
    return { ok: false, error: 'No change was produced. Try describing the change differently.' }
  }
  return { ok: true, absolutePath: abs, newContent: cleaned + '\n' }
}

/** Remove a leading/trailing ```lang fence if the model wrapped the file. */
export function stripFences(text: string): string {
  const fence = text.match(/^\s*```[a-zA-Z0-9]*\n([\s\S]*?)\n```\s*$/)
  return fence ? fence[1] : text
}

/**
 * Confidential-mode gate: when a company workspace is connected with
 * `confidential: true`, code from the server may ONLY be sent to providers on
 * the policy's allowlist (e.g. the company's own endpoint or a local model).
 * Violations are audited.
 */
function confidentialBlock(file: string, providerId: string): string | null {
  const policy = remotePolicy()
  if (!file.startsWith('ssh://') || !policy?.confidential) return null
  if (policy.allowedProviders.includes(providerId)) return null
  audit('ai-blocked', `${file} → ${providerId}`)
  return `Company policy: confidential mode allows only ${policy.allowedProviders.join(', ') || 'no'} AI providers for server files.`
}

/**
 * Tab autocomplete: given code around the cursor, return ONLY the insertion.
 * Uses the user's selected provider (Groq/Hub are fast enough for typing).
 * Returns empty text rather than an error when there is nothing sensible —
 * the editor just shows no ghost text.
 */
export async function autocomplete(req: AutocompleteRequest): Promise<AutocompleteResult> {
  const providerId = req.provider || 'atomic'
  if (!getProvider(providerId)) return { ok: false }
  if (confidentialBlock(req.file, providerId)) return { ok: false }
  const apiKey = apiKeyFor(providerId)
  if (getProvider(providerId)?.needsKey && !apiKey) return { ok: false }

  const prefix = req.prefix.slice(-3000)
  const suffix = req.suffix.slice(0, 1000)
  const res = await complete({
    providerId,
    model: req.model,
    apiKey,
    system:
      'You are a code autocomplete engine. Given the code BEFORE the cursor and AFTER the cursor, ' +
      'output ONLY the text to insert at the cursor position. At most 3 lines. No markdown fences, ' +
      'no explanations, no repetition of existing code. If no useful completion exists, output nothing.',
    user: `File: ${req.file}\n<BEFORE>\n${prefix}\n</BEFORE>\n<AFTER>\n${suffix}\n</AFTER>`
  })
  if (!res.ok) return { ok: false }
  const text = stripFences(res.text ?? '').replace(/\s+$/, '')
  return { ok: true, text }
}

/**
 * ⌘K inline edit: rewrite ONLY the selected lines of a file. Returns the
 * replacement snippet — the renderer splices it into the editor buffer as an
 * unsaved change (review, then ⌘S which snapshots), so disk is never touched
 * here and Monaco's own undo covers rejection.
 */
export async function editSelection(req: InlineEditRequest): Promise<InlineEditResult> {
  const providerId = req.provider || 'atomic'
  if (!getProvider(providerId)) return { ok: false, error: `Unknown provider: ${providerId}` }
  if (!req.selectedText.trim()) return { ok: false, error: 'Select some code first.' }
  const blocked = confidentialBlock(req.file, providerId)
  if (blocked) return { ok: false, error: blocked }

  const system =
    'You rewrite ONE selected region of a source file for a non-coder, following their plain-English instruction. ' +
    'Return ONLY the replacement code for the selected region — no explanations, no markdown fences, ' +
    'no surrounding code that was not selected. Preserve the file\'s style and the selection\'s base indentation.'

  const context =
    req.fileContent.length > 24_000
      ? req.fileContent.slice(0, 24_000) + '\n… (file truncated)'
      : req.fileContent

  const user =
    `File: ${req.file}\n\nFULL FILE (context):\n${context}\n\n` +
    `SELECTED REGION (lines ${req.startLine}-${req.endLine}) TO REWRITE:\n${req.selectedText}\n\n` +
    `INSTRUCTION: ${req.instruction}`

  const res = await complete({ providerId, model: req.model, apiKey: apiKeyFor(providerId), system, user })
  if (!res.ok) return { ok: false, error: res.error }
  const replacement = stripFences(res.text ?? '').replace(/\s+$/, '')
  if (!replacement.trim()) return { ok: false, error: 'The model returned an empty result.' }
  return { ok: true, replacement }
}
