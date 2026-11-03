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

  // Check if any transfer occurred before windowStartMs
  const beforeWindow = sorted.find((t) => t.timestampMs < windowStartMs)
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
      rawNotes: `Transaction ${beforeWindow.txDigest} occurred at ${new Date(beforeWindow.timestampMs).toISOString()}, before cycle window start ${new Date(windowStartMs).toISOString()}.`,
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

  if (totalAmount + eps < expected.expectedAmount) {
    return {
      status: 'Partial',
      code: 'partial',
      txDigest: primaryDigest,
      txDigests: digests,
      amountReceived: totalAmount,
      tokenReceived: lastTx.tokenType,
      timestamp: latestIso,
      rawNotes: `Received ${totalAmount} of expected ${expected.expectedAmount} (${sorted.length} payment${sorted.length > 1 ? 's' : ''}).`,
    }
  }

  if (totalAmount - eps > expected.expectedAmount) {
    return {
      status: 'WrongAmount',
      code: 'wrong_amount',
      txDigest: primaryDigest,
      txDigests: digests,
      amountReceived: totalAmount,
      tokenReceived: lastTx.tokenType,
      timestamp: latestIso,
      rawNotes: `Received ${totalAmount}, which exceeds expected ${expected.expectedAmount}.`,
    }
  }

  // Exact amount reached across 2+ partial payments: check partialPaymentWindowHours
  if (sorted.length > 1 && splitSpanMs > maxSplitSpanMs) {
    return {
      status: 'Partial',
      code: 'partial',
      txDigest: primaryDigest,
      txDigests: digests,
      amountReceived: totalAmount,
      tokenReceived: lastTx.tokenType,
      timestamp: latestIso,
      rawNotes: `Split payments totaled ${totalAmount}, but elapsed time between tranches (${(splitSpanMs / 3600000).toFixed(1)}h) exceeded the ${partialPaymentWindowHours}h partial-payment window.`,
    }
  }

  // Check deadline (windowEndMs)
  if (lastTx.timestampMs > windowEndMs) {
    const hoursLate = ((lastTx.timestampMs - windowEndMs) / 3600000).toFixed(1)
    return {
      status: 'Late',
      code: 'late',
      txDigest: primaryDigest,
      txDigests: digests,
      amountReceived: totalAmount,
      tokenReceived: lastTx.tokenType,
      timestamp: latestIso,
      hoursLate: Number(hoursLate),
      rawNotes:
        sorted.length > 1
          ? `Split payments (${sorted.length} tranches) completed ${hoursLate}h after cycle deadline.`
          : `Payment arrived ${hoursLate}h after cycle deadline.`,
    }
  }

  return {
    status: 'Verified',
    code: 'verified',
    txDigest: primaryDigest,
    txDigests: digests,
    amountReceived: totalAmount,
    tokenReceived: lastTx.tokenType,
    timestamp: latestIso,
    rawNotes:
      sorted.length > 1
        ? `Contribution verified across ${sorted.length} split payments within the ${partialPaymentWindowHours}h window and before cycle deadline.`
        : 'Contribution verified on Sui within cycle window.',
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
 * @param {Array<{ id: string, walrusBlobId?: string, title: string, quote: string, memberId?: string, category?: string }>} [options.memories=[]]
 * @param {string} [options.memberId]
 * @param {string} [options.memberName]
 */
export function evaluateContributionPolicy(chainResult, options) {
  const {
    withMemory,
    windowEnd,
    graceWindowHours = 72,
    memories = [],
    memberId,
    memberName,
  } = options

  const chainStatus = chainResult.status
  const windowEndMs = typeof windowEnd === 'number' ? windowEnd : Date.parse(windowEnd)

  // Helper to match memories relevant to this member
  const memberMemories = withMemory
    ? memories.filter((m) => {
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

  if (chainStatus === 'Verified') {
    return {
      chainStatus,
      policyStatus: 'Accepted on time',
      policyVerdict: 'good_standing',
      countsTowardPot: true,
      policyReason: 'On-time verified chain contribution meets circle rules.',
      citedMemory: null,
    }
  }

  if (chainStatus === 'Late') {
    const graceMemory = memberMemories.find(
      (m) =>
        m.category === 'Agreements' &&
        (m.title.toLowerCase().includes('grace') ||
          m.quote.toLowerCase().includes('grace') ||
          m.title.toLowerCase().includes('late') ||
          m.quote.toLowerCase().includes('late'))
    )

    const paymentTimeMs = chainResult.timestamp ? Date.parse(chainResult.timestamp) : NaN
    const maxGraceDeadlineMs = windowEndMs + graceWindowHours * 3600 * 1000
    const withinGraceWindow =
      Number.isFinite(paymentTimeMs) &&
      Number.isFinite(maxGraceDeadlineMs) &&
      paymentTimeMs <= maxGraceDeadlineMs

    if (withMemory && graceMemory && withinGraceWindow) {
      return {
        chainStatus: 'Late', // Chain fact remains Late!
        policyStatus: 'Accepted under recorded grace agreement',
        policyVerdict: 'excused_by_agreement',
        countsTowardPot: true,
        policyReason: `Chain fact is Late, but accepted under recorded grace agreement "${graceMemory.title}" (within ${graceWindowHours}h grace window).`,
        citedMemory: graceMemory,
      }
    }

    if (withMemory && graceMemory && !withinGraceWindow) {
      return {
        chainStatus: 'Late',
        policyStatus: 'Late (Exceeded grace window)',
        policyVerdict: 'violation',
        countsTowardPot: false,
        policyReason: `Chain fact is Late and arrived beyond the ${graceWindowHours}h grace window in "${graceMemory.title}".`,
        citedMemory: graceMemory,
      }
    }

    return {
      chainStatus: 'Late',
      policyStatus: 'Unexcused late payment',
      policyVerdict: 'violation',
      countsTowardPot: false,
      policyReason: withMemory
        ? 'Payment arrived after cycle deadline with no matching grace agreement.'
        : 'Strict timestamp evaluation (memory disabled): payment arrived after cycle deadline.',
      citedMemory: null,
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
    return {
      chainStatus: 'WrongAmount',
      policyStatus: 'Rejected (Wrong amount)',
      policyVerdict: 'rejected',
      countsTowardPot: false,
      policyReason: chainResult.rawNotes || 'Transfer amount did not match circle contribution rule.',
      citedMemory: null,
    }
  }

  if (chainStatus === 'Pending') {
    const reminderMemory = memberMemories.find((m) => m.category === 'Reminder preferences')
    return {
      chainStatus: 'Pending',
      policyStatus: reminderMemory
        ? `Pending (Follow reminder preference: ${reminderMemory.title})`
        : 'Pending contribution',
      policyVerdict: 'pending',
      countsTowardPot: false,
      policyReason: reminderMemory
        ? `No payment verified yet. Follow recorded reminder preference "${reminderMemory.title}".`
        : 'No matching payment transaction verified on Sui yet.',
      citedMemory: reminderMemory || null,
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
