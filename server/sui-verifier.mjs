import { loadConfig } from './config.mjs'
import { tatumRpc, tatumGraphql, MissingApiKeyError } from './tatum-client.mjs'
import {
  classifyChainContribution,
  evaluateContributionPolicy,
  normalizeSuiAddress,
} from './payment-policy.mjs'
import {
  getDatabase,
  withTransaction,
  StorageConflictError,
} from './db.mjs'

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
 * Durable SQLite store of member-submitted transaction digests and server-verified chain outcomes
 * per `(circleId, cycle, normalizedMemberAddress)`.
 * Enforces `PRIMARY KEY (tx_digest, network)` on `submitted_transactions` so the same transaction
 * digest cannot be claimed across conflicting members, circles, or cycles.
 */
export function recordSubmittedDigest(circleId, cycle, memberAddress, digest, options = {}) {
  const db = getDatabase()
  const normCircleId = String(circleId || 'default').trim()
  const normCycle = Number(cycle) || 1
  const normMember = normalizeSuiAddress(memberAddress)
  const trimmedDigest = String(digest || '').trim()
  const network = String(options.network || process.env.SUI_NETWORK || 'testnet').trim()
  const poolAddress = String(options.poolAddress || '').trim()
  const memberId = options.memberId ? String(options.memberId).trim() : null

  return withTransaction(db, () => {
    const existing = db
      .prepare('SELECT * FROM submitted_transactions WHERE tx_digest = ? AND network = ?')
      .get(trimmedDigest, network)

    if (
      existing &&
      (existing.circle_id !== normCircleId ||
        Number(existing.cycle) !== normCycle ||
        existing.normalized_member_address !== normMember)
    ) {
      throw new StorageConflictError(
        `Conflicting transaction submission: digest "${trimmedDigest}" on Sui ${network} is already claimed for circle "${existing.circle_id}", cycle ${existing.cycle}, member ${existing.normalized_member_address}.`,
        409
      )
    }

    if (!existing) {
      db.prepare(`
        INSERT INTO submitted_transactions (
          tx_digest, network, circle_id, cycle, member_id,
          normalized_member_address, expected_pool_address,
          execution_status, verified_at_iso
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified_claim', ?)
      `).run(
        trimmedDigest,
        network,
        normCircleId,
        normCycle,
        memberId,
        normMember,
        poolAddress,
        new Date().toISOString()
      )
    }

    const rows = db
      .prepare(
        `SELECT tx_digest FROM submitted_transactions
         WHERE circle_id = ? AND cycle = ? AND normalized_member_address = ?
         ORDER BY rowid ASC`
      )
      .all(normCircleId, normCycle, normMember)
    return rows.map((r) => r.tx_digest)
  })
}

export function getSubmittedDigests(circleId, cycle, memberAddress) {
  const db = getDatabase()
  const normCircleId = String(circleId || 'default').trim()
  const normCycle = Number(cycle) || 1
  const normMember = normalizeSuiAddress(memberAddress)
  const rows = db
    .prepare(
      `SELECT tx_digest FROM submitted_transactions
       WHERE circle_id = ? AND cycle = ? AND normalized_member_address = ?
       ORDER BY rowid ASC`
    )
    .all(normCircleId, normCycle, normMember)
  return rows.map((r) => r.tx_digest)
}

export function getPersistedSubmittedTransaction(txDigest, network = process.env.SUI_NETWORK || 'testnet') {
  const db = getDatabase()
  const row = db
    .prepare('SELECT * FROM submitted_transactions WHERE tx_digest = ? AND network = ?')
    .get(String(txDigest || '').trim(), String(network || 'testnet').trim())
  if (!row) return null
  return {
    txDigest: row.tx_digest,
    network: row.network,
    circleId: row.circle_id,
    cycle: Number(row.cycle),
    memberId: row.member_id || undefined,
    normalizedMemberAddress: row.normalized_member_address,
    expectedPoolAddress: row.expected_pool_address,
    observedSender: row.observed_sender || null,
    observedRecipient: row.observed_recipient || null,
    tokenType: row.token_type || null,
    amount: row.amount !== null && row.amount !== undefined ? Number(row.amount) : null,
    executionStatus: row.execution_status,
    txTimestampMs:
      row.tx_timestamp_ms !== null && row.tx_timestamp_ms !== undefined
        ? Number(row.tx_timestamp_ms)
        : null,
    txTimestampIso: row.tx_timestamp_iso || null,
    verifiedAtIso: row.verified_at_iso,
  }
}

