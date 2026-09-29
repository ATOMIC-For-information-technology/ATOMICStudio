/**
 * Roles — who may do what, in the air-gapped enterprise deployment.
 *
 * This module is to ROLES what `mode.ts` is to MODES, deliberately. It is PURE (no electron,
 * no DOM, no IO) so the same table is read by the renderer (what to show), by
 * `main/menu.ts` (so a hidden surface keeps no menu item, palette action or accelerator),
 * and mirrored server-side by `server/atomic-git-acl.mjs` and `server/hooks/pre-receive.mjs`.
 *
 * Three rules the table obeys:
 *
 *  1. **The client copy is a MIRROR, never the authority.** Every capability below is also
 *     enforced on the server and refused there regardless of what this table allowed. A
 *     renderer that lies about its role changes what the user SEES and nothing else. A
 *     capability checked ONLY here is a bug, not an optimisation — say so in review.
 *
 *  2. **Nothing hidden is left reachable.** The rule `mode.ts` already obeys. `menu.ts`
 *     filters through `roleAllowed` alongside `commandAllowed`, so a role-hidden surface
 *     loses its menu entry, its palette action and its shortcut together.
 *
 *  3. **Signed out is not a role.** `null` means no valid certificate, and that means no
 *     capability at all — not "the weakest role". Least privilege is the ABSENCE of a grant,
 *     never a small grant. This is why every function here takes `Role | null`.
 *
 * WHY A MATRIX AND NOT A HIDDEN-COMMAND LIST (the shape differs from `mode.ts` on purpose):
 * `mode.ts` has two modes and one flat `BUILDER_HIDDEN_COMMANDS` list, which is exactly right
 * for a binary. Roles are a 4 x N matrix, and four hand-maintained lists would drift the first
 * time someone adds a command. Instead each gated command declares WHICH CAPABILITY it needs
 * (`COMMAND_CAPABILITY`), and `roleAllowed` answers from the matrix. Adding a command that
 * needs gating is then one entry, and it cannot be granted to one role and forgotten for
 * another.
 */

export type Role = 'admin' | 'manager' | 'lead' | 'dev'

/** Every role, most privileged first. Useful for admin pickers and for tests that must cover all. */
export const ROLES: readonly Role[] = ['admin', 'manager', 'lead', 'dev']

/**
 * How far a capability reaches. Some grants are not yes/no: a manager manages members across
 * the COMPANY while a lead manages them only on projects they lead. That was a `boolean` in the
 * first draft of this file and it was a latent security bug — one flag meaning "everyone" for
 * one role and "mine only" for another is how an over-broad grant reaches production without
 * anyone reading a diff that looks wrong. Scope is in the type so the server cannot mistake it.
 */
export type Scope = 'all' | 'own' | 'none'

/**
 * Who the current seat is. `null` = signed out / certificate expired.
 * `expiresAt` is epoch ms and mirrors the SSH certificate's own validity, so the UI can warn
 * before a push starts failing rather than after.
 */
export interface Identity {
  user: string
  display: string
  role: Role
  expiresAt: number
}

export function normalizeRole(raw: unknown): Role | null {
  return raw === 'admin' || raw === 'manager' || raw === 'lead' || raw === 'dev' ? raw : null
}

/**
 * The gated actions. Named for what the USER does, not for the endpoint that implements it,
 * because this same vocabulary appears in the audit trail and an auditor reads it.
 */
export interface RoleCapabilities {
  /** Open and read a repo they are a member of. */
  readCode: boolean
  /** Push to an unprotected branch of a repo they are a member of. */
  pushCode: boolean
  /** Push directly to a protected branch (`main`). */
  pushProtected: boolean
  /**
   * Rewrite the history of a PROTECTED branch (`main`/`master`). The precision matters: this is
   * NOT a ban on `push --force` everywhere. Rebasing a personal feature branch is ordinary work
   * and blocking it would be a tax with no security return, so `pre-receive.mjs` enforces
   * fast-forward-only on protected refs and leaves other branches alone. Naming this `forcePush`
   * without that qualification was the first draft's wording and it overstated what is enforced.
   *
   * FALSE for every role, including admin — kept as a row rather than hardcoded so that granting
   * it later is a reviewable one-line POLICY change, not a code change that slips through as a
   * refactor. `pre-receive.mjs` refuses it independently of anything decided here.
   */
  forcePush: boolean
  createRepo: boolean
  deleteRepo: boolean
  /** Sign off a merge into a protected branch. */
  approveMerge: boolean
  /** Add/remove people and assign roles. `'own'` = only on projects this person leads. */
  manageMembers: Scope
  /** Edit enterprise policy (allowed providers, export blocking, air-gap flag). */
  managePolicy: boolean
  readAuditLog: boolean
  /** See the UNFILTERED repo catalog. Without this, the catalog is filtered to membership. */
  seeAllRepos: boolean
  installExtension: boolean
  /**
   * Move a file OUT of the remote workspace onto the local machine. THE exfiltration control.
   * `policy.ts`'s `blockExport` can force this false for every role including admin; the
   * matrix is a ceiling, never a floor.
   */
  exportFile: boolean
  useAgent: boolean
  triggerDeploy: boolean
  connectWorkspace: boolean
}

