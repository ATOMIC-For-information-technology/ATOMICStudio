/**
 * atomic-git-cert — read the identity out of the SSH certificate sshd actually accepted.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────────────────────
 * With `authorized_keys`, identity was free: sshd substituted `command="atomic-git-shell alice"`
 * for whatever the client asked for, so `argv[1]` could not be spoofed. Certificates delete that
 * file — one CA replaces every line — and with it the place the name was written. `ForceCommand`
 * takes no %-tokens, so the name cannot come back through argv.
 *
 * OpenSSH's answer is `ExposeAuthInfo yes`: sshd writes the credential it accepted to a file that
 * only this session can read, and names it in `$SSH_USER_AUTH`. That file is written by sshd
 * AFTER authentication succeeded. The client never gets to choose its contents.
 *
 * ── Why we verify the signature again, when sshd already did ──────────────────────────────────
 * Because `$SSH_USER_AUTH` is an environment variable naming a path, and `ssh-keygen -L` DECODES a
 * certificate without checking who signed it. A certificate is a self-describing blob that carries
 * its own CA public key — which is public — so anyone can build one that *prints* our CA's
 * fingerprint. Comparing the printed fingerprint would therefore prove nothing at all.
 *
 * So this file parses the certificate wire format itself and verifies the CA signature with
 * node's own crypto. Nothing is trusted that was not signed by the configured CA key.
 *
 * ── What a certificate must say ───────────────────────────────────────────────────────────────
 *   Key ID       atomic:<name>:<epoch>
 *   Principals   <login-account>   (so sshd accepts it for the shared git account)
 *                <name>            (the certified identity)
 *                role:<role>       (exactly one)
 *
 * `<epoch>` is the member's revocation counter. Deleting a member bumps it, so every certificate
 * issued to the old holder of that name stops verifying IMMEDIATELY rather than at expiry — and a
 * recreated `alice` cannot be impersonated by the previous one's still-valid certificate.
 *
 * EVERYTHING here fails closed. There is no path that returns an identity it did not verify.
 *
 * Zero dependencies, because this runs from a forced command on a box with nothing installed.
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import fs from 'node:fs'

/** The roles a certificate may assert. Mirrors ROLE_CAPS in atomic-git-acl.mjs. */
const CERT_ROLES = new Set(['admin', 'manager', 'lead', 'dev', 'viewer'])

/**
 * How many `string` fields sit between the nonce and the serial, per certificate type.
 *
 * The certificate layout is uniform AFTER the subject's public key, but the public key itself is
 * one field for ed25519 and two or three for everything else. Getting this wrong silently shifts
 * every later field, so the count is a table rather than a guess, and an unknown type is refused.
 */
const PUBKEY_FIELDS = {
  'ssh-ed25519-cert-v01@openssh.com': 1,
  'ssh-rsa-cert-v01@openssh.com': 2,
  'rsa-sha2-256-cert-v01@openssh.com': 2,
  'rsa-sha2-512-cert-v01@openssh.com': 2,
  'ecdsa-sha2-nistp256-cert-v01@openssh.com': 2,
  'ecdsa-sha2-nistp384-cert-v01@openssh.com': 2,
  'ecdsa-sha2-nistp521-cert-v01@openssh.com': 2,
  'sk-ssh-ed25519-cert-v01@openssh.com': 2,
  'sk-ecdsa-sha2-nistp256-cert-v01@openssh.com': 3
}

/** SSH wire format: a length-prefixed byte-string reader that cannot run off the end. */
class Reader {
  constructor(buf) {
    this.buf = buf
    this.at = 0
  }
  u32() {
    if (this.at + 4 > this.buf.length) throw new Error('truncated')
    const n = this.buf.readUInt32BE(this.at)
    this.at += 4
    return n
  }
  u64() {
    if (this.at + 8 > this.buf.length) throw new Error('truncated')
    const n = this.buf.readBigUInt64BE(this.at)
    this.at += 8
    return n
  }
  str() {
    const n = this.u32()
    if (this.at + n > this.buf.length) throw new Error('truncated')
    const b = this.buf.subarray(this.at, this.at + n)
    this.at += n
    return b
  }
  skip(n) {
    for (let i = 0; i < n; i++) this.str()
  }
}

