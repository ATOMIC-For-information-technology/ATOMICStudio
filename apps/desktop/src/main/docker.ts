import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execStream } from './terminal'
import { binOverride } from './util'
import type { LogLine } from '../shared/types'

/**
 * Docker integration v1: detect a compose file in the project and drive the
 * common lifecycle (up/down/ps) through the user's own docker CLI, streamed
 * into the Terminal panel. Degrades gracefully when docker isn't installed.
 *
 * STUDIO_DOCKER_BIN overrides the binary so tests run against a local fake.
 */

const DOCKER = (): string => binOverride('STUDIO_DOCKER_BIN', 'docker')

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

export function composeFile(projectPath: string): string | null {
  for (const f of COMPOSE_FILES) if (existsSync(join(projectPath, f))) return f
  return null
}

export async function dockerAvailable(): Promise<boolean> {
  const res = await execStream(`${DOCKER()} --version`, homedir(), () => {}, 10_000).done
  return res.code === 0
}

export type ComposeAction = 'up' | 'down' | 'ps'

/** Run a compose action in the project, streaming output lines to the caller. */
export async function composeRun(
  projectPath: string,
  action: ComposeAction,
  onLine: (line: LogLine) => void
): Promise<{ ok: boolean; output: string }> {
  if (!composeFile(projectPath)) return { ok: false, output: 'No docker-compose file in this project.' }
  if (!(await dockerAvailable())) {
    return { ok: false, output: 'Docker is not installed (or not on PATH). Install Docker Desktop and try again.' }
  }
  const args = action === 'up' ? 'compose up -d' : action === 'down' ? 'compose down' : 'compose ps'
  const res = await execStream(`${DOCKER()} ${args}`, projectPath, onLine, 300_000).done
  return { ok: res.code === 0, output: res.output.slice(-8_000) }
}
