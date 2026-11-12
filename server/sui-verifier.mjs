import { loadConfig } from './config.mjs'
import { tatumRpc, tatumGraphql, MissingApiKeyError } from './tatum-client.mjs'
import {
  classifyChainContribution,
  evaluateContributionPolicy,
  normalizeSuiAddress,
  normalizeCoinType,
} from './payment-policy.mjs'
import { getSupportedTokens } from './tokens.mjs'

export class TransactionConflictError extends Error {
  constructor(message, statusCode = 409) {
    super(message)
    this.name = 'TransactionConflictError'
    this.statusCode = statusCode
    this.code = 'TRANSACTION_CONFLICT'
  }
}

/**
 * Validate a Sui transaction digest (Base58-encoded 32-byte digest, typically 43-44 chars).
 * Rejects 0x-prefixed hex strings or malformed strings.
 * @param {string} digest
 */
export function isValidSuiDigest(digest) {
  if (typeof digest !== 'string') return false
  const trimmed = digest.trim()
  if (!trimmed || trimmed.startsWith('0x')) return false
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(trimmed)
}

/**
 * Rate-limited execution queue with exponential backoff for Tatum RPC calls.
 */
class RateLimitedRpcQueue {
  constructor() {
    this.lastRunAtMs = 0
    this.chain = Promise.resolve()
  }

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @param {{ rateLimitRps: number, rateLimitMaxRetries: number, rateLimitBackoffMs: number }} opts
   * @returns {Promise<T>}
   */
  enqueue(task, opts) {
    const minIntervalMs = Math.ceil(1000 / Math.max(opts.rateLimitRps || 3, 0.1))
    const run = async () => {
      const now = Date.now()
      const waitMs = Math.max(0, this.lastRunAtMs + minIntervalMs - now)
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs))
      }
      this.lastRunAtMs = Date.now()
      return this.executeWithRetry(task, opts.rateLimitMaxRetries ?? 3, opts.rateLimitBackoffMs ?? 1000)
    }
    const resultPromise = this.chain.then(run, run)
    this.chain = resultPromise.then(
      () => undefined,
      () => undefined
    )
    return resultPromise
  }

  async executeWithRetry(task, maxRetries, baseBackoffMs) {
    let attempt = 0
    while (true) {
      try {
        return await task()
      } catch (err) {
        const retryable = err?.retryable === true || err?.name === 'TimeoutError' || err?.name === 'AbortError'
        if (!retryable || attempt >= maxRetries) {
          throw err
        }
        const delayMs = baseBackoffMs * Math.pow(2, attempt)
        attempt++
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }
}

const rpcQueue = new RateLimitedRpcQueue()

/**
 * In-memory stores of member-submitted transaction digests and server-verified chain outcomes
 * per `(circleId, cycle, normalizedMemberAddress)` and `(txDigest, network)`.
 * Enforces unique `(txDigest, network)` claims so the same transaction digest cannot be claimed
 * across conflicting members, circles, or cycles.
 */
const submittedTransactionsStore = new Map()
const submittedDigestsStore = new Map()
const serverVerifiedContributionsStore = new Map()

function makeDigestKey(circleId, cycle, memberAddress) {
  return `${String(circleId || 'default').trim()}:${Number(cycle) || 1}:${normalizeSuiAddress(memberAddress)}`
}

function makeTxNetworkKey(txDigest, network) {
  return `${String(txDigest || '').trim()}:${String(network || 'testnet').trim()}`
}

export function recordSubmittedDigest(circleId, cycle, memberAddress, digest, options = {}) {
  const normCircleId = String(circleId || 'default').trim()
  const normCycle = Number(cycle) || 1
  const normMember = normalizeSuiAddress(memberAddress)
  const trimmedDigest = String(digest || '').trim()
  const network = String(options.network || process.env.SUI_NETWORK || 'testnet').trim()
  const poolAddress = String(options.poolAddress || '').trim()
  const memberId = options.memberId ? String(options.memberId).trim() : null

  const txKey = makeTxNetworkKey(trimmedDigest, network)
  const existing = submittedTransactionsStore.get(txKey)

  if (
    existing &&
    (existing.circleId !== normCircleId ||
      Number(existing.cycle) !== normCycle ||
      existing.normalizedMemberAddress !== normMember)
  ) {
    throw new TransactionConflictError(
      `Conflicting transaction submission: digest "${trimmedDigest}" on Sui ${network} is already claimed for circle "${existing.circleId}", cycle ${existing.cycle}, member ${existing.normalizedMemberAddress}.`,
      409
    )
  }

  if (!existing) {
    submittedTransactionsStore.set(txKey, {
      txDigest: trimmedDigest,
      network,
      circleId: normCircleId,
      cycle: normCycle,
      memberId: memberId || undefined,
      normalizedMemberAddress: normMember,
      expectedPoolAddress: poolAddress,
      observedSender: null,
      observedRecipient: null,
      tokenType: null,
      amount: null,
      executionStatus: 'unverified_claim',
      txTimestampMs: null,
      txTimestampIso: null,
      verifiedAtIso: new Date().toISOString(),
    })
  }

  const key = makeDigestKey(normCircleId, normCycle, normMember)
  const list = submittedDigestsStore.get(key) || []
  if (trimmedDigest && !list.includes(trimmedDigest)) {
    list.push(trimmedDigest)
    submittedDigestsStore.set(key, list)
  }
  return [...list]
}

export function getSubmittedDigests(circleId, cycle, memberAddress) {
  const key = makeDigestKey(circleId, cycle, memberAddress)
  return [...(submittedDigestsStore.get(key) || [])]
}

export function getPersistedSubmittedTransaction(txDigest, network = process.env.SUI_NETWORK || 'testnet') {
  const txKey = makeTxNetworkKey(txDigest, network)
  const row = submittedTransactionsStore.get(txKey)
  return row ? { ...row } : null
}

export function recordServerVerifiedContribution(
  circleId,
  cycle,
  memberAddress,
  result,
  observedTransfers = []
) {
  const normCircleId = String(circleId || 'default').trim()
  const normCycle = Number(cycle) || 1
  const normMember = normalizeSuiAddress(memberAddress)
  const verifiedAtIso = new Date().toISOString()
  const network = String(result.network || process.env.SUI_NETWORK || 'testnet').trim()
  const digestsList = Array.isArray(result.txDigests)
    ? result.txDigests
    : result.txDigest
    ? [result.txDigest]
    : []

  const firstTransfer = observedTransfers[0] || null
  const observedSender = result.observedSender || firstTransfer?.sender || null
  const observedRecipient = result.observedRecipient || firstTransfer?.recipient || null
  const executionStatus =
    result.executionStatus ||
    (firstTransfer
      ? firstTransfer.executionSuccess === false
        ? 'failure'
        : 'success'
      : result.status === 'Verified' || result.status === 'Late' || result.status === 'Partial'
      ? 'success'
      : 'unverified')

  for (const t of observedTransfers) {
    if (!t.txDigest) continue
    const txKey = makeTxNetworkKey(t.txDigest, network)
    const existing = submittedTransactionsStore.get(txKey)

    if (
      existing &&
      (existing.circleId !== normCircleId ||
        Number(existing.cycle) !== normCycle ||
        existing.normalizedMemberAddress !== normMember)
    ) {
      throw new TransactionConflictError(
        `Conflicting transaction submission: digest "${t.txDigest}" on Sui ${network} is already claimed for circle "${existing.circleId}", cycle ${existing.cycle}, member ${existing.normalizedMemberAddress}.`,
        409
      )
    }

    const txIso = Number.isFinite(t.timestampMs) ? new Date(t.timestampMs).toISOString() : null
    const txStatus = t.executionSuccess === false ? 'failure' : 'success'

    submittedTransactionsStore.set(txKey, {
      txDigest: t.txDigest,
      network,
      circleId: normCircleId,
      cycle: normCycle,
      memberId: result.memberId ?? existing?.memberId,
      normalizedMemberAddress: normMember,
      expectedPoolAddress: result.expectedPoolAddress || existing?.expectedPoolAddress || '',
      observedSender: t.sender || null,
      observedRecipient: t.recipient || null,
      tokenType: t.tokenType || null,
      amount: typeof t.amount === 'number' ? t.amount : 0,
      executionStatus: txStatus,
      txTimestampMs: Number.isFinite(t.timestampMs) ? t.timestampMs : null,
      txTimestampIso: txIso,
      verifiedAtIso,
    })
  }

  const key = makeDigestKey(normCircleId, normCycle, normMember)
  const record = {
    ...result,
    network,
    txDigests: digestsList,
    observedSender,
    observedRecipient,
    executionStatus,
    verifiedAtServerIso: verifiedAtIso,
  }
  serverVerifiedContributionsStore.set(key, record)
  return record
}

export function getServerVerifiedContribution(circleId, cycle, memberAddress) {
  const key = makeDigestKey(circleId, cycle, memberAddress)
  return serverVerifiedContributionsStore.get(key) || null
}

export function clearSubmittedDigests(circleId, cycle, memberAddress) {
  const normCircleId = String(circleId || 'default').trim()
  const normCycle = Number(cycle) || 1
  const normMember = normalizeSuiAddress(memberAddress)
  const key = makeDigestKey(normCircleId, normCycle, normMember)
  const digests = submittedDigestsStore.get(key) || []
  for (const d of digests) {
    for (const [txKey, entry] of submittedTransactionsStore.entries()) {
      if (
        entry.txDigest === d &&
        entry.circleId === normCircleId &&
        Number(entry.cycle) === normCycle &&
        entry.normalizedMemberAddress === normMember
      ) {
        submittedTransactionsStore.delete(txKey)
      }
    }
  }
  submittedDigestsStore.delete(key)
  serverVerifiedContributionsStore.delete(key)
}

export function clearAllCircleSubmittedDigests(circleId) {
  const normCircleId = String(circleId || 'default').trim()
  const prefix = `${normCircleId}:`
  for (const key of Array.from(submittedDigestsStore.keys())) {
    if (key.startsWith(prefix)) submittedDigestsStore.delete(key)
  }
  for (const key of Array.from(serverVerifiedContributionsStore.keys())) {
    if (key.startsWith(prefix)) serverVerifiedContributionsStore.delete(key)
  }
  for (const [txKey, entry] of Array.from(submittedTransactionsStore.entries())) {
    if (entry.circleId === normCircleId) {
      submittedTransactionsStore.delete(txKey)
    }
  }
}

export function listSubmittedTransactionsForCircle(circleId) {
  const normCircleId = String(circleId || 'default').trim()
  const items = []
  for (const entry of submittedTransactionsStore.values()) {
    if (entry.circleId === normCircleId) {
      items.push({ ...entry })
    }
  }
  return items
}

function makeTokenDecimalsResolver(network, fallbackCoinType, fallbackDecimals) {
  const decimalsByCoinType = new Map()
  for (const token of Object.values(getSupportedTokens(network))) {
    if (token.coinType && Number.isInteger(token.decimals)) {
      decimalsByCoinType.set(normalizeCoinType(token.coinType), token.decimals)
    }
  }
  if (fallbackCoinType && Number.isInteger(fallbackDecimals)) {
    decimalsByCoinType.set(normalizeCoinType(fallbackCoinType), fallbackDecimals)
  }

  return (coinType) => decimalsByCoinType.get(normalizeCoinType(coinType))
}

function resolveDecimals(tokenDecimals, coinType) {
  const decimals = typeof tokenDecimals === 'function'
    ? tokenDecimals(coinType)
    : tokenDecimals
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : null
}

function unknownPoolTokenDecimals(txDigest, coinType) {
  return {
    lookupStatus: 'incomplete_fields',
    lookupError: `Cannot safely verify transaction "${txDigest}": decimals are not configured for token ${coinType}.`,
    transfers: [],
  }
}

/**
 * Parse a `sui_getTransactionBlock` result payload into verified transfer observations.
 * Verifies that `transaction.data.sender`, `effects.status.status`, `balanceChanges`,
 * and `timestampMs` are present before extracting transfers.
 *
 * @param {string} txDigest
 * @param {any} rpcResult
 * @param {string} expectedPoolAddress
 * @param {number | ((coinType: string) => number | undefined)} tokenDecimals
 */
export function parseSuiTransactionBlock(txDigest, rpcResult, expectedPoolAddress, tokenDecimals = 6) {
  if (!rpcResult || typeof rpcResult !== 'object') {
    return {
      lookupStatus: 'not_found',
      lookupError: `Transaction digest "${txDigest}" was not found on Sui.`,
      transfers: [],
    }
  }

  const sender = rpcResult?.transaction?.data?.sender
  const statusStr = rpcResult?.effects?.status?.status
  const balanceChanges = rpcResult?.balanceChanges
  const rawTimestamp = rpcResult?.timestampMs

  const missingFields = []
  if (!sender || typeof sender !== 'string') missingFields.push('transaction.data.sender')
  if (!statusStr || typeof statusStr !== 'string') missingFields.push('effects.status.status')
  if (!Array.isArray(balanceChanges)) missingFields.push('balanceChanges')
  if (rawTimestamp === undefined || rawTimestamp === null || Number.isNaN(Number(rawTimestamp))) {
    missingFields.push('timestampMs')
  }

  if (missingFields.length > 0) {
    return {
      lookupStatus: 'incomplete_fields',
      lookupError: `Sui transaction "${txDigest}" response is missing required fields: ${missingFields.join(', ')}.`,
      transfers: [],
    }
  }

  const executionSuccess = statusStr === 'success'
  const timestampMs = Number(rawTimestamp)

  if (!executionSuccess) {
    return {
      lookupStatus: 'found',
      transfers: [
        {
          txDigest,
          sender,
          recipient: expectedPoolAddress,
          tokenType: '',
          amount: 0,
          timestampMs,
          executionSuccess: false,
        },
      ],
    }
  }

  const positiveChanges = []

  // 1. Move Contract Event Verification (Circle<T> shared object vault deposits)
  const events = rpcResult?.events || []
  for (const ev of events) {
    const typeStr = ev?.type || ''
    if (typeStr.includes('::circle::ContributionEvent')) {
      const eventJson = ev?.parsedJson || {}
      const circleId = eventJson.circle_id || ''
      if (!expectedPoolAddress || normalizeSuiAddress(circleId) === normalizeSuiAddress(expectedPoolAddress)) {
        const member = eventJson.member || sender
        const amountPaidStr = String(eventJson.amount_paid ?? '0')
        let rawAmtBig = 0n
        try { rawAmtBig = BigInt(amountPaidStr) } catch {}
        let matchedCoinType = ''
        if (Array.isArray(balanceChanges)) {
          const negCoin = balanceChanges.find((bc) => {
            const ct = bc?.coinType || ''
            const amt = BigInt(String(bc?.amount ?? '0'))
            return amt < 0n && !ct.endsWith('::sui::SUI')
          })
          if (negCoin) matchedCoinType = negCoin.coinType || ''
          else {
            const suiNeg = balanceChanges.find((bc) => {
              const ct = bc?.coinType || ''
              const amt = BigInt(String(bc?.amount ?? '0'))
              return amt < 0n && ct.endsWith('::sui::SUI')
            })
            if (suiNeg) matchedCoinType = suiNeg.coinType || '0x2::sui::SUI'
          }
        }
        if (rawAmtBig > 0n) {
          const decimals = resolveDecimals(tokenDecimals, matchedCoinType) ?? 6
          const divisor = Math.pow(10, decimals)
          const humanAmount = Number(rawAmtBig) / divisor
          positiveChanges.push({
            txDigest,
            sender: member,
            recipient: expectedPoolAddress || circleId,
            tokenType: matchedCoinType,
            amount: humanAmount,
            timestampMs,
            executionSuccess: true,
          })
        }
      }
    }
  }

  // 2. Direct Coin Balance Changes Verification (Fallback for direct peer-to-peer / wallet transfers)
  if (positiveChanges.length === 0) {
    for (const bc of balanceChanges) {
      const recipient = bc?.owner?.AddressOwner || bc?.owner?.ObjectOwner || ''
      const coinType = bc?.coinType || ''
      const rawAmtStr = String(bc?.amount ?? '0')
      let rawAmtBig
      try {
        rawAmtBig = BigInt(rawAmtStr)
      } catch {
        continue
      }
      if (rawAmtBig > 0n && recipient && coinType) {
        if (expectedPoolAddress && normalizeSuiAddress(recipient) !== normalizeSuiAddress(expectedPoolAddress)) {
          continue
        }
        const decimals = resolveDecimals(tokenDecimals, coinType)
        if (decimals === null) {
          if (normalizeSuiAddress(recipient) === normalizeSuiAddress(expectedPoolAddress)) {
            return unknownPoolTokenDecimals(txDigest, coinType)
          }
          continue
        }
        const divisor = Math.pow(10, decimals)
        const humanAmount = Number(rawAmtBig) / divisor
        positiveChanges.push({
          txDigest,
          sender,
          recipient,
          tokenType: coinType,
          amount: humanAmount,
          timestampMs,
          executionSuccess: true,
        })
      }
    }
  }

  if (positiveChanges.length === 0) {
    return {
      lookupStatus: 'found',
      transfers: [
        {
          txDigest,
          sender,
          recipient: '',
          tokenType: '',
          amount: 0,
          timestampMs,
          executionSuccess: true,
        },
      ],
    }
  }

  return {
    lookupStatus: 'found',
    transfers: positiveChanges,
  }
}

/**
 * Parse a Tatum Sui GraphQL `transaction(digest)` payload into verified transfer observations.
 * Verifies that `sender.address`, `effects.status`, `effects.timestamp`, and
 * `effects.balanceChanges.nodes` are present before extracting transfers.
 *
 * @param {string} txDigest
 * @param {any} gqlTx
 * @param {string} expectedPoolAddress
 * @param {number | ((coinType: string) => number | undefined)} tokenDecimals
 */
export function parseSuiGraphqlTransaction(txDigest, gqlTx, expectedPoolAddress, tokenDecimals = 6) {
  if (!gqlTx || typeof gqlTx !== 'object') {
    return {
      lookupStatus: 'not_found',
      lookupError: `Transaction digest "${txDigest}" was not found on Sui.`,
      transfers: [],
    }
  }

  const sender = gqlTx?.sender?.address
  const statusStr = gqlTx?.effects?.status
  const balanceChangesNodes = gqlTx?.effects?.balanceChanges?.nodes
  const rawTimestampIso = gqlTx?.effects?.timestamp

  const missingFields = []
  if (!sender || typeof sender !== 'string') missingFields.push('sender.address')
  if (!statusStr || typeof statusStr !== 'string') missingFields.push('effects.status')
  if (!Array.isArray(balanceChangesNodes)) missingFields.push('effects.balanceChanges.nodes')
  const parsedTimeMs = rawTimestampIso ? Date.parse(rawTimestampIso) : NaN
  if (!rawTimestampIso || Number.isNaN(parsedTimeMs)) {
    missingFields.push('effects.timestamp')
  }

  if (missingFields.length > 0) {
    return {
      lookupStatus: 'incomplete_fields',
      lookupError: `Sui GraphQL transaction "${txDigest}" response is missing required fields: ${missingFields.join(', ')}.`,
      transfers: [],
    }
  }

  const executionSuccess = statusStr.toUpperCase() === 'SUCCESS'
  const timestampMs = parsedTimeMs

  if (!executionSuccess) {
    return {
      lookupStatus: 'found',
      transfers: [
        {
          txDigest,
          sender,
          recipient: expectedPoolAddress,
          tokenType: '',
          amount: 0,
          timestampMs,
          executionSuccess: false,
        },
      ],
    }
  }

  const positiveChanges = []

  // 1. Move Contract Event Verification (Circle<T> shared object vault deposits)
  const events = gqlTx?.effects?.events?.nodes || []
  for (const ev of events) {
    const typeRepr = ev?.contents?.type?.repr || ''
    if (typeRepr.includes('::circle::ContributionEvent')) {
      const eventJson = ev?.contents?.json || {}
      const circleId = eventJson.circle_id || ''
      if (!expectedPoolAddress || normalizeSuiAddress(circleId) === normalizeSuiAddress(expectedPoolAddress)) {
        const member = eventJson.member || sender
        const amountPaidStr = String(eventJson.amount_paid ?? '0')
        let rawAmtBig = 0n
        try {
          rawAmtBig = BigInt(amountPaidStr)
        } catch {}

        // Find tokenType from negative balanceChange of the member, or fallback to circle config/tokens
        let matchedCoinType = ''
        if (Array.isArray(balanceChangesNodes)) {
          const negCoin = balanceChangesNodes.find((bc) => {
            const ct = bc?.coinType?.repr || ''
            const amt = BigInt(String(bc?.amount ?? '0'))
            return amt < 0n && !ct.endsWith('::sui::SUI')
          })
          if (negCoin) {
            matchedCoinType = negCoin.coinType?.repr || ''
          } else {
            const suiNeg = balanceChangesNodes.find((bc) => {
              const ct = bc?.coinType?.repr || ''
              const amt = BigInt(String(bc?.amount ?? '0'))
              return amt < 0n && ct.endsWith('::sui::SUI')
            })
            if (suiNeg) matchedCoinType = suiNeg.coinType?.repr || '0x2::sui::SUI'
          }
        }

        if (rawAmtBig > 0n) {
          const decimals = resolveDecimals(tokenDecimals, matchedCoinType) ?? 6
          const divisor = Math.pow(10, decimals)
          const humanAmount = Number(rawAmtBig) / divisor
          positiveChanges.push({
            txDigest,
            sender: member,
            recipient: expectedPoolAddress || circleId,
            tokenType: matchedCoinType,
            amount: humanAmount,
            timestampMs,
            executionSuccess: true,
          })
        }
      }
    }
  }

  // 2. Direct Coin Balance Changes Verification (Fallback for direct peer-to-peer / wallet transfers)
  if (positiveChanges.length === 0) {
    for (const bc of balanceChangesNodes) {
      const recipient = bc?.owner?.address || ''
      const coinType = bc?.coinType?.repr || ''
      const rawAmtStr = String(bc?.amount ?? '0')
      let rawAmtBig
      try {
        rawAmtBig = BigInt(rawAmtStr)
      } catch {
        continue
      }
      if (rawAmtBig > 0n && recipient && coinType) {
        if (expectedPoolAddress && normalizeSuiAddress(recipient) !== normalizeSuiAddress(expectedPoolAddress)) {
          continue
        }
        const decimals = resolveDecimals(tokenDecimals, coinType)
        if (decimals === null) {
          if (normalizeSuiAddress(recipient) === normalizeSuiAddress(expectedPoolAddress)) {
            return unknownPoolTokenDecimals(txDigest, coinType)
          }
          continue
        }
        const divisor = Math.pow(10, decimals)
        const humanAmount = Number(rawAmtBig) / divisor
        positiveChanges.push({
          txDigest,
          sender,
          recipient,
          tokenType: coinType,
          amount: humanAmount,
          timestampMs,
          executionSuccess: true,
        })
      }
    }
  }

  if (positiveChanges.length === 0) {
    return {
      lookupStatus: 'found',
      transfers: [
        {
          txDigest,
          sender,
          recipient: '',
          tokenType: '',
          amount: 0,
          timestampMs,
          executionSuccess: true,
        },
      ],
    }
  }

  return {
    lookupStatus: 'found',
    transfers: positiveChanges,
  }
}

const SUI_GRAPHQL_TX_QUERY = `
  query GetSuiTransaction($digest: String!) {
    transaction(digest: $digest) {
      digest
      sender {
        address
      }
      effects {
        status
        timestamp
        balanceChanges {
          nodes {
            owner {
              address
            }
            coinType {
              repr
            }
            amount
          }
        }
        events {
          nodes {
            contents {
              type {
                repr
              }
              json
            }
          }
        }
      }
    }
  }
`

const SUI_GRAPHQL_RECENT_CONTRIBUTIONS_QUERY = `
  query FindRecentContributions($pool: SuiAddress!, $sender: SuiAddress!) {
    transactions(last: 50, filter: { affectedAddress: $pool, sentAddress: $sender }) {
      nodes {
        digest
        sender { address }
        effects {
          status
          timestamp
          balanceChanges {
            nodes {
              owner { address }
              coinType { repr }
              amount
            }
          }
          events {
            nodes {
              contents {
                type { repr }
                json
              }
            }
          }
        }
      }
    }
  }
`

/**
 * Discover recent successful transfers from a member into a circle pool.
 * This recovers payments when the wallet execution succeeded but the client
 * did not retain the returned digest. Only transactions matching the exact
 * sender, recipient, token, and cycle start are returned.
 */
export async function discoverRecentContributionDigests(params, options = {}) {
  const env = options.env || process.env
  const cfg = loadConfig(env)
  if (!cfg.integrations.tatum.configured || !cfg.integrations.tatum.config) {
    throw new Error(`Tatum Sui integration is not configured (${cfg.integrations.tatum.issues.join('; ')}).`)
  }

  const {
    poolAddress,
    memberAddress,
    token,
    windowStart,
    windowEnd,
    cycle = 1,
    circleId,
    createdAt,
    expectedAmount,
    decimals,
  } = params
  const windowStartMs = typeof windowStart === 'number' ? windowStart : Date.parse(windowStart)
  const windowEndMs = typeof windowEnd === 'number' ? windowEnd : (windowEnd ? Date.parse(windowEnd) : NaN)
  const createdAtMs = createdAt ? (typeof createdAt === 'number' ? createdAt : Date.parse(createdAt)) : NaN
  const effectiveStartMs = Number.isFinite(createdAtMs) && Number.isFinite(windowStartMs)
    ? Math.max(createdAtMs, windowStartMs)
    : Number.isFinite(createdAtMs)
    ? createdAtMs
    : windowStartMs
  const clockSkewBufferMs = 60 * 1000
  const minValidTimestampMs = effectiveStartMs - clockSkewBufferMs
  if (!poolAddress || !memberAddress || !token || !Number.isFinite(windowStartMs)) {
    throw new Error('Pool, member, token, and a valid cycle start are required to discover contributions.')
  }

  const serviceConfig = cfg.integrations.tatum.config
  const tunables = cfg.tunables
  const network = serviceConfig.SUI_NETWORK
  const result = await rpcQueue.enqueue(
    async () => {
      const response = await tatumGraphql(
        'sui',
        SUI_GRAPHQL_RECENT_CONTRIBUTIONS_QUERY,
        { pool: poolAddress, sender: memberAddress },
        network,
        env
      )
      if ([429, 502, 503, 504].includes(response.status)) {
        const retryErr = new Error(`Tatum Sui GraphQL HTTP ${response.status}`)
        retryErr.retryable = true
        throw retryErr
      }
      if (!response.ok) throw new Error(`Tatum Sui GraphQL returned HTTP ${response.status}`)
      return response.json()
    },
    {
      rateLimitRps: tunables.rateLimitRps,
      rateLimitMaxRetries: tunables.rateLimitMaxRetries,
      rateLimitBackoffMs: tunables.rateLimitBackoffMs,
    }
  )

  if (Array.isArray(result?.errors) && result.errors.length > 0) {
    throw new Error(`Tatum Sui GraphQL error: ${result.errors.map((error) => error.message).join('; ')}`)
  }

  const expectedSender = normalizeSuiAddress(memberAddress)
  const expectedPool = normalizeSuiAddress(poolAddress)
  const expectedToken = normalizeCoinType(token)

  const matches = (result?.data?.transactions?.nodes || []).filter((transaction) => {
    const effects = transaction?.effects
    const timestampMs = Date.parse(effects?.timestamp || '')
    if (
      !transaction?.digest ||
      String(effects?.status || '').toUpperCase() !== 'SUCCESS' ||
      normalizeSuiAddress(transaction?.sender?.address || '') !== expectedSender ||
      !Number.isFinite(timestampMs) ||
      timestampMs < minValidTimestampMs ||
      (Number.isFinite(windowEndMs) && timestampMs > windowEndMs)
    ) {
      return false
    }

    // Check if digest was already claimed by a different circle in server memory
    if (circleId) {
      const txKey = makeTxNetworkKey(transaction.digest, network)
      const existing = submittedTransactionsStore.get(txKey)
      if (existing && existing.circleId !== String(circleId).trim()) {
        return false // Belongs to a different circle
      }
    }

    // Check for on-chain Move ContributionEvent
    const hasMatchingEvent = (effects?.events?.nodes || []).some((ev) => {
      const typeRepr = ev?.contents?.type?.repr || ''
      if (!typeRepr.includes('::circle::ContributionEvent')) return false
      const json = ev?.contents?.json || {}
      return normalizeSuiAddress(json.circle_id || '') === expectedPool &&
        normalizeSuiAddress(json.member || '') === expectedSender
    })
    if (hasMatchingEvent) return true

    return (effects?.balanceChanges?.nodes || []).some((change) => {
      let amount = 0n
      try { amount = BigInt(String(change?.amount ?? '0')) } catch {}
      return amount > 0n &&
        normalizeSuiAddress(change?.owner?.address || '') === expectedPool &&
        normalizeCoinType(change?.coinType?.repr || '') === expectedToken
    })
  })

  return [...new Set(matches.map((transaction) => transaction.digest))]
}

/**
 * Look up a single Sui transaction digest via Tatum's Sui Gateway (GraphQL `/graphql` or JSON-RPC `sui_getTransactionBlock`).
 *
 * @param {string} txDigest
 * @param {string} expectedPoolAddress
 * @param {{ env?: NodeJS.ProcessEnv, fetchRpc?: typeof tatumRpc, fetchGraphql?: typeof tatumGraphql }} [options]
 */
export async function lookupSuiTransactionViaTatum(txDigest, expectedPoolAddress, options = {}) {
  const env = options.env || process.env
  const hasCustomRpc = typeof options.fetchRpc === 'function'
  const rpcCaller = options.fetchRpc || tatumRpc
  const gqlCaller = options.fetchGraphql || tatumGraphql

  if (!isValidSuiDigest(txDigest)) {
    return {
      lookupStatus: 'malformed_digest',
      lookupError: `Invalid Sui transaction digest "${txDigest}". Expected a Base58-encoded 32-byte digest.`,
      transfers: [],
    }
  }

  const cfg = loadConfig(env)
  if (!cfg.integrations.tatum.configured || !cfg.integrations.tatum.config) {
    return {
      lookupStatus: 'unavailable',
      lookupError: `Tatum Sui integration is not configured (${cfg.integrations.tatum.issues.join('; ')}).`,
      transfers: [],
    }
  }

  const tatumCfg = cfg.integrations.tatum.config
  const tunables = cfg.tunables
  const network = tatumCfg.SUI_NETWORK
  const decimalsForCoinType = makeTokenDecimalsResolver(
    network,
    tatumCfg.SUI_TOKEN_TYPE,
    tatumCfg.SUI_TOKEN_DECIMALS
  )

  try {
    if (!hasCustomRpc) {
      // Use Tatum Sui GraphQL Gateway (`https://sui-{network}.gateway.tatum.io/graphql`)
      const gqlPayload = await rpcQueue.enqueue(
        async () => {
          const res = await gqlCaller(
            'sui',
            SUI_GRAPHQL_TX_QUERY,
            { digest: txDigest.trim() },
            network,
            env
          )

          if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
            const retryErr = new Error(`Tatum Sui GraphQL HTTP ${res.status}`)
            retryErr.retryable = true
            throw retryErr
          }

          if (!res.ok) {
            throw new Error(`Tatum Sui GraphQL returned HTTP ${res.status}`)
          }

          return res.json()
        },
        {
          rateLimitRps: tunables.rateLimitRps,
          rateLimitMaxRetries: tunables.rateLimitMaxRetries,
          rateLimitBackoffMs: tunables.rateLimitBackoffMs,
        }
      )

      if (Array.isArray(gqlPayload?.errors) && gqlPayload.errors.length > 0) {
        const errMsg = gqlPayload.errors.map((e) => e.message).join('; ')
        const isNotFound =
          errMsg.toLowerCase().includes('not find') ||
          errMsg.toLowerCase().includes('not found') ||
          errMsg.toLowerCase().includes('does not exist')
        return {
          lookupStatus: isNotFound ? 'not_found' : 'unavailable',
          lookupError: `Sui GraphQL error for digest "${txDigest}": ${errMsg}`,
          transfers: [],
        }
      }

      return parseSuiGraphqlTransaction(
        txDigest.trim(),
        gqlPayload?.data?.transaction,
        expectedPoolAddress,
        decimalsForCoinType
      )
    }

    const rpcPayload = await rpcQueue.enqueue(
      async () => {
        const res = await rpcCaller(
          'sui',
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'sui_getTransactionBlock',
            params: [
              txDigest.trim(),
              {
                showInput: true,
                showEffects: true,
                showBalanceChanges: true,
              },
            ],
          },
          network,
          env
        )

        if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
          const retryErr = new Error(`Tatum Sui RPC HTTP ${res.status}`)
          retryErr.retryable = true
          throw retryErr
        }

        if (!res.ok) {
          throw new Error(`Tatum Sui RPC returned HTTP ${res.status}`)
        }

        return res.json()
      },
      {
        rateLimitRps: tunables.rateLimitRps,
        rateLimitMaxRetries: tunables.rateLimitMaxRetries,
        rateLimitBackoffMs: tunables.rateLimitBackoffMs,
      }
    )

    if (rpcPayload?.error) {
      const errMsg = rpcPayload.error.message || JSON.stringify(rpcPayload.error)
      const isNotFound =
        errMsg.toLowerCase().includes('not find') ||
        errMsg.toLowerCase().includes('not found') ||
        errMsg.toLowerCase().includes('does not exist') ||
        rpcPayload.error.code === -32602
      return {
        lookupStatus: isNotFound ? 'not_found' : 'unavailable',
        lookupError: `Sui RPC error for digest "${txDigest}": ${errMsg}`,
        transfers: [],
      }
    }

    return parseSuiTransactionBlock(
      txDigest.trim(),
      rpcPayload?.result,
      expectedPoolAddress,
      decimalsForCoinType
    )
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return {
        lookupStatus: 'unavailable',
        lookupError: err.message,
        transfers: [],
      }
    }
    return {
      lookupStatus: 'unavailable',
      lookupError: `Failed to query Tatum Sui Gateway (${network}): ${err.message}`,
      transfers: [],
    }
  }
}

