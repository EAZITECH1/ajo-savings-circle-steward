import { Router } from 'express'
import { requireWalletSession, WalletAuthError } from '../wallet-auth.mjs'
import {
  listNotificationsForUser,
  markNotificationRead,
  markAllNotificationsRead,
} from '../notifications.mjs'

const router = Router()

function mapErrorStatus(err, fallback = 400) {
  if (err instanceof WalletAuthError) return err.statusCode
  return fallback
}

router.get('/', (req, res) => {
  try {
    const session = requireWalletSession(req)
    const circleId = req.query.circleId ? String(req.query.circleId).trim() : undefined
    const notifications = listNotificationsForUser({
      walletAddress: session.walletAddress,
      circleId,
    })
    const unreadCount = notifications.filter((n) => !n.read).length
    res.json({ notifications, unreadCount })
  } catch (err) {
    res.status(mapErrorStatus(err, 401)).json({ error: err.message })
  }
})

router.post('/read', (req, res) => {
  try {
    const session = requireWalletSession(req)
    const { id, all, circleId } = req.body || {}
    if (all) {
      const count = markAllNotificationsRead({
        walletAddress: session.walletAddress,
        circleId,
      })
      return res.json({ markedAll: true, count })
    }
    if (!id) {
      return res.status(400).json({ error: 'Notification id or all=true is required' })
    }
    markNotificationRead({ id, walletAddress: session.walletAddress })
    res.json({ marked: true, id })
  } catch (err) {
    res.status(mapErrorStatus(err, 401)).json({ error: err.message })
  }
})

export default router
