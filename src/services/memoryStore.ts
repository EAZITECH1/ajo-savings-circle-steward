import {
  MemoryStore,
  MemoryRecord,
  MemoryCategory,
  ProposedMemory,
  Member,
  WalrusRestoreOutcome,
} from './types'
import { getAuthHeaders } from './walletAuth'

export interface ConfirmationChallengeResponse {
  nonce: string
  proposalId: string
  proposalHash: string
  message: string
  issuedAt: string
  expiresAt: string
  member: Member
}

/**
 * Real Walrus Memory implementation of MemoryStore.
 * Communicates with the backend `/api/memory/*` endpoints which hold the
 * server-side @mysten-incubation/memwal delegate key and enforce verified wallet
 * authentication and server-side circle membership.
 */
export class WalrusMemoryStore implements MemoryStore {
  private circleId: string

  constructor(circleId = '') {
    this.circleId = circleId
  }

  setCircleId(circleId: string) {
    this.circleId = circleId.trim()
  }

  getCircleId(): string {
    return this.circleId
  }

  async listCircles(): Promise<any[]> {
    const res = await fetch('/api/memory/circles', {
      headers: getAuthHeaders(),
    })
    if (!res.ok) return []
    const data = await res.json().catch(() => ({ circles: [] }))
    return Array.isArray(data.circles) ? data.circles : []
  }

  async registerCircle(params: {
    circleId: string
    circleName: string
    poolAddress: string
    contributionPerMember: number
    tokenType: string
    cycleLength: string
    currentCycle: number
    members: Member[]
    organizerAddress?: string
  }) {
    this.circleId = params.circleId.trim()
    const res = await fetch('/api/memory/circles', {
      method: 'POST',
      headers: getAuthHeaders(),
      // Circle setup is not restart-recoverable until its roster and terms are on Walrus.
      body: JSON.stringify({ ...params, persistToWalrus: true }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to register circle on server`)
    }
    return data
  }

  async checkHealth(): Promise<{
    connected: boolean
    configured: boolean
    relayerUrl?: string
    accountId?: string
    version?: string
    writeReady?: boolean
    error?: string
    issues?: string[]
  }> {
    const res = await fetch('/api/memory/health')
    return res.json()
  }

  async propose(params: {
    circleId?: string
    category: MemoryCategory
    title: string
    quote: string
    suggestedAction: string
    memberId?: string
    cycle?: number
    txDigest?: string
  }): Promise<ProposedMemory> {
    const circleId = params.circleId || this.circleId
    if (!circleId) throw new Error('No active circleId set for memory proposal')

    const res = await fetch('/api/memory/propose', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ ...params, circleId }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to propose memory`)
    }
    return data.proposal
  }

  async requestConfirmationChallenge(params: {
    circleId?: string
    proposalId: string
    memberId?: string
  }): Promise<ConfirmationChallengeResponse> {
    const circleId = params.circleId || this.circleId
    if (!circleId) throw new Error('No active circleId set for confirmation challenge')

    const res = await fetch('/api/memory/challenge', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        circleId,
        proposalId: params.proposalId,
        memberId: params.memberId,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to issue confirmation challenge`)
    }
    return data
  }

  async confirmProposal(params: {
    circleId?: string
    proposalId?: string
    proposal: ProposedMemory
    memberId?: string
    memberAddress?: string
    signature?: string
    challengeNonce?: string
    publicKeyHex?: string
    confirmationMode?: 'wallet_signature_verified' | 'organizer_entered'
  }): Promise<MemoryRecord> {
    const circleId = params.circleId || this.circleId
    if (!circleId) throw new Error('No active circleId set for memory confirmation')

    const res = await fetch('/api/memory/confirm', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ ...params, circleId }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(
        data.error || `HTTP ${res.status}: Failed to confirm and write memory to Walrus`
      )
    }
    return data.record
  }

  /**
   * Write a confirmed memory record to Walrus Mainnet and wait for job completion.
   * Stages a server proposal first so a proposalId is always bound on the server.
   */
  async remember(
    record: Omit<MemoryRecord, 'id'> & {
      confirmingMemberId?: string
      confirmingMemberAddress?: string
    }
  ): Promise<MemoryRecord> {
    const circleId = record.circleId || this.circleId
    if (!circleId) {
      throw new Error('Cannot write to Walrus Memory without an active circleId.')
    }

    const staged = await this.propose({
      circleId,
      category: record.category,
      title: record.title,
      quote: record.quote,
      suggestedAction: record.context,
      memberId: record.memberId,
      cycle: record.cycle,
      txDigest: record.txDigest,
    })

    return this.confirmProposal({
      circleId,
      proposalId: staged.id,
      proposal: staged,
      memberId: record.confirmingMemberId || record.memberId,
      memberAddress: record.confirmingMemberAddress,
      confirmationMode: 'organizer_entered',
    })
  }

  async recall(
    query: string,
    options?: { category?: MemoryCategory; memberId?: string; cycle?: number }
  ): Promise<MemoryRecord[]> {
    if (!this.circleId) return []

    const res = await fetch('/api/memory/recall', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        circleId: this.circleId,
        query,
        category: options?.category,
        memberId: options?.memberId,
        cycle: options?.cycle,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to recall memories from Walrus`)
    }
    return data.records || []
  }

  async list(): Promise<MemoryRecord[]> {
    if (!this.circleId) return []

    const res = await fetch(
      `/api/memory/list?circleId=${encodeURIComponent(this.circleId)}`,
      {
        headers: getAuthHeaders(),
      }
    )
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to list memories from Walrus`)
    }
    return data.records || []
  }

  async restore(
    limit?: number,
    options?: { windowStart?: string; windowEnd?: string }
  ): Promise<WalrusRestoreOutcome> {
    if (!this.circleId) {
      throw new Error('Cannot restore from Walrus without an active circleId.')
    }
    const res = await fetch('/api/memory/restore', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        circleId: this.circleId,
        limit,
        windowStart: options?.windowStart,
        windowEnd: options?.windowEnd,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to restore memories from Walrus`)
    }
    return data
  }

  async persistCircleConfig(params?: {
    circleId?: string
    memberId?: string
    proposalId?: string
    challengeNonce?: string
    signature?: string
  }) {
    const circleId = params?.circleId || this.circleId
    if (!circleId) {
      throw new Error('Cannot persist circle configuration without an active circleId.')
    }
    const res = await fetch('/api/memory/circles/persist', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ ...params, circleId }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to persist circle configuration to Walrus`)
    }
    return data
  }

  async persistTxAssociation(params: {
    circleId?: string
    cycle: number
    memberId?: string
    memberAddress?: string
    txDigest: string
    network?: string
  }) {
    const circleId = params.circleId || this.circleId
    if (!circleId) {
      throw new Error('Cannot persist transaction digest association without an active circleId.')
    }
    const res = await fetch('/api/memory/tx-associations', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ ...params, circleId }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(
        data.error || `HTTP ${res.status}: Failed to persist transaction digest association to Walrus`
      )
    }
    return data.association
  }
}
