import {
  MemoryStore,
  MemoryRecord,
  MemoryCategory,
  ProposedMemory,
  Member,
  WalrusRestoreOutcome,
} from './types'

/**
 * Real Walrus Memory implementation of MemoryStore.
 * Communicates with the backend `/api/memory/*` endpoints which hold the
 * server-side @mysten-incubation/memwal delegate key and enforce circle membership.
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to register circle on server`)
    }
    return data.circle
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, circleId }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to propose memory`)
    }
    return data.proposal
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
  }): Promise<MemoryRecord> {
    const circleId = params.circleId || this.circleId
    if (!circleId) throw new Error('No active circleId set for memory confirmation')

    const res = await fetch('/api/memory/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, circleId }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to confirm and write memory to Walrus`)
    }
    return data.record
  }

  /**
   * Write a confirmed memory record to Walrus Mainnet and wait for job completion.
   * Requires an authorized member of the circle (`memberId` or `memberAddress`).
   */
  async remember(
    record: Omit<MemoryRecord, 'id'> & { confirmingMemberId?: string; confirmingMemberAddress?: string }
  ): Promise<MemoryRecord> {
    const circleId = record.circleId || this.circleId
    if (!circleId) {
      throw new Error('Cannot write to Walrus Memory without an active circleId.')
    }

    return this.confirmProposal({
      circleId,
      proposal: {
        id: `prop-${Date.now()}`,
        circleId,
        category: record.category,
        memoryType: record.memoryType,
        title: record.title,
        quote: record.quote,
        suggestedAction: record.context,
        memberId: record.memberId,
        memberIds: record.memberIds,
        cycle: record.cycle,
        txDigest: record.txDigest,
      },
      memberId: record.confirmingMemberId || record.memberId,
      memberAddress: record.confirmingMemberAddress,
    })
  }

  async recall(
    query: string,
    options?: { category?: MemoryCategory; memberId?: string; cycle?: number }
  ): Promise<MemoryRecord[]> {
    if (!this.circleId) return []

    const res = await fetch('/api/memory/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    const res = await fetch(`/api/memory/list?circleId=${encodeURIComponent(this.circleId)}`)
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to list memories from Walrus`)
    }
    return data.records || []
  }

  async restore(limit?: number): Promise<WalrusRestoreOutcome> {
    if (!this.circleId) {
      throw new Error('Cannot restore from Walrus without an active circleId.')
    }
    const res = await fetch('/api/memory/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ circleId: this.circleId, limit }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to restore memories from Walrus`)
    }
    return data
  }
}
