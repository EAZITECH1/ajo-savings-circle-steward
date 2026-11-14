/**
 * Pure payment verification & group policy classification logic.
 *
 * Key invariant:
 * Chain facts (`Verified`, `Late`, `Partial`, `WrongToken`, `WrongAmount`, `Pending`, `Unverified`)
 * are strictly separated from group policy outcomes (`Accepted (On Time)`,
 * `Accepted under the recorded grace agreement`, `Late (Unexcused)`, etc.).
 * A payment that arrived after `windowEnd` ALWAYS remains `Late` as a chain fact.
 */

/**
 * Quarantined synthetic Walrus Mainnet records written by an earlier seed script
 * (`namespace: ajo-circle:lagos-techies-seed-circle`).
 * These contain fictional sample-circle history and synthetic confirmation claims,
 * and MUST NEVER be presented as real group history, consensus, or member preferences,
 * nor influence policy outcomes, payout recommendations, or Steward LLM answers.
 */
export const QUARANTINED_SYNTHETIC_CIRCLES = new Set([
  'lagos-techies-seed-circle',
  'ajo-circle:lagos-techies-seed-circle',
])

export const QUARANTINED_SYNTHETIC_BLOB_IDS = new Set([
  '_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc',
  'rPLnm650Px2cF9_l1UcK7zZZ7EjMLQlrTGEAZVILv0U',
  'kmgKVSUM4PiTy1bJYHSAr3iVrspUvbvYVd_jhu3UWAU',
  'FYt7CvCY5YeKpVO7e1LDGwWNI-Bnb01PbJo2qm1_tKU',
  'cq4PFpzCxmWyXhQN7JkRRG6inU0KxvuzOBTaGDwySS8',
  'QAoLGVx0ytBi5SczS6k8xBxO2_WkWk4WnpPmwpDa8bM',
  '6BZtcqAEiGgHPtW1rqAgu11kuItlYI2_ohgCaC4MDcw',
  'DJGI6m-_PMB_tR2zNfywaurBkPEum8Phkde6fNFJE4Y',
  'ZqKcldiC6o3gxTR7GhuXeQ4UP1v9Vs85AskJbKpZiBM',
  'AlrI6_KXE6dyYRvQ0oqLuYvJFk70xnzN5L_MeRX598A',
])

/**
 * Return true if a memory record or circleId belongs to the quarantined synthetic dataset.
 * @param {any} item
 */
export function isQuarantinedSyntheticRecord(item) {
  if (!item) return false
  if (typeof item === 'string') {
    const trimmed = item.trim()
    return (
      QUARANTINED_SYNTHETIC_BLOB_IDS.has(trimmed) ||
      QUARANTINED_SYNTHETIC_CIRCLES.has(trimmed.toLowerCase())
    )
  }
  const blobId = item.walrusBlobId || item.blob_id
  if (blobId && QUARANTINED_SYNTHETIC_BLOB_IDS.has(String(blobId).trim())) {
    return true
  }
  const circleId = String(item.circleId || item.namespace || '').trim().toLowerCase()
  if (
    circleId &&
    (QUARANTINED_SYNTHETIC_CIRCLES.has(circleId) ||
      circleId.endsWith(':lagos-techies-seed-circle'))
  ) {
    return true
  }
  return false
}

/**
 * Normalize a Sui address or Move coin type for case-insensitive hex comparison.
 * Pad 0x-prefixed hex addresses to 64 hex chars when comparing addresses.
 * @param {string} address
 */
export function normalizeSuiAddress(address) {
  if (typeof address !== 'string') return ''
  const trimmed = address.trim().toLowerCase()
  if (!trimmed.startsWith('0x')) return trimmed
  const hex = trimmed.slice(2)
  if (!/^[0-9a-f]+$/.test(hex)) return trimmed
  return `0x${hex.padStart(64, '0')}`
}

/**
 * Normalize a Move coin type `0x...::module::Name` by normalizing its package address prefix.
 * @param {string} coinType
 */
export function normalizeCoinType(coinType) {
  if (typeof coinType !== 'string') return ''
  const parts = coinType.trim().split('::')
  if (parts.length !== 3) return coinType.trim()
  return `${normalizeSuiAddress(parts[0])}::${parts[1]}::${parts[2]}`
}

