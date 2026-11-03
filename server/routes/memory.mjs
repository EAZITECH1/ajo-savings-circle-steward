import { Router } from 'express'
import {
  checkWalrusMemoryHealth,
  upsertCircleRoster,
  getCircleRoster,
  listCircleRosters,
  proposeCircleMemory,
  getPendingProposals,
  issueConfirmationChallenge,
  confirmAndWriteMemory,
  recallCircleMemories,
  listCircleMemories,
  restoreCircleMemoriesFromWalrus,
} from '../walrus-memory.mjs'

const router = Router()

router.get('/health', async (_req, res) => {
  const status = await checkWalrusMemoryHealth()
  res.json(status)
})

router.get('/circles', (_req, res) => {
  res.json({ circles: listCircleRosters() })
})

router.post('/circles', (req, res) => {
  try {
    const circle = upsertCircleRoster(req.body || {})
    res.json({ circle })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/circles/:circleId', (req, res) => {
  const circle = getCircleRoster(req.params.circleId)
  if (!circle) {
    return res.status(404).json({ error: `Circle "${req.params.circleId}" not found` })
  }
  res.json({ circle, pendingProposals: getPendingProposals(req.params.circleId) })
})

router.post('/propose', (req, res) => {
  try {
    const proposal = proposeCircleMemory(req.body || {})
    res.json({ proposal })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.post('/challenge', (req, res) => {
  try {
    const challenge = issueConfirmationChallenge(req.body || {})
    res.json(challenge)
  } catch (err) {
    res.status(403).json({ error: err.message })
  }
})

router.post('/confirm', async (req, res) => {
  try {
    const record = await confirmAndWriteMemory(req.body || {})
    res.json({ record })
  } catch (err) {
    const status = err.message?.includes('Authorization failed') || err.message?.includes('not registered')
      ? 403
      : err.name === 'ConfigValidationError'
      ? 503
      : 400
    res.status(status).json({ error: err.message })
  }
})

router.post('/recall', async (req, res) => {
  const { circleId, query = '', category, memberId, cycle, limit, sort } = req.body || {}
  if (!circleId) {
    return res.status(400).json({ error: 'circleId is required for memory recall' })
  }
  try {
    const result = await recallCircleMemories(circleId, query, {
      category,
      memberId,
      cycle,
      limit,
      sort,
    })
    res.json(result)
  } catch (err) {
    const status = err.name === 'ConfigValidationError' ? 503 : 500
    res.status(status).json({ error: err.message })
  }
})

router.get('/list', async (req, res) => {
  const circleId = String(req.query.circleId || '').trim()
  if (!circleId) {
    return res.status(400).json({ error: 'circleId query parameter is required' })
  }
  try {
    const result = await listCircleMemories(circleId)
    res.json(result)
  } catch (err) {
    const status = err.name === 'ConfigValidationError' ? 503 : 500
    res.status(status).json({ error: err.message })
  }
})

router.post('/restore', async (req, res) => {
  const { circleId, limit } = req.body || {}
  if (!circleId) {
    return res.status(400).json({ error: 'circleId is required for Walrus restore' })
  }
  try {
    const result = await restoreCircleMemoriesFromWalrus(circleId, limit)
    res.json(result)
  } catch (err) {
    const status = err.name === 'ConfigValidationError' ? 503 : 500
    res.status(status).json({ error: err.message })
  }
})

export default router
