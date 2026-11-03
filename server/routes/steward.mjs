import { Router } from 'express'
import {
  getStewardStatus,
  runStewardChat,
  runPayoutRecommendation,
} from '../steward-llm.mjs'
import { verifyCircleMembership } from '../walrus-memory.mjs'
import { requireWalletSession, WalletAuthError } from '../wallet-auth.mjs'

const router = Router()

function mapStewardErrorStatus(err) {
  if (err instanceof WalletAuthError) return err.statusCode
  if (err?.name === 'ConfigValidationError') return 503
  if (err?.message?.includes('Authorization failed')) return 403
  if (err?.message?.includes('not registered')) return 404
  if (err?.message?.includes('Walrus Memory')) return 503
  return 400
}

router.get('/status', (_req, res) => {
  res.json(getStewardStatus())
})

router.post('/chat', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    if (!body.circleId) {
      return res.status(400).json({
        available: true,
        error: 'circleId is required for Steward chat. Activate or select a circle first.',
      })
    }
    verifyCircleMembership(body.circleId, { memberAddress: session.walletAddress })

    const output = await runStewardChat({
      circleId: body.circleId,
      circleName: body.circleName,
      message: body.message,
      currentCycle: body.currentCycle,
      withMemory: body.withMemory,
      windowStart: body.windowStart,
      windowEnd: body.windowEnd,
    })
    res.json(output)
  } catch (err) {
    const status = mapStewardErrorStatus(err)
    res.status(status).json({
      available: err.name !== 'ConfigValidationError',
      error: err.message || 'Steward LLM request failed',
    })
  }
})

router.post('/payout-recommendation', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    if (!body.circleId) {
      return res.status(400).json({
        available: true,
        error:
          'circleId is required for Steward payout recommendations. Activate or select a circle first.',
      })
    }
    verifyCircleMembership(body.circleId, { memberAddress: session.walletAddress })

    const output = await runPayoutRecommendation({
      circleId: body.circleId,
      cycle: body.cycle,
      withMemory: body.withMemory,
      windowStart: body.windowStart,
      windowEnd: body.windowEnd,
    })
    res.json(output)
  } catch (err) {
    const status = mapStewardErrorStatus(err)
    res.status(status).json({
      available: err.name !== 'ConfigValidationError',
      error: err.message || 'Steward payout recommendation failed',
    })
  }
})

export default router
