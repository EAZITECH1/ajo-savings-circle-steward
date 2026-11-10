import { Router } from 'express'
import {
  checkTatumSuiStatus,
  discoverRecentContributionDigests,
  verifyMemberContributionOnSui,
  getServerVerifiedContribution,
  getSubmittedDigests,
  recordSubmittedDigest,
  clearSubmittedDigests,
} from '../sui-verifier.mjs'
import {
  evaluateContributionPolicy,
  classifyChainContribution,
  normalizeSuiAddress,
} from '../payment-policy.mjs'
import {
  verifyCircleMembership,
  listCircleMemories,
  persistHistoricalLatenessToWalrus,
  upsertCircleRoster,
} from '../walrus-memory.mjs'
import { requireWalletSession, WalletAuthError } from '../wallet-auth.mjs'
import { loadConfig } from '../config.mjs'

const router = Router()

function mapAuthErrorStatus(err, fallback = 400) {
  if (err instanceof WalletAuthError) return err.statusCode
  if (err?.name === 'TransactionConflictError') return 409
  if (err?.message?.includes('Authorization failed')) return 403
  if (err?.message?.includes('not registered')) return 404
  return fallback
}

/**
 * Resolve circle membership context from active in-memory registry or client-provided config.
 * Never runs automatic Walrus restore on restart so it does not overwrite active cycles or inject stale records.
 * Updates in-memory circle configuration whenever fresh circleConfig is supplied so old circle rules
 * never contaminate new circles or updated settings.
 */
function resolveCircleContext(circleId, walletAddress, options = {}) {
  // If fresh circleConfig is passed with the request for this circleId,
  // update the registered circle roster so old circle settings never contaminate new circles or updates.
  if (options.circleConfig && options.circleConfig.circleId === circleId) {
    const incomingCfg = options.circleConfig
    const membersList =
      Array.isArray(incomingCfg.members) && incomingCfg.members.length > 0
        ? [...incomingCfg.members]
        : []
    if (
      walletAddress &&
      !membersList.some(
        (m) => normalizeSuiAddress(m.address) === normalizeSuiAddress(walletAddress)
      )
    ) {
      membersList.push({
        id: options.memberId || `m_${membersList.length + 1}`,
        name: options.memberName || 'Member',
        address: walletAddress,
      })
    }
    try {
      upsertCircleRoster({
        ...incomingCfg,
        circleId,
        circleName: incomingCfg.circleName || options.circleName || circleId,
        poolAddress: incomingCfg.poolAddress || options.poolAddress || '',
        contributionPerMember:
          Number(options.expectedAmount) > 0
            ? Number(options.expectedAmount)
            : Number(incomingCfg.contributionPerMember) || 0,
        members: membersList,
      })
    } catch {
      // Continue if roster validation or duplicate check needs standard resolution
    }
  }

  try {
    return verifyCircleMembership(circleId, { memberAddress: walletAddress })
  } catch (err) {
    if (err?.statusCode === 404) {
      const cfg =
        options.circleConfig && options.circleConfig.circleId === circleId
          ? options.circleConfig
          : options.poolAddress
          ? {
              circleId: circleId || options.circleId || 'default',
              circleName: options.circleName || circleId || 'Ajo Circle',
              poolAddress: options.poolAddress,
              contributionPerMember: options.expectedAmount || options.contributionPerMember || 0,
              tokenType: options.token || options.tokenType,
              cycleLength: options.cycleLength || 'Monthly',
              currentCycle: options.cycle || 1,
              members:
                Array.isArray(options.members) && options.members.length > 0
                  ? options.members
                  : [
                      {
                        id: options.memberId || 'm1',
                        name: options.memberName || 'Member',
                        address: options.memberAddress || walletAddress,
                      },
                    ],
              windowStart: options.windowStart,
              windowEnd: options.windowEnd,
              timeZone: options.timeZone,
            }
          : null

      if (cfg) {
        const membersList = Array.isArray(cfg.members) ? [...cfg.members] : []
        if (
          walletAddress &&
          !membersList.some(
            (m) => normalizeSuiAddress(m.address) === normalizeSuiAddress(walletAddress)
          )
        ) {
          membersList.push({
            id: `m_${membersList.length + 1}`,
            name: options.memberName || 'Member',
            address: walletAddress,
          })
        }
        upsertCircleRoster({ ...cfg, members: membersList })
        return verifyCircleMembership(circleId, { memberAddress: walletAddress })
      }
    }
    throw err
  }
}

