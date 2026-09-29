/**
 * atomic-oidc — verify an OIDC access token from the company identity provider.
 *
 * Zero dependencies, like everything else on this box: node's own `crypto` can build a public
 * key straight from a JWK and verify an RSA or ECDSA signature, so a JWT library would add a
 * supply-chain dependency to an air-gapped server for no capability we do not already have.
 *
 * ── The attack this file exists to stop ───────────────────────────────────────────────────────
 * The classic JWT vulnerability is ALGORITHM CONFUSION: a verifier that trusts the token's own
 * `alg` header can be handed `{"alg":"none"}` (accept anything) or `{"alg":"HS256"}` signed with
 * the RSA PUBLIC key as an HMAC secret — and the public key is, by definition, public. Both turn
 * "verify this token" into "accept whatever the caller wrote".
 *
 * So `alg` is checked against an ALLOW-LIST of asymmetric algorithms, and the key type must
 * match the algorithm family. The header never selects the verification strategy; it only has to
 * agree with one we already decided to accept.
 *
 * Everything here fails CLOSED: any malformed input, unknown key, bad signature, expired token
 * or unmet claim returns null. There is no path that returns claims it did not verify.
 */
import { createHash, createPublicKey, createVerify } from 'node:crypto'

/** alg -> { node digest, key type it MUST be }. Nothing symmetric, and no `none`, ever. */
const ALGS = {
  RS256: { verify: 'RSA-SHA256', kty: 'RSA' },
  RS384: { verify: 'RSA-SHA384', kty: 'RSA' },
  RS512: { verify: 'RSA-SHA512', kty: 'RSA' },
  ES256: { verify: 'sha256', kty: 'EC', dsa: 'ieee-p1363' },
  ES384: { verify: 'sha384', kty: 'EC', dsa: 'ieee-p1363' }
}

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function decodeSegment(seg) {
  try {
    const parsed = JSON.parse(b64urlToBuf(seg).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const jwksCache = new Map() // issuer -> { keys, fetchedAt }
const JWKS_TTL_MS = 10 * 60 * 1000

const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '')

/**
 * Fetch the issuer's signing keys, cached.
 *
 * `force` bypasses the cache and is used exactly once: when a token names a `kid` we have never
 * seen. That is the normal signal that the IdP rotated its keys, and refetching then — rather
 * than on a timer — means a rotation costs one extra request instead of an outage. It is also
 * why the cache TTL can be generous.
 */
export async function fetchJwks(issuer, { force = false, fetchImpl = fetch } = {}) {
  const iss = trimUrl(issuer)
  const hit = jwksCache.get(iss)
  if (!force && hit && Date.now() - hit.fetchedAt < JWKS_TTL_MS) return hit.keys
  try {
    const disco = await fetchImpl(`${iss}/.well-known/openid-configuration`)
    if (!disco.ok) return hit?.keys ?? []
    const doc = await disco.json()
    if (!doc?.jwks_uri) return hit?.keys ?? []
    const res = await fetchImpl(doc.jwks_uri)
    if (!res.ok) return hit?.keys ?? []
    const jwks = await res.json()
    const keys = Array.isArray(jwks?.keys) ? jwks.keys : []
    jwksCache.set(iss, { keys, fetchedAt: Date.now() })
    return keys
  } catch {
    // Serving the cached keys beats failing every request because the IdP blipped. Returning []
    // when there is no cache is still fail-closed: no keys means no token verifies.
    return hit?.keys ?? []
  }
}

export function _resetJwksCache() {
  jwksCache.clear()
}

/**
 * Verify `token` and return its claims, or null.
 *
 * `audience` is checked against BOTH `aud` and `azp`: Keycloak issues access tokens whose `aud`
 * is the resource server while `azp` names the client that asked, and which one carries the
 * client id depends on realm configuration. Accepting either is correct; accepting neither
 * would reject valid tokens, and skipping the check would accept a token minted for a
 * different application on the same realm.
 */
export async function verifyJwt(token, { issuer, audience, clockSkewSec = 60, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h64, p64, s64] = parts

  const header = decodeSegment(h64)
  const claims = decodeSegment(p64)
  if (!header || !claims) return null

  const spec = ALGS[header.alg]
  if (!spec) return null // covers 'none', HS256, and anything unrecognised

  const keys = await fetchJwks(issuer, { fetchImpl })
  let candidates = keys.filter((k) => k && k.kty === spec.kty && (!header.kid || k.kid === header.kid))
  if (!candidates.length && header.kid) {
    // Unknown kid → the IdP probably rotated. Refetch once, then give up.
    const fresh = await fetchJwks(issuer, { force: true, fetchImpl })
    candidates = fresh.filter((k) => k && k.kty === spec.kty && k.kid === header.kid)
  }
  if (!candidates.length) return null

  const signed = Buffer.from(`${h64}.${p64}`, 'utf8')
  const sig = b64urlToBuf(s64)
  let verified = false
  for (const jwk of candidates) {
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' })
      const v = createVerify(spec.verify)
      v.update(signed)
      v.end()
      // JWS uses the raw r||s form for ECDSA; node defaults to DER and would reject every valid
      // ES256 token without this.
      if (v.verify(spec.dsa ? { key, dsaEncoding: spec.dsa } : key, sig)) {
        verified = true
        break
      }
    } catch {
      /* wrong key shape — try the next */
    }
  }
  if (!verified) return null

  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp === 'number' && now > claims.exp + clockSkewSec) return null
  if (typeof claims.nbf === 'number' && now + clockSkewSec < claims.nbf) return null
  if (issuer && trimUrl(claims.iss) !== trimUrl(issuer)) return null
  if (audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
    if (!aud.includes(audience) && claims.azp !== audience) return null
  }
  return claims
}

/**
 * Map the IdP's groups onto an ATOMIC role, HIGHEST first.
 *
 * Mirrors `roleFromClaims` in the desktop app so the two cannot disagree about who someone is.
 * No mapping and no match mean NO role — never a default, because a default here would grant
 * server access to anyone the IdP happens to authenticate.
 */
const ROLE_ORDER = ['admin', 'manager', 'lead', 'dev']

export function roleFromClaims(claims, { groupsClaim = 'groups', groupRoles = {} } = {}) {
  const raw = claims?.[groupsClaim]
  const groups = Array.isArray(raw) ? raw.filter((g) => typeof g === 'string') : []
  if (!groups.length) return null
  const held = new Set(groups.map((g) => g.replace(/^\/+/, '')))
  for (const role of ROLE_ORDER) {
    for (const [group, mapped] of Object.entries(groupRoles)) {
      if (mapped === role && held.has(String(group).replace(/^\/+/, ''))) return role
    }
  }
  return null
}

/** Stable, non-reversible id for the audit trail when a subject must be logged but not stored. */
export function subjectHash(sub) {
  return createHash('sha256').update(String(sub)).digest('hex').slice(0, 16)
}
