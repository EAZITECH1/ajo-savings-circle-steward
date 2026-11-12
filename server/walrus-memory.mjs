import crypto from 'node:crypto'
import { MemWal } from '@mysten-incubation/memwal'
import { requireIntegrationConfig, loadConfig } from './config.mjs'
import {
  normalizeSuiAddress,
  QUARANTINED_SYNTHETIC_CIRCLES,
  QUARANTINED_SYNTHETIC_BLOB_IDS,
  isQuarantinedSyntheticRecord,
} from './payment-policy.mjs'
import { verifySuiAddressSignature, WalletAuthError } from './wallet-auth.mjs'
import {
  isValidSuiDigest,
  recordSubmittedDigest,
  verifyMemberContributionOnSui,
  clearAllCircleSubmittedDigests,
  TransactionConflictError,
} from './sui-verifier.mjs'

export {
  QUARANTINED_SYNTHETIC_CIRCLES,
  QUARANTINED_SYNTHETIC_BLOB_IDS,
  isQuarantinedSyntheticRecord,
}

const META_MARKER = '\n[AJO_MEMORY_META]'
const FORBIDDEN_SECRET_KEYS = [
  'token',
  'sessionToken',
  'bearerToken',
  'signature',
  'rawSignature',
  'privateKey',
  'secretKey',
  'challengeNonce',
]

/**
 * Runtime registry of active circles, proposals, and one-time confirmation challenges in memory.
 * Per AGENTS.md preview constraints, no runtime SQLite or filesystem database is used.
 * Confirmed memories are written to Walrus Mainnet via @mysten-incubation/memwal.
 */
const circleRegistry = new Map()
const proposalsStore = new Map()
const authChallenges = new Map()
const consumedChallengeNonces = new Set()
const sessionConfirmedCache = new Map() // namespace -> Map<blobId, MemoryRecord>

/**
 * Reject runtime operations against quarantined synthetic sample circles.
 * @param {string} circleId
 */
export function assertCircleNotQuarantined(circleId) {
  if (isQuarantinedSyntheticRecord(circleId)) {
    throw new WalletAuthError(
      `Circle "${circleId}" is quarantined because its namespace contains synthetic sample history that is blocked from runtime use.`,
      403
    )
  }
}

/**
 * Build a deterministic, safe Walrus Memory namespace for a circle.
 * Note: Namespaces isolate vector search per circle within the app's MemWal account,
 * and are NOT cryptographic authorization boundaries — authorization is enforced
 * server-side before every write or recall.
 *
 * @param {string} circleId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveCircleNamespace(circleId, env = process.env) {
  if (!circleId || typeof circleId !== 'string') {
    throw new Error('circleId is required to resolve a Walrus Memory namespace')
  }
  const slug = circleId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) {
    throw new Error(`Invalid circleId "${circleId}"`)
  }
  const cfg = loadConfig(env)
  const prefix = cfg.integrations.memwal.config?.MEMWAL_NAMESPACE_PREFIX || 'ajo-circle'
  return `${prefix}:${slug}`
}

/**
 * Shared in-memory cache of MemWal client instances keyed by endpoint + account + namespace.
 * Prevents redundant preflight /version probes and session rebuilding on every request,
 * which triggers HTTP 429 rate limits on the Walrus relayer.
 */
const memwalClientCache = new Map()

export function clearMemWalClientCache() {
  for (const client of memwalClientCache.values()) {
    try {
      if (typeof client?.destroy === 'function' && !client.destroyed) {
        client.destroy()
      }
    } catch {}
  }
  memwalClientCache.clear()
}

/**
 * Helper to retry Walrus relayer operations with exponential backoff on HTTP 429 rate limit.
 */