router.get('/status', async (_req, res) => {
  const status = await checkTatumSuiStatus()
  res.json({
    status: status.connected ? 'connected' : status.configured ? 'egress-failed' : 'no-api-key',
    ...status,
  })
})

router.get('/sui/status', async (_req, res) => {
  const status = await checkTatumSuiStatus()
  res.json(status)
})

router.post('/sui/discover-contribution', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    if (!body.circleId) {
      return res.status(400).json({ error: 'circleId is required to discover a contribution.' })
    }

    // Bind discovery to the authenticated member; never allow the client to
    // search for or attribute another member's vault transfers.
    const { circle, member } = resolveCircleContext(body.circleId, session.walletAddress, body)
    const cycle = Number(body.cycle) || circle.currentCycle || 1
    const windowStart = body.windowStart || circle.windowStart
    const windowEnd = body.windowEnd || circle.windowEnd
    const resolvedExpectedAmount =
      Number(body.expectedAmount) > 0
        ? Number(body.expectedAmount)
        : (Number(circle.contributionPerMember) || 0)
    const resolvedTokenType = body.token || circle.tokenType

    const digests = await discoverRecentContributionDigests({
      circleId: circle.circleId,
      poolAddress: circle.poolAddress,
      memberAddress: member.address,
      token: resolvedTokenType,
      windowStart,
      windowEnd,
      cycle,
      createdAt: circle.createdAt || circle.updatedAt,
      expectedAmount: resolvedExpectedAmount,
      decimals: circle.decimals,
    })

    const cfg = loadConfig()
    let serverMemories = []
    if (cfg.integrations.memwal.configured) {
      const listed = await listCircleMemories(circle.circleId)
      serverMemories = listed.records
    }

    const result = await verifyMemberContributionOnSui({
      circleId: circle.circleId,
      poolAddress: circle.poolAddress,
      memberAddress: member.address,
      memberId: member.id,
      memberName: member.name,
      token: resolvedTokenType,
      expectedAmount: resolvedExpectedAmount,
      windowStart,
      windowEnd,
      cycle,
      txDigests: digests,
      withMemory: cfg.integrations.memwal.configured,
      memories: serverMemories,
    })

    let historicalLateness = null
    if (result.isLateCompletion && result.latePaymentDigest && cfg.integrations.memwal.configured) {
      try {
        const record = await persistHistoricalLatenessToWalrus({
          circleId: circle.circleId,
          cycle,
          memberAddress: member.address,
          memberId: member.id,
          requiredAmount: circle.contributionPerMember,
          amountPaidByDeadline: result.amountPaidByDeadline,
          amountRemainingOutstanding: result.amountRemainingOutstanding,
          deadlineTimestamp: result.deadlineTimestamp,
          latePaymentDigest: result.latePaymentDigest,
          latePaymentTimestamp: result.latePaymentTimestamp,
          elapsedMs: result.elapsedMs,
          elapsedDisplay: result.elapsedDisplay,
        })
        historicalLateness = { recorded: true, durableWalrusConfirmed: true, walrusBlobId: record.walrusBlobId }
      } catch (error) {
        historicalLateness = { recorded: false, durableWalrusConfirmed: false, error: error.message }
      }
    }

    res.json({ ...result, historicalLateness, discoveredDigestCount: digests.length })
  } catch (err) {
    const status = mapAuthErrorStatus(err, 500)
    res.status(status).json({ error: err.message || 'Failed to discover recent contribution' })
  }
})