export function recordServerVerifiedContribution(
  circleId,
  cycle,
  memberAddress,
  result,
  observedTransfers = []
) {
  const db = getDatabase()
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

  withTransaction(db, () => {
    // Update authoritative chain evidence for each verified transaction digest
    for (const t of observedTransfers) {
      if (!t.txDigest) continue
      const existing = db
        .prepare('SELECT * FROM submitted_transactions WHERE tx_digest = ? AND network = ?')
        .get(t.txDigest, network)

      if (
        existing &&
        (existing.circle_id !== normCircleId ||
          Number(existing.cycle) !== normCycle ||
          existing.normalized_member_address !== normMember)
      ) {
        throw new StorageConflictError(
          `Conflicting transaction submission: digest "${t.txDigest}" on Sui ${network} is already claimed for circle "${existing.circle_id}", cycle ${existing.cycle}, member ${existing.normalized_member_address}.`,
          409
        )
      }

      const txIso = Number.isFinite(t.timestampMs) ? new Date(t.timestampMs).toISOString() : null
      const txStatus = t.executionSuccess === false ? 'failure' : 'success'

      db.prepare(`
        INSERT INTO submitted_transactions (
          tx_digest, network, circle_id, cycle, member_id,
          normalized_member_address, expected_pool_address,
          observed_sender, observed_recipient, token_type, amount,
          execution_status, tx_timestamp_ms, tx_timestamp_iso, verified_at_iso
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tx_digest, network) DO UPDATE SET
          observed_sender = excluded.observed_sender,
          observed_recipient = excluded.observed_recipient,
          token_type = excluded.token_type,
          amount = excluded.amount,
          execution_status = excluded.execution_status,
          tx_timestamp_ms = excluded.tx_timestamp_ms,
          tx_timestamp_iso = excluded.tx_timestamp_iso,
          verified_at_iso = excluded.verified_at_iso
      `).run(
        t.txDigest,
        network,
        normCircleId,
        normCycle,
        result.memberId ?? null,
        normMember,
        result.expectedPoolAddress || '',
        t.sender || null,
        t.recipient || null,
        t.tokenType || null,
        typeof t.amount === 'number' ? t.amount : 0,
        txStatus,
        Number.isFinite(t.timestampMs) ? t.timestampMs : null,
        txIso,
        verifiedAtIso
      )
    }

    db.prepare(`
      INSERT INTO member_cycle_verifications (
        circle_id, cycle, normalized_member_address, member_id, network,
        status, code, tx_digest, tx_digests_json,
        observed_sender, observed_recipient, token_received, amount_received,
        execution_status, tx_timestamp_iso, hours_late, error, raw_notes,
        policy_json, verified_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(circle_id, cycle, normalized_member_address) DO UPDATE SET
        member_id = excluded.member_id,
        network = excluded.network,
        status = excluded.status,
        code = excluded.code,
        tx_digest = excluded.tx_digest,
        tx_digests_json = excluded.tx_digests_json,
        observed_sender = excluded.observed_sender,
        observed_recipient = excluded.observed_recipient,
        token_received = excluded.token_received,
        amount_received = excluded.amount_received,
        execution_status = excluded.execution_status,
        tx_timestamp_iso = excluded.tx_timestamp_iso,
        hours_late = excluded.hours_late,
        error = excluded.error,
        raw_notes = excluded.raw_notes,
        policy_json = excluded.policy_json,
        verified_at_iso = excluded.verified_at_iso
    `).run(
      normCircleId,
      normCycle,
      normMember,
      result.memberId ?? null,
      network,
      result.status,
      result.code || result.status.toLowerCase(),
      result.txDigest ?? null,
      JSON.stringify(digestsList),
      observedSender,
      observedRecipient,
      result.tokenReceived ?? null,
      Number(result.amountReceived) || 0,
      executionStatus,
      result.timestamp ?? null,
      result.hoursLate !== undefined ? Number(result.hoursLate) : null,
      result.error ?? null,
      result.rawNotes ?? null,
      result.policy ? JSON.stringify(result.policy) : null,
      verifiedAtIso
    )
  })

  return {
    ...result,
    observedSender,
    observedRecipient,
    executionStatus,
    verifiedAtServerIso: verifiedAtIso,
  }
}

