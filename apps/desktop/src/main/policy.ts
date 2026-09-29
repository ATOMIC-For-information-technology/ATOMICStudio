import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EnterprisePolicy, RemotePolicy } from '../shared/types'

/**
 * Enterprise Policies — company-managed configuration for every Studio seat.
 *
 * IT drops a JSON file at `<userData>/enterprise-policy.json` (via MDM, an
 * installer, or by hand), or points STUDIO_ENTERPRISE_POLICY at one:
 *
 *   {
 *     "allowedProviders": ["ollama", "atomic"],
 *     "enforceConfidential": true,
 *     "blockExport": true,
 *     "fraudWebhook": "https://security.company.com/atomic"
 *   }
 *
 * Enforcement is in the MAIN process (the renderer can't bypass it):
 *  - provider list is filtered to the allowlist (Settings shows only those),
 *  - every remote/workspace connection gets confidential/export/webhook forced,
 *  - the status bar shows "Managed by your company".
 */

let cached: EnterprisePolicy | null = null

export function enterprisePolicy(): EnterprisePolicy {
  if (cached) return cached
  const candidates = [process.env.STUDIO_ENTERPRISE_POLICY, join(app.getPath('userData'), 'enterprise-policy.json')]
  for (const p of candidates) {
    if (p && existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8')) as Omit<EnterprisePolicy, 'managed'>
        cached = { managed: true, ...raw }
        return cached
      } catch {
        /* malformed policy file — treat as unmanaged rather than lock users out */
      }
    }
  }
  cached = { managed: false }
  return cached
}

/** For tests: drop the cache so a fresh env/file is re-read. */
export function resetPolicyCache(): void {
  cached = null
}

/**
 * Does this install use a company identity provider?
 *
 * This is the single switch that turns ROLE gating on, and it is deliberately derived from the
 * policy file rather than stored as its own flag: a seat cannot be "role-gated" without somewhere
 * to authenticate against, so the presence of a usable `idp` block IS the condition. All three
 * fields are required — a half-configured IdP would gate the UI while leaving nobody able to sign
 * in, which is the worst of both.
 *
 * Every existing standalone seat returns false here and is completely unaffected by roles.
 */
export function identityRequired(): boolean {
  const idp = enterprisePolicy().idp
  return Boolean(idp?.issuer?.trim() && idp?.clientId?.trim() && idp?.controlPlane?.trim())
}

// ---------------------------------------------------------------- Air-Gapped Mode (Wave 3)

/**
 * Air-Gapped Mode: no AI leaves this machine — only the local model (Ollama) runs.
 * The effective flag is an MDM-forced policy floor OR the user's own toggle,
 * persisted at `<userData>/air-gapped.json`. `setAirGap(false)` clears the user
 * flag but can NEVER lift an MDM-forced air-gap. userData is read lazily (only
 * after app-ready), never at module load.
 */
function airGapFilePath(): string {
  return join(app.getPath('userData'), 'air-gapped.json')
}

export function getAirGap(): boolean {
  if (enterprisePolicy().airGap) return true // MDM floor
  try {
    const p = airGapFilePath()
    if (existsSync(p)) return (JSON.parse(readFileSync(p, 'utf8')) as { airGap?: boolean }).airGap === true
  } catch {
    /* unreadable/malformed → not air-gapped */
  }
  return false
}

/** Set the user toggle; returns the EFFECTIVE state (MDM can keep it on). */
export function setAirGap(on: boolean): boolean {
  try {
    writeFileSync(airGapFilePath(), JSON.stringify({ airGap: on === true }), 'utf8')
  } catch {
    /* best-effort persistence */
  }
  return getAirGap()
}

/** Force company rules onto any remote/workspace policy the user chose. */
export function applyEnterprisePolicy(p: RemotePolicy): RemotePolicy {
  const ep = enterprisePolicy()
  if (!ep.managed) return p
  return {
    ...p,
    confidential: ep.enforceConfidential ? true : p.confidential,
    allowExport: ep.blockExport ? false : p.allowExport,
    allowedProviders: ep.allowedProviders ?? p.allowedProviders,
    fraudWebhook: p.fraudWebhook || ep.fraudWebhook
  }
}
