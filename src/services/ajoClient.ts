// Client API for Ajo On-Chain Lifecycle, Tokens, and Steward Reports

import { TokenConfig } from './tokens'

export interface AjoConfigResponse {
  network: string
  packageId: string
  tokens: Record<string, TokenConfig>
  packageConfigured: boolean
  deploymentGuide: {
    status: string
    buildPath: string
    instructions: string[]
  }
}

export interface OnchainCircleState {
  found: boolean
  objectId: string
  version?: string
  digest?: string
  type?: string
  coinType?: string
  name?: string
  creator?: string
  contributionAmount?: string
  cycleDurationMs?: number
  currentCycle?: number
  cycleDeadlineMs?: number
  members?: string[]
  payoutOrder?: string[]
  acceptedMembers?: string[]
  vaultBalance?: string
  status?: number // 0 = PENDING_ACCEPTANCE, 1 = ACTIVE, 2 = REFUNDING, 3 = COMPLETED
  reason?: string
  error?: string
}

export interface GroupReportResponse {
  circleId: string
  circleName: string
  poolAddress: string
  currentCycle: number
  generatedAt: string
  summary: string
  verifiedContributionsCount: number
  totalExpectedContributions: number
  agreementsCount: number
  memberBreakdown: Array<{
    name: string
    address: string
    chainStatus: string
    policyStatus: string
    amountReceived: number
    txDigest: string | null
  }>
  reportMarkdown: string
}

export async function fetchAjoConfig(): Promise<AjoConfigResponse> {
  const res = await fetch('/api/ajo/config')
  if (!res.ok) {
    throw new Error(`Failed to fetch Ajo config: ${res.statusText}`)
  }
  return res.json()
}

export async function fetchOnchainCircle(objectId: string): Promise<OnchainCircleState> {
  const res = await fetch(`/api/ajo/circle/${encodeURIComponent(objectId)}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to fetch on-chain circle: ${res.statusText}`)
  }
  return res.json()
}

export async function registerCircleInWalrus(circleConfig: any): Promise<{ success: boolean; saved: any }> {
  const token = localStorage.getItem('wallet_session_token') || ''
  const res = await fetch('/api/ajo/register-circle', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ circleConfig }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Failed to register circle in Walrus')
  }
  return res.json()
}

export async function fetchPackageBytecode(): Promise<{ modules: string[] | number[][]; dependencies: string[] }> {
  const res = await fetch('/api/ajo/package-bytecode')
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Failed to fetch package bytecode')
  }
  return res.json()
}

export async function setAjoPackageId(packageId: string): Promise<{ success: boolean; packageId: string }> {
  const res = await fetch('/api/ajo/set-package-id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Failed to set package ID')
  }
  return res.json()
}

export async function inspectCreatedCircle(digest: string): Promise<{
  status: string
  circleObjectId: string | null
  circleType: string | null
  packageId: string | null
}> {
  const res = await fetch(`/api/ajo/inspect-created-circle?digest=${encodeURIComponent(digest)}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Failed to inspect transaction on-chain')
  }
  return res.json()
}

export async function fetchCirclesOverview(): Promise<any[]> {
  const res = await fetch('/api/ajo/overview')
  if (!res.ok) {
    return []
  }
  const data = await res.json().catch(() => ({ circles: [] }))
  return data.circles || []
}

export async function fetchGroupReport(circleId: string, withMemory: boolean = true): Promise<GroupReportResponse> {
  const token = localStorage.getItem('wallet_session_token') || ''
  const res = await fetch('/api/steward/group-report', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ circleId, withMemory }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Failed to generate Group Report')
  }
  return res.json()
}
