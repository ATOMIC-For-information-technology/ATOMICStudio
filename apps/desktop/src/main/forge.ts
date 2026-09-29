import type { ForgeRepo, ForgeUser } from '../shared/types'

/**
 * A source of repositories to clone from and push to.
 *
 * The point of this interface is what it does NOT contain: no clone, no push, no
 * pull. Those live in git-core and take a plain URL, so they never learn which
 * forge produced it. A forge only answers "who am I signed in as, what repos can
 * I see, and what URL clones this one" — everything after that is git's job.
 *
 * `kind` is not decoration: the renderer uses it to keep the self-hosted option
 * visible in air-gapped/enterprise-managed setups where cloud forges are policy-
 * blocked, rather than showing a control that cannot work.
 */
export interface Forge {
  id: string
  name: string
  kind: 'cloud' | 'self-hosted'
  signedIn(): Promise<boolean>
  user(): Promise<ForgeUser | null>
  repos(): Promise<ForgeRepo[]>
  cloneUrl(repo: ForgeRepo): string
}
