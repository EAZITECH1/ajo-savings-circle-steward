import crypto from 'node:crypto'
import { MemWal } from '@mysten-incubation/memwal'
import { requireIntegrationConfig, loadConfig } from './config.mjs'
import { normalizeSuiAddress } from './payment-policy.mjs'

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
  const namespace = circleId ? resolveCircleNamespace(circleId, env) : (serviceConfig.MEMWAL_NAMESPACE_PREFIX || 'ajo-circle')
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
 * Register or update a circle's configuration and member roster on the server
 * so membership & authorization checks can be enforced server-side.
 */
export function upsertCircleRoster(circleData) {
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

  const normalizedMembers = members.map((m, idx) => ({
    id: m.id || `m${idx + 1}`,
    name: String(m.name || '').trim(),
    address: String(m.address || '').trim(),
    avatarColor: m.avatarColor || 'bg-utility-brand-50 text-utility-brand-700',
  }))

  const record = {
    circleId: circleId.trim(),
    circleName: circleName.trim(),
    poolAddress: String(poolAddress || '').trim(),
    contributionPerMember: Number(contributionPerMember) || 0,
    tokenType: String(tokenType || '').trim(),
    cycleLength: String(cycleLength || 'Monthly'),
    currentCycle: Number(currentCycle) || 1,
    members: normalizedMembers,
    organizerAddress: organizerAddress ? String(organizerAddress).trim() : normalizedMembers[0]?.address || '',
    updatedAt: new Date().toISOString(),
  }

  circleRegistry.set(record.circleId, record)
  return record
}

export function getCircleRoster(circleId) {
  return circleRegistry.get(circleId) || null
}

export function listCircleRosters() {
  return Array.from(circleRegistry.values())
}

/**
 * Verify that an actor (`memberId` or `memberAddress`) belongs to the circle's registered roster.
 */
