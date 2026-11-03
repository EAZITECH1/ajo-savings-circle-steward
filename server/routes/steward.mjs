import { Router } from 'express'
import {
  getStewardStatus,
  runStewardChat,
  runPayoutRecommendation,
} from '../steward-llm.mjs'

const router = Router()

router.get('/status', (_req, res) => {
  res.json(getStewardStatus())
})

router.post('/chat', async (req, res) => {
  try {
    const output = await runStewardChat(req.body || {})
    res.json(output)
  } catch (err) {
    const status = err.name === 'ConfigValidationError' ? 503 : 400
    res.status(status).json({
      available: err.name !== 'ConfigValidationError',
      error: err.message || 'Steward LLM request failed',
    })
  }
})

router.post('/payout-recommendation', async (req, res) => {
  try {
    const output = await runPayoutRecommendation(req.body || {})
    res.json(output)
  } catch (err) {
    const status = err.name === 'ConfigValidationError' ? 503 : 400
    res.status(status).json({
      available: err.name !== 'ConfigValidationError',
      error: err.message || 'Steward payout recommendation failed',
    })
  }
})

export default router