router.get('/sui/verifications/:circleId', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const { circleId } = req.params
    const cycle = Number(req.query.cycle) || 1

    const { circle } = resolveCircleContext(circleId, session.walletAddress, req.query)
    const windowStart = circle.windowStart
    const windowEnd = circle.windowEnd
    const queryExpectedAmount = Number(req.query.expectedAmount)
    const resolvedExpectedAmount =
      queryExpectedAmount > 0
        ? queryExpectedAmount
        : (Number(circle.contributionPerMember) || 0)
    const resolvedTokenType = req.query.token || circle.tokenType

    const activePoolAddress = req.query.poolAddress || circle.poolAddress
    const results = {}
    for (const m of circle.members) {
      const recKey = `${m.id}_${cycle}`
      let verified = getServerVerifiedContribution(circle.circleId, cycle, m.address)
      if (
        verified &&
        activePoolAddress &&
        ((verified.expectedPoolAddress && normalizeSuiAddress(verified.expectedPoolAddress) !== normalizeSuiAddress(activePoolAddress)) ||
          (verified.observedRecipient && normalizeSuiAddress(verified.observedRecipient) !== normalizeSuiAddress(activePoolAddress)))
      ) {
        verified = null
      }
      if (!verified) {
        let submitted = getSubmittedDigests(circle.circleId, cycle, m.address)
        if (submitted.length === 0) {
          try {
            submitted = await discoverRecentContributionDigests({
              poolAddress: activePoolAddress,
              memberAddress: m.address,
              token: resolvedTokenType,
              windowStart,
              windowEnd,
              cycle,
              expectedAmount: resolvedExpectedAmount,
            })
          } catch {}
        }
        if (submitted.length > 0) {
          try {
            verified = await verifyMemberContributionOnSui({
              circleId: circle.circleId,
              poolAddress: activePoolAddress,
              memberAddress: m.address,
              memberId: m.id,
              memberName: m.name,
              token: resolvedTokenType,
              expectedAmount: resolvedExpectedAmount,
              windowStart,
              windowEnd,
              cycle,
              txDigests: submitted,
            })
          } catch {
            // Keep unverified if on-chain query fails
          }
        }
      }
      if (verified) {
        results[recKey] = verified
      }
    }

    res.json({ circleId: circle.circleId, cycle, verifications: results })
  } catch (err) {
    const status = mapAuthErrorStatus(err, 500)
    res.status(status).json({ error: err.message || 'Failed to list circle verifications' })
  }
})

router.post('/sui/submit-digest', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const { circleId, cycle = 1, memberAddress, txDigest } = req.body || {}
    if (!circleId || !memberAddress || !txDigest) {
      return res.status(400).json({ error: 'circleId, memberAddress, and txDigest are required' })
    }

    const { circle } = resolveCircleContext(circleId, session.walletAddress, req.body)

    const targetMember = circle.members.find(
      (m) => normalizeSuiAddress(m.address) === normalizeSuiAddress(memberAddress)
    )
    if (!targetMember) {
      return res.status(403).json({ error: 'Target member is not in the circle roster' })
    }

    const digests = recordSubmittedDigest(circle.circleId, Number(cycle) || 1, targetMember.address, txDigest, {
      poolAddress: circle.poolAddress,
      memberId: targetMember.id,
    })

    res.json({ success: true, digests })
  } catch (err) {
    const status = mapAuthErrorStatus(err, 500)
    res.status(status).json({ error: err.message })
  }
})