/**
 * Classify the on-chain payment status from verified transaction observations.
 *
 * @param {object} input
 * @param {'found' | 'no_digest_submitted' | 'unavailable' | 'malformed_digest' | 'not_found' | 'incomplete_fields'} input.lookupStatus
 * @param {string} [input.lookupError]
 * @param {Array<{
 *   txDigest: string,
 *   sender: string,
 *   recipient: string,
 *   tokenType: string,
 *   amount: number,
 *   timestampMs: number,
 *   executionSuccess?: boolean
 * }>} [input.transfers]
 * @param {object} input.expected
 * @param {string} input.expected.poolAddress
 * @param {string} input.expected.memberAddress
 * @param {string} input.expected.token
 * @param {number} input.expected.expectedAmount
 * @param {string | number} input.expected.windowStart
 * @param {string | number} input.expected.windowEnd
 * @param {number} [input.partialPaymentWindowHours=48]
 */
export function formatElapsedDuration(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return '0 hours late'
  const totalHours = Math.floor(elapsedMs / (3600 * 1000))
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days > 0) {
    return `${days} day${days === 1 ? '' : 's'}, ${hours} hour${hours === 1 ? '' : 's'} late`
  }
  return `${hours} hour${hours === 1 ? '' : 's'} late`
}

export function classifyChainContribution(input) {
  const {
    lookupStatus,
    lookupError,
    transfers = [],
    expected,
    partialPaymentWindowHours = 48,
  } = input

  if (lookupStatus === 'unavailable') {
    return {
      status: 'Unverified',
      code: 'unverified',
      amountReceived: 0,
      error: lookupError || 'Tatum Sui RPC is unavailable.',
      rawNotes: lookupError || 'Chain data is unavailable; cannot verify contribution.',
    }
  }

  if (lookupStatus === 'malformed_digest') {
    return {
      status: 'Unverified',
      code: 'unverified',
      amountReceived: 0,
      error: lookupError || 'Malformed Sui transaction digest.',
      rawNotes: lookupError || 'Submitted transaction digest format is invalid.',
    }
  }

  if (lookupStatus === 'not_found') {
    return {
      status: 'Unverified',
      code: 'unverified',
      amountReceived: 0,
      error: lookupError || 'Transaction digest was not found on Sui.',
      rawNotes: lookupError || 'Submitted transaction digest could not be found on the configured Sui network.',
    }
  }

  if (lookupStatus === 'incomplete_fields') {
    return {
      status: 'Unverified',
      code: 'unverified',
      amountReceived: 0,
      error: lookupError || 'Transaction response is missing required verification fields.',
      rawNotes: lookupError || 'RPC response lacked sender, balanceChanges, timestampMs, or effects status.',
    }
  }

  if (lookupStatus === 'no_digest_submitted') {
    return {
      status: 'Pending',
      code: 'pending',
      amountReceived: 0,
      rawNotes: 'No transaction digest submitted or matched for this member and cycle yet.',
    }
  }

  const windowStartMs =
    typeof expected.windowStart === 'number'
      ? expected.windowStart
      : Date.parse(expected.windowStart)
  const windowEndMs =
    typeof expected.windowEnd === 'number'
      ? expected.windowEnd
      : Date.parse(expected.windowEnd)

  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs < windowStartMs) {
    return {
      status: 'Unverified',
      code: 'unverified',
      amountReceived: 0,
      error: 'Invalid cycle windowStart or windowEnd timestamp.',
      rawNotes: 'Cycle time window is invalid or unconfigured.',
    }
  }

  if (!Array.isArray(transfers) || transfers.length === 0) {
    return {
      status: 'Pending',
      code: 'pending',
      amountReceived: 0,
      rawNotes: 'Lookup succeeded, but no matching transfer to the pool address was found.',
    }
  }

  const normPool = normalizeSuiAddress(expected.poolAddress)
  const normMember = normalizeSuiAddress(expected.memberAddress)
  const normExpectedToken = normalizeCoinType(expected.token)

  // Filter for failed execution first
  const executedTransfers = transfers.filter((t) => t.executionSuccess !== false)
  if (executedTransfers.length === 0) {
    return {
      status: 'Unverified',
      code: 'unverified',
      txDigest: transfers[0]?.txDigest,
      amountReceived: 0,
      error: 'Transaction execution failed on-chain.',
      rawNotes: 'The submitted transaction did not execute successfully on Sui.',
    }
  }

  // Filter for sender === memberAddress and recipient === poolAddress
  const memberToPool = executedTransfers.filter(
    (t) =>
      normalizeSuiAddress(t.sender) === normMember &&
      normalizeSuiAddress(t.recipient) === normPool &&
      typeof t.amount === 'number' &&
      t.amount > 0
  )

  if (memberToPool.length === 0) {
    const first = executedTransfers[0]
    const senderMismatch = normalizeSuiAddress(first.sender) !== normMember
    const recipientMismatch = normalizeSuiAddress(first.recipient) !== normPool
    const reasons = []
    if (senderMismatch) reasons.push(`sender (${first.sender}) does not match member (${expected.memberAddress})`)
    if (recipientMismatch) reasons.push(`recipient (${first.recipient}) does not match pool (${expected.poolAddress})`)
    return {
      status: 'Unverified',
      code: 'unverified',
      txDigest: first.txDigest,
      amountReceived: 0,
      error: `Transaction does not transfer funds from member to pool: ${reasons.join('; ') || 'no positive transfer found'}.`,
      rawNotes: `Transaction ${first.txDigest} did not credit pool ${expected.poolAddress} from member ${expected.memberAddress}.`,
    }
  }

  // Check token type
  const matchingTokenTransfers = memberToPool.filter(
    (t) => normalizeCoinType(t.tokenType) === normExpectedToken
  )

  if (matchingTokenTransfers.length === 0) {
    const wrongTransfer = memberToPool[0]
    return {
      status: 'WrongToken',
      code: 'wrong_token',
      txDigest: wrongTransfer.txDigest,
      txDigests: memberToPool.map((t) => t.txDigest),
      amountReceived: wrongTransfer.amount,
      tokenReceived: wrongTransfer.tokenType,
      timestamp: new Date(wrongTransfer.timestampMs).toISOString(),
      rawNotes: `Received token ${wrongTransfer.tokenType}, but circle requires ${expected.token}.`,
    }
  }

  // Sort chronologically by timestampMs
  const sorted = [...matchingTokenTransfers].sort((a, b) => a.timestampMs - b.timestampMs)

  // Window start validation:
  // Allow a 60-second grace buffer for clock skew around windowStart (or circle createdAt if provided).
  // Strictly disallow transactions that predated this circle/cycle window, as they belong to
  // earlier circles or prior cycles that shared the same vault address.
  const createdAtMs = expected.createdAt
    ? (typeof expected.createdAt === 'number' ? expected.createdAt : Date.parse(expected.createdAt))
    : NaN
  const effectiveStartMs = Number.isFinite(createdAtMs) && Number.isFinite(windowStartMs)
    ? Math.max(createdAtMs, windowStartMs)
    : Number.isFinite(createdAtMs)
    ? createdAtMs
    : windowStartMs
  const clockSkewBufferMs = 60 * 1000
  const minValidTimestampMs = effectiveStartMs - clockSkewBufferMs

  // Check if any transfer occurred before minValidTimestampMs
  const beforeWindow = sorted.find((t) => t.timestampMs < minValidTimestampMs)
  if (beforeWindow) {
    return {
      status: 'Unverified',
      code: 'unverified',
      txDigest: beforeWindow.txDigest,
      txDigests: sorted.map((t) => t.txDigest),
      amountReceived: beforeWindow.amount,
      tokenReceived: beforeWindow.tokenType,
      timestamp: new Date(beforeWindow.timestampMs).toISOString(),
      error: 'Transaction timestamp predates the cycle window start.',
      rawNotes: `Transaction ${beforeWindow.txDigest} occurred at ${new Date(beforeWindow.timestampMs).toISOString()}, before cycle window start ${new Date(windowStartMs).toISOString()}. It may belong to a prior circle or cycle.`,
    }
  }

  const totalAmount = sorted.reduce((acc, t) => acc + t.amount, 0)
  const firstTx = sorted[0]
  const lastTx = sorted[sorted.length - 1]
  const digests = Array.from(new Set(sorted.map((t) => t.txDigest)))
  const primaryDigest = digests.join(', ')
  const latestIso = new Date(lastTx.timestampMs).toISOString()

  // Check split-payment window when multiple partial payments are aggregated
  const maxSplitSpanMs = partialPaymentWindowHours * 3600 * 1000
  const splitSpanMs = lastTx.timestampMs - firstTx.timestampMs

  // Epsilon for floating point comparison
  const eps = 1e-6

  const onTimeTransfers = sorted.filter((t) => t.timestampMs <= windowEndMs)
  const lateTransfers = sorted.filter((t) => t.timestampMs > windowEndMs)
  const amountPaidByDeadline = onTimeTransfers.reduce((acc, t) => acc + t.amount, 0)
  const amountPaidAfterDeadline = lateTransfers.reduce((acc, t) => acc + t.amount, 0)
  const amountRemainingOutstanding = Math.max(0, expected.expectedAmount - totalAmount)
  const deadlineIso = new Date(windowEndMs).toISOString()

  if (totalAmount + eps < expected.expectedAmount) {
    const isPastDeadline = Boolean(input.isPastDeadline || (lastTx && lastTx.timestampMs > windowEndMs))
    return {
      status: isPastDeadline ? 'MissedDeadline' : 'Partial',
      code: isPastDeadline ? 'missed_deadline' : 'partial',
      txDigest: primaryDigest,
      txDigests: digests,
      amountReceived: totalAmount,
      amountPaidByDeadline,
      amountPaidAfterDeadline,
      amountRemainingOutstanding,
      deadlineTimestamp: deadlineIso,
      missedDeadline: isPastDeadline,
      tokenReceived: lastTx.tokenType,
      timestamp: latestIso,
      rawNotes: isPastDeadline
        ? `Missed deadline: paid ${totalAmount} of expected ${expected.expectedAmount} (${amountPaidByDeadline} by deadline); ${amountRemainingOutstanding} remains outstanding.`
        : `Received ${totalAmount} of expected ${expected.expectedAmount} (${sorted.length} payment${sorted.length > 1 ? 's' : ''}).`,
    }
  }

  if (totalAmount - eps > expected.expectedAmount) {
    return {
      status: 'WrongAmount',
      code: 'wrong_amount',
      txDigest: primaryDigest,
      txDigests: digests,
      amountReceived: totalAmount,
      expectedAmount: expected.expectedAmount,
      isOverpayment: true,
      amountPaidByDeadline,
      amountPaidAfterDeadline,
      amountRemainingOutstanding: 0,
      deadlineTimestamp: deadlineIso,
      tokenReceived: lastTx.tokenType,
      timestamp: latestIso,
      rawNotes: `Overpayment on-chain: received ${totalAmount}, which exceeds expected ${expected.expectedAmount}.`,
    }
  }

  // Check deadline (windowEndMs)
  if (lastTx.timestampMs > windowEndMs) {
    const elapsedMs = lastTx.timestampMs - windowEndMs
    const hoursLate = Number((elapsedMs / 3600000).toFixed(1))
    const elapsedDisplay = formatElapsedDuration(elapsedMs)

    return {
      status: 'Late',
      code: 'late',
      txDigest: primaryDigest,
      txDigests: digests,
      amountReceived: totalAmount,
      amountPaidByDeadline,
      amountPaidAfterDeadline,
      amountRemainingOutstanding: 0,
      deadlineTimestamp: deadlineIso,
      latePaymentDigest: lastTx.txDigest,
      latePaymentTimestamp: latestIso,
      elapsedMs,
      elapsedDisplay,
      isLateCompletion: true,
      tokenReceived: lastTx.tokenType,
      timestamp: latestIso,
      hoursLate,
      rawNotes:
        sorted.length > 1
          ? `Split payments (${sorted.length} tranches) completed ${elapsedDisplay} (${amountPaidByDeadline} paid by deadline).`
          : `Payment arrived ${elapsedDisplay}.`,
    }
  }

  // Exact amount reached across 2+ partial payments within window: check partialPaymentWindowHours
  if (sorted.length > 1 && splitSpanMs > maxSplitSpanMs) {
    return {
      status: 'Partial',
      code: 'partial',
      txDigest: primaryDigest,
      txDigests: digests,
      amountReceived: totalAmount,
      amountPaidByDeadline,
      amountPaidAfterDeadline,
      amountRemainingOutstanding,
      deadlineTimestamp: deadlineIso,
      tokenReceived: lastTx.tokenType,
      timestamp: latestIso,
      rawNotes: `Split payments totaled ${totalAmount}, but elapsed time between tranches (${(splitSpanMs / 3600000).toFixed(1)}h) exceeded the ${partialPaymentWindowHours}h partial-payment window.`,
    }
  }

  return {
    status: 'Verified',
    code: 'verified',
    txDigest: primaryDigest,
    txDigests: digests,
    amountReceived: totalAmount,
    amountPaidByDeadline: totalAmount,
    amountPaidAfterDeadline: 0,
    amountRemainingOutstanding: 0,
    deadlineTimestamp: deadlineIso,
    tokenReceived: lastTx.tokenType,
    timestamp: latestIso,
    rawNotes:
      sorted.length > 1
        ? `Contribution verified across ${sorted.length} split payments within the ${partialPaymentWindowHours}h window and before cycle deadline.`
        : 'Contribution verified on Sui within cycle window.',
  }
}