/** A `string` containing a sequence of `string`s — how principals are packed. */
function readStringList(buf) {
  const r = new Reader(buf)
  const out = []
  while (r.at < buf.length) out.push(r.str().toString('utf8'))
  return out
}

/**
 * Decode `<type> <base64> [comment]` into the fields we care about, PLUS the exact bytes the CA
 * signed and the signature over them. Returns null on anything malformed.
 */
export function decodeCertificate(line) {
  try {
    const parts = String(line || '').trim().split(/\s+/)
    if (parts.length < 2) return null
    const type = parts[0]
    const pubFields = PUBKEY_FIELDS[type]
    if (!pubFields) return null
    const blob = Buffer.from(parts[1], 'base64')
    if (!blob.length) return null

    const r = new Reader(blob)
    if (r.str().toString('utf8') !== type) return null // the inner type must agree with the outer
    r.str() // nonce
    r.skip(pubFields) // the subject's public key
    const serial = r.u64()
    const certType = r.u32() // 1 = user, 2 = host
    const keyId = r.str().toString('utf8')
    const principals = readStringList(r.str())
    const validAfter = r.u64()
    const validBefore = r.u64()
    r.str() // critical options
    r.str() // extensions
    r.str() // reserved
    const caKey = r.str()
    // Everything up to and including the CA key is what the signature covers. Taking the slice by
    // OFFSET rather than reconstructing the fields is what makes this exact.
    const signed = blob.subarray(0, r.at)
    const signature = r.str()
    if (r.at !== blob.length) return null // trailing bytes are not a certificate

    return { type, serial, certType, keyId, principals, validAfter, validBefore, caKey, signed, signature }
  } catch {
    return null
  }
}

/** An `ssh-ed25519` public-key blob -> a node KeyObject, or null. */
function ed25519KeyFromBlob(blob) {
  try {
    const r = new Reader(blob)
    if (r.str().toString('utf8') !== 'ssh-ed25519') return null
    const raw = r.str()
    if (raw.length !== 32) return null
    // SPKI DER prefix for Ed25519 (RFC 8410). Wrapping the raw key is the whole conversion.
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
    return createPublicKey({ key: der, format: 'der', type: 'spki' })
  } catch {
    return null
  }
}

/** Read an OpenSSH public key file and return its raw key blob, or null. */
export function readPublicKeyBlob(keyPath) {
  try {
    const parts = fs.readFileSync(keyPath, 'utf8').trim().split(/\s+/)
    if (parts.length < 2) return null
    return Buffer.from(parts[1], 'base64')
  } catch {
    return null
  }
}

/**
 * The result of asking "who is this, according to a certificate I trust?".
 *
 * Every failure returns `{ ok: false, reason }` with a reason fit to print on the client's
 * terminal. No failure returns a name.
 */
