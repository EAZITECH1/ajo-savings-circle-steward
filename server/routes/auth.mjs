import { Router } from 'express'
import {
  issueWalletAuthChallenge,
  verifyWalletAuthChallenge,
  extractSessionToken,
  getWalletSessionByToken,
  revokeWalletSession,
  WalletAuthError,
} from '../wallet-auth.mjs'

const router = Router()

function mapAuthRouteStatus(err, fallback = 400) {
  if (err instanceof WalletAuthError) return err.statusCode
  return fallback
}

router.post('/challenge', (req, res) => {
  try {
    const challenge = issueWalletAuthChallenge(req.body || {})
    res.json(challenge)
  } catch (err) {
    res.status(mapAuthRouteStatus(err, 400)).json({ error: err.message })
  }
})

router.post('/verify', async (req, res) => {
  try {
    const session = await verifyWalletAuthChallenge(req.body || {})
    res.json(session)
  } catch (err) {
    res.status(mapAuthRouteStatus(err, 401)).json({ error: err.message })
  }
})

router.get('/session', (req, res) => {
  try {
    const token = extractSessionToken(req)
    const session = getWalletSessionByToken(token)
    if (!session) {
      return res.json({ authenticated: false, walletAddress: null })
    }
    res.json({
      authenticated: true,
      walletAddress: session.walletAddress,
      authenticatedAt: session.authenticatedAt,
      expiresAt: session.expiresAt,
    })
  } catch (err) {
    res.status(mapAuthRouteStatus(err, 503)).json({ error: err.message })
  }
})

router.post('/logout', (req, res) => {
  try {
    const token = extractSessionToken(req)
    revokeWalletSession(token)
    res.json({ loggedOut: true })
  } catch (err) {
    res.status(mapAuthRouteStatus(err, 503)).json({ error: err.message })
  }
})

export default router