export function getServerVerifiedContribution(circleId, cycle, memberAddress) {
  const db = getDatabase()
  const normCircleId = String(circleId || 'default').trim()
  const normCycle = Number(cycle) || 1
  const normMember = normalizeSuiAddress(memberAddress)
  const row = db
    .prepare(
      `SELECT * FROM member_cycle_verifications
       WHERE circle_id = ? AND cycle = ? AND normalized_member_address = ?`
    )
    .get(normCircleId, normCycle, normMember)
  if (!row) return null

  let txDigests = []
  try {
    txDigests = JSON.parse(row.tx_digests_json || '[]')
  } catch {
    txDigests = row.tx_digest ? [row.tx_digest] : []
  }

  let policy = undefined
  if (row.policy_json) {
    try {
      policy = JSON.parse(row.policy_json)
    } catch {
      policy = undefined
    }
  }

  return {
    status: row.status,
    code: row.code,
    network: row.network,
    txDigest: row.tx_digest || undefined,
    txDigests,
    observedSender: row.observed_sender || undefined,
    observedRecipient: row.observed_recipient || undefined,
    tokenReceived: row.token_received || undefined,
    amountReceived: Number(row.amount_received) || 0,
    executionStatus: row.execution_status,
    timestamp: row.tx_timestamp_iso || undefined,
    hoursLate: row.hours_late !== null && row.hours_late !== undefined ? Number(row.hours_late) : undefined,
    error: row.error || undefined,
    rawNotes: row.raw_notes || undefined,
    policy,
    verifiedAtServerIso: row.verified_at_iso,
  }
}

export function clearSubmittedDigests(circleId, cycle, memberAddress) {
  const db = getDatabase()
  const normCircleId = String(circleId || 'default').trim()
  const normCycle = Number(cycle) || 1
  const normMember = normalizeSuiAddress(memberAddress)
  withTransaction(db, () => {
    db.prepare(
      'DELETE FROM submitted_transactions WHERE circle_id = ? AND cycle = ? AND normalized_member_address = ?'
    ).run(normCircleId, normCycle, normMember)
    db.prepare(
      'DELETE FROM member_cycle_verifications WHERE circle_id = ? AND cycle = ? AND normalized_member_address = ?'
    ).run(normCircleId, normCycle, normMember)
  })
}

/**
 * Parse a `sui_getTransactionBlock` result payload into verified transfer observations.
 * Verifies that `transaction.data.sender`, `effects.status.status`, `balanceChanges`,
 * and `timestampMs` are present before extracting transfers.
 *
 * @param {string} txDigest
 * @param {any} rpcResult
 * @param {string} expectedPoolAddress
 * @param {number} tokenDecimals
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

  const divisor = Math.pow(10, Number.isInteger(tokenDecimals) ? tokenDecimals : 6)
  const positiveChanges = []

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
 * @param {number} tokenDecimals
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

  const divisor = Math.pow(10, Number.isInteger(tokenDecimals) ? tokenDecimals : 6)
  const positiveChanges = []

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
      }
    }
  }
`

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
  const decimals = tatumCfg.SUI_TOKEN_DECIMALS

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

      return parseSuiGraphqlTransaction(txDigest.trim(), gqlPayload?.data?.transaction, expectedPoolAddress, decimals)
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

    return parseSuiTransactionBlock(txDigest.trim(), rpcPayload?.result, expectedPoolAddress, decimals)
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
      conflict: err instanceof StorageConflictError ? true : undefined,
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