/**
 * Verify a member's contribution for a cycle (digest-first MVP, with split-payment aggregation)
 * and compute the separate group-policy evaluation.
 */
export async function verifyMemberContributionOnSui(params, options = {}) {
  const env = options.env || process.env
  const cfg = loadConfig(env)
  const tatumCfg = cfg.integrations.tatum.config
  const tunables = cfg.tunables

  const {
    circleId = 'default',
    poolAddress,
    memberAddress,
    memberId,
    memberName,
    token,
    expectedAmount,
    windowStart,
    windowEnd,
    cycle = 1,
    txDigest,
    txDigests,
    withMemory = true,
    memories = [],
  } = params

  const expectedToken = token || tatumCfg?.SUI_TOKEN_TYPE || ''
  if (!poolAddress || !memberAddress || !expectedToken || !expectedAmount) {
    const unverified = classifyChainContribution({
      lookupStatus: 'incomplete_fields',
      lookupError: 'Missing required verification parameters (poolAddress, memberAddress, token, expectedAmount).',
      expected: {
        poolAddress: poolAddress || '',
        memberAddress: memberAddress || '',
        token: expectedToken,
        expectedAmount: Number(expectedAmount) || 0,
        windowStart: windowStart || '',
        windowEnd: windowEnd || '',
      },
    })
    const policy = evaluateContributionPolicy(unverified, {
      withMemory,
      windowEnd,
      graceWindowHours: tunables.graceWindowHours,
      memories,
      memberId,
      memberName,
    })
    return { ...unverified, policy }
  }

  const buildUnverifiedFromStorageOrConflictError = (err, digestHint) => {
    const unverified = classifyChainContribution({
      lookupStatus: 'unavailable',
      lookupError: err.message || 'Durable storage failure while recording transaction verification.',
      expected: {
        poolAddress,
        memberAddress,
        token: expectedToken,
        expectedAmount: Number(expectedAmount),
        windowStart,
        windowEnd,
      },
    })
    const policy = evaluateContributionPolicy(unverified, {
      withMemory,
      windowEnd,
      graceWindowHours: tunables.graceWindowHours,
      memories,
      memberId,
      memberName,
    })
    return {
      ...unverified,
      txDigest: digestHint || txDigest || undefined,
      network: tatumCfg?.SUI_NETWORK || 'testnet',
      conflict: err instanceof TransactionConflictError ? true : undefined,
      policy,
    }
  }

  const resolvedNetwork = tatumCfg?.SUI_NETWORK || 'testnet'

  // Collect digests: explicitly provided in request or previously submitted for this member/cycle
  let digestsToVerify = []
  try {
    if (Array.isArray(txDigests) && txDigests.length > 0) {
      digestsToVerify = txDigests.map((d) => String(d).trim()).filter(Boolean)
      for (const d of digestsToVerify) {
        if (isValidSuiDigest(d)) {
          recordSubmittedDigest(circleId, cycle, memberAddress, d, {
            network: resolvedNetwork,
            poolAddress,
            memberId,
          })
        }
      }
    } else if (typeof txDigest === 'string' && txDigest.trim() !== '') {
      const single = txDigest.trim()
      if (isValidSuiDigest(single)) {
        digestsToVerify = recordSubmittedDigest(circleId, cycle, memberAddress, single, {
          network: resolvedNetwork,
          poolAddress,
          memberId,
        })
      } else {
        digestsToVerify = [single]
      }
    } else {
      digestsToVerify = getSubmittedDigests(circleId, cycle, memberAddress)
    }
  } catch (err) {
    return buildUnverifiedFromStorageOrConflictError(err, txDigest)
  }

  if (digestsToVerify.length === 0) {
    // No digest submitted yet. Check if Tatum is configured at all:
    if (!cfg.integrations.tatum.configured) {
      const unverified = classifyChainContribution({
        lookupStatus: 'unavailable',
        lookupError: `Tatum Sui verifier is not configured (${cfg.integrations.tatum.issues.join('; ')}).`,
        expected: { poolAddress, memberAddress, token: expectedToken, expectedAmount: Number(expectedAmount), windowStart, windowEnd },
      })
      const policy = evaluateContributionPolicy(unverified, {
        withMemory,
        windowEnd,
        graceWindowHours: tunables.graceWindowHours,
        memories,
        memberId,
        memberName,
        cycle,
      })
      const outcome = {
        ...unverified,
        memberId,
        expectedPoolAddress: poolAddress,
        network: resolvedNetwork,
        policy,
      }
      try {
        return recordServerVerifiedContribution(circleId, cycle, memberAddress, outcome, [])
      } catch (err) {
        return buildUnverifiedFromStorageOrConflictError(err)
      }
    }

    const pending = classifyChainContribution({
      lookupStatus: 'no_digest_submitted',
      expected: {
        poolAddress,
        memberAddress,
        token: expectedToken,
        expectedAmount: Number(expectedAmount),
        windowStart,
        windowEnd,
      },
      partialPaymentWindowHours: tunables.partialPaymentWindowHours,
    })
    const policy = evaluateContributionPolicy(pending, {
      withMemory,
      windowEnd,
      graceWindowHours: tunables.graceWindowHours,
      memories,
      memberId,
      memberName,
      cycle,
    })
    const outcome = {
      ...pending,
      memberId,
      expectedPoolAddress: poolAddress,
      network: resolvedNetwork,
      policy,
    }
    try {
      return recordServerVerifiedContribution(circleId, cycle, memberAddress, outcome, [])
    } catch (err) {
      return buildUnverifiedFromStorageOrConflictError(err)
    }
  }

  const allTransfers = []
  for (const d of digestsToVerify) {
    const lookup = await lookupSuiTransactionViaTatum(d, poolAddress, options)
    if (lookup.lookupStatus !== 'found') {
      const failedResult = classifyChainContribution({
        lookupStatus: lookup.lookupStatus,
        lookupError: lookup.lookupError,
        expected: {
          poolAddress,
          memberAddress,
          token: expectedToken,
          expectedAmount: Number(expectedAmount),
          windowStart,
          windowEnd,
        },
        partialPaymentWindowHours: tunables.partialPaymentWindowHours,
      })
      const policy = evaluateContributionPolicy(failedResult, {
        withMemory,
        windowEnd,
        graceWindowHours: tunables.graceWindowHours,
        memories,
        memberId,
        memberName,
        cycle,
      })
      const outcome = {
        ...failedResult,
        txDigest: d,
        memberId,
        expectedPoolAddress: poolAddress,
        network: resolvedNetwork,
        policy,
      }
      try {
        return recordServerVerifiedContribution(circleId, cycle, memberAddress, outcome, [])
      } catch (err) {
        return buildUnverifiedFromStorageOrConflictError(err, d)
      }
    }
    allTransfers.push(...lookup.transfers)
  }

  const classified = classifyChainContribution({
    lookupStatus: 'found',
    transfers: allTransfers,
    expected: {
      poolAddress,
      memberAddress,
      token: expectedToken,
      expectedAmount: Number(expectedAmount),
      windowStart,
      windowEnd,
      createdAt: params.createdAt,
    },
    partialPaymentWindowHours: tunables.partialPaymentWindowHours,
  })

  const policy = evaluateContributionPolicy(classified, {
    withMemory,
    windowEnd,
    graceWindowHours: tunables.graceWindowHours,
    memories,
    memberId,
    memberName,
    cycle,
  })

  const outcome = {
    ...classified,
    memberId,
    expectedPoolAddress: poolAddress,
    network: resolvedNetwork,
    policy,
  }
  try {
    return recordServerVerifiedContribution(circleId, cycle, memberAddress, outcome, allTransfers)
  } catch (err) {
    // CRITICAL: Never report a payment as Verified if persistence of its verification result fails
    return buildUnverifiedFromStorageOrConflictError(err, outcome.txDigest)
  }
}

