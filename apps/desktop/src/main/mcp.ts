import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getAirGap } from './policy'
import { audit } from './audit'
import type { ConnectorInfo, ConnectorTool, McpCallResult } from '../shared/types'

/**
 * MCP connectors — the extension mechanism.
 *
 * An MCP server is just a process that exposes tools over stdio, so this buys a real ecosystem
 * (Postgres, GitHub, Slack, Figma, Puppeteer, filesystem…) without inventing an extension API that
 * only we would ever implement.
 *
 * The safety model is deliberately the one this app already uses everywhere else, not a new one:
 *  - a connector is INERT until the user enables it, and its tool list is shown before that;
 *  - the FIRST use of each tool asks, then is remembered — the staged-diff approval pattern applied
 *    to tools rather than to file writes;
 *  - every call is written to the audit log;
 *  - Air-Gapped Mode disables all of it, and an MDM-forced air-gap cannot be lifted from here.
 *
 * Lifecycle mirrors `pty.ts`: spawn lazily, keep a handle, kill everything on quit — a stranded
 * child process is invisible and keeps the app alive.
 */

// The SDK is CJS and its transport spawns a child, so it is required lazily and defensively: a
// broken install must degrade to "connectors unavailable", never take the app down at import time.
type McpClient = {
  connect: (t: unknown) => Promise<void>
  close: () => Promise<void>
  listTools: () => Promise<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }>
  callTool: (a: { name: string; arguments?: Record<string, unknown> }) => Promise<{
    content?: { type: string; text?: string }[]
    isError?: boolean
  }>
}

let sdkError: string | null = null
function sdk(): { Client: new (i: unknown, o: unknown) => McpClient; StdioClientTransport: new (o: unknown) => unknown } | null {
  try {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
    /* eslint-enable @typescript-eslint/no-var-requires */
    return { Client, StdioClientTransport }
  } catch (e) {
    sdkError = e instanceof Error ? e.message : String(e)
    return null
  }
}

export interface ConnectorConfig {
  id: string
  name: string
  /** Executable to spawn (e.g. `npx`), plus its args — an MCP server is always a child process. */
  command: string
  args: string[]
  /** Non-secret env only. Anything secret belongs in the keychain via keyvault.ts. */
  env?: Record<string, string>
  enabled: boolean
  /** Tools the user has already approved, by bare tool name. */
  approvedTools: string[]
  /** Where it came from, so the panel can be honest about provenance. */
  source?: 'folder' | 'github' | 'registry' | 'manual'
}

interface Live {
  client: McpClient
  tools: ConnectorTool[]
}

const live = new Map<string, Live>()

function configPath(): string {
  return join(app.getPath('userData'), 'connectors.json')
}

/** Never throws: a hand-edited or truncated file must degrade to "no connectors", like policy.ts. */
export function readConfig(): ConnectorConfig[] {
  try {
    const p = configPath()
    if (!existsSync(p)) return []
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (c): c is ConnectorConfig =>
        !!c && typeof (c as ConnectorConfig).id === 'string' && typeof (c as ConnectorConfig).command === 'string'
    )
  } catch {
    return []
  }
}

export function writeConfig(list: ConnectorConfig[]): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(list, null, 2), 'utf8')
}

export function upsert(cfg: ConnectorConfig): void {
  const list = readConfig()
  const i = list.findIndex((c) => c.id === cfg.id)
  if (i >= 0) list[i] = cfg
  else list.push(cfg)
  writeConfig(list)
}

export async function remove(id: string): Promise<void> {
  // Config first: killing the process can take a moment, and callers (uninstall) check the registry
  // straight after. The persisted state is what "removed" means.
  writeConfig(readConfig().filter((c) => c.id !== id))
  audit('connector.removed', id)
  await stop(id)
}

/** Start a connector and read its tool list. Returns an error string instead of throwing. */
export async function start(id: string): Promise<{ ok: boolean; tools?: ConnectorTool[]; error?: string }> {
  if (getAirGap()) return { ok: false, error: 'Air-Gapped Mode is on — connectors are disabled.' }
  const existing = live.get(id)
  if (existing) return { ok: true, tools: existing.tools }

  const cfg = readConfig().find((c) => c.id === id)
  if (!cfg) return { ok: false, error: `No connector "${id}".` }
  const mod = sdk()
  if (!mod) return { ok: false, error: `Connectors unavailable: ${sdkError ?? 'MCP SDK failed to load'}` }

  try {
    const transport = new mod.StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) }
    })
    const client = new mod.Client({ name: 'atomic-studio', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
    const listed = await client.listTools()
    const tools: ConnectorTool[] = (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      approved: cfg.approvedTools.includes(t.name)
    }))
    live.set(id, { client, tools })
    audit('connector.started', `${id} (${tools.length} tools)`)
    return { ok: true, tools }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    audit('connector.failed', `${id}: ${error}`)
    return { ok: false, error }
  }
}

