import { Router } from 'express'
import {
  checkTatumSuiStatus,
  verifyMemberContributionOnSui,
  getServerVerifiedContribution,
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
} from '../walrus-memory.mjs'
import { requireWalletSession, WalletAuthError } from '../wallet-auth.mjs'
import { loadConfig } from '../config.mjs'

const router = Router()

function mapAuthErrorStatus(err, fallback = 400) {
  if (err instanceof WalletAuthError) return err.statusCode
  if (err?.name === 'StorageUnavailableError') return 503
  if (err?.name === 'StorageConflictError') return 409
  if (err?.message?.includes('Authorization failed')) return 403
  if (err?.message?.includes('not registered')) return 404
  return fallback
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

router.post('/sui/verify-contribution', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    if (!body.circleId) {
      return res.status(400).json({
        status: 'Unverified',
        code: 'unverified',
        amountReceived: 0,
        error: 'circleId is required to verify a circle contribution.',
      })
    }

    const { circle } = verifyCircleMembership(body.circleId, {
      memberAddress: session.walletAddress,
    })

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

    const result = await verifyMemberContributionOnSui({
      circleId: circle.circleId,
      poolAddress: circle.poolAddress,
      memberAddress: targetMember.address,
      memberId: targetMember.id,
      memberName: targetMember.name,
      token: circle.tokenType || body.token,
      expectedAmount: circle.contributionPerMember || body.expectedAmount,
      windowStart: body.windowStart,
      windowEnd: body.windowEnd,
      cycle: Number(body.cycle) || circle.currentCycle || 1,
      txDigest: body.txDigest,
      txDigests: body.txDigests,
      withMemory: body.withMemory !== false,
      memories: serverMemories,
    })
    res.json(result)
  } catch (err) {
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

    const { circle } = verifyCircleMembership(circleId, {
      memberAddress: session.walletAddress,
    })

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