/**
 * The capabilities that are plain yes/no. `can()` accepts only these, so a scoped capability
 * can never be read as a boolean by accident — `capabilities(role).manageMembers` forces the
 * caller to handle `'own'` explicitly.
 */
export type BooleanCapability = {
  [K in keyof RoleCapabilities]: RoleCapabilities[K] extends boolean ? K : never
}[keyof RoleCapabilities]

/**
 * The matrix. Settled with the product owner on 2026-09-01; the notes record WHY, including
 * the trade-offs that were named and accepted rather than missed.
 *
 *   admin    everything, incl. audit log, member management, policy
 *   manager  sees all repos + reports, cannot push code
 *   lead     approves merges, protects branches, triggers deploys
 *   dev      clone/push own repos only
 */
export const ROLE_MATRIX: Record<Role, RoleCapabilities> = {
  admin: {
    readCode: true,
    pushCode: true,
    pushProtected: true,
    forcePush: false,
    createRepo: true,
    deleteRepo: true,
    approveMerge: true,
    manageMembers: 'all',
    managePolicy: true,
    readAuditLog: true,
    seeAllRepos: true,
    installExtension: true,
    // The ONLY export path in the product. Deliberate: a company needs a way to hand a
    // deliverable to a client, and a documented attributable route is safer than the
    // undocumented ones people invent when there is none. Every use is audited, and
    // `policy.ts`'s blockExport can still close it entirely.
    exportFile: true,
    useAgent: true,
    triggerDeploy: true,
    connectWorkspace: true
  },
  manager: {
    // "Sees all repos" was confirmed to mean the SOURCE, not just the catalog. Accepted
    // trade-off, stated so it is never mistaken for an oversight: this is the broadest read
    // grant in the matrix, so a compromised manager account reads 100% of company source.
    // Detection rather than prevention covers it — the audit rules must watch bulk reads by
    // a role that never pushes, which is an unusually clean signal.
    readCode: true,
    pushCode: false,
    pushProtected: false,
    forcePush: false,
    createRepo: true,
    deleteRepo: false,
    approveMerge: false,
    manageMembers: 'all',
    managePolicy: false,
    // KNOWN AND ACCEPTED: manager holds manageMembers AND readAuditLog, so the same person can
    // change who has access and then read the record of having done it. This is the classic
    // separation-of-duties finding and an auditor WILL raise it. It was named and chosen on
    // 2026-09-01 because managers are the people who actually know the headcount. Mitigation
    // is in the audit subsystem, not here: member-management events must be in the hash chain
    // and must fire the fraudWebhook, so the trail is tamper-EVIDENT even to someone who can
    // read it. Do not silently "fix" this by flipping the flag — it is a policy decision.
    readAuditLog: true,
    seeAllRepos: true,
    installExtension: false,
    exportFile: false,
    useAgent: false,
    triggerDeploy: false,
    connectWorkspace: true
  },
  lead: {
    readCode: true,
    pushCode: true,
    pushProtected: true,
    forcePush: false,
    createRepo: true,
    deleteRepo: false,
    approveMerge: true,
    // 'own', NOT 'all' — a lead adds people to projects they lead and nowhere else. The server
    // must resolve "own" against project leadership; a server that treats this as a boolean
    // grants company-wide member management to every lead.
    manageMembers: 'own',
    managePolicy: false,
    readAuditLog: false,
    seeAllRepos: false,
    installExtension: true,
    exportFile: false,
    useAgent: true,
    triggerDeploy: true,
    connectWorkspace: true
  },
  dev: {
    readCode: true,
    pushCode: true,
    pushProtected: false,
    forcePush: false,
    // Self-service, chosen to remove the admin bottleneck. The cost is catalog sprawl and
    // orphaned repos when someone leaves; ownership transfer on offboarding is therefore a
    // requirement on the control plane, not an afterthought.
    createRepo: true,
    deleteRepo: false,
    approveMerge: false,
    manageMembers: 'none',
    managePolicy: false,
    readAuditLog: false,
    seeAllRepos: false,
    // Safe mainly BECAUSE of the air gap: `extensions.ts` reads `getAirGap()` from `policy.ts`
    // and refuses URL installs offline, so the internal registry is the only reachable source.
    // If the air gap is ever relaxed, revisit this cell first — extensions.ts says plainly that
    // an extension is code running with the user's own permissions, and no sandbox changes that.
    installExtension: true,
    exportFile: false,
    useAgent: true,
    triggerDeploy: false,
    connectWorkspace: true
  }
}