/**
 * Check live Tatum Sui Gateway connectivity using GraphQL (`chainIdentifier`) or JSON-RPC (`sui_getChainIdentifier`).
 */
export async function checkTatumSuiStatus(options = {}) {
  const env = options.env || process.env
  const hasCustomRpc = typeof options.fetchRpc === 'function'
  const rpcCaller = options.fetchRpc || tatumRpc
  const gqlCaller = options.fetchGraphql || tatumGraphql
  const cfg = loadConfig(env)

  if (!cfg.integrations.tatum.configured || !cfg.integrations.tatum.config) {
    return {
      connected: false,
      configured: false,
      chain: 'sui',
      network: cfg.integrations.tatum.config?.SUI_NETWORK || 'unconfigured',
      error: cfg.integrations.tatum.issues.join('; '),
    }
  }

  const network = cfg.integrations.tatum.config.SUI_NETWORK
  try {
    if (!hasCustomRpc) {
      const res = await gqlCaller(
        'sui',
        '{ chainIdentifier checkpoint { sequenceNumber } }',
        {},
        network,
        env
      )

      if (!res.ok) {
        // Try JSON-RPC fallback if GraphQL returns an error
        try {
          const fbRes = await rpcCaller(
            'sui',
            { jsonrpc: '2.0', id: 1, method: 'sui_getChainIdentifier', params: [] },
            network,
            env
          )
          if (fbRes.ok) {
            const fbData = await fbRes.json()
            if (fbData?.result) {
              return {
                connected: true,
                configured: true,
                chain: 'sui',
                network: `sui-${network}`,
                chainId: fbData.result,
              }
            }
          }
        } catch {
          // fallback failed, return GraphQL error
        }

        return {
          connected: false,
          configured: true,
          chain: 'sui',
          network: `sui-${network}`,
          statusCode: res.status,
          error: `Tatum Sui GraphQL Gateway returned HTTP ${res.status}`,
        }
      }

      const data = await res.json()
      if (Array.isArray(data?.errors) && data.errors.length > 0) {
        return {
          connected: false,
          configured: true,
          chain: 'sui',
          network: `sui-${network}`,
          error: data.errors.map((e) => e.message).join('; '),
        }
      }

      return {
        connected: true,
        configured: true,
        chain: 'sui',
        network: `sui-${network}`,
        chainId: data?.data?.chainIdentifier || null,
        latestCheckpoint: data?.data?.checkpoint?.sequenceNumber ?? null,
      }
    }

    const res = await rpcCaller(
      'sui',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'sui_getChainIdentifier',
        params: [],
      },
      network,
      env
    )

    if (!res.ok) {
      return {
        connected: false,
        configured: true,
        chain: 'sui',
        network: `sui-${network}`,
        statusCode: res.status,
        error: `Tatum Sui Gateway returned HTTP ${res.status}`,
      }
    }

    const data = await res.json()
    if (data?.error) {
      return {
        connected: false,
        configured: true,
        chain: 'sui',
        network: `sui-${network}`,
        error: data.error.message || JSON.stringify(data.error),
      }
    }

    return {
      connected: true,
      configured: true,
      chain: 'sui',
      network: `sui-${network}`,
      chainId: data?.result || null,
    }
  } catch (err) {
    return {
      connected: false,
      configured: true,
      chain: 'sui',
      network: `sui-${network}`,
      error: err.message,
    }
  }
}
