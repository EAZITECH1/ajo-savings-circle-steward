import { getAuthHeaders } from './walletAuth'

export interface CircleNotification {
  id: string
  circleId: string
  circleName: string
  recipientAddresses: string[]
  type:
    | 'proposal_pending_organizer'
    | 'proposal_approved'
    | 'proposal_rejected'
    | 'contribution_verified'
    | 'contribution_late'
    | 'contribution_overdue'
    | 'contribution_due'
    | 'circle_update'
  title: string
  message: string
  severity: 'info' | 'warning' | 'success' | 'error'
  actionTab?: string
  proposalId?: string
  walrusBlobId?: string
  txDigest?: string
  cycle?: number
  createdAt: string
  read: boolean
  synthetic?: boolean
}

export async function fetchNotifications(circleId?: string): Promise<{
  notifications: CircleNotification[]
  unreadCount: number
}> {
  const qs = circleId ? `?circleId=${encodeURIComponent(circleId)}` : ''
  const res = await fetch(`/api/notifications${qs}`, {
    headers: getAuthHeaders(),
  })
  if (!res.ok) {
    return { notifications: [], unreadCount: 0 }
  }
  const data = await res.json().catch(() => ({}))
  return {
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
    unreadCount: Number(data.unreadCount) || 0,
  }
}

export async function markNotificationAsRead(id: string): Promise<void> {
  await fetch('/api/notifications/read', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ id }),
  }).catch(() => {})
}

export async function markAllNotificationsAsRead(circleId?: string): Promise<void> {
  await fetch('/api/notifications/read', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ all: true, circleId }),
  }).catch(() => {})
}