/** No certificate, no capability. Every grant empty — see rule 3 in the header. */
const NO_CAPABILITIES: RoleCapabilities = {
  readCode: false,
  pushCode: false,
  pushProtected: false,
  forcePush: false,
  createRepo: false,
  deleteRepo: false,
  approveMerge: false,
  manageMembers: 'none',
  managePolicy: false,
  readAuditLog: false,
  seeAllRepos: false,
  installExtension: false,
  exportFile: false,
  useAgent: false,
  triggerDeploy: false,
  connectWorkspace: false
}

export function capabilities(role: Role | null): RoleCapabilities {
  return role ? ROLE_MATRIX[role] : NO_CAPABILITIES
}

/** Yes/no capabilities only. Scoped ones must be read from `capabilities()` and handled. */
export function can(role: Role | null, capability: BooleanCapability): boolean {
  return capabilities(role)[capability]
}

/** How far this role's member management reaches. `'none'` when signed out. */
export function memberScope(role: Role | null): Scope {
  return capabilities(role).manageMembers
}

/**
 * Which capability each GATED command needs. A command absent from this map is ungated and
 * available to any signed-in seat — that is the common case and should stay the common case;
 * gate a command only when the server also refuses it.
 *
 * Ids are the exact strings `menu.ts` sends and the palette registers.
 */
export const COMMAND_CAPABILITY: Readonly<Record<string, BooleanCapability>> = {
  'file.newProject': 'createRepo',
  'file.settings': 'managePolicy',
  'view.extensions': 'installExtension',
  'panel.company': 'connectWorkspace',
  'panel.github': 'readCode',
  'run.agent': 'useAgent',
  'run.stopAgent': 'useAgent',
  'edit.ai': 'useAgent',
  'edit.undoAi': 'useAgent',
  'run.genTests': 'useAgent',
  'view.media': 'useAgent'
}

/**
 * True when this role shows the command at all (menu item, palette action, shortcut).
 * Mirrors `commandAllowed` in `mode.ts`; `menu.ts` requires BOTH.
 */
export function roleAllowed(role: Role | null, id: string): boolean {
  if (!role) return false
  const needed = COMMAND_CAPABILITY[id]
  return needed ? can(role, needed) : true
}

/**
 * The gate the menu and the renderer BOTH apply. Use this, not `roleAllowed`, at call sites.
 *
 * Two different states look like `role === null` and they must not be conflated:
 *
 *   - **Unmanaged install** — no company IdP is configured, so there are no roles at all and
 *     the app must behave exactly as it always has. This is every existing seat.
 *   - **Signed out of a MANAGED install** — there is an IdP and this seat holds no valid
 *     certificate, so it gets nothing (rule 3).
 *
 * `identityRequired` comes from enterprise policy and is the only thing that distinguishes them.
 * Collapsing the two is not a cosmetic bug: role gating that defaulted itself ON would blank the
 * entire menu on every standalone seat the moment this file shipped.
 */
export function surfaceAllowed(identityRequired: boolean, role: Role | null, id: string): boolean {
  return identityRequired ? roleAllowed(role, id) : true
}

export interface RoleDescription {
  title: string
  /** One line, plain English — what this person can do, stated as fact. */
  tagline: string
  bullets: string[]
}

export function describeRole(role: Role): RoleDescription {
  switch (role) {
    case 'admin':
      return {
        title: 'Admin',
        tagline: 'Manages people, repositories and company policy.',
        bullets: ['Adds and removes team members', 'Reads the audit trail', 'Sets company policy']
      }
    case 'manager':
      return {
        title: 'Manager',
        tagline: 'Sees every project and its reports, and does not push code.',
        bullets: ['Sees all repositories', 'Reads reports and the audit trail', 'Cannot push code']
      }
    case 'lead':
      return {
        title: 'Lead',
        tagline: 'Approves merges, protects branches and releases to production.',
        bullets: ['Approves merges into main', 'Manages members on their own projects', 'Triggers deployments']
      }
    case 'dev':
      return {
        title: 'Developer',
        tagline: 'Writes code in the projects they are a member of.',
        bullets: ['Creates and pushes their own repositories', 'Cannot push straight to main', 'Uses the AI agent']
      }
  }
}