export function verifyCircleMembership(circleId, { memberId, memberAddress }) {
  const circle = circleRegistry.get(circleId)
  if (!circle) {
    throw new Error(`Circle "${circleId}" is not registered on the server. Activate or register the circle first.`)
  }
  if (!circle.members || circle.members.length === 0) {
    throw new Error(`Circle "${circleId}" has no registered members.`)
  }

  const normAddr = memberAddress ? normalizeSuiAddress(memberAddress) : ''
  const matched = circle.members.find((m) => {
    if (memberId && m.id === memberId) return true
    if (normAddr && normalizeSuiAddress(m.address) === normAddr) return true
    return false
  })

  if (!matched) {
    throw new Error(
      `Authorization failed: member (${memberId || memberAddress || 'unknown'}) is not in circle "${circle.circleName}".`
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

  const plainSentence =
    record.context ||
    `${record.title}: ${record.quote}`

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
    confirmedByList: Array.isArray(record.confirmedByList) ? record.confirmedByList : [record.confirmedBy],
    confirmationType: record.confirmationType || 'organizer_entered',
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
          (hit.created_at ? new Date(hit.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recorded on Walrus'),
        cycle: Number(meta.cycle) || 1,
        confirmedBy: meta.confirmedBy || 'Organizer-entered record',
        confirmedByList: meta.confirmedByList || [meta.confirmedBy || 'Organizer-entered record'],
        confirmationType: meta.confirmationType || 'organizer_entered',
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

  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean)
  const titleLine = lines.find((l) => l.startsWith('Title:'))
  const summaryLine = lines.find((l) => l.startsWith('Summary:'))
  const quoteLine = lines.find((l) => l.startsWith('Source quote:'))

  const title = titleLine ? titleLine.replace(/^Title:\s*/, '') : lines[0]?.slice(0, 72) || 'Walrus Memory Record'
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
      ? new Date(hit.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
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
 * Issue a server-side challenge for a member to sign or confirm a proposed memory.
 */
export function issueConfirmationChallenge({ circleId, proposalId, memberId, memberAddress }) {
  const { member } = verifyCircleMembership(circleId, { memberId, memberAddress })
  const nonce = crypto.randomUUID()
  const issuedAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const message = [
    'Ajo Steward Memory Confirmation',
    `Circle: ${circleId}`,
    `Proposal: ${proposalId}`,
    `Member: ${member.id} (${member.address})`,
    `Nonce: ${nonce}`,
    `IssuedAt: ${issuedAt}`,
  ].join('\n')

  authChallenges.set(nonce, {
    nonce,
    circleId,
    proposalId,
    memberId: member.id,
    memberAddress: member.address,
    message,
    expiresAtMs: Date.now() + 10 * 60 * 1000,
  })

  return { nonce, message, expiresAt, member }
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
  if (!title || !quote) throw new Error('title and quote are required to propose a memory')

  const proposal = {
    id: `prop-${crypto.randomUUID()}`,
    circleId,
    category,
    memoryType: memoryType || categoryToMemoryType(category),
    title: String(title).trim(),
    quote: String(quote).trim(),
    suggestedAction: String(suggestedAction || title).trim(),
    memberId: memberId ? String(memberId).trim() : undefined,
    memberIds: Array.isArray(memberIds) ? memberIds : memberId ? [String(memberId).trim()] : [],
    cycle: Number(cycle) || 1,
    txDigest: txDigest ? String(txDigest).trim() : undefined,
    proposedBy,
    createdAt: new Date().toISOString(),
  }

  pendingProposals.set(proposal.id, proposal)
  return proposal
}

export function getPendingProposals(circleId) {
  return Array.from(pendingProposals.values()).filter((p) => !circleId || p.circleId === circleId)
}

/**
 * Confirm a proposed memory and write it to Walrus Mainnet via @mysten-incubation/memwal.
 * Waits for the background Walrus upload & indexing job to reach terminal `done` status
 * and returns the real Walrus `blob_id`.
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
  } = input

  if (!circleId) {
    throw new Error('circleId is required to confirm a memory')
  }

  // Enforce server-side circle membership
  const { circle, member } = verifyCircleMembership(circleId, { memberId, memberAddress })

  const storedProposal = proposalId ? pendingProposals.get(proposalId) : null
  const proposal = storedProposal || inlineProposal
  if (!proposal || !proposal.title || !proposal.quote) {
    throw new Error('Valid memory proposal (proposalId or proposal payload) is required for confirmation.')
  }
  if (storedProposal && storedProposal.circleId !== circleId) {
    throw new Error(`Proposal "${proposalId}" does not belong to circle "${circleId}".`)
  }

  // Determine confirmation authentication level
  let confirmationType = 'organizer_entered'
  let confirmedByLabel = `Organizer-entered record (${member.name} · ${member.address})`

  if (signature && challengeNonce && publicKeyHex) {
    const challenge = authChallenges.get(challengeNonce)
    if (!challenge || challenge.circleId !== circleId || challenge.memberId !== member.id) {
      throw new Error('Invalid or mismatched confirmation challenge nonce.')
    }
    if (Date.now() > challenge.expiresAtMs) {
      authChallenges.delete(challengeNonce)
      throw new Error('Confirmation challenge nonce has expired.')
    }
    // Verify Ed25519 signature using Node crypto
    const pubKeyBytes = Buffer.from(publicKeyHex.replace(/^0x/, ''), 'hex')
    const sigBytes = Buffer.from(signature.replace(/^0x/, ''), 'hex')
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
    const pubKeyObj = crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, pubKeyBytes]),
      format: 'der',
      type: 'spki',
    })
    const verified = crypto.verify(
      null,
      Buffer.from(challenge.message, 'utf8'),
      pubKeyObj,
      sigBytes
    )
    if (!verified) {
      throw new Error('Cryptographic Ed25519 signature verification failed for confirmation challenge.')
    }
    authChallenges.delete(challengeNonce)
    confirmationType = 'wallet_signature_verified'
    confirmedByLabel = `Signed by ${member.name} (${member.address})`
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
      memoryType: proposal.memoryType || categoryToMemoryType(proposal.category),
      category: proposal.category || 'Agreements',
      title: proposal.title,
      quote: proposal.quote,
      context: proposal.suggestedAction || proposal.context || proposal.title,
      date: dateStr,
      cycle: Number(proposal.cycle) || circle.currentCycle || 1,
      confirmedBy: confirmedByLabel,
      confirmedByList: [confirmedByLabel],
      confirmationType,
      memberId: proposal.memberId,
      memberIds: proposal.memberIds || (proposal.memberId ? [proposal.memberId] : []),
      txDigest: proposal.txDigest,
    }

    const serializedText = serializeMemoryForWalrus(draftRecord)

    // Write to Walrus Mainnet and wait for terminal completion (`done` + real `blob_id`)
    const rememberResult = await client.rememberAndWait(serializedText, namespace, {
      pollIntervalMs: tunables.pollingIntervalMs,
      timeoutMs: Math.max(tunables.requestTimeoutMs * 4, 90000),
      idempotencyKey: `${circle.circleId}:${proposal.id || recordId}`,
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
      pendingProposals.delete(proposalId)
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
 */
export async function recallCircleMemories(circleId, query, options = {}, env = process.env) {
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
        if (options.category && rec.category !== options.category) return false
        if (options.memberId && rec.memberId !== options.memberId && !(rec.memberIds || []).includes(options.memberId)) {
          return false
        }
        if (options.cycle !== undefined && rec.cycle !== options.cycle) return false
        return true
      })

    // Cache recalled records by real blob_id
    if (!sessionConfirmedCache.has(namespace)) {
      sessionConfirmedCache.set(namespace, new Map())
    }
    const nsCache = sessionConfirmedCache.get(namespace)
    for (const r of records) {
      if (r.walrusBlobId) nsCache.set(r.walrusBlobId, r)
    }

    return {
      namespace,
      query: searchQuery,
      total: recallRes.total ?? records.length,
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
      byBlob.set(blobId, rec)
    }
  }
  for (const rec of recalled.records) {
    if (rec.walrusBlobId && !byBlob.has(rec.walrusBlobId)) {
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
 *
 * Honest capability boundary (per SDK docs):
 * - `memwal.restore(namespace, limit)` scans on-chain Walrus blobs owned by the account in `namespace`,
 *   downloads & SEAL-decrypts blobs missing from the relayer's vector index, and re-embeds them.
 * - It is subject to `limit` and the relayer's per-owner candidate cap, and Walrus Memory is
 *   semantic vector memory rather than a deterministic relational database.
 */
export async function restoreCircleMemoriesFromWalrus(circleId, limit, env = process.env) {
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
        'Walrus Memory is a semantic vector store, not a relational database. restore() re-indexes on-chain Walrus blobs missing from the relayer vector index (bounded by limit and relayer candidate caps), and recent memories are retrieved via semantic recall.',
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