export async function withWalrusRetry(fn, maxRetries = 3, baseBackoffMs = 1500) {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (err) {
      attempt++
      const msg = String(err?.message || '')
      const is429 = msg.includes('429') || err?.status === 429 || msg.includes('rate limit') || msg.includes('Too Many Requests')
      if (is429 && attempt <= maxRetries) {
        const delay = baseBackoffMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500)
        console.warn(`[Walrus] Rate limited (429). Retrying attempt ${attempt}/${maxRetries} after ${delay}ms...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }
      throw err
    }
  }
}

/**
 * Create or reuse a configured MemWal SDK client from validated environment variables.
 * Never reads env vars implicitly inside the SDK.
 */
export function createMemWalClient(circleId, env = process.env, options = {}) {
  const { serviceConfig, tunables } = requireIntegrationConfig('memwal', env)
  const namespace = circleId
    ? resolveCircleNamespace(circleId, env)
    : serviceConfig.MEMWAL_NAMESPACE_PREFIX || 'ajo-circle'

  if (options.fresh === true) {
    const client = MemWal.create({
      key: serviceConfig.MEMWAL_KEY,
      accountId: serviceConfig.MEMWAL_ACCOUNT_ID,
      serverUrl: serviceConfig.MEMWAL_SERVER_URL,
      namespace,
      requestTimeoutMs: tunables.requestTimeoutMs,
    })
    return { client, namespace, serviceConfig, tunables, isCached: false }
  }

  const cacheKey = `${serviceConfig.MEMWAL_SERVER_URL}:${serviceConfig.MEMWAL_ACCOUNT_ID}:${namespace}`
  let client = memwalClientCache.get(cacheKey)
  if (!client || client.destroyed) {
    client = MemWal.create({
      key: serviceConfig.MEMWAL_KEY,
      accountId: serviceConfig.MEMWAL_ACCOUNT_ID,
      serverUrl: serviceConfig.MEMWAL_SERVER_URL,
      namespace,
      requestTimeoutMs: tunables.requestTimeoutMs,
    })
    memwalClientCache.set(cacheKey, client)
  }
  return { client, namespace, serviceConfig, tunables, isCached: true }
}

/**
 * Map between internal memoryType and UI category.
 */
export function categoryToMemoryType(category) {
  switch (category) {
    case 'Agreements':
      return 'agreement'
    case 'Member patterns':
      return 'member_pattern'
    case 'Reminder preferences':
      return 'reminder_preference'
    default:
      return 'agreement'
  }
}

export function memoryTypeToCategory(memoryType, fallback = 'Agreements') {
  switch (memoryType) {
    case 'agreement':
      return 'Agreements'
    case 'member_pattern':
    case 'historical_behavior':
      return 'Member patterns'
    case 'reminder_preference':
      return 'Reminder preferences'
    case 'verified_payment_event':
      return 'Member patterns'
    default:
      return fallback
  }
}

/**
 * Compute a deterministic SHA-256 hash of a proposal's canonical content.
 * Used to cryptographically bind a confirmation challenge to the exact proposal fields.
 */
export function computeProposalHash(proposal) {
  const category = String(proposal?.category || 'Agreements').trim()
  const memoryType = String(proposal?.memoryType || categoryToMemoryType(category)).trim()
  const memberId = proposal?.memberId ? String(proposal.memberId).trim() : null
  const rawMemberIds = Array.isArray(proposal?.memberIds)
    ? proposal.memberIds
    : memberId
    ? [memberId]
    : []
  const memberIds = Array.from(new Set(rawMemberIds.map((m) => String(m).trim()).filter(Boolean))).sort()

  const canonical = JSON.stringify({
    circleId: String(proposal?.circleId || '').trim(),
    category,
    memoryType,
    title: String(proposal?.title || '').trim(),
    quote: String(proposal?.quote || '').trim(),
    suggestedAction: String(
      proposal?.suggestedAction || proposal?.context || proposal?.title || ''
    ).trim(),
    memberId,
    memberIds,
    cycle: Number(proposal?.cycle) || 1,
    txDigest: proposal?.txDigest ? String(proposal.txDigest).trim() : null,
  })

  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Compute a deterministic SHA-256 hash of a circle's canonical configuration and minimal roster.
 */
export function computeCircleConfigHash(circleData) {
  const membersCanonical = Array.isArray(circleData?.members)
    ? circleData.members
        .map((m, idx) => ({
          id: String(m.id || `m${idx + 1}`).trim(),
          name: String(m.name || '').trim(),
          address: normalizeSuiAddress(m.address || ''),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : []

  const canonicalObj = {
    circleId: String(circleData?.circleId || '').trim(),
    circleName: String(circleData?.circleName || '').trim(),
    poolAddress: normalizeSuiAddress(circleData?.poolAddress || ''),
    contributionPerMember: Number(circleData?.contributionPerMember) || 0,
    tokenType: String(circleData?.tokenType || '').trim(),
    cycleLength: String(circleData?.cycleLength || 'Monthly').trim(),
    currentCycle: Number(circleData?.currentCycle) || 1,
    organizerAddress: normalizeSuiAddress(
      circleData?.organizerAddress || membersCanonical[0]?.address || ''
    ),
    members: membersCanonical,
  }

  if (circleData?.timeZone && String(circleData.timeZone).trim()) {
    canonicalObj.timeZone = String(circleData.timeZone).trim()
  }
  if (circleData?.windowStart && String(circleData.windowStart).trim()) {
    canonicalObj.windowStart = String(circleData.windowStart).trim()
  }
  if (circleData?.windowEnd && String(circleData.windowEnd).trim()) {
    canonicalObj.windowEnd = String(circleData.windowEnd).trim()
  }

  const canonical = JSON.stringify(canonicalObj)

  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Register or update a circle's configuration and member roster on the server
 * so membership & authorization checks can be enforced server-side.
 *
 * @param {object} circleData
 * @param {{ authenticatedWalletAddress?: string }} [options]
 */
export function upsertCircleRoster(circleData, options = {}) {
  const {
    circleId,
    circleName,
    poolAddress,
    contributionPerMember,
    tokenType,
    cycleLength,
    currentCycle = 1,
    members = [],
    organizerAddress,
  } = circleData

  if (!circleId || !circleName) {
    throw new Error('circleId and circleName are required to register a circle')
  }

  const trimmedCircleId = String(circleId).trim()
  assertCircleNotQuarantined(trimmedCircleId)

  const normalizedMembers = members.map((m, idx) => ({
    id: m.id || `m${idx + 1}`,
    name: String(m.name || '').trim(),
    address: String(m.address || '').trim(),
    avatarColor: m.avatarColor || 'bg-utility-brand-50 text-utility-brand-700',
  }))

  if (normalizedMembers.length === 0) {
    throw new Error('At least one circle member with a valid Sui address is required.')
  }

  // Validate against duplicate member IDs or duplicate member wallet addresses in the roster
  const seenMemberIds = new Set()
  const seenNormalizedAddresses = new Set()
  for (const m of normalizedMembers) {
    if (!m.address) {
      throw new Error(`Member "${m.name || m.id}" is missing a Sui wallet address.`)
    }
    const normAddr = normalizeSuiAddress(m.address)
    if (seenMemberIds.has(m.id)) {
      throw new WalletAuthError(
        `Duplicate member ID "${m.id}" in circle "${trimmedCircleId}". Each member must have a unique member ID.`,
        409
      )
    }
    if (seenNormalizedAddresses.has(normAddr)) {
      throw new WalletAuthError(
        `Duplicate member wallet address "${normAddr}" in circle "${trimmedCircleId}". Each member must have a unique Sui wallet address.`,
        409
      )
    }
    seenMemberIds.add(m.id)
    seenNormalizedAddresses.add(normAddr)
  }

  const existing = circleRegistry.get(trimmedCircleId)
  const authAddr = options.authenticatedWalletAddress
    ? normalizeSuiAddress(options.authenticatedWalletAddress)
    : ''

  if (authAddr) {
    if (existing) {
      const isExistingOrganizer = normalizeSuiAddress(existing.organizerAddress) === authAddr
      const isExistingMember = existing.members.some(
        (m) => normalizeSuiAddress(m.address) === authAddr
      )
      if (!isExistingOrganizer && !isExistingMember) {
        throw new WalletAuthError(
          `Authorization failed: wallet ${authAddr} is not a registered member or organizer of circle "${trimmedCircleId}".`,
          403
        )
      }
    }

    const isInNewRoster = normalizedMembers.some(
      (m) => normalizeSuiAddress(m.address) === authAddr
    )
    if (!isInNewRoster) {
      throw new WalletAuthError(
        `Authenticated wallet (${authAddr}) must be included in the circle member roster.`,
        403
      )
    }
  }

  const normalizedPoolAddress = normalizeSuiAddress(poolAddress || '')
  const poolOwnerMember = normalizedMembers.find(
    (member) => normalizeSuiAddress(member.address) === normalizedPoolAddress,
  )
  if (poolOwnerMember) {
    throw new WalletAuthError(
      `Pool vault address matches member "${poolOwnerMember.name || poolOwnerMember.id}". A contribution sent from that member to the same address is a self-transfer and does not fund a separate pool. Use a dedicated vault address.`,
      400,
    )
  }

  const resolvedOrganizer = existing?.organizerAddress
    ? existing.organizerAddress
    : authAddr
    ? options.authenticatedWalletAddress
    : organizerAddress
    ? String(organizerAddress).trim()
    : normalizedMembers[0]?.address || ''

  const nextCore = {
    circleId: trimmedCircleId,
    circleName: circleName.trim(),
    poolAddress: String(poolAddress || '').trim(),
    contributionPerMember: Number(contributionPerMember) || 0,
    tokenType: String(tokenType || '').trim(),
    cycleLength: String(cycleLength || 'Monthly'),
    currentCycle: Number(currentCycle) || 1,
    members: normalizedMembers,
    organizerAddress: resolvedOrganizer,
    ...(circleData.timeZone ? { timeZone: String(circleData.timeZone).trim() } : existing?.timeZone ? { timeZone: existing.timeZone } : {}),
    ...(circleData.windowStart ? { windowStart: String(circleData.windowStart).trim() } : existing?.windowStart ? { windowStart: existing.windowStart } : {}),
    ...(circleData.windowEnd ? { windowEnd: String(circleData.windowEnd).trim() } : existing?.windowEnd ? { windowEnd: existing.windowEnd } : {}),
  }

  const nextConfigHash = computeCircleConfigHash(nextCore)
  const existingConfigHash = existing?.configHash || (existing ? computeCircleConfigHash(existing) : null)
  const isChanged = Boolean(existing && existingConfigHash !== nextConfigHash)
  const nextVersion = existing
    ? isChanged
      ? (Number(existing.version) || 1) + 1
      : Number(existing.version) || 1
    : Number(circleData.version) || 1
  const previousConfigHash = isChanged
    ? existingConfigHash
    : existing?.previousConfigHash || circleData.previousConfigHash || null

  const record = {
    ...nextCore,
    version: nextVersion,
    configHash: nextConfigHash,
    previousConfigHash,
    walrusConfigBlobId: isChanged ? undefined : existing?.walrusConfigBlobId,
    createdAt: existing?.createdAt || circleData.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  circleRegistry.set(record.circleId, record)
  return record
}

/**
 * Clear all in-memory state for a specific circle (or all circles if omitted) to simulate a server restart
 * or reset state before restoring from Walrus. Never touches walletSessions or consumed nonces.
 */
export function clearCircleRuntimeState(circleId, env = process.env) {
  if (!circleId) {
    for (const cid of Array.from(circleRegistry.keys())) {
      clearAllCircleSubmittedDigests(cid)
    }
    circleRegistry.clear()
    proposalsStore.clear()
    sessionConfirmedCache.clear()
    recordedLatenessMemories.clear()
    recordedSplitMemories.clear()
    recordedReminderOutcomeMemories.clear()
    return
  }
  const trimmed = String(circleId).trim()
  circleRegistry.delete(trimmed)
  for (const [pid, prop] of Array.from(proposalsStore.entries())) {
    if (prop.circleId === trimmed) {
      proposalsStore.delete(pid)
    }
  }
  for (const key of Array.from(recordedLatenessMemories.keys())) {
    if (key.startsWith(`${trimmed}:lateness:`)) {
      recordedLatenessMemories.delete(key)
    }
  }
  for (const key of Array.from(recordedSplitMemories.keys())) {
    if (key.startsWith(`${trimmed}:split:`)) {
      recordedSplitMemories.delete(key)
    }
  }
  for (const key of Array.from(recordedReminderOutcomeMemories.keys())) {
    if (key.startsWith(`${trimmed}:reminder-outcome:`)) {
      recordedReminderOutcomeMemories.delete(key)
    }
  }
  try {
    const ns = resolveCircleNamespace(trimmed, env)
    sessionConfirmedCache.delete(ns)
  } catch {
    // ignore invalid circleId
  }
  clearAllCircleSubmittedDigests(trimmed)
}

export function getCircleRoster(circleId) {
  if (!circleId || isQuarantinedSyntheticRecord(circleId)) return null
  return circleRegistry.get(String(circleId).trim()) || null
}

/**
 * List circles in which `memberAddress` is a registered member (or all non-quarantined circles if internal).
 * @param {{ memberAddress?: string }} [filter]
 */
export function listCircleRosters(filter = {}) {
  const all = Array.from(circleRegistry.values()).filter(
    (c) => !isQuarantinedSyntheticRecord(c.circleId)
  )
  if (!filter.memberAddress) {
    return all
  }
  const normAddr = normalizeSuiAddress(filter.memberAddress)
  return all.filter(
    (c) =>
      normalizeSuiAddress(c.organizerAddress) === normAddr ||
      c.members.some((m) => normalizeSuiAddress(m.address) === normAddr)
  )
}

/**
 * Verify that an actor (`memberId` or `memberAddress`) belongs to the circle's registered roster.
 * When both `memberId` and `memberAddress` are supplied, they MUST refer to the same member record.
 */
export function verifyCircleMembership(circleId, { memberId, memberAddress }) {
  assertCircleNotQuarantined(circleId)
  const circle = circleRegistry.get(String(circleId || '').trim())
  if (!circle) {
    throw new WalletAuthError(
      `Circle "${circleId}" is not registered on the server. Activate or register the circle first.`,
      404
    )
  }
  if (!circle.members || circle.members.length === 0) {
    throw new WalletAuthError(`Circle "${circleId}" has no registered members.`, 403)
  }

  const normAddr = memberAddress ? normalizeSuiAddress(memberAddress) : ''
  const matched = circle.members.find((m) => {
    const idMatch = memberId ? m.id === memberId : true
    const addrMatch = normAddr ? normalizeSuiAddress(m.address) === normAddr : true
    return Boolean(memberId || normAddr) && idMatch && addrMatch
  })

  if (!matched) {
    if (normAddr && circle.organizerAddress && normalizeSuiAddress(circle.organizerAddress) === normAddr) {
      return {
        circle,
        member: {
          id: 'organizer',
          name: 'Organizer',
          address: circle.organizerAddress,
        },
      }
    }
    throw new WalletAuthError(
      `Authorization failed: member (${memberId || memberAddress || 'unknown'}) is not in circle "${circle.circleName}".`,
      403
    )
  }

  return { circle, member: matched }
}

/**
 * Serialize a structured memory record into plaintext + embedded metadata for Walrus Memory.
 * The leading natural-language paragraph is indexed by the Walrus Memory embedding model,
 * while the trailing `[AJO_MEMORY_META]` JSON preserves exact metadata fields on recall.
 */
export function serializeMemoryForWalrus(record) {
  const memoryType = record.memoryType || categoryToMemoryType(record.category)
  const category = record.category || memoryTypeToCategory(memoryType)
  const memberIds = Array.isArray(record.memberIds)
    ? record.memberIds
    : record.memberId
    ? [record.memberId]
    : []

  const plainSentence = record.context || `${record.title}: ${record.quote}`

  const meta = {
    schema: 'ajo-steward-memory/v2',
    recordKind: 'memory',
    id: record.id,
    circleId: record.circleId,
    memoryType,
    category,
    version: Number(record.version) || 1,
    previousProposalHash: record.previousProposalHash || undefined,
    title: record.title,
    sentence: plainSentence,
    quote: record.quote,
    context: record.context || plainSentence,
    cycle: Number(record.cycle) || 1,
    date: record.date || new Date().toISOString().slice(0, 10),
    memberId: record.memberId || memberIds[0] || undefined,
    memberIds,
    confirmedBy: record.confirmedBy,
    confirmedByList: Array.isArray(record.confirmedByList)
      ? record.confirmedByList
      : [record.confirmedBy],
    confirmationType: record.confirmationType || 'organizer_entered',
    confirmingAddress: record.confirmingAddress || undefined,
    proposalHash: record.proposalHash || undefined,
    txDigest: record.txDigest || undefined,
    label: record.label || undefined,
    elapsedMs: record.elapsedMs !== undefined ? record.elapsedMs : undefined,
    elapsedDisplay: record.elapsedDisplay || undefined,
    graceEvaluation: record.graceEvaluation || undefined,
  }

  const naturalText = [
    `[Circle: ${record.circleId}] [Type: ${memoryType}] [Category: ${category}] [Cycle ${meta.cycle}]`,
    `Title: ${record.title}`,
    `Summary: ${plainSentence}`,
    `Source quote: "${record.quote}"`,
    meta.memberIds.length > 0 ? `Members: ${meta.memberIds.join(', ')}` : null,
    meta.txDigest ? `Verified Tx Digest: ${meta.txDigest}` : null,
    `Confirmation: ${meta.confirmedBy}`,
  ]
    .filter(Boolean)
    .join('\n')

  return `${naturalText}${META_MARKER}${JSON.stringify(meta)}`
}

/**
 * Parse a recalled Walrus Memory hit (`{ blob_id, text, distance, created_at }`)
 * into a structured `MemoryRecord` with its real `walrusBlobId`.
 */
export function parseRecalledMemory(hit, fallbackCircleId = 'default') {
  const rawText = String(hit.text || '')
  const markerIdx = rawText.lastIndexOf(META_MARKER)

  if (markerIdx !== -1) {
    const jsonPart = rawText.slice(markerIdx + META_MARKER.length).trim()
    try {
      const meta = JSON.parse(jsonPart)
      return {
        id: meta.id || `walrus-${hit.blob_id}`,
        recordKind: meta.recordKind || (meta.memoryType === 'circle_config' ? 'circle_config' : meta.memoryType === 'tx_digest_association' ? 'tx_digest_association' : 'memory'),
        circleId: meta.circleId || fallbackCircleId,
        memoryType: meta.memoryType || categoryToMemoryType(meta.category),
        category: meta.category || memoryTypeToCategory(meta.memoryType),
        version: Number(meta.version) || 1,
        previousProposalHash: meta.previousProposalHash,
        configHash: meta.configHash,
        previousConfigHash: meta.previousConfigHash,
        circleConfig: meta.circleConfig,
        network: meta.network,
        memberAddress: meta.memberAddress,
        title: meta.title || 'Recorded Circle Memory',
        quote: meta.quote || meta.sentence || '',
        context: meta.context || meta.sentence || '',
        date:
          meta.date ||
          (hit.created_at
            ? new Date(hit.created_at).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : 'Recorded on Walrus'),
        cycle: Number(meta.cycle) || 1,
        confirmedBy: meta.confirmedBy || 'Organizer-entered record',
        confirmedByList: meta.confirmedByList || [meta.confirmedBy || 'Organizer-entered record'],
        confirmationType: meta.confirmationType || 'organizer_entered',
        confirmingAddress: meta.confirmingAddress,
        proposalHash: meta.proposalHash,
        walrusBlobId: hit.blob_id,
        memberId: meta.memberId,
        memberIds: meta.memberIds || (meta.memberId ? [meta.memberId] : []),
        txDigest: meta.txDigest,
        label: meta.label,
        elapsedMs: meta.elapsedMs,
        elapsedDisplay: meta.elapsedDisplay,
        graceEvaluation: meta.graceEvaluation,
        distance: hit.distance,
        createdAt: hit.created_at || meta.createdAt || meta.updatedAt,
      }
    } catch {
      // Fall through to unstructured parser if metadata JSON was truncated
    }
  }

  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const titleLine = lines.find((l) => l.startsWith('Title:'))
  const summaryLine = lines.find((l) => l.startsWith('Summary:'))
  const quoteLine = lines.find((l) => l.startsWith('Source quote:'))

  const title = titleLine
    ? titleLine.replace(/^Title:\s*/, '')
    : lines[0]?.slice(0, 72) || 'Walrus Memory Record'
  const quote = quoteLine
    ? quoteLine.replace(/^Source quote:\s*"?/, '').replace(/"$/, '')
    : rawText.slice(0, 240)
  const context = summaryLine ? summaryLine.replace(/^Summary:\s*/, '') : quote

  return {
    id: `walrus-${hit.blob_id}`,
    circleId: fallbackCircleId,
    memoryType: 'agreement',
    category: 'Agreements',
    title,
    quote,
    context,
    date: hit.created_at
      ? new Date(hit.created_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : 'Recorded on Walrus',
    cycle: 1,
    confirmedBy: 'Recalled from Walrus Memory',
    confirmedByList: ['Recalled from Walrus Memory'],
    confirmationType: 'recalled',
    walrusBlobId: hit.blob_id,
    distance: hit.distance,
    createdAt: hit.created_at,
  }
}

/**
 * Serialize a confirmed circle configuration & minimal member roster snapshot for Walrus Memory.
 * Privacy invariant: only minimal roster fields (`id`, `name`, normalized `address`) and circle
 * operational parameters are written. Session tokens, challenges, and raw signature bytes are never included.
 */
export function serializeCircleConfigForWalrus(circle, approvalMeta = {}) {
  const version = Number(approvalMeta.version ?? circle.version) || 1
  const minimalMembers = (circle.members || []).map((m, idx) => ({
    id: String(m.id || `m${idx + 1}`).trim(),
    name: String(m.name || '').trim(),
    address: normalizeSuiAddress(m.address),
  }))
  const organizerAddress = normalizeSuiAddress(
    circle.organizerAddress || minimalMembers[0]?.address || ''
  )
  const circleConfig = {
    circleId: String(circle.circleId).trim(),
    circleName: String(circle.circleName).trim(),
    poolAddress: normalizeSuiAddress(circle.poolAddress),
    contributionPerMember: Number(circle.contributionPerMember) || 0,
    tokenType: String(circle.tokenType).trim(),
    cycleLength: String(circle.cycleLength || 'Monthly').trim(),
    currentCycle: Number(circle.currentCycle) || 1,
    organizerAddress,
    members: minimalMembers,
    ...(circle.timeZone ? { timeZone: String(circle.timeZone).trim() } : {}),
    ...(circle.windowStart ? { windowStart: String(circle.windowStart).trim() } : {}),
    ...(circle.windowEnd ? { windowEnd: String(circle.windowEnd).trim() } : {}),
  }
  const configHash = computeCircleConfigHash(circleConfig)
  const previousConfigHash =
    approvalMeta.previousConfigHash !== undefined
      ? approvalMeta.previousConfigHash
      : circle.previousConfigHash || null

  const confirmationType = approvalMeta.confirmationType || 'organizer_entered'
  const confirmingAddress = normalizeSuiAddress(
    approvalMeta.confirmingAddress || organizerAddress
  )
  const confirmedBy =
    approvalMeta.confirmedBy ||
    `Organizer-entered setup by ${confirmingAddress} — organizer entry only, not member-signed consensus`

  const meta = {
    schema: 'ajo-steward-memory/v2',
    recordKind: 'circle_config',
    memoryType: 'circle_config',
    category: 'Agreements',
    id: approvalMeta.id || `cfg-${circleConfig.circleId}-v${version}`,
    circleId: circleConfig.circleId,
    version,
    configHash,
    previousConfigHash,
    circleConfig,
    title: `Circle Configuration v${version}: ${circleConfig.circleName}`,
    quote: `Pool ${circleConfig.poolAddress} | ${circleConfig.contributionPerMember} ${circleConfig.tokenType} (${circleConfig.cycleLength}, Cycle ${circleConfig.currentCycle}) | ${minimalMembers.length} members`,
    context: `Confirmed circle configuration and roster snapshot v${version} for ${circleConfig.circleName} (${circleConfig.circleId}).`,
    cycle: circleConfig.currentCycle,
    confirmedBy,
    confirmedByList: Array.isArray(approvalMeta.confirmedByList)
      ? approvalMeta.confirmedByList
      : [confirmedBy],
    confirmationType,
    confirmingAddress,
    proposalId: approvalMeta.proposalId || undefined,
    proposalHash: approvalMeta.proposalHash || configHash,
    updatedAt: approvalMeta.updatedAt || circle.updatedAt || new Date().toISOString(),
  }

  const naturalText = [
    `[Circle: ${circleConfig.circleId}] [Type: circle_config] [Version: ${version}] [Cycle ${circleConfig.currentCycle}]`,
    `Title: ${meta.title}`,
    `Summary: ${meta.context}`,
    `Pool: ${circleConfig.poolAddress} | Contribution: ${circleConfig.contributionPerMember} ${circleConfig.tokenType} | CycleLength: ${circleConfig.cycleLength}`,
    `Roster Members: ${minimalMembers.map((m) => `${m.id}:${m.name}(${m.address})`).join(', ')}`,
    `Confirmation: ${confirmedBy}`,
  ].join('\n')

  return `${naturalText}${META_MARKER}${JSON.stringify(meta)}`
}

/**
 * Serialize a confirmed transaction digest association for Walrus Memory.
 * Invariant: A digest association records ONLY that a digest was submitted for `(circleId, cycle, memberId, memberAddress)`
 * on `network`. It is NEVER treated as verified payment evidence until Tatum confirms the on-chain transaction.
 */
export function serializeTxDigestAssociationForWalrus(assoc, approvalMeta = {}) {
  const circleId = String(assoc.circleId || '').trim()
  const cycle = Number(assoc.cycle) || 1
  const memberId = String(assoc.memberId || '').trim()
  const memberAddress = normalizeSuiAddress(assoc.memberAddress || '')
  const txDigest = String(assoc.txDigest || '').trim()
  const network = String(assoc.network || 'testnet').trim()
  const version = Number(assoc.version) || 1
  const confirmingAddress = normalizeSuiAddress(
    approvalMeta.confirmingAddress || memberAddress
  )
  const confirmationType =
    approvalMeta.confirmationType || 'member_submitted_digest'
  const confirmedBy =
    approvalMeta.confirmedBy ||
    `Digest association recorded by ${confirmingAddress} — unverified until Tatum confirms on Sui ${network}`

  const meta = {
    schema: 'ajo-steward-memory/v2',
    recordKind: 'tx_digest_association',
    memoryType: 'tx_digest_association',
    category: 'Member patterns',
    id: approvalMeta.id || `txassoc-${circleId}-${cycle}-${txDigest}`,
    circleId,
    cycle,
    memberId,
    memberAddress,
    txDigest,
    network,
    version,
    title: `Submitted Tx Digest Association (${txDigest.slice(0, 10)}...)`,
    quote: `Member ${memberId} (${memberAddress}) associated Sui ${network} digest ${txDigest} with cycle ${cycle}. Requires live Tatum re-verification.`,
    context: `Submitted transaction digest association for ${memberId} in cycle ${cycle} on Sui ${network}.`,
    confirmedBy,
    confirmedByList: [confirmedBy],
    confirmationType,
    confirmingAddress,
    proposalHash: approvalMeta.proposalHash || undefined,
    createdAt: approvalMeta.createdAt || new Date().toISOString(),
  }

  const naturalText = [
    `[Circle: ${circleId}] [Type: tx_digest_association] [Cycle ${cycle}] [Network: ${network}]`,
    `Title: ${meta.title}`,
    `Summary: ${meta.context}`,
    `Source quote: "${meta.quote}"`,
    `Members: ${memberId}`,
    `Submitted Tx Digest: ${txDigest}`,
    `Confirmation: ${confirmedBy}`,
  ].join('\n')

  return `${naturalText}${META_MARKER}${JSON.stringify(meta)}`
}

function isValidNormalizedSuiAddress(addr) {
  if (typeof addr !== 'string' || !addr.trim()) return false
  const norm = normalizeSuiAddress(addr)
  return /^0x[0-9a-f]{64}$/.test(norm)
}

/**
 * Validate a recalled Walrus blob hit (`{ blob_id, text, created_at, distance }`) for circle recovery.
 * Rejects missing/corrupt metadata JSON, forbidden secret fields, circleId mismatches, invalid addresses/digests,
 * or invalid approval metadata.
 */
export function validateWalrusRecordForRestore(hit, expectedCircleId) {
  const blobId = String(hit?.blob_id || '').trim()
  const rawText = String(hit?.text || '')
  if (!blobId) {
    return { valid: false, error: 'Missing Walrus blob_id on recalled hit.' }
  }
  const markerIdx = rawText.lastIndexOf(META_MARKER)
  if (markerIdx === -1) {
    return {
      valid: false,
      error: 'Missing structured [AJO_MEMORY_META] envelope; unstructured text cannot be trusted for state reconstruction.',
    }
  }

  let meta
  try {
    meta = JSON.parse(rawText.slice(markerIdx + META_MARKER.length).trim())
  } catch {
    return {
      valid: false,
      error: 'Corrupt or truncated [AJO_MEMORY_META] JSON payload.',
    }
  }

  if (!meta || typeof meta !== 'object') {
    return { valid: false, error: 'Metadata payload is not a JSON object.' }
  }

  // Ensure no bearer tokens, session tokens, or raw wallet signatures were embedded in the record
  for (const forbiddenKey of FORBIDDEN_SECRET_KEYS) {
    if (meta[forbiddenKey] !== undefined && meta[forbiddenKey] !== null) {
      return {
        valid: false,
        error: `Record contains forbidden sensitive field "${forbiddenKey}".`,
      }
    }
  }

  if (
    meta.schema !== 'ajo-steward-memory/v1' &&
    meta.schema !== 'ajo-steward-memory/v2'
  ) {
    return {
      valid: false,
      error: `Unsupported record schema "${String(meta.schema || 'unknown')}".`,
    }
  }

  const recordCircleId = String(meta.circleId || '').trim()
  if (!recordCircleId || recordCircleId !== String(expectedCircleId).trim()) {
    return {
      valid: false,
      error: `Circle ID mismatch: record belongs to "${recordCircleId || 'unknown'}", expected "${expectedCircleId}".`,
    }
  }

  if (
    meta.confirmingAddress !== undefined &&
    meta.confirmingAddress !== null &&
    !isValidNormalizedSuiAddress(meta.confirmingAddress)
  ) {
    return {
      valid: false,
      error: `Invalid confirmingAddress "${meta.confirmingAddress}" in approval metadata.`,
    }
  }

  const confirmedByStr = String(meta.confirmedBy || '').trim()
  if (!confirmedByStr) {
    return {
      valid: false,
      error: 'Missing confirmedBy approval metadata.',
    }
  }

  const recordKind =
    meta.recordKind ||
    (meta.memoryType === 'circle_config'
      ? 'circle_config'
      : meta.memoryType === 'tx_digest_association'
      ? 'tx_digest_association'
      : 'memory')

  if (recordKind === 'circle_config') {
    const cfg = meta.circleConfig
    if (!cfg || typeof cfg !== 'object') {
      return {
        valid: false,
        error: 'circle_config record is missing circleConfig object.',
        missingFields: ['circleConfig'],
      }
    }
    const missingFields = []
    if (!cfg.circleId || String(cfg.circleId).trim() !== recordCircleId) {
      missingFields.push('circleId')
    }
    if (!cfg.circleName || !String(cfg.circleName).trim()) {
      missingFields.push('circleName')
    }
    if (!isValidNormalizedSuiAddress(cfg.poolAddress)) {
      missingFields.push('poolAddress')
    }
    if (!cfg.tokenType || !String(cfg.tokenType).trim()) {
      missingFields.push('tokenType')
    }
    if (!(Number(cfg.contributionPerMember) > 0)) {
      missingFields.push('contributionPerMember')
    }
    if (!cfg.cycleLength || !String(cfg.cycleLength).trim()) {
      missingFields.push('cycleLength')
    }
    if (!(Number(cfg.currentCycle) >= 1)) {
      missingFields.push('currentCycle')
    }
    if (!isValidNormalizedSuiAddress(cfg.organizerAddress)) {
      missingFields.push('organizerAddress')
    }
    if (!Array.isArray(cfg.members) || cfg.members.length === 0) {
      missingFields.push('members')
    }

    if (missingFields.length > 0) {
      return {
        valid: false,
        error: `Incomplete circle_config record: missing or invalid fields (${missingFields.join(', ')}).`,
        missingFields,
      }
    }

    const seenIds = new Set()
    const seenAddrs = new Set()
    const normalizedMembers = []
    for (const m of cfg.members) {
      const mid = String(m?.id || '').trim()
      const mname = String(m?.name || '').trim()
      if (!mid || !mname || !isValidNormalizedSuiAddress(m?.address)) {
        return {
          valid: false,
          error: `Malformed member entry (${mid || 'unknown'}) in circle_config roster.`,
          missingFields: ['members'],
        }
      }
      const normAddr = normalizeSuiAddress(m.address)
      if (seenIds.has(mid) || seenAddrs.has(normAddr)) {
        return {
          valid: false,
          error: `Duplicate member ID ("${mid}") or wallet address ("${normAddr}") in circle_config roster.`,
        }
      }
      seenIds.add(mid)
      seenAddrs.add(normAddr)
      normalizedMembers.push({
        id: mid,
        name: mname,
        address: normAddr,
        avatarColor: 'bg-utility-brand-50 text-utility-brand-700',
      })
    }

    const normalizedConfig = {
      circleId: recordCircleId,
      circleName: String(cfg.circleName).trim(),
      poolAddress: normalizeSuiAddress(cfg.poolAddress),
      contributionPerMember: Number(cfg.contributionPerMember),
      tokenType: String(cfg.tokenType).trim(),
      cycleLength: String(cfg.cycleLength).trim(),
      currentCycle: Number(cfg.currentCycle),
      organizerAddress: normalizeSuiAddress(cfg.organizerAddress),
      members: normalizedMembers,
      ...(cfg.timeZone ? { timeZone: String(cfg.timeZone).trim() } : {}),
      ...(cfg.windowStart ? { windowStart: String(cfg.windowStart).trim() } : {}),
      ...(cfg.windowEnd ? { windowEnd: String(cfg.windowEnd).trim() } : {}),
    }

    const computedHash = computeCircleConfigHash(normalizedConfig)
    if (meta.configHash && meta.configHash !== computedHash) {
      return {
        valid: false,
        error: `circle_config integrity check failed: computed configHash (${computedHash}) does not match recorded configHash (${meta.configHash}).`,
      }
    }

    const version = Number(meta.version)
    if (!Number.isInteger(version) || version < 1) {
      return {
        valid: false,
        error: `Invalid circle_config version "${meta.version}".`,
      }
    }

    return {
      valid: true,
      recordKind: 'circle_config',
      blobId,
      version,
      configHash: computedHash,
      previousConfigHash: meta.previousConfigHash || null,
      circleConfig: normalizedConfig,
      confirmedBy: confirmedByStr,
      confirmationType: meta.confirmationType || 'organizer_entered',
      confirmingAddress: meta.confirmingAddress
        ? normalizeSuiAddress(meta.confirmingAddress)
        : normalizedConfig.organizerAddress,
      updatedAt: meta.updatedAt || hit.created_at || new Date().toISOString(),
    }
  }

  if (recordKind === 'tx_digest_association') {
    const missingFields = []
    const txDigest = String(meta.txDigest || '').trim()
    const network = String(meta.network || '').trim()
    const memberId = String(meta.memberId || '').trim()
    const cycle = Number(meta.cycle)

    if (!isValidSuiDigest(txDigest)) missingFields.push('txDigest')
    if (network !== 'testnet' && network !== 'mainnet') missingFields.push('network')
    if (!memberId) missingFields.push('memberId')
    if (!isValidNormalizedSuiAddress(meta.memberAddress)) missingFields.push('memberAddress')
    if (!Number.isInteger(cycle) || cycle < 1) missingFields.push('cycle')

    if (missingFields.length > 0) {
      return {
        valid: false,
        error: `Malformed tx_digest_association record: invalid or missing (${missingFields.join(', ')}).`,
        missingFields,
      }
    }

    return {
      valid: true,
      recordKind: 'tx_digest_association',
      blobId,
      id: meta.id || `txassoc-${recordCircleId}-${cycle}-${txDigest}`,
      circleId: recordCircleId,
      cycle,
      memberId,
      memberAddress: normalizeSuiAddress(meta.memberAddress),
      txDigest,
      network,
      version: Number(meta.version) || 1,
      confirmedBy: confirmedByStr,
      confirmationType: meta.confirmationType || 'member_submitted_digest',
      confirmingAddress: meta.confirmingAddress
        ? normalizeSuiAddress(meta.confirmingAddress)
        : normalizeSuiAddress(meta.memberAddress),
      createdAt: meta.createdAt || hit.created_at || new Date().toISOString(),
    }
  }

  // Standard confirmed group memory (`agreement`, `member_pattern`, `reminder_preference`, `verified_payment_event`)
  const title = String(meta.title || '').trim()
  const quote = String(meta.quote || meta.sentence || '').trim()
  const cycle = Number(meta.cycle) || 1
  if (!title || !quote) {
    return {
      valid: false,
      error: 'Memory record is missing required title or quote.',
      missingFields: [!title ? 'title' : null, !quote ? 'quote' : null].filter(Boolean),
    }
  }
  if (meta.txDigest && !isValidSuiDigest(String(meta.txDigest))) {
    return {
      valid: false,
      error: `Memory record contains malformed txDigest "${meta.txDigest}".`,
    }
  }

  const parsedMemory = parseRecalledMemory(hit, expectedCircleId)
  return {
    valid: true,
    recordKind: 'memory',
    blobId,
    version: Number(meta.version) || 1,
    previousProposalHash: meta.previousProposalHash || null,
    record: parsedMemory,
  }
}

/**
 * Create a memory proposal on the server (Step 1 of Propose -> Confirm -> Write).
 * The agent or member may only PROPOSE memories; nothing is written to Walrus until confirmed.
 */
export function proposeCircleMemory(input) {
  const {
    circleId,
    category = 'Agreements',
    memoryType,
    title,
    quote,
    suggestedAction,
    memberId,
    memberIds,
    cycle = 1,
    txDigest,
    proposedBy = 'steward',
  } = input

  if (!circleId) throw new Error('circleId is required to propose a memory')
  assertCircleNotQuarantined(circleId)
  if (!title || !quote) throw new Error('title and quote are required to propose a memory')

  const draft = {
    id: `prop-${crypto.randomUUID()}`,
    circleId: String(circleId).trim(),
    category,
    memoryType: memoryType || categoryToMemoryType(category),
    title: String(title).trim(),
    quote: String(quote).trim(),
    suggestedAction: String(suggestedAction || title).trim(),
    memberId: memberId ? String(memberId).trim() : undefined,
    memberIds: Array.isArray(memberIds)
      ? memberIds
      : memberId
      ? [String(memberId).trim()]
      : [],
    cycle: Number(cycle) || 1,
    txDigest: txDigest ? String(txDigest).trim() : undefined,
    proposedBy,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }

  const proposal = {
    ...draft,
    proposalHash: computeProposalHash(draft),
  }

  proposalsStore.set(proposal.id, proposal)
  return proposal
}

export function getPendingProposals(circleId) {
  return Array.from(proposalsStore.values()).filter(
    (p) => p.status === 'pending' && (!circleId || p.circleId === String(circleId).trim())
  )
}

export function getProposalById(proposalId) {
  if (!proposalId || typeof proposalId !== 'string') return null
  return proposalsStore.get(proposalId.trim()) || null
}

export function getCircleProposals(circleId, { status } = {}) {
  if (!circleId) return []
  const trimmed = String(circleId).trim()
  return Array.from(proposalsStore.values()).filter(
    (p) => p.circleId === trimmed && (!status || p.status === status)
  )
}

/**
 * Issue a server-side challenge for a member to sign and confirm a specific proposed memory.
 * Binds the challenge to:
 * - `circleId`
 * - `proposalId`
 * - `proposalHash` (SHA-256 of canonical proposal content)
 * - `member.id` and normalized `member.address`
 * - `nonce` (single-use)
 * - `expiresAt`
 */
export function issueConfirmationChallenge({ circleId, proposalId, memberId, memberAddress }) {
  assertCircleNotQuarantined(circleId)
  const { member } = verifyCircleMembership(circleId, { memberId, memberAddress })

  if (!proposalId || typeof proposalId !== 'string') {
    throw new WalletAuthError('proposalId is required to issue a confirmation challenge.', 400)
  }

  const storedProposal = getProposalById(proposalId)
  if (
    !storedProposal ||
    storedProposal.circleId !== circleId ||
    storedProposal.status !== 'pending'
  ) {
    throw new WalletAuthError(
      `Proposal "${proposalId}" was not found in pending proposals for circle "${circleId}". Stage the proposal before requesting a confirmation challenge.`,
      404
    )
  }

  // Prevent member impersonation: if proposal is targeted at a specific member, only they can confirm
  if (storedProposal.memberId && storedProposal.memberId !== member.id) {
    throw new WalletAuthError(
      `Authorization mismatch: This agreement proposal specifically pertains to member ID "${storedProposal.memberId}", but the requesting wallet belongs to ${member.name} (${member.id}). Member impersonation is strictly forbidden.`,
      403
    )
  }

  const proposalHash = computeProposalHash(storedProposal)
  const normalizedMemberAddress = normalizeSuiAddress(member.address)
  const nonce = crypto.randomUUID()
  const issuedAt = new Date().toISOString()
  const expiresAtMs = Date.now() + 10 * 60 * 1000
  const expiresAt = new Date(expiresAtMs).toISOString()

  const message = [
    'Ajo Steward Memory Confirmation',
    `Circle: ${circleId}`,
    `Proposal: ${storedProposal.id}`,
    `ProposalHash: ${proposalHash}`,
    `Category: ${storedProposal.category}`,
    `Title: ${storedProposal.title}`,
    `Quote: ${storedProposal.quote}`,
    `Cycle: ${storedProposal.cycle}`,
    `Member: ${member.id} (${normalizedMemberAddress})`,
    `Nonce: ${nonce}`,
    `IssuedAt: ${issuedAt}`,
    `ExpiresAt: ${expiresAt}`,
  ].join('\n')

  authChallenges.set(nonce, {
    nonce,
    circleId,
    proposalId: storedProposal.id,
    proposalHash,
    memberId: member.id,
    memberAddress: normalizedMemberAddress,
    message,
    issuedAt,
    expiresAt,
    expiresAtMs,
  })

  return {
    nonce,
    proposalId: storedProposal.id,
    proposalHash,
    message,
    issuedAt,
    expiresAt,
    member,
  }
}

/**
 * Confirm a proposed memory and write it to Walrus Mainnet via @mysten-incubation/memwal.
 *
 * Security invariants:
 * 1. Member-signed confirmation (`wallet_signature_verified`) requires a valid one-time `challengeNonce`
 *    bound to `(circleId, proposalId, proposalHash, memberId, memberAddress)` and a signature whose
 *    Sui public key derives to `normalizeSuiAddress(member.address)`.
 * 2. A valid signature from an unrelated key is ALWAYS rejected.
 * 3. `challengeNonce` is consumed immediately on first lookup (strictly one-time use).
 * 4. Organizer-entered records (`organizer_entered`) can only be submitted by the circle's registered
 *    `organizerAddress` and are labeled distinctly from member-signed confirmations.
 * 5. Neither a single member signature nor an organizer-entered record is labeled as full group consensus.
 */
export async function confirmAndWriteMemory(input, env = process.env) {
  const {
    circleId,
    proposalId,
    proposal: inlineProposal,
    memberId,
    memberAddress,
    signature,
    challengeNonce,
    publicKeyHex,
    confirmationMode,
    memwalClientOverride,
  } = input

  if (!circleId) {
    throw new Error('circleId is required to confirm a memory')
  }
  assertCircleNotQuarantined(circleId)

  // Enforce server-side circle membership
  const { circle, member } = verifyCircleMembership(circleId, { memberId, memberAddress })
  const normalizedMemberAddr = normalizeSuiAddress(member.address)

  const storedProposal = proposalId ? getProposalById(String(proposalId).trim()) : null
  if (storedProposal && storedProposal.circleId !== circleId) {
    throw new WalletAuthError(
      `Proposal "${proposalId}" does not belong to circle "${circleId}".`,
      403
    )
  }

  const wantsSignatureVerification =
    confirmationMode === 'wallet_signature_verified' ||
    Boolean(signature) ||
    Boolean(challengeNonce) ||
    Boolean(publicKeyHex)

  let proposalToWrite = storedProposal || inlineProposal

  // Prevent member impersonation: if proposal is targeted at a specific member, only they can confirm
  if (proposalToWrite?.memberId && proposalToWrite.memberId !== member.id) {
    throw new WalletAuthError(
      `Authorization mismatch: This agreement proposal specifically pertains to member ID "${proposalToWrite.memberId}", but the confirming wallet belongs to ${member.name} (${member.id}). Member impersonation is strictly forbidden.`,
      403
    )
  }

  let confirmationType = 'organizer_entered'
  let confirmedByLabel = `Organizer-entered record by ${member.name} (${normalizedMemberAddr}) — organizer entry only, not member-signed consensus`
  let verifiedProposalHash = undefined

  if (wantsSignatureVerification) {
    if (!challengeNonce || !signature || !proposalId) {
      throw new WalletAuthError(
        'proposalId, challengeNonce, and wallet signature are all required for wallet_signature_verified confirmation.',
        400
      )
    }

    const trimmedNonce = String(challengeNonce).trim()
    if (consumedChallengeNonces.has(trimmedNonce)) {
      throw new WalletAuthError(
        'Invalid or already-consumed confirmation challenge nonce.',
        401
      )
    }

    const challenge = authChallenges.get(trimmedNonce)
    // Enforce strict one-time challenge consumption before any validation
    authChallenges.delete(trimmedNonce)
    consumedChallengeNonces.add(trimmedNonce)

    if (!challenge) {
      throw new WalletAuthError(
        'Invalid or already-consumed confirmation challenge nonce.',
        401
      )
    }

    if (Date.now() > challenge.expiresAtMs) {
      throw new WalletAuthError('Confirmation challenge nonce has expired.', 401)
    }

    if (
      challenge.circleId !== circleId ||
      challenge.proposalId !== String(proposalId).trim() ||
      challenge.memberId !== member.id ||
      normalizeSuiAddress(challenge.memberAddress) !== normalizedMemberAddr
    ) {
      throw new WalletAuthError(
        'Confirmation challenge does not match circleId, proposalId, or confirming member wallet.',
        403
      )
    }

    if (!storedProposal || storedProposal.status !== 'pending') {
      throw new WalletAuthError(
        `Pending proposal "${proposalId}" was not found or was already confirmed.`,
        404
      )
    }

    const storedHash = computeProposalHash(storedProposal)
    if (storedHash !== challenge.proposalHash) {
      throw new WalletAuthError(
        'Stored proposal content does not match the signed challenge proposalHash.',
        403
      )
    }

    if (inlineProposal) {
      const inlineHash = computeProposalHash({
        ...storedProposal,
        ...inlineProposal,
        circleId,
      })
      if (inlineHash !== challenge.proposalHash) {
        throw new WalletAuthError(
          'Submitted proposal payload does not match the signed challenge proposalHash.',
          403
        )
      }
    }

    // Verify signature AND prove signing public key derives to member.address
    await verifySuiAddressSignature({
      message: challenge.message,
      expectedAddress: member.address,
      signature,
      publicKeyHex,
    })

    proposalToWrite = storedProposal
    verifiedProposalHash = challenge.proposalHash
    confirmationType = 'wallet_signature_verified'
    confirmedByLabel = `Member-signed by ${member.name} (${normalizedMemberAddr}) — 1 wallet signature, not full group consensus`
  } else {
    // Organizer-entered confirmation: only allowed if the confirming member is the registered circle organizer
    if (normalizedMemberAddr !== normalizeSuiAddress(circle.organizerAddress)) {
      throw new WalletAuthError(
        `Only the circle organizer (${circle.organizerAddress}) may record an organizer-entered memory without a proposal-bound member wallet signature.`,
        403
      )
    }
    if (storedProposal && storedProposal.status !== 'pending') {
      throw new WalletAuthError(
        `Proposal "${proposalId}" was already ${storedProposal.status}.`,
        409
      )
    }
    if (!proposalToWrite || !proposalToWrite.title || !proposalToWrite.quote) {
      throw new WalletAuthError(
        'Valid memory proposal (proposalId or proposal payload) is required for confirmation.',
        400
      )
    }
    verifiedProposalHash = computeProposalHash({ ...proposalToWrite, circleId })
  }

  const { client, namespace, tunables, isCached } = memwalClientOverride
    ? {
        client: memwalClientOverride,
        namespace: resolveCircleNamespace(circleId, env),
        tunables: loadConfig(env).tunables,
        isCached: false,
      }
    : createMemWalClient(circleId, env)
  try {
    const recordId = `mem-${crypto.randomUUID()}`
    const dateStr = new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })

    const draftRecord = {
      id: recordId,
      circleId: circle.circleId,
      memoryType: proposalToWrite.memoryType || categoryToMemoryType(proposalToWrite.category),
      category: proposalToWrite.category || 'Agreements',
      title: proposalToWrite.title,
      quote: proposalToWrite.quote,
      context:
        proposalToWrite.suggestedAction || proposalToWrite.context || proposalToWrite.title,
      date: dateStr,
      cycle: Number(proposalToWrite.cycle) || circle.currentCycle || 1,
      confirmedBy: confirmedByLabel,
      confirmedByList: [confirmedByLabel],
      confirmationType,
      confirmingAddress: normalizedMemberAddr,
      proposalHash: verifiedProposalHash,
      memberId: proposalToWrite.memberId,
      memberIds:
        proposalToWrite.memberIds ||
        (proposalToWrite.memberId ? [proposalToWrite.memberId] : []),
      txDigest: proposalToWrite.txDigest,
    }

    const serializedText = serializeMemoryForWalrus(draftRecord)

    // Write to Walrus Mainnet and wait for terminal completion (`done` + real `blob_id`)
    const rememberResult = await withWalrusRetry(() =>
      client.rememberAndWait(serializedText, namespace, {
        pollIntervalMs: tunables.pollingIntervalMs,
        timeoutMs: Math.max(tunables.requestTimeoutMs * 4, 90000),
        idempotencyKey: `${circle.circleId}:${proposalToWrite.id || recordId}`,
      })
    )

    if (!rememberResult || !rememberResult.blob_id) {
      throw new Error('Walrus Memory write completed without returning a valid blob_id.')
    }

    const confirmedAt = new Date().toISOString()
    const savedRecord = {
      ...draftRecord,
      id: rememberResult.id || recordId,
      jobId: rememberResult.job_id || rememberResult.id,
      walrusBlobId: rememberResult.blob_id,
      namespace: rememberResult.namespace || namespace,
      owner: rememberResult.owner,
      createdAt: confirmedAt,
    }

    if (proposalId && proposalsStore.has(String(proposalId).trim())) {
      const existingProp = proposalsStore.get(String(proposalId).trim())
      proposalsStore.set(String(proposalId).trim(), {
        ...existingProp,
        status: 'confirmed',
        walrusBlobId: savedRecord.walrusBlobId,
        confirmedBy: confirmedByLabel,
        confirmationType,
        confirmingAddress: normalizedMemberAddr,
        confirmedAt,
      })
    }

    if (!sessionConfirmedCache.has(namespace)) {
      sessionConfirmedCache.set(namespace, new Map())
    }
    sessionConfirmedCache.get(namespace).set(savedRecord.walrusBlobId, savedRecord)

    return savedRecord
  } finally {
    if (!isCached && typeof client.destroy === 'function') {
      client.destroy()
    }
  }
}

/**
 * Persist a circle's confirmed configuration and minimal member roster to Walrus Memory.
 * Distinguishes organizer-signed/entered initial setup from member-signed configuration changes,
 * and never represents a single signature as full group consensus.
 */
export async function persistCircleConfigToWalrus(input, env = process.env) {
  const {
    circleId,
    memberId,
    memberAddress,
    signature,
    challengeNonce,
    publicKeyHex,
    proposalId,
    memwalClientOverride,
  } = input || {}

  if (!circleId) {
    throw new Error('circleId is required to persist circle configuration to Walrus.')
  }
  assertCircleNotQuarantined(circleId)

  const { circle, member } = verifyCircleMembership(circleId, { memberId, memberAddress })
  const normalizedMemberAddr = normalizeSuiAddress(member.address)
  const isOrganizer = normalizedMemberAddr === normalizeSuiAddress(circle.organizerAddress)

  const wantsSignature = Boolean(signature || challengeNonce || publicKeyHex)
  let confirmationType = 'organizer_entered'
  let confirmedByLabel = `Organizer-entered setup by ${member.name} (${normalizedMemberAddr}) — organizer entry only, not member-signed consensus`

  if (wantsSignature) {
    if (!challengeNonce || !signature || !proposalId) {
      throw new WalletAuthError(
        'proposalId, challengeNonce, and wallet signature are required for signed circle configuration persistence.',
        400
      )
    }
    const trimmedNonce = String(challengeNonce).trim()
    if (consumedChallengeNonces.has(trimmedNonce)) {
      throw new WalletAuthError('Invalid or already-consumed confirmation challenge nonce.', 401)
    }
    const challenge = authChallenges.get(trimmedNonce)
    authChallenges.delete(trimmedNonce)
    consumedChallengeNonces.add(trimmedNonce)

    if (!challenge || Date.now() > challenge.expiresAtMs) {
      throw new WalletAuthError('Invalid or expired confirmation challenge nonce.', 401)
    }
    if (
      challenge.circleId !== circle.circleId ||
      challenge.proposalId !== String(proposalId).trim() ||
      challenge.memberId !== member.id ||
      normalizeSuiAddress(challenge.memberAddress) !== normalizedMemberAddr
    ) {
      throw new WalletAuthError(
        'Confirmation challenge does not match circleId, proposalId, or confirming member wallet.',
        403
      )
    }

    await verifySuiAddressSignature({
      message: challenge.message,
      expectedAddress: member.address,
      signature,
      publicKeyHex,
    })

    if (isOrganizer && (Number(circle.version) || 1) === 1) {
      confirmationType = 'organizer_signed_setup'
      confirmedByLabel = `Organizer-signed setup by ${member.name} (${normalizedMemberAddr}) — 1 organizer wallet signature, not multi-member group consensus`
    } else {
      confirmationType = 'wallet_signature_verified'
      confirmedByLabel = `Member-signed configuration change by ${member.name} (${normalizedMemberAddr}) — 1 wallet signature, not full group consensus`
    }
  } else {
    if (!isOrganizer) {
      throw new WalletAuthError(
        `Only the circle organizer (${circle.organizerAddress}) may persist an organizer-entered circle configuration without a proposal-bound wallet signature.`,
        403
      )
    }
    if ((Number(circle.version) || 1) > 1) {
      confirmedByLabel = `Organizer-entered configuration update v${circle.version} by ${member.name} (${normalizedMemberAddr}) — organizer entry only, not member-signed consensus`
    }
  }

  const { client, namespace, tunables, isCached } = memwalClientOverride
    ? {
        client: memwalClientOverride,
        namespace: resolveCircleNamespace(circle.circleId, env),
        tunables: loadConfig(env).tunables,
        isCached: false,
      }
    : createMemWalClient(circle.circleId, env)

  try {
    const version = Number(circle.version) || 1
    const configHash = circle.configHash || computeCircleConfigHash(circle)
    const serialized = serializeCircleConfigForWalrus(circle, {
      version,
      previousConfigHash: circle.previousConfigHash || null,
      confirmationType,
      confirmingAddress: normalizedMemberAddr,
      confirmedBy: confirmedByLabel,
      proposalId: proposalId || undefined,
      proposalHash: configHash,
    })

    const rememberResult = await withWalrusRetry(() =>
      client.rememberAndWait(serialized, namespace, {
        pollIntervalMs: tunables.pollingIntervalMs,
        timeoutMs: Math.max(tunables.requestTimeoutMs * 4, 90000),
        idempotencyKey: `${circle.circleId}:circle_config:v${version}:${configHash}`,
        dedupe: true,
      })
    )

    if (!rememberResult || !rememberResult.blob_id) {
      throw new Error('Walrus Memory write for circle_config completed without returning a valid blob_id.')
    }

    const updatedCircle = {
      ...circle,
      version,
      configHash,
      walrusConfigBlobId: rememberResult.blob_id,
      updatedAt: new Date().toISOString(),
    }
    circleRegistry.set(circle.circleId, updatedCircle)

    return {
      circle: updatedCircle,
      walrusBlobId: rememberResult.blob_id,
      namespace: rememberResult.namespace || namespace,
      version,
      configHash,
      confirmationType,
      confirmedBy: confirmedByLabel,
    }
  } finally {
    if (!isCached && typeof client.destroy === 'function') {
      client.destroy()
    }
  }
}

/**
 * Persist a confirmed transaction digest association (`network, txDigest, circleId, cycle, memberId, memberAddress`)
 * to Walrus Memory so digest associations survive server restarts.
 * Never treats the digest as verified until Tatum confirms the on-chain transaction.
 */
export async function persistTxDigestAssociationToWalrus(input, env = process.env) {
  const {
    circleId,
    cycle,
    memberId,
    memberAddress,
    txDigest,
    network,
    authenticatedWalletAddress,
    memwalClientOverride,
  } = input || {}

  if (!circleId) {
    throw new Error('circleId is required to persist a transaction digest association.')
  }
  assertCircleNotQuarantined(circleId)

  const { circle, member: actorMember } = verifyCircleMembership(circleId, {
    memberAddress: authenticatedWalletAddress || memberAddress,
  })

  const targetMember = circle.members.find((m) => {
    if (memberId && m.id === memberId) return true
    if (memberAddress && normalizeSuiAddress(m.address) === normalizeSuiAddress(memberAddress)) {
      return true
    }
    return false
  }) || actorMember

  const trimmedDigest = String(txDigest || '').trim()
  if (!isValidSuiDigest(trimmedDigest)) {
    throw new WalletAuthError(
      `Invalid Sui transaction digest "${trimmedDigest}". Must be a valid Base58 digest.`,
      400
    )
  }

  const resolvedCycle = Number(cycle) || circle.currentCycle || 1
  const resolvedNetwork = String(
    network || loadConfig(env).integrations.tatum.config?.SUI_NETWORK || env.SUI_NETWORK || 'testnet'
  ).trim()

  // Enforce conflict check and record unverified digest association in server memory
  recordSubmittedDigest(circle.circleId, resolvedCycle, targetMember.address, trimmedDigest, {
    network: resolvedNetwork,
    poolAddress: circle.poolAddress,
    memberId: targetMember.id,
  })

  const confirmingAddr = normalizeSuiAddress(actorMember.address)
  const confirmedByLabel = `Digest association recorded by ${actorMember.name} (${confirmingAddr}) for ${targetMember.name} — unverified until Tatum confirms on Sui ${resolvedNetwork}`

  const { client, namespace, tunables, isCached } = memwalClientOverride
    ? {
        client: memwalClientOverride,
        namespace: resolveCircleNamespace(circle.circleId, env),
        tunables: loadConfig(env).tunables,
        isCached: false,
      }
    : createMemWalClient(circle.circleId, env)

  try {
    const serialized = serializeTxDigestAssociationForWalrus(
      {
        circleId: circle.circleId,
        cycle: resolvedCycle,
        memberId: targetMember.id,
        memberAddress: targetMember.address,
        txDigest: trimmedDigest,
        network: resolvedNetwork,
      },
      {
        confirmationType: 'member_submitted_digest',
        confirmingAddress: confirmingAddr,
        confirmedBy: confirmedByLabel,
      }
    )

    const rememberResult = await withWalrusRetry(() =>
      client.rememberAndWait(serialized, namespace, {
        pollIntervalMs: tunables.pollingIntervalMs,
        timeoutMs: Math.max(tunables.requestTimeoutMs * 4, 90000),
        idempotencyKey: `${circle.circleId}:txassoc:${resolvedNetwork}:${resolvedCycle}:${normalizeSuiAddress(targetMember.address)}:${trimmedDigest}`,
        dedupe: true,
      })
    )

    if (!rememberResult || !rememberResult.blob_id) {
      throw new Error('Walrus Memory write for tx_digest_association completed without returning a valid blob_id.')
    }

    return {
      circleId: circle.circleId,
      cycle: resolvedCycle,
      memberId: targetMember.id,
      memberAddress: normalizeSuiAddress(targetMember.address),
      txDigest: trimmedDigest,
      network: resolvedNetwork,
      walrusBlobId: rememberResult.blob_id,
      namespace: rememberResult.namespace || namespace,
      verifiedOnChain: false,
      confirmedBy: confirmedByLabel,
    }
  } finally {
    if (!isCached && typeof client.destroy === 'function') {
      client.destroy()
    }
  }
}

const recordedLatenessMemories = new Map()
const recordedSplitMemories = new Map()
const recordedReminderOutcomeMemories = new Map()

/**
 * Write a factual, idempotent Walrus Memory entry recording a member's confirmed late contribution.
 * Labeled strictly as "historical contribution behavior" — never an automatic penalty or accusation.
 */
export async function persistHistoricalLatenessToWalrus(input, env = process.env) {
  const {
    circleId,
    cycle,
    memberAddress,
    memberId,
    requiredAmount,
    amountPaidByDeadline = 0,
    amountRemainingOutstanding = 0,
    deadlineTimestamp,
    latePaymentDigest,
    latePaymentTimestamp,
    elapsedMs,
    elapsedDisplay,
    policyEvaluation,
    memwalClientOverride,
  } = input || {}

  if (!circleId) {
    throw new Error('circleId is required to persist historical lateness behavior.')
  }
  assertCircleNotQuarantined(circleId)

  const normAddr = normalizeSuiAddress(memberAddress)
  const trimmedDigest = String(latePaymentDigest || '').trim()
  const resolvedCycle = Number(cycle) || 1
  const idempotencyKey = `${circleId}:lateness:${resolvedCycle}:${normAddr}:${trimmedDigest}`

  if (recordedLatenessMemories.has(idempotencyKey)) {
    return {
      recorded: true,
      cached: true,
      ...recordedLatenessMemories.get(idempotencyKey),
    }
  }

  const { circle } = verifyCircleMembership(circleId, { memberAddress: normAddr, memberId })
  const member = circle.members.find((m) => normalizeSuiAddress(m.address) === normAddr)
  const memberName = member?.name || memberId || normAddr.slice(0, 6)
  const resolvedMemberId = member?.id || memberId || normAddr

  const graceEval = policyEvaluation?.graceEvaluation || null
  const recordId = `hist-lateness-${circleId}-${resolvedCycle}-${normAddr.slice(2, 8)}-${Date.now()}`

  let title = `Historical Contribution Behavior: Late Completion by ${memberName} in Cycle ${resolvedCycle}`
  let quote = `Member ${memberName} (${resolvedMemberId}) completed cycle ${resolvedCycle} contribution (${requiredAmount} expected) ${elapsedDisplay || 'late'}. Amount paid by deadline: ${amountPaidByDeadline}; remaining completed on Sui at ${latePaymentTimestamp} in transaction ${trimmedDigest}.`
  let context = `Factual historical contribution behavior recorded from confirmed Sui on-chain transaction data. Label: historical contribution behavior. Factual record only; not an automatic penalty, membership denial, or change of payout order.`

  if (graceEval) {
    const ruleRef = graceEval.graceBlobId
      ? `"${graceEval.graceTitle || 'recorded grace agreement'}" (Rule Blob: ${graceEval.graceBlobId})`
      : `"${graceEval.graceTitle || 'recorded grace agreement'}"`
    if (graceEval.honored) {
      title = `Historical Contribution Behavior: Grace Agreement Honored by ${memberName} in Cycle ${resolvedCycle}`
      quote = `Member ${memberName} (${resolvedMemberId}) completed cycle ${resolvedCycle} contribution (${requiredAmount} expected) ${elapsedDisplay || 'late'}, within the ${graceEval.durationLabel} grace window of ${ruleRef}. Amount paid by deadline: ${amountPaidByDeadline}; remaining completed on Sui at ${latePaymentTimestamp} in transaction ${trimmedDigest}.`
      context = `Grace resolution outcome: ${memberName} honored the ${graceEval.durationLabel} grace window in Cycle ${resolvedCycle} (${elapsedDisplay || 'late'}). Label: historical contribution behavior. Factual record only; not an automatic penalty.`
    } else {
      title = `Historical Contribution Behavior: Grace Window Exceeded by ${memberName} in Cycle ${resolvedCycle}`
      quote = `Member ${memberName} (${resolvedMemberId}) completed cycle ${resolvedCycle} contribution (${requiredAmount} expected) ${elapsedDisplay || 'late'}, exceeding the ${graceEval.durationLabel} grace window of ${ruleRef}. Amount paid by deadline: ${amountPaidByDeadline}; remaining completed on Sui at ${latePaymentTimestamp} in transaction ${trimmedDigest}.`
      context = `Grace resolution outcome: ${memberName} exceeded the ${graceEval.durationLabel} grace window in Cycle ${resolvedCycle} (${elapsedDisplay || 'late'}). Label: historical contribution behavior. Factual record only; not an automatic penalty.`
    }
  }

  const confirmedBy = `Tatum on-chain confirmed late contribution recorded by system for ${memberName} (${normAddr})`

  const draftRecord = {
    id: recordId,
    circleId: circle.circleId,
    category: 'Member patterns',
    memoryType: 'historical_behavior',
    label: 'historical contribution behavior',
    title,
    quote,
    context,
    cycle: resolvedCycle,
    date: new Date().toISOString().slice(0, 10),
    memberId: resolvedMemberId,
    memberIds: [resolvedMemberId],
    memberAddress: normAddr,
    requiredAmount,
    amountPaidByDeadline,
    amountRemainingOutstanding,
    deadlineTimestamp,
    latePaymentDigest: trimmedDigest,
    latePaymentTimestamp,
    elapsedMs,
    elapsedDisplay,
    graceEvaluation: graceEval || undefined,
    confirmedBy,
    confirmationType: 'tatum_confirmed_chain_event',
    txDigest: trimmedDigest,
  }

  const serialized = serializeMemoryForWalrus(draftRecord)
  const { client, namespace, tunables, isCached } = memwalClientOverride
    ? {
        client: memwalClientOverride,
        namespace: resolveCircleNamespace(circle.circleId, env),
        tunables: loadConfig(env).tunables,
        isCached: false,
      }
    : createMemWalClient(circle.circleId, env)

  try {
    const rememberResult = await withWalrusRetry(() =>
      client.rememberAndWait(serialized, namespace, {
        pollIntervalMs: tunables.pollingIntervalMs,
        timeoutMs: Math.max(tunables.requestTimeoutMs * 4, 90000),
        idempotencyKey,
        dedupe: true,
      })
    )

    if (!rememberResult || !rememberResult.blob_id) {
      throw new Error('Walrus Memory write for historical lateness completed without returning a valid blob_id.')
    }

    const saved = {
      ...draftRecord,
      walrusBlobId: rememberResult.blob_id,
      namespace: rememberResult.namespace || namespace,
      recorded: true,
      durableWalrusConfirmed: true,
      createdAt: new Date().toISOString(),
    }

    recordedLatenessMemories.set(idempotencyKey, saved)
    if (!sessionConfirmedCache.has(namespace)) {
      sessionConfirmedCache.set(namespace, new Map())
    }
    sessionConfirmedCache.get(namespace).set(saved.walrusBlobId, saved)

    return saved
  } finally {
    if (!isCached && typeof client.destroy === 'function') {
      client.destroy()
    }
  }
}

/**
 * Return memories confirmed or recorded in the current server session for `circleId`
 * (zero network calls; prevents vector-index lag from hiding newly written Walrus blobs).
 */
export function getSessionConfirmedCircleMemories(circleId, env = process.env) {
  if (!circleId || isQuarantinedSyntheticRecord(circleId)) return []
  try {
    const namespace = resolveCircleNamespace(circleId, env)
    const nsCache = sessionConfirmedCache.get(namespace)
    if (!nsCache) return []
    const out = []
    for (const rec of nsCache.values()) {
      if (
        rec?.walrusBlobId &&
        !isQuarantinedSyntheticRecord(rec) &&
        rec.recordKind !== 'circle_config' &&
        rec.recordKind !== 'tx_digest_association' &&
        rec.memoryType !== 'circle_config' &&
        rec.memoryType !== 'tx_digest_association'
      ) {
        out.push(rec)
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Loop 3: Write a factual, idempotent Walrus Memory entry recording a verified multi-tranche (split) completion.
 */
export async function persistSplitCompletionToWalrus(input, env = process.env) {
  const {
    circleId,
    cycle,
    memberAddress,
    memberId,
    requiredAmount,
    txDigests = [],
    memwalClientOverride,
  } = input || {}

  if (!circleId) {
    throw new Error('circleId is required to persist split completion pattern.')
  }
  assertCircleNotQuarantined(circleId)

  const digests = Array.isArray(txDigests)
    ? txDigests.map((d) => String(d || '').trim()).filter(Boolean)
    : []
  if (digests.length < 2) {
    throw new Error('At least 2 transaction digests are required to persist a split completion pattern.')
  }

  const normAddr = normalizeSuiAddress(memberAddress)
  const resolvedCycle = Number(cycle) || 1
  const digestKey = digests.slice().sort().join(',')
  const idempotencyKey = `${circleId}:split:${resolvedCycle}:${normAddr}:${digestKey}`

  if (recordedSplitMemories.has(idempotencyKey)) {
    return {
      recorded: true,
      cached: true,
      ...recordedSplitMemories.get(idempotencyKey),
    }
  }

  const { circle } = verifyCircleMembership(circleId, { memberAddress: normAddr, memberId })
  const member = circle.members.find((m) => normalizeSuiAddress(m.address) === normAddr)
  const memberName = member?.name || memberId || normAddr.slice(0, 6)
  const resolvedMemberId = member?.id || memberId || normAddr

  const draftRecord = {
    id: `split-pattern-${circleId}-${resolvedCycle}-${normAddr.slice(2, 8)}-${Date.now()}`,
    circleId: circle.circleId,
    category: 'Member patterns',
    memoryType: 'historical_behavior',
    label: 'split contribution pattern',
    title: `Split Contribution Pattern: ${memberName} Completed Cycle ${resolvedCycle} in ${digests.length} Tranches`,
    quote: `Member ${memberName} (${resolvedMemberId}) completed Cycle ${resolvedCycle} contribution (${requiredAmount} expected) across ${digests.length} verified Sui tranches (${digests.join(', ')}).`,
    context: `Factual split-payment completion pattern recorded from confirmed Sui on-chain transactions. Label: split contribution pattern. Factual record only; not an automatic penalty or payout-order mutation.`,
    cycle: resolvedCycle,
    date: new Date().toISOString().slice(0, 10),
    memberId: resolvedMemberId,
    memberIds: [resolvedMemberId],
    memberAddress: normAddr,
    requiredAmount,
    txDigests: digests,
    txDigest: digests[digests.length - 1],
    confirmedBy: `Tatum on-chain confirmed ${digests.length}-tranche split completion for ${memberName} (${normAddr})`,
    confirmationType: 'tatum_confirmed_chain_event',
  }

  const serialized = serializeMemoryForWalrus(draftRecord)
  const { client, namespace, tunables, isCached } = memwalClientOverride
    ? {
        client: memwalClientOverride,
        namespace: resolveCircleNamespace(circle.circleId, env),
        tunables: loadConfig(env).tunables,
        isCached: false,
      }
    : createMemWalClient(circle.circleId, env)

  try {
    const rememberResult = await withWalrusRetry(() =>
      client.rememberAndWait(serialized, namespace, {
        pollIntervalMs: tunables.pollingIntervalMs,
        timeoutMs: Math.max(tunables.requestTimeoutMs * 4, 90000),
        idempotencyKey,
        dedupe: true,
      })
    )

    if (!rememberResult || !rememberResult.blob_id) {
      throw new Error('Walrus Memory write for split completion completed without returning a valid blob_id.')
    }

    const saved = {
      ...draftRecord,
      walrusBlobId: rememberResult.blob_id,
      namespace: rememberResult.namespace || namespace,
      recorded: true,
      durableWalrusConfirmed: true,
      createdAt: new Date().toISOString(),
    }

    recordedSplitMemories.set(idempotencyKey, saved)
    if (!sessionConfirmedCache.has(namespace)) {
      sessionConfirmedCache.set(namespace, new Map())
    }
    sessionConfirmedCache.get(namespace).set(saved.walrusBlobId, saved)
    return saved
  } finally {
    if (!isCached && typeof client.destroy === 'function') {
      client.destroy()
    }
  }
}

/**
 * Loop 4: Write a factual, idempotent Walrus Memory entry recording that a verified payment followed an opted-in reminder preference.
 */
export async function persistReminderConversionToWalrus(input, env = process.env) {
  const {
    circleId,
    cycle,
    memberAddress,
    memberId,
    txDigest,
    reminderPreferenceBlobId,
    reminderPreferenceTitle,
    memwalClientOverride,
  } = input || {}

  if (!circleId) {
    throw new Error('circleId is required to persist reminder conversion outcome.')
  }
  assertCircleNotQuarantined(circleId)

  const normAddr = normalizeSuiAddress(memberAddress)
  const trimmedDigest = String(txDigest || '').trim()
  const resolvedCycle = Number(cycle) || 1
  const idempotencyKey = `${circleId}:reminder-outcome:${resolvedCycle}:${normAddr}:${trimmedDigest}`

  if (recordedReminderOutcomeMemories.has(idempotencyKey)) {
    return {
      recorded: true,
      cached: true,
      ...recordedReminderOutcomeMemories.get(idempotencyKey),
    }
  }

  const { circle } = verifyCircleMembership(circleId, { memberAddress: normAddr, memberId })
  const member = circle.members.find((m) => normalizeSuiAddress(m.address) === normAddr)
  const memberName = member?.name || memberId || normAddr.slice(0, 6)
  const resolvedMemberId = member?.id || memberId || normAddr

  const prefRef = reminderPreferenceBlobId
    ? `"${reminderPreferenceTitle || 'opted-in reminder preference'}" (Blob: ${reminderPreferenceBlobId})`
    : `"${reminderPreferenceTitle || 'opted-in reminder preference'}"`

  const draftRecord = {
    id: `reminder-outcome-${circleId}-${resolvedCycle}-${normAddr.slice(2, 8)}-${Date.now()}`,
    circleId: circle.circleId,
    category: 'Reminder preferences',
    memoryType: 'reminder_preference',
    label: 'reminder conversion outcome',
    title: `Reminder Conversion Outcome: ${memberName} Completed Cycle ${resolvedCycle}`,
    quote: `Member ${memberName} (${resolvedMemberId}) completed Cycle ${resolvedCycle} contribution on Sui (${trimmedDigest}) after recording ${prefRef}.`,
    context: `Factual reminder conversion outcome recorded after Tatum-confirmed Sui payment. Label: reminder conversion outcome. Factual record only; not an automatic penalty or credit score.`,
    cycle: resolvedCycle,
    date: new Date().toISOString().slice(0, 10),
    memberId: resolvedMemberId,
    memberIds: [resolvedMemberId],
    memberAddress: normAddr,
    txDigest: trimmedDigest,
    reminderPreferenceBlobId: reminderPreferenceBlobId || undefined,
    confirmedBy: `Tatum on-chain confirmed contribution following opted-in reminder preference for ${memberName} (${normAddr})`,
    confirmationType: 'tatum_confirmed_chain_event',
  }

  const serialized = serializeMemoryForWalrus(draftRecord)
  const { client, namespace, tunables, isCached } = memwalClientOverride
    ? {
        client: memwalClientOverride,
        namespace: resolveCircleNamespace(circle.circleId, env),
        tunables: loadConfig(env).tunables,
        isCached: false,
      }
    : createMemWalClient(circle.circleId, env)

  try {
    const rememberResult = await withWalrusRetry(() =>
      client.rememberAndWait(serialized, namespace, {
        pollIntervalMs: tunables.pollingIntervalMs,
        timeoutMs: Math.max(tunables.requestTimeoutMs * 4, 90000),
        idempotencyKey,
        dedupe: true,
      })
    )

    if (!rememberResult || !rememberResult.blob_id) {
      throw new Error('Walrus Memory write for reminder conversion outcome completed without returning a valid blob_id.')
    }

    const saved = {
      ...draftRecord,
      walrusBlobId: rememberResult.blob_id,
      namespace: rememberResult.namespace || namespace,
      recorded: true,
      durableWalrusConfirmed: true,
      createdAt: new Date().toISOString(),
    }

    recordedReminderOutcomeMemories.set(idempotencyKey, saved)
    if (!sessionConfirmedCache.has(namespace)) {
      sessionConfirmedCache.set(namespace, new Map())
    }
    sessionConfirmedCache.get(namespace).set(saved.walrusBlobId, saved)
    return saved
  } finally {
    if (!isCached && typeof client.destroy === 'function') {
      client.destroy()
    }
  }
}

/**
 * Semantic recall against the circle's Walrus Memory namespace.
 * Automatically excludes quarantined synthetic blobs unless `options.includeQuarantinedForAudit === true`.
 */
export async function recallCircleMemories(circleId, query, options = {}, env = process.env) {
  if (!options.includeQuarantinedForAudit) {
    assertCircleNotQuarantined(circleId)
  }

  const { client, namespace, tunables, isCached } = options.memwalClientOverride
    ? {
        client: options.memwalClientOverride,
        namespace: resolveCircleNamespace(circleId, env),
        tunables: loadConfig(env).tunables,
        isCached: false,
      }
    : createMemWalClient(circleId, env)
  try {
    const searchQuery =
      query && query.trim()
        ? query.trim()
        : 'circle agreement grace period member payment pattern reminder preference rule'

    const limit = options.limit || tunables.recallLimit
    const recallRes = await withWalrusRetry(() =>
      client.recall({
        query: searchQuery,
        limit,
        namespace,
        sort: options.sort || 'relevance',
      })
    )

    const records = (recallRes.results || [])
      .filter((hit) => Boolean(hit.blob_id))
      .map((hit) => parseRecalledMemory(hit, circleId))
      .filter((rec) => {
        if (!options.includeQuarantinedForAudit && isQuarantinedSyntheticRecord(rec)) {
          return false
        }
        if (
          !options.includeInternalRecords &&
          (rec.recordKind === 'circle_config' ||
            rec.recordKind === 'tx_digest_association' ||
            rec.memoryType === 'circle_config' ||
            rec.memoryType === 'tx_digest_association')
        ) {
          return false
        }
        if (options.category && rec.category !== options.category) return false
        if (
          options.memberId &&
          rec.memberId !== options.memberId &&
          !(rec.memberIds || []).includes(options.memberId)
        ) {
          return false
        }
        if (options.cycle !== undefined && rec.cycle !== options.cycle) return false
        return true
      })

    if (!options.includeQuarantinedForAudit) {
      if (!sessionConfirmedCache.has(namespace)) {
        sessionConfirmedCache.set(namespace, new Map())
      }
      const nsCache = sessionConfirmedCache.get(namespace)
      for (const r of records) {
        if (r.walrusBlobId) nsCache.set(r.walrusBlobId, r)
      }
    }

    return {
      namespace,
      query: searchQuery,
      total: records.length,
      droppedCount: recallRes.dropped_count ?? 0,
      records,
    }
  } finally {
    if (!isCached && typeof client.destroy === 'function') {
      client.destroy()
    }
  }
}

/**
 * List known memories for a circle by recalling recent records from Walrus Memory
 * and merging with any memories confirmed in the current server session.
 */
export async function listCircleMemories(circleId, env = process.env) {
  assertCircleNotQuarantined(circleId)
  const namespace = resolveCircleNamespace(circleId, env)
  const recalled = await recallCircleMemories(
    circleId,
    'circle agreement member pattern reminder preference verified payment cycle rule',
    { sort: 'recent' },
    env
  )

  const byBlob = new Map()
  const nsCache = sessionConfirmedCache.get(namespace)
  if (nsCache) {
    for (const [blobId, rec] of nsCache.entries()) {
      if (
        !isQuarantinedSyntheticRecord(rec) &&
        rec.recordKind !== 'circle_config' &&
        rec.recordKind !== 'tx_digest_association'
      ) {
        byBlob.set(blobId, rec)
      }
    }
  }
  for (const rec of recalled.records) {
    if (rec.walrusBlobId && !isQuarantinedSyntheticRecord(rec) && !byBlob.has(rec.walrusBlobId)) {
      byBlob.set(rec.walrusBlobId, rec)
    }
  }

  return {
    namespace,
    records: Array.from(byBlob.values()),
  }
}

/**
 * Full restart-recovery workflow for a circle from Walrus Memory + Tatum Sui re-verification.
 *
 * Supported MemWal retrieval operations used:
 * 1. `client.restore(namespace, limit)` — re-indexes missing on-chain Walrus blobs into the relayer vector index.
 * 2. `client.listMemories({ namespace, cursor, limit })` — walks the paginated metadata inventory (`has_more`, `next_cursor`)
 *    to discover every `blob_id` stored in `namespace` without relying on semantic similarity to count blobs.
 * 3. `client.recall({ query, limit, namespace, sort: 'recent' })` — executes targeted semantic queries across
 *    `circle_config`, `agreement`/`member_pattern`/`reminder_preference`, and `tx_digest_association` records
 *    to download and SEAL-decrypt the plaintext payloads.
 *
 * Completeness & Safety Guarantees:
 * - Never claims `complete: true` unless a valid `circle_config` is present, the complete inventory was obtained,
 *   every non-quarantined `blob_id` from
 *   `listMemories` was recovered and validated, `restoreResult.truncated === false`, `restoreResult.failed === 0`,
 *   `droppedCount === 0`, `malformedRecords.length === 0`, and `conflicts.length === 0`.
 * - Never silently picks between conflicting `circle_config` versions, conflicting policies, or conflicting
 *   `tx_digest_association` claims; surfaces all conflicts in `conflicts`.
 * - Re-queries Tatum (`verifyMemberContributionOnSui`) for every restored transaction digest association;
 *   never treats a restored digest as `Verified` unless Tatum confirms the on-chain transfer.
 */
export async function restoreCircleFromWalrus(circleId, options = {}, env = process.env) {
  if (!circleId || typeof circleId !== 'string') {
    throw new Error('circleId is required to restore a circle from Walrus.')
  }
  const trimmedCircleId = circleId.trim()
  assertCircleNotQuarantined(trimmedCircleId)

  const requestingWalletAddress = options.authenticatedWalletAddress
    ? normalizeSuiAddress(options.authenticatedWalletAddress)
    : ''
  if (!requestingWalletAddress) {
    throw new WalletAuthError(
      'Authenticated wallet session is required to restore a circle from Walrus.',
      401
    )
  }

  const { client, namespace, tunables, isCached } = options.memwalClientOverride
    ? {
        client: options.memwalClientOverride,
        namespace: resolveCircleNamespace(trimmedCircleId, env),
        tunables: loadConfig(env).tunables,
        isCached: false,
      }
    : createMemWalClient(trimmedCircleId, env)

  try {
    const inspectLimit = Math.min(Math.max(Number(options.limit) || tunables.recallLimit || 25, 10), 100)

    // Step 1: Trigger relayer restore(namespace, inspectLimit)
    const rawRestoreRes = await withWalrusRetry(() => client.restore(namespace, inspectLimit))
    const restoreResult = {
      restored: Number(rawRestoreRes?.restored) || 0,
      skipped: Number(rawRestoreRes?.skipped) || 0,
      failed: Number(rawRestoreRes?.failed) || 0,
      total: Number(rawRestoreRes?.total) || 0,
      namespace: rawRestoreRes?.namespace || namespace,
      owner: rawRestoreRes?.owner || '',
      truncated: Boolean(rawRestoreRes?.truncated),
    }

    const quarantinedRecordsSkipped = []
    const expectedBlobIds = new Set()
    let inventoryWalked = false
    let inventoryPaginationTruncated = false

    // Step 2: Walk listMemories({ namespace, cursor, limit: 500 }) for authoritative blob_id inventory
    if (typeof client.listMemories === 'function') {
      inventoryWalked = true
      let cursor = undefined
      let hasMore = true
      let pages = 0
      const MAX_PAGES = 20
      while (hasMore && pages < MAX_PAGES) {
        pages++
        const page = await withWalrusRetry(() =>
          client.listMemories({
            namespace,
            cursor,
            limit: 500,
          })
        )
        const items = Array.isArray(page?.memories) ? page.memories : []
        for (const item of items) {
          if (item?.namespace_id && item.namespace_id !== namespace) continue
          const bid = String(item?.blob_id || '').trim()
          if (!bid) continue
          if (QUARANTINED_SYNTHETIC_BLOB_IDS.has(bid)) {
            quarantinedRecordsSkipped.push({
              blobId: bid,
              reason: 'Quarantined synthetic Walrus blob ID in namespace inventory.',
            })
            continue
          }
          expectedBlobIds.add(bid)
        }
        hasMore = Boolean(page?.has_more)
        cursor = page?.next_cursor ?? undefined
        if (hasMore && !cursor) {
          inventoryPaginationTruncated = true
          break
        }
      }
      if (hasMore) {
        inventoryPaginationTruncated = true
      }
    }

    // Step 3: Targeted multi-query semantic recall to retrieve decrypted record texts
    const recallQueries = [
      `[Circle: ${trimmedCircleId}] [Type: circle_config] circle configuration roster members poolAddress tokenType contributionPerMember cycleLength currentCycle`,
      `[Circle: ${trimmedCircleId}] [Type: agreement] [Type: member_pattern] [Type: historical_behavior] [Type: reminder_preference] circle agreement policy rule grace period member pattern historical contribution behavior reminder preference`,
      `[Circle: ${trimmedCircleId}] [Type: tx_digest_association] [Type: verified_payment_event] transaction digest association sui contribution cycle member`,
    ]

    const recallLimit = Math.min(Math.max(inspectLimit, 50), 100)
    const rawHitsByBlobId = new Map()
    let totalDroppedCount = 0

    for (const q of recallQueries) {
      const recallRes = await withWalrusRetry(() =>
        client.recall({
          query: q,
          limit: recallLimit,
          namespace,
          sort: 'recent',
        })
      )
      totalDroppedCount += Number(recallRes?.dropped_count) || 0
      for (const hit of recallRes?.results || []) {
        const bid = String(hit?.blob_id || '').trim()
        if (!bid) continue
        if (!rawHitsByBlobId.has(bid)) {
          rawHitsByBlobId.set(bid, hit)
        }
      }
      // If listMemories gave us a non-empty inventory and we have already collected every expected blob_id, stop early
      if (
        inventoryWalked &&
        expectedBlobIds.size > 0 &&
        Array.from(expectedBlobIds).every((bid) => rawHitsByBlobId.has(bid))
      ) {
        break
      }
    }

    const malformedRecords = []
    const duplicateRecordsSkipped = []
    const staleRecordsSkipped = []
    const conflicts = []

    const validConfigs = []
    const validTxAssocs = []
    const validMemories = []

    // Step 4: Quarantine check & strict schema validation for each recalled blob
    for (const [blobId, hit] of rawHitsByBlobId.entries()) {
      if (
        QUARANTINED_SYNTHETIC_BLOB_IDS.has(blobId) ||
        isQuarantinedSyntheticRecord(hit?.text || '')
      ) {
        if (!quarantinedRecordsSkipped.some((q) => q.blobId === blobId)) {
          quarantinedRecordsSkipped.push({
            blobId,
            reason: 'Quarantined synthetic record blocked during restore.',
          })
        }
        expectedBlobIds.delete(blobId)
        continue
      }

      const validation = validateWalrusRecordForRestore(hit, trimmedCircleId)
      if (!validation.valid) {
        malformedRecords.push({
          blobId,
          reason: validation.error,
          missingFields: validation.missingFields || [],
        })
        continue
      }

      if (validation.recordKind === 'circle_config') {
        validConfigs.push(validation)
      } else if (validation.recordKind === 'tx_digest_association') {
        validTxAssocs.push(validation)
      } else {
        validMemories.push(validation)
      }
    }

    // Step 5: Reconstruct Circle Configuration (deduplicate, order by version, detect conflicts)
    const configByHash = new Map()
    for (const cfgRec of validConfigs) {
      if (configByHash.has(cfgRec.configHash)) {
        const primary = configByHash.get(cfgRec.configHash)
        duplicateRecordsSkipped.push({
          blobId: cfgRec.blobId,
          duplicateOfBlobId: primary.blobId,
          recordKind: 'circle_config',
        })
      } else {
        configByHash.set(cfgRec.configHash, cfgRec)
      }
    }

    const uniqueConfigs = Array.from(configByHash.values()).sort((a, b) => {
      if (a.version !== b.version) return a.version - b.version
      return String(a.updatedAt).localeCompare(String(b.updatedAt))
    })

    let selectedConfig = null
    let hasConfigConflict = false

    if (uniqueConfigs.length === 1) {
      selectedConfig = uniqueConfigs[0]
    } else if (uniqueConfigs.length > 1) {
      // Group by version to detect same-version divergent configs
      const byVersion = new Map()
      for (const c of uniqueConfigs) {
        const list = byVersion.get(c.version) || []
        list.push(c)
        byVersion.set(c.version, list)
      }

      for (const [ver, group] of byVersion.entries()) {
        if (group.length > 1) {
          hasConfigConflict = true
          conflicts.push({
            type: 'circle_config_conflict',
            reason: `Multiple circle_config records found at version ${ver} with conflicting configuration hashes.`,
            version: ver,
            blobIds: group.map((g) => g.blobId),
            candidates: group.map((g) => ({
              blobId: g.blobId,
              version: g.version,
              configHash: g.configHash,
              circleConfig: g.circleConfig,
              confirmedBy: g.confirmedBy,
            })),
          })
        }
      }

      // Check hash lineage when versions are distinct
      if (!hasConfigConflict) {
        const knownHashes = new Set([uniqueConfigs[0].configHash])
        for (let i = 1; i < uniqueConfigs.length; i++) {
          const curr = uniqueConfigs[i]
          if (curr.previousConfigHash && !knownHashes.has(curr.previousConfigHash)) {
            hasConfigConflict = true
            conflicts.push({
              type: 'circle_config_conflict',
              reason: `circle_config version ${curr.version} (${curr.blobId}) references previousConfigHash ${curr.previousConfigHash} which does not match prior version history.`,
              version: curr.version,
              blobIds: uniqueConfigs.map((u) => u.blobId),
              candidates: uniqueConfigs.map((g) => ({
                blobId: g.blobId,
                version: g.version,
                configHash: g.configHash,
                previousConfigHash: g.previousConfigHash,
                circleConfig: g.circleConfig,
              })),
            })
            break
          }
          knownHashes.add(curr.configHash)
        }
      }

      if (!hasConfigConflict) {
        selectedConfig = uniqueConfigs[uniqueConfigs.length - 1]
        for (let i = 0; i < uniqueConfigs.length - 1; i++) {
          staleRecordsSkipped.push({
            blobId: uniqueConfigs[i].blobId,
            supersededByBlobId: selectedConfig.blobId,
            version: uniqueConfigs[i].version,
            recordKind: 'circle_config',
          })
        }
      }
    }

    // Step 6: Authorize requestingWalletAddress against restored or existing circle roster BEFORE mutating state
    const existingCircle = circleRegistry.get(trimmedCircleId) || null
    const authorizationRosters = selectedConfig
      ? [selectedConfig.circleConfig]
      : uniqueConfigs.length > 0
      ? uniqueConfigs.map((u) => u.circleConfig)
      : existingCircle
      ? [existingCircle]
      : []

    if (authorizationRosters.length > 0) {
      const isAuthorizedInRoster = authorizationRosters.some(
        (r) =>
          normalizeSuiAddress(r.organizerAddress) === requestingWalletAddress ||
          (r.members || []).some((m) => normalizeSuiAddress(m.address) === requestingWalletAddress)
      )
      if (!isAuthorizedInRoster) {
        throw new WalletAuthError(
          `Authorization failed: wallet ${requestingWalletAddress} is not a registered member or organizer of circle "${trimmedCircleId}".`,
          403
        )
      }
    }

    let restoredCircle = existingCircle
    if (selectedConfig && !hasConfigConflict) {
      restoredCircle = {
        ...selectedConfig.circleConfig,
        version: selectedConfig.version,
        configHash: selectedConfig.configHash,
        previousConfigHash: selectedConfig.previousConfigHash,
        walrusConfigBlobId: selectedConfig.blobId,
        updatedAt: selectedConfig.updatedAt,
      }
      circleRegistry.set(trimmedCircleId, restoredCircle)
    }

    // Step 7: Deduplicate & check conflicts across confirmed group memories (agreements, patterns, preferences)
    const memoryByHash = new Map()
    for (const m of validMemories) {
      const rec = m.record
      const dedupeKey =
        rec.proposalHash ||
        `${rec.memoryType}:${rec.cycle}:${rec.memberId || ''}:${rec.title}:${rec.quote}`
      if (memoryByHash.has(dedupeKey)) {
        const primary = memoryByHash.get(dedupeKey)
        duplicateRecordsSkipped.push({
          blobId: m.blobId,
          duplicateOfBlobId: primary.blobId,
          recordKind: 'memory',
        })
      } else {
        memoryByHash.set(dedupeKey, m)
      }
    }

    const uniqueMemories = Array.from(memoryByHash.values())
    // Detect policy/agreement conflicts on the same (memoryType, cycle, memberId, normalizedTitle)
    const policySlots = new Map()
    for (const m of uniqueMemories) {
      const rec = m.record
      const slotKey = `${rec.memoryType}:${rec.cycle}:${rec.memberId || 'group'}:${String(rec.title || '').trim().toLowerCase()}`
      const list = policySlots.get(slotKey) || []
      list.push(m)
      policySlots.set(slotKey, list)
    }

    const activeMemories = []
    for (const [, group] of policySlots.entries()) {
      if (group.length === 1) {
        activeMemories.push(group[0].record)
        continue
      }
      // Check if sorted versions form a clean linear chain via previousProposalHash
      const sorted = [...group].sort((a, b) => a.version - b.version)
      let linear = true
      for (let i = 1; i < sorted.length; i++) {
        if (
          sorted[i].version <= sorted[i - 1].version ||
          (sorted[i].previousProposalHash &&
            sorted[i].previousProposalHash !== sorted[i - 1].record.proposalHash)
        ) {
          linear = false
          break
        }
        if (!sorted[i].previousProposalHash && sorted[i].version === sorted[i - 1].version) {
          linear = false
          break
        }
      }

      if (linear && sorted[sorted.length - 1].version > sorted[0].version) {
        const latest = sorted[sorted.length - 1]
        activeMemories.push(latest.record)
        for (let i = 0; i < sorted.length - 1; i++) {
          staleRecordsSkipped.push({
            blobId: sorted[i].blobId,
            supersededByBlobId: latest.blobId,
            version: sorted[i].version,
            recordKind: 'memory',
          })
        }
      } else {
        conflicts.push({
          type: 'policy_conflict',
          reason: `Conflicting ${group[0].record.memoryType} records for "${group[0].record.title}" in cycle ${group[0].record.cycle}.`,
          blobIds: group.map((g) => g.blobId),
          candidates: group.map((g) => ({
            blobId: g.blobId,
            version: g.version,
            title: g.record.title,
            quote: g.record.quote,
            confirmedBy: g.record.confirmedBy,
          })),
        })
        for (const g of group) {
          activeMemories.push(g.record)
        }
      }
    }

    if (!sessionConfirmedCache.has(namespace)) {
      sessionConfirmedCache.set(namespace, new Map())
    }
    const nsCache = sessionConfirmedCache.get(namespace)
    nsCache.clear()
    for (const rec of activeMemories) {
      if (rec.walrusBlobId && !isQuarantinedSyntheticRecord(rec)) {
        nsCache.set(rec.walrusBlobId, rec)
      }
    }

    // Step 8: Deduplicate, conflict-check, and restore transaction digest associations, then re-verify via Tatum
    const txAssocByKey = new Map()
    for (const assoc of validTxAssocs) {
      const exactKey = `${assoc.circleId}:${assoc.cycle}:${assoc.memberAddress}:${assoc.txDigest}:${assoc.network}`
      if (txAssocByKey.has(exactKey)) {
        const primary = txAssocByKey.get(exactKey)
        duplicateRecordsSkipped.push({
          blobId: assoc.blobId,
          duplicateOfBlobId: primary.blobId,
          recordKind: 'tx_digest_association',
        })
      } else {
        txAssocByKey.set(exactKey, assoc)
      }
    }

    const uniqueTxAssocs = Array.from(txAssocByKey.values())
    const txClaimsByDigestNet = new Map()
    for (const assoc of uniqueTxAssocs) {
      const claimKey = `${assoc.txDigest}:${assoc.network}`
      const list = txClaimsByDigestNet.get(claimKey) || []
      list.push(assoc)
      txClaimsByDigestNet.set(claimKey, list)
    }

    const restoredTxAssociations = []
    const memberCyclesToReverify = new Map()

    for (const [, claimGroup] of txClaimsByDigestNet.entries()) {
      if (claimGroup.length > 1) {
        conflicts.push({
          type: 'tx_digest_conflict',
          reason: `Transaction digest "${claimGroup[0].txDigest}" on Sui ${claimGroup[0].network} is claimed by multiple conflicting member/cycle records.`,
          txDigest: claimGroup[0].txDigest,
          network: claimGroup[0].network,
          blobIds: claimGroup.map((c) => c.blobId),
          candidates: claimGroup.map((c) => ({
            blobId: c.blobId,
            circleId: c.circleId,
            cycle: c.cycle,
            memberId: c.memberId,
            memberAddress: c.memberAddress,
          })),
        })
        continue
      }

      const assoc = claimGroup[0]
      if (restoredCircle) {
        const inRoster = restoredCircle.members.some(
          (m) => normalizeSuiAddress(m.address) === assoc.memberAddress
        )
        if (!inRoster) {
          malformedRecords.push({
            blobId: assoc.blobId,
            reason: `Transaction digest association references memberAddress ${assoc.memberAddress} which is not in the circle roster.`,
            missingFields: [],
          })
          continue
        }
      }

      try {
        recordSubmittedDigest(
          trimmedCircleId,
          assoc.cycle,
          assoc.memberAddress,
          assoc.txDigest,
          {
            network: assoc.network,
            poolAddress: restoredCircle?.poolAddress || '',
            memberId: assoc.memberId,
          }
        )
        restoredTxAssociations.push({
          blobId: assoc.blobId,
          circleId: assoc.circleId,
          cycle: assoc.cycle,
          memberId: assoc.memberId,
          memberAddress: assoc.memberAddress,
          txDigest: assoc.txDigest,
          network: assoc.network,
          verifiedOnChain: false,
        })
        const mcKey = `${assoc.cycle}:${assoc.memberAddress}`
        const existingGroup = memberCyclesToReverify.get(mcKey) || {
          cycle: assoc.cycle,
          memberId: assoc.memberId,
          memberAddress: assoc.memberAddress,
          networks: new Set(),
          digests: [],
        }
        existingGroup.networks.add(assoc.network)
        existingGroup.digests.push(assoc.txDigest)
        memberCyclesToReverify.set(mcKey, existingGroup)
      } catch (err) {
        if (err instanceof TransactionConflictError) {
          conflicts.push({
            type: 'tx_digest_conflict',
            reason: err.message,
            txDigest: assoc.txDigest,
            network: assoc.network,
            blobIds: [assoc.blobId],
          })
        } else {
          throw err
        }
      }
    }

    // Re-query Tatum for every restored member/cycle digest association
    const tatumReverifications = []
    const configuredNetwork = String(
      loadConfig(env).integrations.tatum.config?.SUI_NETWORK || env.SUI_NETWORK || 'testnet'
    ).trim()

    if (restoredCircle && memberCyclesToReverify.size > 0) {
      for (const [, group] of memberCyclesToReverify.entries()) {
        const rosterMember = restoredCircle.members.find(
          (m) => normalizeSuiAddress(m.address) === group.memberAddress
        )
        const networkMismatch = Array.from(group.networks).find((n) => n !== configuredNetwork)
        if (networkMismatch) {
          tatumReverifications.push({
            circleId: trimmedCircleId,
            cycle: group.cycle,
            memberId: rosterMember?.id || group.memberId,
            memberAddress: group.memberAddress,
            txDigests: group.digests,
            status: 'Unverified',
            code: 'unverified',
            network: networkMismatch,
            amountReceived: 0,
            error: `Restored digest association is for Sui "${networkMismatch}", but server Tatum verifier is configured for Sui "${configuredNetwork}".`,
          })
          continue
        }

        const verifyRes = await verifyMemberContributionOnSui(
          {
            circleId: trimmedCircleId,
            poolAddress: restoredCircle.poolAddress,
            memberAddress: group.memberAddress,
            memberId: rosterMember?.id || group.memberId,
            memberName: rosterMember?.name || group.memberId,
            token: restoredCircle.tokenType,
            expectedAmount: restoredCircle.contributionPerMember,
            windowStart: options.windowStart,
            windowEnd: options.windowEnd,
            cycle: group.cycle,
            txDigests: group.digests,
            withMemory: true,
            memories: activeMemories,
          },
          {
            env,
            fetchRpc: options.fetchRpc,
            fetchGraphql: options.fetchGraphql,
          }
        )

        for (const rAssoc of restoredTxAssociations) {
          if (rAssoc.cycle === group.cycle && rAssoc.memberAddress === group.memberAddress) {
            rAssoc.verifiedOnChain =
              verifyRes.status === 'Verified' ||
              verifyRes.status === 'Late' ||
              verifyRes.status === 'Partial'
            rAssoc.chainStatus = verifyRes.status
          }
        }

        tatumReverifications.push({
          circleId: trimmedCircleId,
          cycle: group.cycle,
          memberId: rosterMember?.id || group.memberId,
          memberAddress: group.memberAddress,
          txDigests: group.digests,
          status: verifyRes.status,
          code: verifyRes.code,
          network: verifyRes.network || configuredNetwork,
          amountReceived: verifyRes.amountReceived,
          observedSender: verifyRes.observedSender,
          observedRecipient: verifyRes.observedRecipient,
          executionStatus: verifyRes.executionStatus,
          timestamp: verifyRes.timestamp,
          policy: verifyRes.policy,
          error: verifyRes.error,
        })
      }
    } else if (!restoredCircle && memberCyclesToReverify.size > 0) {
      for (const [, group] of memberCyclesToReverify.entries()) {
        tatumReverifications.push({
          circleId: trimmedCircleId,
          cycle: group.cycle,
          memberId: group.memberId,
          memberAddress: group.memberAddress,
          txDigests: group.digests,
          status: 'Unverified',
          code: 'unverified',
          network: configuredNetwork,
          amountReceived: 0,
          error: 'Cannot re-verify transaction digest on Tatum because circle_config (poolAddress, tokenType, contributionPerMember) is missing or conflicted.',
        })
      }
    }

    // Step 9: Compute missingBlobIds, missingFields, recoveryStatus, and recoveryPath
    const missingBlobIds = Array.from(expectedBlobIds).filter(
      (bid) => !rawHitsByBlobId.has(bid)
    )
    const missingFields = []
    if (!restoredCircle && !hasConfigConflict) {
      missingFields.push(
        'circle_config (circleId, circleName, poolAddress, tokenType, contributionPerMember, cycleLength, currentCycle, members)'
      )
    }

    const isRestoreTruncated =
      restoreResult.truncated ||
      restoreResult.failed > 0 ||
      totalDroppedCount > 0 ||
      inventoryPaginationTruncated

    const hasConflicts = conflicts.length > 0
    const hasIncompleteData =
      !inventoryWalked ||
      !restoredCircle ||
      missingBlobIds.length > 0 ||
      missingFields.length > 0 ||
      malformedRecords.length > 0 ||
      isRestoreTruncated

    const recoveryStatus = hasConflicts
      ? 'conflict'
      : hasIncompleteData
      ? 'incomplete'
      : 'complete'
    const complete = recoveryStatus === 'complete'

    const recoveryPath = []
    if (missingFields.length > 0) {
      recoveryPath.push(
        'Persist the circle configuration and member roster to Walrus (POST /api/memory/circles/persist) so future restarts can reconstruct the circle roster and terms.'
      )
    }
    if (!inventoryWalked) {
      recoveryPath.push(
        'This MemWal client does not expose listMemories, so the app cannot compare recovered records against the complete namespace inventory. Update to a supported MemWal SDK/API before treating this restore as complete.'
      )
    }
    if (missingBlobIds.length > 0 || isRestoreTruncated) {
      recoveryPath.push(
        `Walrus recall/restore did not return all namespace blobs (missingBlobIds: ${missingBlobIds.length}, truncated: ${restoreResult.truncated}, failed: ${restoreResult.failed}, dropped: ${totalDroppedCount}). Retry POST /api/memory/restore with a higher limit (up to 100) or re-confirm any missing records.`
      )
    }
    if (hasConflicts) {
      recoveryPath.push(
        `Review the ${conflicts.length} surfaced conflict(s) in the restoration report and submit a new confirmed version (with previousConfigHash / previousProposalHash) to supersede conflicting branches.`
      )
    }
    if (malformedRecords.length > 0) {
      recoveryPath.push(
        `${malformedRecords.length} malformed or mismatched Walrus blob(s) were rejected during schema validation. Inspect malformedRecords for blob IDs and reasons.`
      )
    }

    return {
      namespace,
      circleId: trimmedCircleId,
      complete,
      recoveryStatus,
      restoreResult,
      circle: restoredCircle,
      records: activeMemories,
      restoredTxAssociations,
      tatumReverifications,
      inventoryAvailable: inventoryWalked,
      expectedBlobCount: expectedBlobIds.size,
      recoveredBlobCount: rawHitsByBlobId.size - quarantinedRecordsSkipped.length,
      missingBlobIds,
      missingFields,
      conflicts,
      malformedRecords,
      staleRecordsSkipped,
      duplicateRecordsSkipped,
      quarantinedRecordsSkipped,
      recoveryPath,
      limitationsNote:
        'MemWal retrieval combines restore(namespace, limit), paginated listMemories({ namespace, cursor }) for the blob_id inventory, and targeted semantic recall({ query, limit: 100, sort: "recent" }). Because MemWal restore() is single-shot with a per-owner candidate cap and recall() is similarity-ranked (max 100 per query), complete recovery is verified by comparing recalled blob_ids against listMemories() and checking restoreResult.truncated / failed / dropped_count. Wallet sessions and unconsumed challenges are never stored on Walrus; Tatum is re-queried for all restored transaction digest associations.',
    }
  } finally {
    if (!isCached && typeof client.destroy === 'function') {
      client.destroy()
    }
  }
}

/**
 * Backwards-compatible wrapper around `restoreCircleFromWalrus`.
 */
export async function restoreCircleMemoriesFromWalrus(circleId, limit, env = process.env, options = {}) {
  const circle = getCircleRoster(circleId)
  const fallbackWallet =
    options.authenticatedWalletAddress ||
    circle?.organizerAddress ||
    circle?.members?.[0]?.address
  if (fallbackWallet) {
    return restoreCircleFromWalrus(
      circleId,
      {
        ...options,
        limit,
        authenticatedWalletAddress: fallbackWallet,
      },
      env
    )
  }

  assertCircleNotQuarantined(circleId)
  const { client, namespace, tunables, isCached } = createMemWalClient(circleId, env)
  try {
    const inspectLimit = limit || tunables.recallLimit
    const restoreRes = await withWalrusRetry(() => client.restore(namespace, inspectLimit))
    const recalled = await recallCircleMemories(
      circleId,
      'circle agreement member pattern reminder preference verified payment cycle rule',
      { limit: tunables.recallLimit, sort: 'recent', memwalClientOverride: client },
      env
    )
    return {
      namespace,
      complete: false,
      recoveryStatus: 'incomplete',
      restoreResult: restoreRes,
      records: recalled.records,
      missingFields: ['circle_config'],
      limitationsNote:
        'Circle configuration was not found in memory and no authenticatedWalletAddress was provided.',
    }
  } finally {
    if (!isCached && typeof client.destroy === 'function') {
      client.destroy()
    }
  }
}

let lastHealthCheck = null
let lastHealthCheckTime = 0
const HEALTH_CACHE_TTL_MS = 15000

/**
 * Check Walrus Memory relayer health and list namespaces for the configured account.
 */
export async function checkWalrusMemoryHealth(env = process.env, options = {}) {
  const cfg = loadConfig(env)
  if (!cfg.integrations.memwal.configured) {
    return {
      connected: false,
      configured: false,
      status: cfg.integrations.memwal.status,
      issues: cfg.integrations.memwal.issues,
    }
  }

  const now = Date.now()
  if (!options.fresh && lastHealthCheck && now - lastHealthCheckTime < HEALTH_CACHE_TTL_MS) {
    return lastHealthCheck
  }

  const { client, serviceConfig, isCached } = createMemWalClient('health-check', env)
  try {
    const health = await withWalrusRetry(() => client.health())
    const res = {
      connected: health.status === 'ok',
      configured: true,
      relayerUrl: serviceConfig.MEMWAL_SERVER_URL,
      accountId: serviceConfig.MEMWAL_ACCOUNT_ID,
      version: health.version,
      writeReady: health.write_ready ?? true,
      mode: health.mode,
    }
    lastHealthCheck = res
    lastHealthCheckTime = Date.now()
    return res
  } catch (err) {
    const res = {
      connected: false,
      configured: true,
      relayerUrl: serviceConfig.MEMWAL_SERVER_URL,
      accountId: serviceConfig.MEMWAL_ACCOUNT_ID,
      error: err.message,
    }
    lastHealthCheck = res
    lastHealthCheckTime = Date.now() - (HEALTH_CACHE_TTL_MS - 3000)
    return res
  } finally {
    if (!isCached && typeof client.destroy === 'function') {
      client.destroy()
    }
  }
}
