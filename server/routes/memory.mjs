import { Router } from 'express'
import {
  checkWalrusMemoryHealth,
  upsertCircleRoster,
  getCircleRoster,
  listCircleRosters,
  verifyCircleMembership,
  proposeCircleMemory,
  rejectCircleProposal,
  getPendingProposals,
  getCircleProposals,
  getProposalById,
  issueConfirmationChallenge,
  confirmAndWriteMemory,
  persistCircleConfigToWalrus,
  persistTxDigestAssociationToWalrus,
  recallCircleMemories,
  listCircleMemories,
  restoreCircleFromWalrus,
} from '../walrus-memory.mjs'
import { requireWalletSession, WalletAuthError } from '../wallet-auth.mjs'
import { addNotification } from '../notifications.mjs'

const router = Router()

function mapErrorStatus(err, fallback = 400) {
  if (err instanceof WalletAuthError) return err.statusCode
  if (err?.name === 'TransactionConflictError') return 409
  if (err?.name === 'ConfigValidationError') return 503
  if (err?.message?.includes('Authorization failed')) return 403
  if (err?.message?.includes('not registered')) return 404
  return fallback
}

router.get('/health', async (_req, res) => {
  const status = await checkWalrusMemoryHealth()
  res.json(status)
})

router.get('/circles', (req, res) => {
  try {
    const session = requireWalletSession(req)
    res.json({ circles: listCircleRosters({ memberAddress: session.walletAddress }) })
  } catch (err) {
    res.status(mapErrorStatus(err, 401)).json({ error: err.message })
  }
})

router.post('/circles', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    const circle = upsertCircleRoster(body, {
      authenticatedWalletAddress: session.walletAddress,
    })
    if (body.persistToWalrus === true) {
      const persisted = await persistCircleConfigToWalrus({
        circleId: circle.circleId,
        memberAddress: session.walletAddress,
        proposalId: body.proposalId,
        challengeNonce: body.challengeNonce,
        signature: body.signature,
        publicKeyHex: body.publicKeyHex,
      })
      return res.json({
        circle: persisted.circle,
        walrusBlobId: persisted.walrusBlobId,
        namespace: persisted.namespace,
        version: persisted.version,
        configHash: persisted.configHash,
        confirmationType: persisted.confirmationType,
        confirmedBy: persisted.confirmedBy,
      })
    }
    res.json({ circle })
  } catch (err) {
    res.status(mapErrorStatus(err, 400)).json({ error: err.message })
  }
})

router.post('/circles/persist', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    if (!body.circleId) {
      return res.status(400).json({ error: 'circleId is required to persist circle configuration to Walrus' })
    }
    const persisted = await persistCircleConfigToWalrus({
      circleId: body.circleId,
      memberId: body.memberId,
      memberAddress: session.walletAddress,
      proposalId: body.proposalId,
      challengeNonce: body.challengeNonce,
      signature: body.signature,
      publicKeyHex: body.publicKeyHex,
    })
    res.json(persisted)
  } catch (err) {
    res.status(mapErrorStatus(err, 400)).json({ error: err.message })
  }
})

router.post('/tx-associations', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    if (!body.circleId || !body.txDigest) {
      return res.status(400).json({
        error: 'circleId and txDigest are required to persist a transaction digest association to Walrus.',
      })
    }
    const association = await persistTxDigestAssociationToWalrus({
      circleId: body.circleId,
      cycle: body.cycle,
      memberId: body.memberId,
      memberAddress: body.memberAddress,
      txDigest: body.txDigest,
      network: body.network,
      authenticatedWalletAddress: session.walletAddress,
    })
    res.json({ association })
  } catch (err) {
    res.status(mapErrorStatus(err, 400)).json({ error: err.message })
  }
})

router.get('/circles/:circleId', (req, res) => {
  try {
    const session = requireWalletSession(req)
    const { circle } = verifyCircleMembership(req.params.circleId, {
      memberAddress: session.walletAddress,
    })
    res.json({
      circle,
      pendingProposals: getPendingProposals(circle.circleId),
      proposals: getCircleProposals(circle.circleId),
    })
  } catch (err) {
    res.status(mapErrorStatus(err, 403)).json({ error: err.message })
  }
})

router.post('/propose', (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    const { circle, member } = verifyCircleMembership(body.circleId, {
      memberAddress: session.walletAddress,
    })
    const proposal = proposeCircleMemory({
      ...body,
      proposedBy: `${member.name} (${session.walletAddress})`,
      proposedByAddress: session.walletAddress,
      proposedByMemberId: member.id,
    })
    if (proposal.requiresOrganizerApproval && circle.organizerAddress) {
      addNotification({
        circleId: circle.circleId,
        circleName: circle.circleName,
        recipientAddresses: [circle.organizerAddress],
        type: 'proposal_pending_organizer',
        title: `Agreement Proposal Needs Your Signature`,
        message: `${member.name} proposed "${proposal.title}" in ${circle.circleName || circle.circleId}. Review and sign or reject it in Steward Chat.`,
        severity: 'warning',
        actionTab: 'chat',
        proposalId: proposal.id,
        cycle: proposal.cycle,
      })
    }
    res.json({ proposal })
  } catch (err) {
    res.status(mapErrorStatus(err, 400)).json({ error: err.message })
  }
})

