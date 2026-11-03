import crypto from 'node:crypto'
import { verifyPersonalMessageSignature } from '@mysten/sui/verify'
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519'
import { normalizeSuiAddress } from './payment-policy.mjs'
import { getDatabase, hashSessionToken, withTransaction } from './db.mjs'

const CHALLENGE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours

export class WalletAuthError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode=401]
   */
  constructor(message, statusCode = 401) {
    super(message)
    this.name = 'WalletAuthError'
    this.statusCode = statusCode
  }
}

/**
 * Validate that a string is a plausible hex Sui address (0x followed by 1..64 hex chars).
 * @param {string} address
 */
export function isValidSuiAddress(address) {
  if (typeof address !== 'string') return false
  const trimmed = address.trim()
  return /^0x[0-9a-fA-F]{1,64}$/.test(trimmed)
}

/**
 * Decode a hex or base64 string into a Uint8Array.
 * @param {string} input
 */
function decodeBytes(input) {
  const trimmed = String(input || '').trim()
  if (/^(0x)?[0-9a-fA-F]+$/.test(trimmed) && trimmed.replace(/^0x/, '').length % 2 === 0) {
    return Uint8Array.from(Buffer.from(trimmed.replace(/^0x/, ''), 'hex'))
  }
  return Uint8Array.from(Buffer.from(trimmed, 'base64'))
}

/**
 * Cryptographically verify that `signature` over `message` was produced by the private key
 * whose Sui public key derives to `expectedAddress`.
 *
 * Uses the official `@mysten/sui` SDK (`verifyPersonalMessageSignature` and `Ed25519PublicKey`).
 * A valid signature from an unrelated key is ALWAYS rejected because its derived Sui address
 * (`publicKey.toSuiAddress()`) will not match `normalizeSuiAddress(expectedAddress)`.
 *
 * Supports:
 * 1. Standard Sui serialized `signPersonalMessage` signatures (base64 flag || sig || pubkey).
 * 2. Raw 64-byte Ed25519 signatures accompanied by `publicKeyHex` (32-byte Ed25519 public key),
 *    verified only after confirming `new Ed25519PublicKey(pubKeyBytes).toSuiAddress()` equals `expectedAddress`.
 *
 * @param {{
 *   message: string,
 *   expectedAddress: string,
 *   signature: string,
 *   publicKeyHex?: string
 * }} params
 */
