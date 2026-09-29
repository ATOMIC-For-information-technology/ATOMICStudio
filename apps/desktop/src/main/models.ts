import { execStream, type RunHandle } from './terminal'
import { homedir, totalmem } from 'node:os'
import { platform } from 'node:process'
import { binOverride } from './util'
import type { CatalogModel, LogLine, ModelCatalog, ModelCatalogEntry, OllamaState } from '../shared/types'

/**
 * Air-gapped local model catalog — a curated list of recommended on-device
 * models (for Ollama, the local provider) plus which are actually installed,
 * so an air-gapped user knows what they can run and how to get more. Read-only:
 * `pullCommand` is a copy-paste string, this module never installs anything.
 * Shells the user's own `ollama` CLI; STUDIO_OLLAMA_BIN overrides it for tests.
 * Degrades to "unavailable, nothing installed" (never throws) when ollama is
 * missing or its daemon is down.
 */

const OLLAMA = (): string => binOverride('STUDIO_OLLAMA_BIN', 'ollama')

// qwen2.5-coder first — kept in sync with providers.ts ollama defaultModel.
// `needsGb` is the working set the model actually wants resident, which is more than the download:
// weights + KV cache + the OS's own needs. Used only to warn, never to block.
const RECOMMENDED: (CatalogModel & { needsGb: number })[] = [
  { name: 'qwen2.5-coder', size: '~4.7 GB', useCase: 'Coding — the default local model', needsGb: 8 },
  { name: 'llama3.1', size: '~4.9 GB', useCase: 'General-purpose assistant', needsGb: 8 },
  { name: 'deepseek-coder-v2', size: '~8.9 GB', useCase: 'Larger coding model', needsGb: 16 },
  { name: 'phi3', size: '~2.2 GB', useCase: 'Small & fast, low-RAM machines', needsGb: 4 },
  { name: 'mistral', size: '~4.1 GB', useCase: 'Balanced general model', needsGb: 8 },
  { name: 'nomic-embed-text', size: '~274 MB', useCase: 'Embeddings / local search', needsGb: 2 }
]

/** How to get Ollama, per platform — shown as a copyable command, never run for the user. */
const INSTALL_HINT: { command: string; url: string } =
  platform === 'darwin'
    ? { command: 'brew install ollama', url: 'https://ollama.com/download' }
    : platform === 'win32'
      ? { command: 'winget install Ollama.Ollama', url: 'https://ollama.com/download' }
      : { command: 'curl -fsSL https://ollama.com/install.sh | sh', url: 'https://ollama.com/download' }

/** Is the `ollama` binary on PATH at all? */
async function ollamaInstalled(): Promise<boolean> {
  try {
    const res = await execStream(`${OLLAMA()} --version`, homedir(), () => {}, 10_000).done
    return res.code === 0
  } catch {
    return false
  }
}

/**
 * Installed model names from `ollama list` (header row skipped).
 *
 * `ok` distinguishes the two failures that look identical from the outside but need opposite
 * answers from us: the binary is missing (install it) versus the binary is there and its daemon
 * isn't running (start it). Returning [] for both was why "Ollama not detected" showed for a
 * perfectly good install whose server happened to be down.
 */
async function installedModels(): Promise<{ ok: boolean; names: string[] }> {
  try {
    const res = await execStream(`${OLLAMA()} list`, homedir(), () => {}, 10_000).done
    if (res.code !== 0) return { ok: false, names: [] }
    return {
      ok: true,
      names: res.output
        .split('\n')
        .slice(1) // drop the "NAME  ID  SIZE  MODIFIED" header
        .map((l) => l.trim().split(/\s+/)[0])
        .filter(Boolean)
    }
  } catch {
    return { ok: false, names: [] }
  }
}

const totalGb = (): number => Math.round(totalmem() / 1024 ** 3)

export async function modelCatalog(): Promise<ModelCatalog> {
  const installedBin = await ollamaInstalled()
  const list = installedBin ? await installedModels() : { ok: false, names: [] }
  const available = installedBin && list.ok
  const ram = totalGb()

  const isInstalled = (name: string): boolean => list.names.some((n) => n === name || n.startsWith(name + ':'))

  const models: ModelCatalogEntry[] = RECOMMENDED.map((m) => ({
    name: m.name,
    size: m.size,
    useCase: m.useCase,
    installed: isInstalled(m.name),
    pullCommand: `ollama pull ${m.name}`,
    // A warning, not a verdict: the user's machine is theirs to judge. Only claimed when we
    // actually know the RAM (totalmem is always available, so this is honest either way).
    fitsMemory: ram >= m.needsGb,
    needsGb: m.needsGb
  }))

  // Anything the user pulled themselves. The provider will happily run these — they were simply
  // invisible here, which made the curated six look like the only options that exist.
  const curated = new Set(RECOMMENDED.map((m) => m.name))
  const others: ModelCatalogEntry[] = list.names
    .filter((n) => !curated.has(n.split(':')[0]))
    .map((n) => ({
      name: n,
      size: '',
      useCase: 'Installed on this machine',
      installed: true,
      pullCommand: `ollama pull ${n}`,
      fitsMemory: true,
      needsGb: 0
    }))

  return {
    available,
    state: !installedBin ? 'not-installed' : list.ok ? 'ready' : 'stopped',
    install: INSTALL_HINT,
    totalMemoryGb: ram,
    models,
    others
  }
}

/**
 * Start Ollama's local server (`ollama serve`) when the binary is present but its daemon isn't.
 * Detached and unwaited on purpose: `serve` runs until it's stopped, so awaiting it would hang.
 * We give it a moment, then re-probe and report the real state rather than claiming success.
 */
export async function startOllama(): Promise<OllamaState> {
  if (!(await ollamaInstalled())) return 'not-installed'
  execStream(`${OLLAMA()} serve`, homedir(), () => {}, 60_000)
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if ((await installedModels()).ok) return 'ready'
  }
  return 'stopped'
}

/**
 * Stream `ollama pull <name>` (the model download). The name MUST be one of the
 * curated RECOMMENDED entries — that whitelist is the injection guard, since
 * execStream runs under a shell. Runs in HOME with a 45-min timeout (multi-GB
 * pulls take a while — never the default 3-min).
 */
export function pullModel(name: string, onLine: (l: LogLine) => void): RunHandle {
  if (!RECOMMENDED.some((m) => m.name === name)) {
    onLine({ stream: 'system', text: `Unknown model "${name}" — refusing to pull.`, ts: Date.now() })
    return { done: Promise.resolve({ code: null, output: '', timedOut: false, error: 'unknown model', truncated: false }), kill() {} }
  }
  return execStream(`${OLLAMA()} pull ${name}`, homedir(), onLine, 45 * 60_000)
}
