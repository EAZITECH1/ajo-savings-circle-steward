import { Router } from 'express'
import {
  checkTatumSuiStatus,
  verifyMemberContributionOnSui,
  clearSubmittedDigests,
} from '../sui-verifier.mjs'
import { evaluateContributionPolicy } from '../payment-policy.mjs'
import { loadConfig } from '../config.mjs'

const router = Router()

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
    const result = await verifyMemberContributionOnSui(req.body || {})
    res.json(result)
  } catch (err) {
    res.status(500).json({
      status: 'Unverified',
      code: 'unverified',
      amountReceived: 0,
      error: err.message || 'Unexpected error verifying Sui contribution',
      rawNotes: 'Server error while verifying contribution.',
    })
  }
})

router.post('/sui/evaluate-policy', (req, res) => {
  const { chainResult, withMemory = true, windowEnd, memories = [], memberId, memberName } = req.body || {}
  if (!chainResult || !chainResult.status) {
    return res.status(400).json({ error: 'chainResult with status is required' })
  }
  const cfg = loadConfig()
  const policy = evaluateContributionPolicy(chainResult, {
    withMemory: Boolean(withMemory),
    windowEnd,
    graceWindowHours: cfg.tunables.graceWindowHours,
    memories,
    memberId,
    memberName,
  })
  res.json({ policy })
})

router.post('/sui/clear-digests', (req, res) => {
  const { circleId, cycle, memberAddress } = req.body || {}
  if (!memberAddress) {
    return res.status(400).json({ error: 'memberAddress is required' })
  }
  clearSubmittedDigests(circleId || 'default', cycle || 1, memberAddress)
  res.json({ cleared: true })
})

export default router