export async function verifySuiAddressSignature({
  message,
  expectedAddress,
  signature,
  publicKeyHex,
}) {
  if (!message || typeof message !== 'string') {
    throw new WalletAuthError('Challenge message is required for signature verification.', 400)
  }
  if (!isValidSuiAddress(expectedAddress)) {
    throw new WalletAuthError(`Invalid Sui address "${expectedAddress || ''}".`, 400)
  }
  if (!signature || typeof signature !== 'string' || !signature.trim()) {
    throw new WalletAuthError('A cryptographic wallet signature is required.', 401)
  }

  const normalizedExpected = normalizeSuiAddress(expectedAddress)
  const messageBytes = new TextEncoder().encode(message)

  // Path 1: Standard Sui serialized personal-message signature (base64 with scheme flag + sig + pubkey)
  try {
    const publicKey = await verifyPersonalMessageSignature(messageBytes, signature.trim(), {
      address: normalizedExpected,
    })
    const derivedAddress = normalizeSuiAddress(publicKey.toSuiAddress())
    if (derivedAddress !== normalizedExpected) {
      throw new WalletAuthError(
        `Signature public key derives to ${derivedAddress}, which does not match ${normalizedExpected}.`,
        403
      )
    }
    return {
      verified: true,
      address: derivedAddress,
      publicKeyBase64: publicKey.toBase64(),
      scheme: 'sui_personal_message',
    }
  } catch (suiPersonalErr) {
    if (suiPersonalErr instanceof WalletAuthError) {
      throw suiPersonalErr
    }
    // If no separate publicKeyHex was provided, surface the official Sui verification failure directly.
    if (!publicKeyHex || !String(publicKeyHex).trim()) {
      const msg = suiPersonalErr?.message || 'Invalid Sui personal message signature'
      const status = msg.toLowerCase().includes('address') ? 403 : 401
      throw new WalletAuthError(
        `Sui wallet signature verification failed for ${normalizedExpected}: ${msg}`,
        status
      )
    }
  }

  // Path 2: Explicit 32-byte Ed25519 public key + raw 64-byte signature
  let pubKeyBytes
  try {
    pubKeyBytes = decodeBytes(publicKeyHex)
  } catch {
    throw new WalletAuthError('Malformed publicKeyHex: expected 32-byte Ed25519 public key.', 400)
  }

  if (pubKeyBytes.length !== 32) {
    throw new WalletAuthError(
      `Invalid Ed25519 public key length (${pubKeyBytes.length} bytes; expected 32 bytes).`,
      400
    )
  }

  let suiPubKey
  try {
    suiPubKey = new Ed25519PublicKey(pubKeyBytes)
  } catch (err) {
    throw new WalletAuthError(`Invalid Ed25519 public key: ${err.message}`, 400)
  }

  // CRITICAL: Verify that the Ed25519 public key derives to the exact expected Sui address
  const derivedAddress = normalizeSuiAddress(suiPubKey.toSuiAddress())
  if (derivedAddress !== normalizedExpected) {
    throw new WalletAuthError(
      `Signing key address mismatch: public key derives to ${derivedAddress}, but expected registered address ${normalizedExpected}.`,
      403
    )
  }

  let sigBytes
  try {
    sigBytes = decodeBytes(signature)
  } catch {
    throw new WalletAuthError('Malformed signature bytes.', 400)
  }

  if (sigBytes.length !== 64) {
    throw new WalletAuthError(
      `Invalid Ed25519 signature length (${sigBytes.length} bytes; expected 64 bytes or standard Sui base64 signature).`,
      401
    )
  }

  // Check Sui BCS PersonalMessage signature first, then raw UTF-8 Ed25519 signature
  let isValid = false
  try {
    isValid = await suiPubKey.verifyPersonalMessage(messageBytes, sigBytes)
  } catch {
    isValid = false
  }

  if (!isValid) {
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
    const pubKeyObj = crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, Buffer.from(pubKeyBytes)]),
      format: 'der',
      type: 'spki',
    })
    isValid = crypto.verify(null, Buffer.from(messageBytes), pubKeyObj, Buffer.from(sigBytes))
  }

  if (!isValid) {
    throw new WalletAuthError(
      'Cryptographic Ed25519 signature verification failed for the challenge message.',
      401
    )
  }

  return {
    verified: true,
    address: derivedAddress,
    publicKeyBase64: suiPubKey.toBase64(),
    scheme: 'ed25519_address_bound',
  }
}

/**
 * Issue a single-use login challenge bound to a specific Sui wallet address.
 * @param {{ address: string }} input
 */
