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

export {
  QUARANTINED_SYNTHETIC_CIRCLES,
  QUARANTINED_SYNTHETIC_BLOB_IDS,
  isQuarantinedSyntheticRecord,
}

const META_MARKER = '\n[AJO_MEMORY_META]'

/**
 * Runtime registry of active circles & pending proposals in memory.
 * Per AGENTS.md, no local database or filesystem persistence is used.
 * Confirmed memories are written to Walrus Mainnet via @mysten-incubation/memwal.
 */
const circleRegistry = new Map()
const pendingProposals = new Map()
const authChallenges = new Map()
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
 * Create a configured MemWal SDK client from validated environment variables.
 * Never reads env vars implicitly inside the SDK.
 */
export function createMemWalClient(circleId, env = process.env) {
  const { serviceConfig, tunables } = requireIntegrationConfig('memwal', env)
  const namespace = circleId
    ? resolveCircleNamespace(circleId, env)
    : serviceConfig.MEMWAL_NAMESPACE_PREFIX || 'ajo-circle'
  const client = MemWal.create({
    key: serviceConfig.MEMWAL_KEY,
    accountId: serviceConfig.MEMWAL_ACCOUNT_ID,
    serverUrl: serviceConfig.MEMWAL_SERVER_URL,
    namespace,
    requestTimeoutMs: tunables.requestTimeoutMs,
  })
  return { client, namespace, serviceConfig, tunables }
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

  const resolvedOrganizer = existing?.organizerAddress
    ? existing.organizerAddress
    : authAddr
    ? options.authenticatedWalletAddress
    : organizerAddress
    ? String(organizerAddress).trim()
    : normalizedMembers[0]?.address || ''

  const record = {
    circleId: trimmedCircleId,
    circleName: circleName.trim(),
    poolAddress: String(poolAddress || '').trim(),
    contributionPerMember: Number(contributionPerMember) || 0,
    tokenType: String(tokenType || '').trim(),
    cycleLength: String(cycleLength || 'Monthly'),
    currentCycle: Number(currentCycle) || 1,
    members: normalizedMembers,
    organizerAddress: resolvedOrganizer,
    updatedAt: new Date().toISOString(),
  }

  circleRegistry.set(record.circleId, record)
  return record
}

export function getCircleRoster(circleId) {
  if (!circleId || isQuarantinedSyntheticRecord(circleId)) return null
  return circleRegistry.get(circleId) || null
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
  const circle = circleRegistry.get(circleId)
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
    schema: 'ajo-steward-memory/v1',
    id: record.id,
    circleId: record.circleId,
    memoryType,
    category,
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
        circleId: meta.circleId || fallbackCircleId,
        memoryType: meta.memoryType || categoryToMemoryType(meta.category),
        category: meta.category || memoryTypeToCategory(meta.memoryType),
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
        distance: hit.distance,
        createdAt: hit.created_at,
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
    createdAt: new Date().toISOString(),
  }

  const proposal = {
    ...draft,
    proposalHash: computeProposalHash(draft),
  }

  pendingProposals.set(proposal.id, proposal)
  return proposal
}

