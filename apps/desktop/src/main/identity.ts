import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { audit } from './audit'
import { enterprisePolicy, identityRequired } from './policy'
import { getApiKey, setApiKey } from './keyvault'
import { ROLES, normalizeRole, type Identity, type Role } from '../shared/roles'
import type { DeviceLoginPrompt, IdentityResult, IdentityStatus, IdpConfig } from '../shared/types'

/**
 * Company sign-in against the on-prem OIDC provider (Keycloak), and the role it resolves to.
 *
 * ── Why the DEVICE-CODE flow and not an embedded browser ──────────────────────────────────────
 * An embedded `BrowserWindow` pointed at the IdP is the usual shortcut and it is the wrong one
 * twice over. It trains people to type company credentials into a chrome-less window whose URL
 * they cannot inspect — which is exactly the thing phishing training tells them never to do — and
 * it interferes with the IdP's own MFA prompts (hardware keys and platform authenticators are
 * bound to a real browser origin). So Studio shows a short code, the user opens THEIR browser,
 * and Studio polls. Slower by a few seconds; honest, and MFA works.
 *
 * ── What this file trusts, and what it does not ───────────────────────────────────────────────
 * `decodeClaims()` reads the id_token WITHOUT verifying its signature, and that is safe ONLY
 * because nothing here is a security decision: the claims populate a name in the UI and a role
 * that decides what to SHOW. Every capability is re-checked server-side against a token the
 * server verifies itself (`shared/roles.ts`, rule 1). If you ever find yourself using a claim
 * read here to permit an action rather than to render one, stop — that is the bug this note
 * exists to prevent.
 *
 * ── Deployment note (air gap) ─────────────────────────────────────────────────────────────────
 * The issuer and control plane will present certificates from the company's internal CA. Node
 * will reject them unless that CA is trusted. Install it in the OS trust store, or launch with
 * `NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem`. Studio does NOT disable TLS verification to
 * paper over this, and it never will — a flag that turns off certificate checking is a hole that
 * outlives the deployment problem it was added for.
 */

/** Reserved keyvault entry. Prefixed so it can never collide with a provider id. */
const REFRESH_KEY = '__identity.refresh'

const SCOPES = 'openid profile email offline_access'

interface OidcDiscovery {
  device_authorization_endpoint: string
  token_endpoint: string
}

interface PendingLogin {
  deviceCode: string
  intervalMs: number
  expiresAt: number
}

let discoveryCache: { issuer: string; doc: OidcDiscovery } | null = null
let pending: PendingLogin | null = null
let current: Identity | null = null
/**
 * The access token for control-plane calls. IN MEMORY ONLY, deliberately: it is short-lived and
 * re-obtainable from the refresh token, so writing it to disk would add a stealable credential
 * and buy nothing. The refresh token is the one thing that persists, and it lives in the vault.
 */
let accessToken: string | null = null
let accessExpiresAt = 0
let lastError: string | undefined
const listeners = new Set<(s: IdentityStatus) => void>()

// ---------------------------------------------------------------- config

function idp(): IdpConfig | null {
  return identityRequired() ? (enterprisePolicy().idp as IdpConfig) : null
}

/** Trailing slashes make `${issuer}/.well-known/...` produce a double slash on some IdPs. */
const trimUrl = (u: string): string => u.trim().replace(/\/+$/, '')

// ---------------------------------------------------------------- change notification

