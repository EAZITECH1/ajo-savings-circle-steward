import crypto from 'crypto'
import { normalizeSuiAddress } from './payment-policy.mjs'
import { listCircleRosters } from './walrus-memory.mjs'
import { getServerVerifiedContribution } from './sui-verifier.mjs'

const notificationsList = []
const readByAddress = new Map() // normalizedAddress -> Set<notificationIdOrDedupeKey>
const MAX_NOTIFICATIONS = 500

function getReadSet(walletAddress) {
  const norm = normalizeSuiAddress(walletAddress)
  let set = readByAddress.get(norm)
  if (!set) {
    set = new Set()
    readByAddress.set(norm, set)
  }
  return set
}

/**
 * Record an event notification for specific member addresses or an entire circle.
 */
export function addNotification(input) {
  const {
    circleId,
    circleName,
    recipientAddresses = [],
    type = 'circle_update',
    title,
    message,
    severity = 'info',
    actionTab,
    proposalId,
    walrusBlobId,
    txDigest,
    cycle,
    dedupeKey,
  } = input || {}

  if (!circleId || !title || !message) {
    throw new Error('circleId, title, and message are required to create a notification')
  }

  const normalizedRecipients = Array.from(
    new Set((recipientAddresses || []).map((a) => normalizeSuiAddress(a)).filter(Boolean))
  )

  if (dedupeKey) {
    const existing = notificationsList.find((n) => n.dedupeKey === dedupeKey)
    if (existing) {
      existing.title = title
      existing.message = message
      existing.severity = severity
      existing.updatedAt = new Date().toISOString()
      return existing
    }
  }

  const item = {
    id: `notif-${crypto.randomUUID()}`,
    circleId: String(circleId).trim(),
    circleName: circleName || String(circleId).trim(),
    recipientAddresses: normalizedRecipients,
    type,
    title: String(title).trim(),
    message: String(message).trim(),
    severity,
    actionTab: actionTab || undefined,
    proposalId: proposalId || undefined,
    walrusBlobId: walrusBlobId || undefined,
    txDigest: txDigest || undefined,
    cycle: cycle ? Number(cycle) : undefined,
    dedupeKey: dedupeKey || undefined,
    createdAt: new Date().toISOString(),
  }

  notificationsList.unshift(item)
  if (notificationsList.length > MAX_NOTIFICATIONS) {
    notificationsList.length = MAX_NOTIFICATIONS
  }
  return item
}

/**
 * List notifications for a connected wallet across all circles they participate in,
 * including dynamically synthesized contribution due / overdue reminders.
 */
export function listNotificationsForUser({ walletAddress, circleId } = {}) {
  if (!walletAddress) return []
  const normWallet = normalizeSuiAddress(walletAddress)
  const readSet = getReadSet(normWallet)
  const userCircles = listCircleRosters({ memberAddress: normWallet })
  const memberCircleIds = new Set(userCircles.map((c) => c.circleId))

  const stored = notificationsList.filter((n) => {
    if (circleId && n.circleId !== String(circleId).trim()) return false
    if (!memberCircleIds.has(n.circleId) && !n.recipientAddresses.includes(normWallet)) {
      return false
    }
    if (n.recipientAddresses.length > 0 && !n.recipientAddresses.includes(normWallet)) {
      return false
    }
    return true
  })

  // Synthesize contribution due / overdue notifications for active circles where member hasn't paid
  const synthesized = []
  const nowMs = Date.now()

  for (const circle of userCircles) {
    if (circleId && circle.circleId !== String(circleId).trim()) continue
    const cycle = Number(circle.currentCycle) || 1
    const member = (circle.members || []).find(
      (m) => normalizeSuiAddress(m.address) === normWallet
    )
    if (!member) continue

    const verif = getServerVerifiedContribution(circle.circleId, cycle, normWallet)
    const isPaid =
      verif &&
      (verif.status === 'Verified' ||
        verif.status === 'Late' ||
        verif.policy?.countsTowardPot === true ||
        (Number(verif.amountReceived) || 0) >= (Number(circle.contributionPerMember) || 0))

    if (isPaid) continue

    const windowEndMs = circle.windowEnd ? Date.parse(circle.windowEnd) : NaN
    const windowStartMs = circle.windowStart ? Date.parse(circle.windowStart) : NaN
    const isBeforeStart = Number.isFinite(windowStartMs) && nowMs < windowStartMs - 60_000
    if (isBeforeStart) continue

    const isOverdue = Number.isFinite(windowEndMs) && nowMs > windowEndMs
    const remainingAmount =
      verif?.status === 'Partial'
        ? Math.max(0, Number(circle.contributionPerMember || 0) - Number(verif.amountReceived || 0))
        : Number(circle.contributionPerMember || 0)

    const synthId = isOverdue
      ? `synth-overdue-${circle.circleId}-c${cycle}-${normWallet}`
      : `synth-due-${circle.circleId}-c${cycle}-${normWallet}`

    synthesized.push({
      id: synthId,
      circleId: circle.circleId,
      circleName: circle.circleName || circle.circleId,
      recipientAddresses: [normWallet],
      type: isOverdue ? 'contribution_overdue' : 'contribution_due',
      title: isOverdue
        ? `Overdue Contribution — ${circle.circleName || circle.circleId} (Cycle ${cycle})`
        : `Contribution Pending — ${circle.circleName || circle.circleId} (Cycle ${cycle})`,
      message: isOverdue
        ? `The Cycle ${cycle} contribution window has passed and your ${remainingAmount} ${circle.tokenType?.split('::').pop() || 'SUI'} contribution is not yet verified. You can still submit a late payment to the vault.`
        : `You have not yet contributed ${remainingAmount} ${circle.tokenType?.split('::').pop() || 'SUI'} for Cycle ${cycle} of ${circle.circleName || circle.circleId}.`,
      severity: isOverdue ? 'warning' : 'info',
      actionTab: 'overview',
      cycle,
      createdAt: circle.windowEnd || circle.updatedAt || new Date().toISOString(),
      synthetic: true,
    })
  }

  const combined = [...synthesized, ...stored].map((item) => ({
    ...item,
    read: readSet.has(item.id),
  }))

  combined.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
  return combined
}

export function markNotificationRead({ id, walletAddress }) {
  if (!id || !walletAddress) return false
  const readSet = getReadSet(walletAddress)
  readSet.add(String(id).trim())
  return true
}

export function markAllNotificationsRead({ walletAddress, circleId } = {}) {
  if (!walletAddress) return 0
  const items = listNotificationsForUser({ walletAddress, circleId })
  const readSet = getReadSet(walletAddress)
  for (const item of items) {
    readSet.add(item.id)
  }
  return items.length
}

export function clearNotificationsForTests() {
  notificationsList.length = 0
  readByAddress.clear()
}