router.post('/reject', (req, res) => {
  try {
    const session = requireWalletSession(req)
    const { circleId, proposalId, reason } = req.body || {}
    const { proposal, circle, organizer } = rejectCircleProposal({
      circleId,
      proposalId,
      organizerAddress: session.walletAddress,
      reason,
    })
    if (proposal.proposedByAddress) {
      addNotification({
        circleId: circle.circleId,
        circleName: circle.circleName,
        recipientAddresses: [proposal.proposedByAddress],
        type: 'proposal_rejected',
        title: `Agreement Proposal Rejected`,
        message: `${organizer.name} (organizer) rejected "${proposal.title}"${proposal.rejectionReason ? `: ${proposal.rejectionReason}` : '.'}`,
        severity: 'error',
        actionTab: 'chat',
        proposalId: proposal.id,
        cycle: proposal.cycle,
      })
    }
    res.json({ proposal })
  } catch (err) {
    res.status(mapErrorStatus(err, 400)).json({ error: err.message })
  }
})

router.post('/challenge', (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    const { member } = verifyCircleMembership(body.circleId, {
      memberId: body.memberId,
      memberAddress: session.walletAddress,
    })
    if (body.memberId && member.id !== String(body.memberId).trim()) {
      return res.status(403).json({
        error: `Authorization mismatch: Connected wallet (${session.walletAddress}) belongs to ${member.name} (${member.id}), but the request attempted to confirm on behalf of member ID "${body.memberId}". Member impersonation is strictly forbidden.`,
      })
    }
    const challenge = issueConfirmationChallenge({
      circleId: body.circleId,
      proposalId: body.proposalId,
      memberId: member.id,
      memberAddress: session.walletAddress,
    })
    res.json(challenge)
  } catch (err) {
    res.status(mapErrorStatus(err, 403)).json({ error: err.message })
  }
})

router.post('/confirm', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    const { member } = verifyCircleMembership(body.circleId, {
      memberId: body.memberId,
      memberAddress: session.walletAddress,
    })
    if (body.memberId && member.id !== String(body.memberId).trim()) {
      return res.status(403).json({
        error: `Authorization mismatch: Connected wallet (${session.walletAddress}) belongs to ${member.name} (${member.id}), but the request attempted to confirm on behalf of member ID "${body.memberId}". Member impersonation is strictly forbidden.`,
      })
    }
    const preConfirmProposal = body.proposalId ? getProposalById(body.proposalId) : null
    const record = await confirmAndWriteMemory({
      ...body,
      memberId: member.id,
      memberAddress: session.walletAddress,
    })
    if (preConfirmProposal?.proposedByAddress && preConfirmProposal.requiresOrganizerApproval) {
      const circle = getCircleRoster(body.circleId)
      addNotification({
        circleId: body.circleId,
        circleName: circle?.circleName,
        recipientAddresses: [preConfirmProposal.proposedByAddress],
        type: 'proposal_approved',
        title: `Agreement Approved & Written to Walrus`,
        message: `${member.name} (organizer) signed "${record.title}" and committed it to Walrus Memory.`,
        severity: 'success',
        actionTab: 'chat',
        proposalId: preConfirmProposal.id,
        walrusBlobId: record.walrusBlobId,
        cycle: record.cycle,
      })
    }
    res.json({ record })
  } catch (err) {
    res.status(mapErrorStatus(err, 400)).json({ error: err.message })
  }
})

router.post('/recall', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const { circleId, query = '', category, memberId, cycle, limit, sort } = req.body || {}
    if (!circleId) {
      return res.status(400).json({ error: 'circleId is required for memory recall' })
    }
    verifyCircleMembership(circleId, { memberAddress: session.walletAddress })
    const result = await recallCircleMemories(circleId, query, {
      category,
      memberId,
      cycle,
      limit,
      sort,
    })
    res.json(result)
  } catch (err) {
    res.status(mapErrorStatus(err, 500)).json({ error: err.message })
  }
})

router.get('/list', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const circleId = String(req.query.circleId || '').trim()
    if (!circleId) {
      return res.status(400).json({ error: 'circleId query parameter is required' })
    }
    verifyCircleMembership(circleId, { memberAddress: session.walletAddress })
    const result = await listCircleMemories(circleId)
    res.json(result)
  } catch (err) {
    res.status(mapErrorStatus(err, 500)).json({ error: err.message })
  }
})

router.post('/restore', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const { circleId, limit, windowStart, windowEnd } = req.body || {}
    if (!circleId) {
      return res.status(400).json({ error: 'circleId is required for Walrus restore' })
    }
    // If circle is already active in memory, verify membership immediately before querying Walrus.
    // After a server restart (when circleRegistry is empty), restoreCircleFromWalrus verifies
    // session.walletAddress against the restored circle_config roster before applying state.
    if (getCircleRoster(circleId)) {
      verifyCircleMembership(circleId, { memberAddress: session.walletAddress })
    }
    const result = await restoreCircleFromWalrus(circleId, {
      authenticatedWalletAddress: session.walletAddress,
      limit,
      windowStart,
      windowEnd,
    })
    res.json(result)
  } catch (err) {
    res.status(mapErrorStatus(err, 500)).json({ error: err.message })
  }
})

export default router
