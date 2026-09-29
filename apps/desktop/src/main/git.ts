/**
 * Barrel for the git subsystem.
 *
 * This file used to be 491 lines of two different modules wearing one filename:
 * a GitHub REST client and a pile of host-agnostic porcelain. Splitting them is
 * what makes a self-hosted server possible at all — clone/push/pull now take a
 * plain URL and have no idea whether it points at GitHub or at a bare repo on the
 * team's own box.
 *
 *   git-exec.ts      the one place that runs `git`, plus the shell-safety rules
 *   git-core.ts      host-agnostic porcelain (status, staging, branches, merge)
 *   git-history.ts   paged log, searched and followed, over the argv runner
 *   git-snapshot.ts  the one-process hot status, exact per-row diffs, cold-data cache stamps
 *   git-insight.ts   read-only history folds for the Project Brain
 *   forge.ts         what a "place to get repos from" has to provide
 *   forge-github.ts  GitHub, as one forge among several
 *   forge-gitlab.ts  GitLab, hosted or a company's own, over one v4 client
 *   forge-atomic.ts  the self-hosted ATOMIC server, over stock sshd
 *
 * The barrel stays so that every existing import site — 13 ipcMain.handle
 * registrations among them — keeps working untouched.
 */

export * from './git-exec'
export * from './git-core'
export * from './git-history'
export * from './git-snapshot'
export * from './git-insight'
export * from './forge'
export * from './forge-github'
export * from './forge-gitlab'
export * from './forge-atomic'

import { githubForge } from './forge-github'
import { gitlabForge, gitlabHost } from './forge-gitlab'
import { atomicForge } from './forge-atomic'
import type { Forge } from './forge'
import { registerCredentialSource } from './git-exec'

/**
 * Every forge Studio knows about. Order is display order, and self-hosted comes
 * first on purpose: this product's wedge is that your code does not have to leave
 * your building, so the option that honours that should not be the second one.
 */
export const FORGES: Forge[] = [atomicForge, githubForge, gitlabForge]

export function forgeById(id: string): Forge | undefined {
  return FORGES.find((f) => f.id === id)
}

/**
 * Which host each token-authenticated forge lives on, so `git-exec`'s askpass bridge can hand a
 * push the credential for the server it is actually talking to rather than the only one it knew.
 *
 * Registered HERE, in the barrel, rather than as a side effect at the bottom of each forge module.
 * Both are correct at runtime; only this one is correct when something imports a single forge
 * directly — as the headless agent suite does, from an explicit module list. A credential that
 * appears only when an unrelated file happens to be imported is a bug that reproduces nowhere.
 *
 * `atomicForge` is deliberately ABSENT: its data plane is stock sshd, so it authenticates with an
 * SSH certificate or key and has no token to route. Adding it here would create a place for one.
 */
registerCredentialSource({ forgeId: 'github', host: () => 'github.com' })
registerCredentialSource({ forgeId: 'gitlab', host: gitlabHost })