export function issueWalletAuthChallenge({ address }) {
  if (!isValidSuiAddress(address)) {
    throw new WalletAuthError('A valid Sui wallet address (0x...) is required.', 400)
  }
  const normalizedAddress = normalizeSuiAddress(address)
  const challengeId = crypto.randomUUID()
  const nonce = crypto.randomUUID()
  const issuedAt = new Date().toISOString()
  const expiresAtMs = Date.now() + CHALLENGE_TTL_MS
  const expiresAt = new Date(expiresAtMs).toISOString()

  const message = [
    'Ajo Savings Circle Steward — Wallet Authentication',
    `Address: ${normalizedAddress}`,
    `ChallengeId: ${challengeId}`,
    `Nonce: ${nonce}`,
    `IssuedAt: ${issuedAt}`,
    `ExpiresAt: ${expiresAt}`,
  ].join('\n')

  const db = getDatabase()
  db.prepare(`
    INSERT INTO wallet_auth_challenges (
      challenge_id, nonce, address, message, issued_at, expires_at, expires_at_ms, consumed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(challengeId, nonce, normalizedAddress, message, issuedAt, expiresAt, expiresAtMs)

  return {
    challengeId,
    nonce,
    address: normalizedAddress,
    message,
    issuedAt,
    expiresAt,
  }
}

/**
 * Verify a signed wallet authentication challenge and issue a server-side session token.
 * Enforces strict one-time challenge consumption persisted in SQLite (`consumed = 1`).
 * Stores only the SHA-256 hash (`token_hash`) of the bearer session token in SQLite;
 * raw session tokens and wallet signature bytes are never persisted to disk.
 *
 * @param {{
 *   challengeId: string,
 *   address: string,
 *   signature: string,
 *   publicKeyHex?: string
 * }} input
 */
export async function verifyWalletAuthChallenge({
  challengeId,
  address,
  signature,
  publicKeyHex,
}) {
  if (!challengeId || typeof challengeId !== 'string') {
    throw new WalletAuthError('challengeId is required.', 400)
  }

  const db = getDatabase()
  const trimmedChallengeId = challengeId.trim()

  const challenge = withTransaction(db, () => {
    const row = db
      .prepare('SELECT * FROM wallet_auth_challenges WHERE challenge_id = ?')
      .get(trimmedChallengeId)
    if (!row || Number(row.consumed) === 1) {
      return null
    }
    const updateRes = db
      .prepare(
        'UPDATE wallet_auth_challenges SET consumed = 1, consumed_at = ? WHERE challenge_id = ? AND consumed = 0'
      )
      .run(new Date().toISOString(), trimmedChallengeId)
    if (updateRes.changes !== 1) {
      return null
    }
    return {
      challengeId: row.challenge_id,
      nonce: row.nonce,
      address: row.address,
      message: row.message,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      expiresAtMs: Number(row.expires_at_ms),
    }
  })

  if (!challenge) {
    throw new WalletAuthError(
      'Invalid or already-consumed wallet authentication challenge.',
      401
    )
  }

  if (Date.now() > challenge.expiresAtMs) {
    throw new WalletAuthError('Wallet authentication challenge has expired.', 401)
  }

  const normalizedAddress = normalizeSuiAddress(address || challenge.address)
  if (normalizedAddress !== challenge.address) {
    throw new WalletAuthError(
      `Challenge address mismatch: challenge was issued for ${challenge.address}, not ${normalizedAddress}.`,
      403
    )
  }

  const verified = await verifySuiAddressSignature({
    message: challenge.message,
    expectedAddress: challenge.address,
    signature,
    publicKeyHex,
  })

  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = hashSessionToken(token)
  const authenticatedAt = new Date().toISOString()
  const expiresAtMs = Date.now() + SESSION_TTL_MS
  const expiresAt = new Date(expiresAtMs).toISOString()

  db.prepare(`
    INSERT INTO wallet_sessions (
      token_hash, wallet_address, public_key_base64, scheme, authenticated_at, expires_at, expires_at_ms, revoked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    tokenHash,
    verified.address,
    verified.publicKeyBase64,
    verified.scheme,
    authenticatedAt,
    expiresAt,
    expiresAtMs
  )

  return {
    token,
    walletAddress: verified.address,
    authenticatedAt,
    expiresAt,
  }
}

/**
 * Extract bearer token from an Express request (`Authorization: Bearer <token>` or `x-wallet-session`).
 */
export function extractSessionToken(req) {
  const authHeader = req?.headers?.authorization || req?.headers?.Authorization
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim()
  }
  const customHeader = req?.headers?.['x-wallet-session']
  if (typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim()
  }
  return null
}

/**
 * Look up an active, non-expired wallet session by token (hashes the token with SHA-256 before lookup).
 * @param {string | null | undefined} token
 */
export function getWalletSessionByToken(token) {
  if (!token || typeof token !== 'string' || !token.trim()) return null
  const db = getDatabase()
  const tokenHash = hashSessionToken(token)
  const row = db
    .prepare('SELECT * FROM wallet_sessions WHERE token_hash = ? AND revoked = 0')
    .get(tokenHash)
  if (!row) return null
  if (Date.now() > Number(row.expires_at_ms)) {
    db.prepare('UPDATE wallet_sessions SET revoked = 1 WHERE token_hash = ?').run(tokenHash)
    return null
  }
  return {
    walletAddress: row.wallet_address,
    publicKeyBase64: row.public_key_base64,
    scheme: row.scheme,
    authenticatedAt: row.authenticated_at,
    expiresAt: row.expires_at,
    expiresAtMs: Number(row.expires_at_ms),
  }
}

/**
 * Require a verified wallet session on an incoming Express request.
 * Throws `WalletAuthError` (HTTP 401) if missing, invalid, or expired.
 */
export function requireWalletSession(req) {
  const token = extractSessionToken(req)
  const session = getWalletSessionByToken(token)
  if (!session) {
    throw new WalletAuthError(
      'Wallet authentication required. Sign a server challenge with your Sui wallet to access this route.',
      401
    )
  }
  return session
}

/**
 * Revoke a wallet session token.
 * @param {string | null | undefined} token
 */
export function revokeWalletSession(token) {
  if (!token || typeof token !== 'string' || !token.trim()) return false
  const db = getDatabase()
  const tokenHash = hashSessionToken(token)
  const res = db
    .prepare('UPDATE wallet_sessions SET revoked = 1 WHERE token_hash = ? AND revoked = 0')
    .run(tokenHash)
  return res.changes > 0
}