export function onIdentityChange(cb: (s: IdentityStatus) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit(): void {
  const s = identityStatus()
  for (const cb of listeners) {
    try {
      cb(s)
    } catch {
      /* a bad listener must never break sign-in */
    }
  }
}

// ---------------------------------------------------------------- status

export function identityStatus(): IdentityStatus {
  const required = identityRequired()
  // An expired certificate is signed OUT, not signed in with stale claims. Checked on every read
  // rather than on a timer, so a seat left open overnight cannot keep a role it no longer holds.
  if (current && current.expiresAt <= Date.now()) current = null
  return { required, signedIn: Boolean(current), identity: current, ...(lastError ? { error: lastError } : {}) }
}

export function currentIdentity(): Identity | null {
  return identityStatus().identity
}

export function currentRole(): Role | null {
  return currentIdentity()?.role ?? null
}

// ---------------------------------------------------------------- OIDC plumbing

async function discover(cfg: IdpConfig): Promise<OidcDiscovery> {
  const issuer = trimUrl(cfg.issuer)
  if (discoveryCache?.issuer === issuer) return discoveryCache.doc
  const res = await fetch(`${issuer}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`the identity provider answered ${res.status} to a discovery request`)
  const doc = (await res.json()) as Partial<OidcDiscovery>
  if (!doc.device_authorization_endpoint || !doc.token_endpoint) {
    throw new Error('the identity provider does not advertise device-code sign-in')
  }
  const full = doc as OidcDiscovery
  discoveryCache = { issuer, doc: full }
  return full
}

/**
 * Read a JWT's payload. NOT a verification — see the file header. Returns `{}` on anything
 * malformed rather than throwing, because a login that fails should say "sign-in failed", not
 * surface a base64 error to someone who cannot act on it.
 */
function decodeClaims(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split('.')[1]
    if (!part) return {}
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Resolve the ATOMIC role from the IdP's group claim.
 *
 * HIGHEST role wins when someone is in several groups — `ROLES` is ordered most-privileged first
 * and this walks it in that order. The alternative (first matching group) would make the role
 * depend on the order Keycloak happens to serialise groups in, which is not something a company
 * should have to reason about.
 *
 * No mapping, or no match, means NO role — never a default. A default role here would silently
 * grant access to anyone who authenticates, which is the opposite of what an IdP is for.
 */
function roleFromClaims(cfg: IdpConfig, claims: Record<string, unknown>): Role | null {
  const claimName = cfg.groupsClaim?.trim() || 'groups'
  const raw = claims[claimName]
  const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : []
  if (!groups.length || !cfg.groupRoles) return null
  // Normalise Keycloak's leading-slash group paths ("/eng-leads") to bare names.
  const held = new Set(groups.map((g) => g.replace(/^\/+/, '')))
  for (const role of ROLES) {
    for (const [group, mapped] of Object.entries(cfg.groupRoles)) {
      if (normalizeRole(mapped) === role && held.has(group.replace(/^\/+/, ''))) return role
    }
  }
  return null
}

function identityFromTokens(cfg: IdpConfig, idToken: string, expiresInSec: number): Identity | null {
  const claims = decodeClaims(idToken)
  const user =
    (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
    (typeof claims.sub === 'string' && claims.sub) ||
    ''
  if (!user) return null
  const role = roleFromClaims(cfg, claims)
  if (!role) return null
  const display = (typeof claims.name === 'string' && claims.name) || user
  return { user, display, role, expiresAt: Date.now() + Math.max(60, expiresInSec) * 1000 }
}

/** Keep a token with a 60s safety margin, so a call cannot start with a token that expires mid-flight. */
function rememberAccessToken(token: string | undefined, expiresInSec: number | undefined): void {
  if (!token) return
  accessToken = token
  accessExpiresAt = Date.now() + Math.max(60, expiresInSec ?? 300) * 1000 - 60_000
}

/**
 * A usable access token, refreshing silently if the one in hand has gone stale. Returns null when
 * signed out or when the refresh fails — callers must treat that as "not signed in", never as an
 * error worth showing, because the ordinary cause is simply that nobody has signed in.
 */
export async function ensureAccessToken(): Promise<string | null> {
  const cfg = idp()
  if (!cfg) return null
  if (accessToken && Date.now() < accessExpiresAt) return accessToken
  const refresh = getApiKey(REFRESH_KEY)
  if (!refresh) return null
  try {
    const doc = await discover(cfg)
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, grant_type: 'refresh_token', refresh_token: refresh })
    })
    if (!res.ok) return null
    const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (body.refresh_token) setApiKey(REFRESH_KEY, body.refresh_token)
    rememberAccessToken(body.access_token, body.expires_in)
    return accessToken
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- device-code login

export async function beginLogin(): Promise<DeviceLoginPrompt> {
  const cfg = idp()
  if (!cfg) return { ok: false, error: 'This copy of Studio is not set up to sign in to a company server.' }
  lastError = undefined
  try {
    const doc = await discover(cfg)
    const res = await fetch(doc.device_authorization_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, scope: SCOPES })
    })
    if (!res.ok) throw new Error(`the identity provider answered ${res.status}`)
    const body = (await res.json()) as {
      device_code?: string
      user_code?: string
      verification_uri?: string
      verification_uri_complete?: string
      interval?: number
      expires_in?: number
    }
    if (!body.device_code || !body.user_code || !body.verification_uri) {
      throw new Error('the identity provider returned an incomplete sign-in request')
    }
    const expiresInSec = body.expires_in ?? 600
    pending = {
      deviceCode: body.device_code,
      // The spec's default poll interval is 5s. Honour whatever the IdP asks for, and never
      // poll faster — an IdP that answers `slow_down` will start refusing otherwise.
      intervalMs: Math.max(1, body.interval ?? 5) * 1000,
      expiresAt: Date.now() + expiresInSec * 1000
    }
    return {
      ok: true,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      ...(body.verification_uri_complete ? { verificationUriComplete: body.verification_uri_complete } : {}),
      expiresInSec
    }
  } catch (e) {
    lastError = `Studio could not reach the company sign-in service: ${e instanceof Error ? e.message : String(e)}`
    return { ok: false, error: lastError }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll until the user finishes in their browser, the code expires, or they are refused. */
export async function completeLogin(): Promise<IdentityResult> {
  const cfg = idp()
  if (!cfg) return { ok: false, error: 'This copy of Studio is not set up to sign in to a company server.' }
  if (!pending) return { ok: false, error: 'Start the sign-in first.' }
  const doc = await discover(cfg).catch(() => null)
  if (!doc) return { ok: false, error: 'Studio could not reach the company sign-in service.' }

  let intervalMs = pending.intervalMs
  while (pending && Date.now() < pending.expiresAt) {
    await sleep(intervalMs)
    if (!pending) return { ok: false, error: 'Sign-in was cancelled.' }
    let body: { error?: string; id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number }
    try {
      const res = await fetch(doc.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: pending.deviceCode
        })
      })
      body = (await res.json()) as typeof body
    } catch (e) {
      lastError = `Studio lost contact with the company sign-in service: ${e instanceof Error ? e.message : String(e)}`
      return { ok: false, error: lastError }
    }

    // The three "keep waiting" cases are NOT failures and must not surface to the user.
    if (body.error === 'authorization_pending') continue
    if (body.error === 'slow_down') {
      intervalMs += 5000
      continue
    }
    if (body.error === 'expired_token') {
      pending = null
      lastError = 'The sign-in code expired. Start again.'
      return { ok: false, error: lastError }
    }
    if (body.error === 'access_denied') {
      pending = null
      lastError = 'Sign-in was refused. Check with your administrator that you have access.'
      audit('identity.denied', 'device-code sign-in refused by the identity provider')
      return { ok: false, error: lastError }
    }
    if (body.error) {
      pending = null
      lastError = `The company sign-in service refused: ${body.error}`
      return { ok: false, error: lastError }
    }

    if (!body.id_token) {
      pending = null
      lastError = 'The company sign-in service did not return an identity.'
      return { ok: false, error: lastError }
    }
    rememberAccessToken(body.access_token, body.expires_in)

    const who = identityFromTokens(cfg, body.id_token, body.expires_in ?? 8 * 3600)
    pending = null
    if (!who) {
      // Authenticated but unmapped: a real person with no role. Say so precisely — "sign-in
      // failed" would send them to reset a password that works fine.
      lastError = 'You signed in, but your account is not assigned to a team in Studio. Ask your administrator to add you.'
      audit('identity.norole', 'authenticated with no group mapping to an ATOMIC role')
      return { ok: false, error: lastError }
    }

    if (body.refresh_token) {
      // Reuses the vault's hard-won discipline, including its refusal to overwrite a vault it
      // could not read (see keyvault.ts). A failure here is not fatal: the session still works,
      // the user just signs in again next launch.
      const saved = setApiKey(REFRESH_KEY, body.refresh_token)
      if (!saved.ok) lastError = 'Signed in, but Studio could not remember it for next time.'
    }

    current = who
    audit('identity.signin', `${who.user} signed in as ${who.role}`)
    // The certificate is what actually lets this seat reach git. Failing to get one is NOT a
    // failed sign-in — the user is authenticated and the UI should say so — but it does need
    // saying, because pushes will fail until it succeeds.
    const cert = await requestCertificate()
    if (!cert.ok) lastError = `Signed in, but no access certificate was issued: ${cert.error}`
    emit()
    return { ok: true, identity: who }
  }

  pending = null
  lastError = 'The sign-in code expired. Start again.'
  return { ok: false, error: lastError }
}

/**
 * Silent re-sign-in at launch using the stored refresh token, so a managed seat is not a login
 * screen every morning. Failure is silent and simply leaves the user signed out — a startup path
 * must never block on the IdP being reachable.
 */
export async function restoreSession(): Promise<void> {
  const cfg = idp()
  if (!cfg) return
  const refresh = getApiKey(REFRESH_KEY)
  if (!refresh) return
  try {
    const doc = await discover(cfg)
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, grant_type: 'refresh_token', refresh_token: refresh })
    })
    if (!res.ok) return
    const body = (await res.json()) as { id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number }
    if (!body.id_token) return
    const who = identityFromTokens(cfg, body.id_token, body.expires_in ?? 8 * 3600)
    if (!who) return
    if (body.refresh_token) setApiKey(REFRESH_KEY, body.refresh_token)
    rememberAccessToken(body.access_token, body.expires_in)
    current = who
    audit('identity.restore', `${who.user} restored session as ${who.role}`)
    emit()
  } catch {
    /* offline or IdP down at launch — stay signed out, say nothing */
  }
}

export function logout(): IdentityStatus {
  const who = current
  current = null
  pending = null
  accessToken = null
  accessExpiresAt = 0
  lastError = undefined
  // Best effort: an unreadable vault refuses writes, and that must not block signing out.
  setApiKey(REFRESH_KEY, '')
  clearCertificate()
  if (who) audit('identity.signout', `${who.user} signed out`)
  emit()
  return identityStatus()
}

// ---------------------------------------------------------------- SSH certificate

/**
 * Where Studio keeps the short-lived certificate the control plane issues. Deliberately NOT
 * `~/.ssh`: this file is Studio-managed and is deleted on sign-out, and writing into the user's
 * own ssh directory risks colliding with keys the company's other tooling manages.
 *
 * CONSUMED, as of 2026-09-05, by `certificateCredential()` below: `remote.ts` passes it to every
 * ssh invocation as `-o CertificateFile=`, and `git-exec.ts` puts the same pair into
 * `GIT_SSH_COMMAND`, so clone, fetch, pull and push all authenticate with it. (This comment used to
 * say the opposite, and said so deliberately rather than claiming a capability that did not exist.)
 */
function certDir(): string {
  return join(app.getPath('userData'), 'atomic-cert')
}

export function certificatePath(): string {
  return join(certDir(), 'id_atomic-cert.pub')
}

function clearCertificate(): void {
  try {
    rmSync(certDir(), { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/** The user's own public key. Their PRIVATE key is never read, forwarded, or stored. */
function publicKeyPath(): string {
  return process.env.STUDIO_SSH_PUBKEY ?? join(homedir(), '.ssh', 'id_ed25519.pub')
}

/**
 * The private key that MATCHES the certificate — by path only.
 *
 * OpenSSH needs both halves named: `CertificateFile` says what to present, `-i` says which private
 * key to prove possession of, and they must be a pair. The certificate was issued against
 * `publicKeyPath()`, so its private half is the same path without `.pub`. Studio names this file to
 * ssh and NEVER opens it — the one rule in this whole subsystem that has no exceptions.
 */
function privateKeyPath(): string {
  return publicKeyPath().replace(/\.pub$/, '')
}

export interface CertificateCredential {
  certPath: string
  keyPath: string
}

/**
 * The certificate + key pair to authenticate with, or null when this is not a managed seat.
 *
 * Null is the STANDALONE answer, and callers must treat it as "use whatever was configured
 * locally" rather than as an error: a BYO server has no control plane to issue anything. Returning
 * a pair whose files are not both present would be worse than returning null — ssh fails with a
 * confusing error instead of falling back to the key the user actually set up.
 */
export function certificateCredential(): CertificateCredential | null {
  if (!identityRequired()) return null
  const certPath = certificatePath()
  const keyPath = privateKeyPath()
  if (!existsSync(certPath) || !existsSync(keyPath)) return null
  return { certPath, keyPath }
}

export interface CertResult {
  ok: boolean
  error?: string
}

/**
 * Exchange the signed-in session for an SSH certificate from the control plane. The certificate
 * carries the user and role as principals, which is what lets `atomic-git-shell.mjs` know who is
 * pushing without a key-to-user lookup table that has to be kept in step.
 */
export async function requestCertificate(): Promise<CertResult> {
  const cfg = idp()
  if (!cfg) return { ok: false, error: 'No company server is configured.' }
  const token = await ensureAccessToken()
  if (!token) return { ok: false, error: 'You are not signed in to the company server.' }
  const pub = publicKeyPath()
  if (!existsSync(pub)) {
    return {
      ok: false,
      error: `Studio could not find your SSH public key at ${pub}. Create one with: ssh-keygen -t ed25519`
    }
  }
  try {
    const res = await fetch(`${trimUrl(cfg.controlPlane)}/v1/cert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: readFileSync(pub, 'utf8').trim() })
    })
    if (!res.ok) return { ok: false, error: `The company server refused to issue a certificate (${res.status}).` }
    const body = (await res.json()) as { certificate?: string }
    if (!body.certificate) return { ok: false, error: 'The company server returned an empty certificate.' }
    mkdirSync(certDir(), { recursive: true })
    writeFileSync(certificatePath(), body.certificate.trim() + '\n', { mode: 0o600 })
    audit('identity.cert', `certificate issued for ${current?.user ?? 'unknown'}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Studio could not reach the company server: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * For tests: inject an access token without an IdP.
 *
 * The suites have no Keycloak to sign in against, but the control-plane calls that matter
 * (`/v1/repos`, `/v1/cert`) are exercised against a local stub — so the ONE thing they need is the
 * token `ensureAccessToken()` would have returned. Injecting it here uses the same field the real
 * flow writes, rather than adding a second code path that could drift from it.
 */
export function _setAccessTokenForTests(token: string, ttlSec = 3600): void {
  accessToken = token
  accessExpiresAt = Date.now() + ttlSec * 1000
}

/** For tests: forget everything without touching the vault or the disk. */
export function _resetIdentityForTests(): void {
  discoveryCache = null
  pending = null
  current = null
  accessToken = null
  accessExpiresAt = 0
  lastError = undefined
}