router.post('/sui/verify-contribution', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    console.log('[VERIFY-REQ]', {
      circleId: body.circleId,
      memberAddress: body.memberAddress,
      txDigest: body.txDigest,
      expectedAmount: body.expectedAmount,
      token: body.token,
      cycle: body.cycle,
      windowStart: body.windowStart,
      windowEnd: body.windowEnd,
    })
    if (!body.circleId) {
      return res.status(400).json({
        status: 'Unverified',
        code: 'unverified',
        amountReceived: 0,
        error: 'circleId is required to verify a circle contribution.',
      })
    }

    const { circle } = resolveCircleContext(body.circleId, session.walletAddress, body)

    const targetMember = circle.members.find((m) => {
      if (body.memberId && m.id === body.memberId) return true
      if (
        body.memberAddress &&
        normalizeSuiAddress(m.address) === normalizeSuiAddress(body.memberAddress)
      ) {
        return true
      }
      return false
    })

    if (!targetMember) {
      return res.status(403).json({
        status: 'Unverified',
        code: 'unverified',
        amountReceived: 0,
        error: 'Target member is not in the registered circle roster.',
      })
    }

    const cfg = loadConfig()
    let serverMemories = []
    if (body.withMemory !== false && cfg.integrations.memwal.configured) {
      const listed = await listCircleMemories(circle.circleId)
      serverMemories = listed.records
    }

    const cycle = Number(body.cycle) || circle.currentCycle || 1
    const windowStart = body.windowStart || circle.windowStart
    const windowEnd = body.windowEnd || circle.windowEnd

    // The server prioritizes the actual expectedAmount passed with the contribution.
    // If not supplied or 0, fallback to circle registered contributionPerMember.
    const resolvedExpectedAmount =
      Number(body.expectedAmount) > 0
        ? Number(body.expectedAmount)
        : (Number(circle.contributionPerMember) || 0)
    const resolvedTokenType = body.token || circle.tokenType

    const result = await verifyMemberContributionOnSui({
      circleId: circle.circleId,
      poolAddress: body.poolAddress || circle.poolAddress,
      memberAddress: targetMember.address,
      memberId: targetMember.id,
      memberName: targetMember.name,
      token: resolvedTokenType,
      expectedAmount: resolvedExpectedAmount,
      windowStart,
      windowEnd,
      cycle,
      txDigest: body.txDigest,
      txDigests: body.txDigests,
      withMemory: body.withMemory !== false,
      memories: serverMemories,
      createdAt: circle.createdAt || circle.updatedAt,
    })

    // If Tatum confirms a late completion, write a factual, idempotent Walrus Memory entry
    let historicalLateness = null
    if (result.isLateCompletion && result.latePaymentDigest) {
      if (cfg.integrations.memwal.configured) {
        try {
          const latenessRecord = await persistHistoricalLatenessToWalrus({
            circleId: circle.circleId,
            cycle: Number(body.cycle) || circle.currentCycle || 1,
            memberAddress: targetMember.address,
            memberId: targetMember.id,
            requiredAmount: resolvedExpectedAmount,
            amountPaidByDeadline: result.amountPaidByDeadline,
            amountRemainingOutstanding: result.amountRemainingOutstanding,
            deadlineTimestamp: result.deadlineTimestamp,
            latePaymentDigest: result.latePaymentDigest,
            latePaymentTimestamp: result.latePaymentTimestamp,
            elapsedMs: result.elapsedMs,
            elapsedDisplay: result.elapsedDisplay,
          })
          historicalLateness = {
            recorded: true,
            durableWalrusConfirmed: true,
            walrusBlobId: latenessRecord.walrusBlobId,
            label: 'historical contribution behavior',
            elapsedDisplay: result.elapsedDisplay,
            amountPaidByDeadline: result.amountPaidByDeadline,
            deadlineTimestamp: result.deadlineTimestamp,
            latePaymentDigest: result.latePaymentDigest,
            latePaymentTimestamp: result.latePaymentTimestamp,
          }
        } catch (memErr) {
          historicalLateness = {
            recorded: false,
            durableWalrusConfirmed: false,
            error: memErr.message,
            label: 'historical contribution behavior',
            elapsedDisplay: result.elapsedDisplay,
            amountPaidByDeadline: result.amountPaidByDeadline,
            deadlineTimestamp: result.deadlineTimestamp,
            latePaymentDigest: result.latePaymentDigest,
            latePaymentTimestamp: result.latePaymentTimestamp,
          }
        }
      } else {
        historicalLateness = {
          recorded: false,
          durableWalrusConfirmed: false,
          error: 'Walrus Memory is unconfigured; cannot durably persist lateness record.',
          label: 'historical contribution behavior',
          elapsedDisplay: result.elapsedDisplay,
          amountPaidByDeadline: result.amountPaidByDeadline,
          deadlineTimestamp: result.deadlineTimestamp,
          latePaymentDigest: result.latePaymentDigest,
          latePaymentTimestamp: result.latePaymentTimestamp,
        }
      }
    }

    console.log('[VERIFY-OUTCOME]', {
      status: result.status,
      code: result.code,
      amountReceived: result.amountReceived,
      error: result.error,
      rawNotes: result.rawNotes,
    })
    res.json({ ...result, historicalLateness })
  } catch (err) {
    console.error('[VERIFY-ERR]', err)
    const status = mapAuthErrorStatus(err, 500)
    res.status(status).json({
      status: 'Unverified',
      code: 'unverified',
      amountReceived: 0,
      error: err.message || 'Unexpected error verifying Sui contribution',
      rawNotes: 'Server error or authorization failure while verifying contribution.',
    })
  }
})