export function verifyCertificate(line, { caPublicKeyBlob, now = Date.now(), loginAccount } = {}) {
  const cert = decodeCertificate(line)
  if (!cert) return { ok: false, reason: 'the certificate could not be read' }
  if (cert.certType !== 1) return { ok: false, reason: 'that is a host certificate, not a user certificate' }

  if (!caPublicKeyBlob || !caPublicKeyBlob.length) {
    // Refusing is the only safe answer: without the CA key there is nothing to check against, and
    // "no CA configured" must never be allowed to mean "accept anything".
    return { ok: false, reason: 'this server is not configured to trust any certificate authority' }
  }
  if (!cert.caKey.equals(caPublicKeyBlob)) {
    return { ok: false, reason: 'that certificate was signed by a different authority' }
  }

  // SIGNATURE. Without this the CA-key comparison above proves nothing — a forged certificate can
  // embed any public key it likes, including ours.
  const caKey = ed25519KeyFromBlob(cert.caKey)
  if (!caKey) return { ok: false, reason: 'the certificate authority key is not a supported type (use ed25519)' }
  let sigBytes
  try {
    const sr = new Reader(cert.signature)
    if (sr.str().toString('utf8') !== 'ssh-ed25519') return { ok: false, reason: 'unsupported certificate signature' }
    sigBytes = sr.str()
  } catch {
    return { ok: false, reason: 'the certificate signature could not be read' }
  }
  let good = false
  try {
    good = cryptoVerify(null, cert.signed, caKey, sigBytes)
  } catch {
    good = false
  }
  if (!good) return { ok: false, reason: 'the certificate signature does not verify' }

  // VALIDITY. sshd checks this too; checking again costs nothing and keeps this function honest
  // when it is called from a test or a tool that is not sshd.
  const sec = BigInt(Math.floor(now / 1000))
  if (cert.validBefore <= cert.validAfter) return { ok: false, reason: 'the certificate has no validity window' }
  if (sec < cert.validAfter) return { ok: false, reason: 'that certificate is not valid yet' }
  if (sec >= cert.validBefore) return { ok: false, reason: 'that certificate has expired — sign in again' }

  // KEY ID carries the identity and the revocation epoch: `atomic:<name>:<epoch>`.
  const m = /^atomic:([A-Za-z0-9._-]{1,64}):(\d{1,12})$/.exec(cert.keyId)
  if (!m) return { ok: false, reason: 'the certificate does not name an ATOMIC identity' }
  const name = m[1]
  const epoch = Number(m[2])

  // PRINCIPALS. Exactly one role, and the certified name must be among them — a certificate whose
  // key id and principals disagree is tampered with, not merely odd.
  const roles = cert.principals.filter((p) => p.startsWith('role:')).map((p) => p.slice(5))
  if (roles.length !== 1) return { ok: false, reason: 'the certificate does not carry exactly one role' }
  const role = roles[0]
  if (!CERT_ROLES.has(role)) return { ok: false, reason: 'the certificate carries a role this server does not know' }
  if (!cert.principals.includes(name)) return { ok: false, reason: 'the certificate name and principals disagree' }
  if (loginAccount && !cert.principals.includes(loginAccount)) {
    return { ok: false, reason: 'the certificate is not valid for this account' }
  }

  return { ok: true, name, role, epoch, keyId: cert.keyId, serial: cert.serial }
}

/**
 * Pull the certificate line out of the file sshd wrote for `$SSH_USER_AUTH`.
 *
 * The file has one line per authentication method that succeeded, e.g.
 *   publickey ssh-ed25519-cert-v01@openssh.com AAAAIH...
 * We want the certificate one. A plain (non-certificate) public key is NOT an identity here: it
 * means this session authenticated some other way, and the caller must refuse rather than guess.
 */
export function certificateFromAuthInfo(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    // sshd writes "<method> <keytype> <base64>"; tolerate a bare "<keytype> <base64>" too.
    const start = PUBKEY_FIELDS[parts[0]] ? 0 : 1
    if (!parts[start] || !PUBKEY_FIELDS[parts[start]]) continue
    return parts.slice(start).join(' ')
  }
  return null
}

/**
 * The revocation epoch ledger, shared by the control plane (which writes it) and the forced
 * command (which reads it).
 *
 * MISSING file -> `{}`, i.e. epoch 0 for everyone. That is a fresh install where nothing has been
 * revoked, and refusing every login on a fresh install would be a worse failure than the one it
 * prevents. PRESENT but unreadable or malformed -> null, and every caller treats that as "refuse".
 * The file is written atomically (temp + rename), so a malformed one is tampering, not a torn write.
 */
export function readEpochs(epochsPath) {
  if (!epochsPath) return Object.create(null)
  try {
    const parsed = JSON.parse(fs.readFileSync(epochsPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out = Object.create(null)
    for (const [k, v] of Object.entries(parsed)) {
      // Dropping a malformed entry would reset a revoked identity to epoch zero.
      if (!Number.isSafeInteger(v) || v < 0) return null
      out[k] = v
    }
    return out
  } catch (error) {
    if (error.code === 'ENOENT') return Object.create(null)
    return null
  }
}

/** The epoch a certificate for `name` must currently carry, or null when the ledger is unusable. */
export function currentEpoch(epochs, name) {
  if (!epochs) return null
  return Object.prototype.hasOwnProperty.call(epochs, name) ? epochs[name] : 0
}