export async function stop(id: string): Promise<void> {
  const l = live.get(id)
  if (!l) return
  live.delete(id)
  try {
    await l.client.close()
  } catch {
    /* already gone */
  }
}

export async function stopAll(): Promise<void> {
  await Promise.all([...live.keys()].map((id) => stop(id)))
}

/** What the panel renders: config + live state + tool list, with nothing invented. */
export async function list(): Promise<ConnectorInfo[]> {
  const airGapped = getAirGap()
  return readConfig().map((c) => {
    const l = live.get(c.id)
    return {
      id: c.id,
      name: c.name,
      command: [c.command, ...c.args].join(' '),
      enabled: c.enabled && !airGapped,
      running: !!l,
      blockedByAirGap: airGapped && c.enabled,
      source: c.source ?? 'manual',
      tools: l ? l.tools : [],
      approvedTools: c.approvedTools
    }
  })
}

export async function setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; tools?: ConnectorTool[]; error?: string }> {
  const list = readConfig()
  const cfg = list.find((c) => c.id === id)
  if (!cfg) return { ok: false, error: `No connector "${id}".` }
  cfg.enabled = enabled
  writeConfig(list)
  audit('connector.enabled', `${id}=${enabled}`)
  if (!enabled) {
    await stop(id)
    return { ok: true, tools: [] }
  }
  return start(id)
}

/** Approve (or revoke) one tool. Approval is per tool, never "trust this whole server". */
export function setToolApproved(id: string, tool: string, approved: boolean): void {
  const list = readConfig()
  const cfg = list.find((c) => c.id === id)
  if (!cfg) return
  const set = new Set(cfg.approvedTools)
  if (approved) set.add(tool)
  else set.delete(tool)
  cfg.approvedTools = [...set]
  writeConfig(list)
  const l = live.get(id)
  if (l) l.tools = l.tools.map((t) => (t.name === tool ? { ...t, approved } : t))
  audit('connector.tool-approval', `${id}.${tool}=${approved}`)
}

/**
 * Every enabled+approved tool, flattened for the agent's system prompt.
 * Only APPROVED tools are exposed: each one costs prompt tokens on every single turn, so an
 * un-capped list would quietly degrade the agent while raising its cost.
 */
export async function agentTools(): Promise<{ id: string; tool: ConnectorTool }[]> {
  if (getAirGap()) return []
  const out: { id: string; tool: ConnectorTool }[] = []
  for (const cfg of readConfig()) {
    if (!cfg.enabled) continue
    const l = live.get(cfg.id)
    if (!l) {
      /* Deliberately NOT awaited. This runs at the top of every agent turn, and a connector whose
         server is slow (or hung) would otherwise stall the run itself — a broken connector must
         never be able to hold the agent hostage. Start it in the background; its tools appear on
         the next turn, and the tool call itself starts it on demand anyway. */
      void start(cfg.id)
      continue
    }
    for (const t of l.tools) if (cfg.approvedTools.includes(t.name)) out.push({ id: cfg.id, tool: t })
  }
  return out
}

/**
 * Call a tool on behalf of the agent.
 *
 * Refuses anything not explicitly approved. That refusal is the whole safety story for connectors —
 * an MCP server can expose a tool that deletes a database, and "the model decided to" is not consent.
 */
export async function callTool(id: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
  if (getAirGap()) return { ok: false, error: 'Air-Gapped Mode is on — connectors are disabled.' }
  const cfg = readConfig().find((c) => c.id === id)
  if (!cfg || !cfg.enabled) return { ok: false, error: `Connector "${id}" is not enabled.` }
  if (!cfg.approvedTools.includes(tool)) {
    audit('connector.refused', `${id}.${tool} (not approved)`)
    return { ok: false, error: `Tool "${tool}" has not been approved. Approve it in Extensions → Connectors first.` }
  }
  const started = live.get(id) ? { ok: true } : await start(id)
  if (!started.ok) return { ok: false, error: started.error ?? 'connector failed to start' }
  const l = live.get(id)
  if (!l) return { ok: false, error: 'connector failed to start' }

  try {
    const res = await l.client.callTool({ name: tool, arguments: args })
    const text = (res.content ?? [])
      .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`))
      .join('\n')
      .slice(0, 20_000) // same capture ceiling the command runner uses
    audit('connector.call', `${id}.${tool}`)
    return { ok: !res.isError, text, error: res.isError ? text : undefined }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    audit('connector.call-failed', `${id}.${tool}: ${error}`)
    return { ok: false, error }
  }
}