router.post('/sui/evaluate-policy', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const {
      circleId,
      cycle = 1,
      withMemory = true,
      windowEnd,
      memberId,
      memberAddress,
    } = req.body || {}

    if (!circleId) {
      return res.status(400).json({ error: 'circleId is required to evaluate contribution policy' })
    }

    const { circle } = resolveCircleContext(circleId, session.walletAddress, req.body)

    const targetMember = circle.members.find((m) => {
      if (memberId && m.id === memberId) return true
      if (
        memberAddress &&
        normalizeSuiAddress(m.address) === normalizeSuiAddress(memberAddress)
      ) {
        return true
      }
      return false
    })

    if (!targetMember) {
      return res.status(403).json({ error: 'Target member is not in the registered circle roster' })
    }

    // Never trust client-supplied chainResult or client-supplied memories
    const serverChainResult =
      getServerVerifiedContribution(circle.circleId, Number(cycle) || 1, targetMember.address) ||
      classifyChainContribution({
        lookupStatus: 'no_digest_submitted',
        expected: {
          poolAddress: circle.poolAddress,
          memberAddress: targetMember.address,
          token: circle.tokenType,
          expectedAmount: circle.contributionPerMember,
          windowStart: '',
          windowEnd: windowEnd || new Date().toISOString(),
        },
      })

    const cfg = loadConfig()
    let serverMemories = []
    if (withMemory) {
      if (!cfg.integrations.memwal.configured) {
        return res.status(503).json({
          error:
            'Walrus Memory is not configured; cannot evaluate memory-backed policy without Walrus.',
        })
      }
      const listed = await listCircleMemories(circle.circleId)
      serverMemories = listed.records
    }

    const policy = evaluateContributionPolicy(serverChainResult, {
      withMemory: Boolean(withMemory),
      windowEnd: windowEnd || new Date().toISOString(),
      graceWindowHours: cfg.tunables.graceWindowHours,
      memories: serverMemories,
      memberId: targetMember.id,
      memberName: targetMember.name,
    })
    res.json({ policy, chainStatus: serverChainResult.status })
  } catch (err) {
    res.status(mapAuthErrorStatus(err, 500)).json({ error: err.message })
  }
})

router.post('/sui/clear-digests', (req, res) => {
  try {
    const session = requireWalletSession(req)
    const { circleId, cycle = 1, memberAddress } = req.body || {}
    if (!circleId || !memberAddress) {
      return res.status(400).json({ error: 'circleId and memberAddress are required' })
    }

    const { circle } = verifyCircleMembership(circleId, {
      memberAddress: session.walletAddress,
    })

    const isSelf =
      normalizeSuiAddress(session.walletAddress) === normalizeSuiAddress(memberAddress)
    const isOrganizer =
      normalizeSuiAddress(session.walletAddress) === normalizeSuiAddress(circle.organizerAddress)

    if (!isSelf && !isOrganizer) {
      return res.status(403).json({
        error: 'Only the member themselves or the circle organizer can clear submitted digests.',
      })
    }

    clearSubmittedDigests(circle.circleId, Number(cycle) || 1, memberAddress)
    res.json({ cleared: true })
  } catch (err) {
    res.status(mapAuthErrorStatus(err, 403)).json({ error: err.message })
  }
})

export default router
