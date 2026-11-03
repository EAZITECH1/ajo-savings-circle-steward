import { Router } from 'express'
import {
  checkWalrusMemoryHealth,
  upsertCircleRoster,
  listCircleRosters,
  verifyCircleMembership,
  proposeCircleMemory,
  getPendingProposals,
  issueConfirmationChallenge,
  confirmAndWriteMemory,
  recallCircleMemories,
  listCircleMemories,
  restoreCircleMemoriesFromWalrus,
} from '../walrus-memory.mjs'
import { requireWalletSession, WalletAuthError } from '../wallet-auth.mjs'

const router = Router()

function mapErrorStatus(err, fallback = 400) {
  if (err instanceof WalletAuthError) return err.statusCode
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

router.post('/circles', (req, res) => {
  try {
    const session = requireWalletSession(req)
    const circle = upsertCircleRoster(req.body || {}, {
      authenticatedWalletAddress: session.walletAddress,
    })
    res.json({ circle })
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
    res.json({ circle, pendingProposals: getPendingProposals(circle.circleId) })
  } catch (err) {
    res.status(mapErrorStatus(err, 403)).json({ error: err.message })
  }
})

router.post('/propose', (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    const { member } = verifyCircleMembership(body.circleId, {
      memberAddress: session.walletAddress,
    })
    const proposal = proposeCircleMemory({
      ...body,
      proposedBy: `${member.name} (${session.walletAddress})`,
    })
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
    const record = await confirmAndWriteMemory({
      ...body,
      memberId: member.id,
      memberAddress: session.walletAddress,
    })
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
    const { circleId, limit } = req.body || {}
    if (!circleId) {
      return res.status(400).json({ error: 'circleId is required for Walrus restore' })
    }
    verifyCircleMembership(circleId, { memberAddress: session.walletAddress })
    const result = await restoreCircleMemoriesFromWalrus(circleId, limit)
    res.json(result)
  } catch (err) {
    res.status(mapErrorStatus(err, 500)).json({ error: err.message })
  }
})

export default router