/**
 * Parse explicit cycle scope and grace window duration from a recorded grace agreement memory.
 * Falls back to `defaultGraceWindowHours` when the memory does not specify a custom duration.
 *
 * @param {{ id?: string, walrusBlobId?: string, title?: string, quote?: string, context?: string, cycle?: number }} memory
 * @param {number} [defaultGraceWindowHours=72]
 */
export function parseGraceAgreementMeta(memory, defaultGraceWindowHours = 72) {
  if (!memory) {
    const fallbackMs = defaultGraceWindowHours * 3600 * 1000
    return {
      durationMs: fallbackMs,
      durationLabel: `${defaultGraceWindowHours}h`,
      explicitCycle: null,
      isCustomDuration: false,
    }
  }

  const combinedText = `${memory.title || ''} ${memory.quote || ''} ${memory.context || ''}`
  const cycleMatch = combinedText.match(/\bcycle\s+(\d+)\b/i)
  const explicitCycle = cycleMatch ? Number(cycleMatch[1]) : null

  const durMatch = combinedText.match(
    /\b(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(minutes?|miniutes?|mins?|hours?|hrs?|days?)\b/i
  )

  if (durMatch) {
    const val = Number(durMatch[1])
    const unitRaw = durMatch[2].toLowerCase()
    if (Number.isFinite(val) && val > 0) {
      if (unitRaw.startsWith('m')) {
        return {
          durationMs: val * 60 * 1000,
          durationLabel: `${val}m`,
          explicitCycle,
          isCustomDuration: true,
        }
      }
      if (unitRaw.startsWith('h')) {
        return {
          durationMs: val * 3600 * 1000,
          durationLabel: `${val}h`,
          explicitCycle,
          isCustomDuration: true,
        }
      }
      if (unitRaw.startsWith('d')) {
        const hours = val * 24
        return {
          durationMs: hours * 3600 * 1000,
          durationLabel: `${hours}h`,
          explicitCycle,
          isCustomDuration: true,
        }
      }
    }
  }

  return {
    durationMs: defaultGraceWindowHours * 3600 * 1000,
    durationLabel: `${defaultGraceWindowHours}h`,
    explicitCycle,
    isCustomDuration: false,
  }
}

/**
 * Evaluate group policy separately from the chain fact.
 * NEVER relabels `chainResult.status` — returns both `chainStatus` and `policyStatus`.
 *
 * @param {ReturnType<typeof classifyChainContribution>} chainResult
 * @param {object} options
 * @param {boolean} options.withMemory
 * @param {string | number} options.windowEnd
 * @param {number} [options.graceWindowHours=72]
 * @param {Array<{ id: string, walrusBlobId?: string, title: string, quote: string, context?: string, memberId?: string, category?: string, memoryType?: string, label?: string, cycle?: number }>} [options.memories=[]]
 * @param {string} [options.memberId]
 * @param {string} [options.memberName]
 * @param {number} [options.cycle]
 */
export function evaluateContributionPolicy(chainResult, options) {
  const {
    withMemory,
    windowEnd,
    graceWindowHours = 72,
    memories = [],
    memberId,
    memberName,
    cycle,
  } = options

  const chainStatus = chainResult.status
  const windowEndMs = typeof windowEnd === 'number' ? windowEnd : Date.parse(windowEnd)
  const currentCycleNum = Number(cycle) > 0 ? Number(cycle) : null

  // Helper to match memories relevant to this member (excluding any quarantined synthetic blobs)
  const memberMemories = withMemory
    ? memories.filter((m) => {
        if (isQuarantinedSyntheticRecord(m)) return false
        if (memberId && m.memberId === memberId) return true
        if (memberName) {
          const firstName = memberName.split(' ')[0].toLowerCase()
          if (
            firstName &&
            (m.title?.toLowerCase().includes(firstName) ||
              m.quote?.toLowerCase().includes(firstName))
          ) {
            return true
          }
        }
        return false
      })
    : []

  const isHistoricalBehaviorMemory = (m) =>
    m.label !== 'split contribution pattern' &&
    m.label !== 'split tranche completion' &&
    (m.memoryType === 'historical_behavior' ||
      m.label === 'historical contribution behavior' ||
      Boolean(m.title?.toLowerCase().includes('historical contribution behavior')) ||
      Boolean(m.title?.toLowerCase().includes('grace resolution')))

  const priorCycleLatenessMemory =
    memberMemories.find((m) => {
      if (!isHistoricalBehaviorMemory(m)) return false
      if (currentCycleNum && m.cycle && Number(m.cycle) < currentCycleNum) return true
      if (!currentCycleNum) return true
      return false
    }) || null

  const anyHistoricalLatenessMemory =
    priorCycleLatenessMemory ||
    memberMemories.find((m) => isHistoricalBehaviorMemory(m)) ||
    null

  const splitMemory = memberMemories.find(
    (m) =>
      m.category === 'Member patterns' &&
      (m.label === 'split tranche completion' ||
        m.title?.toLowerCase().includes('split') ||
        m.quote?.toLowerCase().includes('split') ||
        m.quote?.toLowerCase().includes('tranche') ||
        m.quote?.toLowerCase().includes('partial'))
  )

  const reminderPreferenceMemory = memberMemories.find(
    (m) => m.category === 'Reminder preferences' && m.label !== 'reminder conversion outcome'
  )
  const priorReminderOutcomeMemory = memberMemories.find(
    (m) => m.category === 'Reminder preferences' && m.label === 'reminder conversion outcome'
  )

  if (chainStatus === 'Verified') {
    const txDigests = Array.isArray(chainResult.txDigests)
      ? chainResult.txDigests
      : chainResult.txDigest
      ? [chainResult.txDigest]
      : []
    const isSplitCompletion = txDigests.length > 1
    const splitCompletion = isSplitCompletion
      ? {
          trancheCount: txDigests.length,
          txDigests,
          matchedPatternBlobId: splitMemory?.walrusBlobId || null,
          matchedPatternTitle: splitMemory?.title || null,
        }
      : null
    const reminderPreference = reminderPreferenceMemory
      ? {
          id: reminderPreferenceMemory.id,
          walrusBlobId: reminderPreferenceMemory.walrusBlobId || null,
          title: reminderPreferenceMemory.title,
        }
      : null

    if (withMemory && priorCycleLatenessMemory) {
      return {
        chainStatus,
        policyStatus: 'Accepted on time (Recovered after prior late cycle)',
        policyVerdict: 'good_standing',
        countsTowardPot: true,
        policyReason: `On-time verified chain contribution meets circle rules. Trajectory: recovered to on-time settlement after prior late completion recorded in "${priorCycleLatenessMemory.title}" (Blob ${priorCycleLatenessMemory.walrusBlobId || priorCycleLatenessMemory.id}).`,
        citedMemory: priorCycleLatenessMemory,
        timelinessTrajectory: 'recovered_on_time',
        splitCompletion,
        reminderPreference,
      }
    }

    if (withMemory && isSplitCompletion) {
      return {
        chainStatus,
        policyStatus: splitMemory
          ? 'Accepted on time (Split tranches completed under recorded pattern)'
          : 'Accepted on time (Split tranches completed)',
        policyVerdict: 'good_standing',
        countsTowardPot: true,
        policyReason: splitMemory
          ? `Contribution verified across ${txDigests.length} tranches on Sui, matching recorded split pattern "${splitMemory.title}" (Blob ${splitMemory.walrusBlobId || splitMemory.id}).`
          : `Contribution verified across ${txDigests.length} split tranches on Sui before cycle deadline.`,
        citedMemory: splitMemory || null,
        timelinessTrajectory: 'on_time',
        splitCompletion,
        reminderPreference,
      }
    }

    if (withMemory && reminderPreferenceMemory) {
      return {
        chainStatus,
        policyStatus: 'Accepted on time',
        policyVerdict: 'good_standing',
        countsTowardPot: true,
        policyReason: `On-time verified chain contribution meets circle rules. Opted-in reminder preference "${reminderPreferenceMemory.title}" was active for this member.`,
        citedMemory: priorReminderOutcomeMemory || reminderPreferenceMemory,
        timelinessTrajectory: 'on_time',
        splitCompletion,
        reminderPreference,
      }
    }

    return {
      chainStatus,
      policyStatus: 'Accepted on time',
      policyVerdict: 'good_standing',
      countsTowardPot: true,
      policyReason: 'On-time verified chain contribution meets circle rules.',
      citedMemory: null,
      timelinessTrajectory: 'on_time',
      splitCompletion,
      reminderPreference,
    }
  }

  if (chainStatus === 'Late') {
    const graceMemory = memberMemories.find((m) => {
      if (m.category !== 'Agreements') return false
      const text = `${m.title || ''} ${m.quote || ''}`.toLowerCase()
      if (!text.includes('grace') && !text.includes('late')) return false
      const parsed = parseGraceAgreementMeta(m, graceWindowHours)
      if (currentCycleNum && parsed.explicitCycle && parsed.explicitCycle !== currentCycleNum) {
        return false
      }
      return true
    })

    const graceMeta = parseGraceAgreementMeta(graceMemory, graceWindowHours)
    const paymentTimeMs = chainResult.timestamp ? Date.parse(chainResult.timestamp) : NaN
    const maxGraceDeadlineMs = windowEndMs + graceMeta.durationMs
    const withinGraceWindow =
      Number.isFinite(paymentTimeMs) &&
      Number.isFinite(maxGraceDeadlineMs) &&
      paymentTimeMs <= maxGraceDeadlineMs

    if (withMemory && graceMemory && withinGraceWindow) {
      const priorNote = priorCycleLatenessMemory
        ? ` Prior lateness also recorded in Cycle ${priorCycleLatenessMemory.cycle}.`
        : ''
      return {
        chainStatus: 'Late', // Chain fact remains Late!
        policyStatus: 'Accepted under recorded grace agreement',
        policyVerdict: 'excused_by_agreement',
        countsTowardPot: true,
        policyReason: `Chain fact is Late, but accepted under recorded grace agreement "${graceMemory.title}" (within ${graceMeta.durationLabel} grace window).${priorNote}`,
        citedMemory: graceMemory,
        graceEvaluation: {
          honored: true,
          durationMs: graceMeta.durationMs,
          durationLabel: graceMeta.durationLabel,
          explicitCycle: graceMeta.explicitCycle,
          graceMemoryId: graceMemory.id,
          graceBlobId: graceMemory.walrusBlobId || null,
          graceTitle: graceMemory.title,
        },
        timelinessTrajectory: priorCycleLatenessMemory
          ? 'repeat_late_excused'
          : 'late_excused_within_grace',
      }
    }

    if (withMemory && graceMemory && !withinGraceWindow) {
      return {
        chainStatus: 'Late',
        policyStatus: 'Late (Exceeded grace window)',
        policyVerdict: 'violation',
        countsTowardPot: false,
        policyReason: `Chain fact is Late and arrived beyond the ${graceMeta.durationLabel} grace window in "${graceMemory.title}".`,
        citedMemory: graceMemory,
        graceEvaluation: {
          honored: false,
          durationMs: graceMeta.durationMs,
          durationLabel: graceMeta.durationLabel,
          explicitCycle: graceMeta.explicitCycle,
          graceMemoryId: graceMemory.id,
          graceBlobId: graceMemory.walrusBlobId || null,
          graceTitle: graceMemory.title,
        },
        timelinessTrajectory: priorCycleLatenessMemory
          ? 'repeat_late_exceeded_grace'
          : 'late_exceeded_grace',
      }
    }

    return {
      chainStatus: 'Late',
      policyStatus:
        withMemory && priorCycleLatenessMemory
          ? 'Unexcused late payment (Repeat late cycle)'
          : 'Unexcused late payment',
      policyVerdict: 'violation',
      countsTowardPot: false,
      policyReason: withMemory
        ? priorCycleLatenessMemory
          ? `Payment arrived after cycle deadline with no matching grace agreement. Repeat late contribution following Cycle ${priorCycleLatenessMemory.cycle} record "${priorCycleLatenessMemory.title}".`
          : 'Payment arrived after cycle deadline with no matching grace agreement.'
        : 'Strict timestamp evaluation (memory disabled): payment arrived after cycle deadline.',
      citedMemory: withMemory ? anyHistoricalLatenessMemory : null,
      timelinessTrajectory:
        withMemory && priorCycleLatenessMemory ? 'repeat_late_unexcused' : 'late_unexcused',
    }
  }

  if (chainStatus === 'Partial') {
    const splitMemory = memberMemories.find(
      (m) =>
        m.category === 'Member patterns' &&
        (m.title.toLowerCase().includes('split') ||
          m.quote.toLowerCase().includes('split') ||
          m.quote.toLowerCase().includes('tranche') ||
          m.quote.toLowerCase().includes('partial'))
    )

    if (withMemory && splitMemory) {
      return {
        chainStatus: 'Partial',
        policyStatus: 'Awaiting second tranche (recorded split pattern)',
        policyVerdict: 'in_progress_known_pattern',
        countsTowardPot: false,
        policyReason: `Partial payment on-chain (${chainResult.amountReceived}); matches recorded member pattern "${splitMemory.title}".`,
        citedMemory: splitMemory,
      }
    }

    return {
      chainStatus: 'Partial',
      policyStatus: 'Partial payment deficit',
      policyVerdict: 'deficit',
      countsTowardPot: false,
      policyReason: `Only ${chainResult.amountReceived} received on-chain; full contribution is still required.`,
      citedMemory: null,
    }
  }

  if (chainStatus === 'WrongToken') {
    return {
      chainStatus: 'WrongToken',
      policyStatus: 'Rejected (Wrong token)',
      policyVerdict: 'rejected',
      countsTowardPot: false,
      policyReason: chainResult.rawNotes || 'Transfer used an unaccepted token type.',
      citedMemory: null,
    }
  }

  if (chainStatus === 'WrongAmount') {
    const isOverpayment = (chainResult.amountReceived ?? 0) > (chainResult.expectedAmount ?? 0)
    return {
      chainStatus: 'WrongAmount',
      policyStatus: isOverpayment
        ? 'Rejected (Overpayment / amount mismatch)'
        : 'Rejected (Wrong amount)',
      policyVerdict: 'rejected',
      countsTowardPot: false,
      policyReason: chainResult.rawNotes || (isOverpayment
        ? `Overpayment on-chain: received ${chainResult.amountReceived}, which exceeds circle rule of ${chainResult.expectedAmount}.`
        : 'Transfer amount did not match circle contribution rule.'),
      citedMemory: null,
    }
  }

  if (chainStatus === 'Pending') {
    const reminderMemory = reminderPreferenceMemory || priorReminderOutcomeMemory
    const reminderPreference = reminderPreferenceMemory
      ? {
          id: reminderPreferenceMemory.id,
          walrusBlobId: reminderPreferenceMemory.walrusBlobId || null,
          title: reminderPreferenceMemory.title,
        }
      : null
    const outcomeNote =
      priorReminderOutcomeMemory && reminderPreferenceMemory
        ? ` Prior on-time settlement recorded under this cadence (${priorReminderOutcomeMemory.title}).`
        : ''
    return {
      chainStatus: 'Pending',
      policyStatus: reminderMemory
        ? `Pending (Follow reminder preference: ${reminderMemory.title})`
        : 'Pending contribution',
      policyVerdict: 'pending',
      countsTowardPot: false,
      policyReason: reminderMemory
        ? `No payment verified yet. Follow recorded reminder preference "${reminderMemory.title}".${outcomeNote}`
        : 'No matching payment transaction verified on Sui yet.',
      citedMemory: reminderMemory || null,
      reminderPreference,
    }
  }

  return {
    chainStatus: 'Unverified',
    policyStatus: 'Unverified (Chain evidence unavailable or invalid)',
    policyVerdict: 'unverified',
    countsTowardPot: false,
    policyReason: chainResult.error || chainResult.rawNotes || 'Could not verify transaction on Sui.',
    citedMemory: null,
  }
}

/**
 * Detect any confirmed payout-order swap agreement in Walrus Memory and pair it
 * with the immutable Sui Move contract guardrail (`ajo::circle::claim_cycle` enforces
 * fixed `payout_order` set at `create_circle` time).
 */
export function detectPayoutSwapAgreement(memories = [], options = {}) {
  const { cycle, scheduledRecipientName = 'scheduled recipient' } = options
  const currentCycleNum = Number(cycle) > 0 ? Number(cycle) : null

  const swapMemory = memories.find((m) => {
    if (isQuarantinedSyntheticRecord(m)) return false
    if (m.category !== 'Agreements') return false
    // Inspect only user-authored title and quote (never system-generated context metadata)
    const text = `${m.title || ''} ${m.quote || ''}`.toLowerCase()
    const hasNegation =
      /\b(no|not|never|disallow(?:ed)?|prohibit(?:ed)?)\s+(?:payout[\s-]*)?(?:swap|swaps|turn exchange)\b/i.test(text)
    if (hasNegation) return false
    const isSwap =
      /\b(swap|swapping|swapped)\b/i.test(text) ||
      text.includes('turn exchange') ||
      ((text.includes('payout order') || text.includes('payout-order')) &&
        /\b(swap|exchange|trade|switch|change|reorder)\b/i.test(text))
    if (!isSwap) return false
    const cycleMatch = text.match(/\bcycle\s+(\d+)\b/i)
    if (currentCycleNum && cycleMatch && Number(cycleMatch[1]) !== currentCycleNum) {
      return false
    }
    return true
  })

  if (!swapMemory) {
    return null
  }

  return {
    detected: true,
    walrusBlobId: swapMemory.walrusBlobId || null,
    memoryId: swapMemory.id,
    title: swapMemory.title,
    quote: swapMemory.quote,
    memberId: swapMemory.memberId || null,
    contractInvariant: 'Move claim_cycle enforces fixed payout_order; advisory guardrail only',
    advisoryNote: `Off-chain payout-order swap agreement "${swapMemory.title}" is recorded on Walrus (Blob ${swapMemory.walrusBlobId || swapMemory.id}). However, the deployed Sui Move contract (ajo::circle::claim_cycle) enforces the immutable payout_order set at circle creation, so ${scheduledRecipientName} must still execute the on-chain claim.`,
  }
}