export function getPendingProposals(circleId) {
  return Array.from(pendingProposals.values()).filter(
    (p) => !circleId || p.circleId === circleId
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

  const storedProposal = pendingProposals.get(proposalId.trim())
  if (!storedProposal || storedProposal.circleId !== circleId) {
    throw new WalletAuthError(
      `Proposal "${proposalId}" was not found in pending proposals for circle "${circleId}". Stage the proposal before requesting a confirmation challenge.`,
      404
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
  } = input

  if (!circleId) {
    throw new Error('circleId is required to confirm a memory')
  }
  assertCircleNotQuarantined(circleId)

  // Enforce server-side circle membership
  const { circle, member } = verifyCircleMembership(circleId, { memberId, memberAddress })
  const normalizedMemberAddr = normalizeSuiAddress(member.address)

  const storedProposal = proposalId ? pendingProposals.get(String(proposalId).trim()) : null
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

    const challenge = authChallenges.get(String(challengeNonce).trim())
    // Enforce strict one-time challenge consumption before any validation
    authChallenges.delete(String(challengeNonce).trim())

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

    if (!storedProposal) {
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
    if (!proposalToWrite || !proposalToWrite.title || !proposalToWrite.quote) {
      throw new WalletAuthError(
        'Valid memory proposal (proposalId or proposal payload) is required for confirmation.',
        400
      )
    }
    verifiedProposalHash = computeProposalHash({ ...proposalToWrite, circleId })
  }

  const { client, namespace, tunables } = createMemWalClient(circleId, env)
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
    const rememberResult = await client.rememberAndWait(serializedText, namespace, {
      pollIntervalMs: tunables.pollingIntervalMs,
      timeoutMs: Math.max(tunables.requestTimeoutMs * 4, 90000),
      idempotencyKey: `${circle.circleId}:${proposalToWrite.id || recordId}`,
    })

    if (!rememberResult || !rememberResult.blob_id) {
      throw new Error('Walrus Memory write completed without returning a valid blob_id.')
    }

    const savedRecord = {
      ...draftRecord,
      id: rememberResult.id || recordId,
      jobId: rememberResult.job_id || rememberResult.id,
      walrusBlobId: rememberResult.blob_id,
      namespace: rememberResult.namespace || namespace,
      owner: rememberResult.owner,
      createdAt: new Date().toISOString(),
    }

    if (proposalId) {
      pendingProposals.delete(String(proposalId).trim())
    }

    if (!sessionConfirmedCache.has(namespace)) {
      sessionConfirmedCache.set(namespace, new Map())
    }
    sessionConfirmedCache.get(namespace).set(savedRecord.walrusBlobId, savedRecord)

    return savedRecord
  } finally {
    client.destroy()
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

  const { client, namespace, tunables } = createMemWalClient(circleId, env)
  try {
    const searchQuery =
      query && query.trim()
        ? query.trim()
        : 'circle agreement grace period member payment pattern reminder preference rule'

    const limit = options.limit || tunables.recallLimit
    const recallRes = await client.recall({
      query: searchQuery,
      limit,
      namespace,
      sort: options.sort || 'relevance',
    })

    const records = (recallRes.results || [])
      .filter((hit) => Boolean(hit.blob_id))
      .map((hit) => parseRecalledMemory(hit, circleId))
      .filter((rec) => {
        if (!options.includeQuarantinedForAudit && isQuarantinedSyntheticRecord(rec)) {
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
    client.destroy()
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
      if (!isQuarantinedSyntheticRecord(rec)) {
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
 * Trigger Walrus Memory `restore(namespace, limit)` to re-index missing on-chain Walrus blobs
 * for this circle's namespace, then recall recent memories from the restored index.
 */
export async function restoreCircleMemoriesFromWalrus(circleId, limit, env = process.env) {
  assertCircleNotQuarantined(circleId)
  const { client, namespace, tunables } = createMemWalClient(circleId, env)
  try {
    const inspectLimit = limit || tunables.recallLimit
    const restoreRes = await client.restore(namespace, inspectLimit)
    const recalled = await recallCircleMemories(
      circleId,
      'circle agreement member pattern reminder preference verified payment cycle rule',
      { limit: tunables.recallLimit, sort: 'recent' },
      env
    )

    return {
      namespace,
      restoreResult: restoreRes,
      records: recalled.records,
      limitationsNote:
        'Walrus Memory is a semantic vector store, not a relational database. restore() re-indexes on-chain Walrus blobs missing from the relayer vector index (bounded by limit and relayer candidate caps), and recent memories are retrieved via semantic recall. Circle rosters, wallet sessions, pending proposals, and submitted tx digests are held in server memory only.',
    }
  } finally {
    client.destroy()
  }
}

/**
 * Check Walrus Memory relayer health and list namespaces for the configured account.
 */
export async function checkWalrusMemoryHealth(env = process.env) {
  const cfg = loadConfig(env)
  if (!cfg.integrations.memwal.configured) {
    return {
      connected: false,
      configured: false,
      status: cfg.integrations.memwal.status,
      issues: cfg.integrations.memwal.issues,
    }
  }

  const { client, serviceConfig } = createMemWalClient('health-check', env)
  try {
    const health = await client.health()
    return {
      connected: health.status === 'ok',
      configured: true,
      relayerUrl: serviceConfig.MEMWAL_SERVER_URL,
      accountId: serviceConfig.MEMWAL_ACCOUNT_ID,
      version: health.version,
      writeReady: health.write_ready ?? true,
      mode: health.mode,
    }
  } catch (err) {
    return {
      connected: false,
      configured: true,
      relayerUrl: serviceConfig.MEMWAL_SERVER_URL,
      accountId: serviceConfig.MEMWAL_ACCOUNT_ID,
      error: err.message,
    }
  } finally {
    client.destroy()
  }
}
