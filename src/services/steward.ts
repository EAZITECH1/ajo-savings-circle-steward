import {
  Steward,
  StewardChatInput,
  StewardChatOutput,
  MemoryRecord,
  VerificationResult,
  Member,
} from './types'
import { getAuthHeaders } from './walletAuth'

/**
 * Real server-backed AjoSteward implementation.
 * Delegates all reasoning to the server `/api/steward/*` endpoints, which recall
 * Walrus memories on the server (when `withMemory === true`), read server-verified
 * Sui chain status, invoke the configured LLM, and validate structured citations with Zod.
 * Never falls back to canned responses or client-supplied evidence.
 */
export class AjoSteward implements Steward {
  async checkStatus(): Promise<{
    available: boolean
    status: string
    model: string | null
    missingVars: string[]
    issues: string[]
  }> {
    const res = await fetch('/api/steward/status')
    if (!res.ok) {
      return {
        available: false,
        status: 'unavailable',
        model: null,
        missingVars: [],
        issues: [`HTTP ${res.status} checking Steward status`],
      }
    }
    return res.json()
  }

  async processChat(
    input: StewardChatInput & { windowStart?: string; windowEnd?: string },
    _memories: MemoryRecord[],
    _verifications: Record<string, VerificationResult>
  ): Promise<StewardChatOutput> {
    const res = await fetch('/api/steward/chat', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        circleId: input.circleId,
        circleName: input.circleName,
        message: input.message,
        currentCycle: input.currentCycle,
        withMemory: input.withMemory,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
      }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Steward LLM is unavailable`)
    }
    return data
  }

  async generatePayoutRecommendation(
    cycle: number,
    _members: Member[],
    _verifications: Record<string, VerificationResult>,
    _memories: MemoryRecord[],
    withMemory: boolean,
    extra?: { circleId?: string; windowStart?: string; windowEnd?: string; claimedMemberIds?: string[] }
  ) {
    const res = await fetch('/api/steward/payout-recommendation', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        circleId: extra?.circleId,
        windowStart: extra?.windowStart,
        windowEnd: extra?.windowEnd,
        cycle,
        withMemory,
        claimedMemberIds: extra?.claimedMemberIds,
      }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(
        data.error || `HTTP ${res.status}: Steward payout recommendation is unavailable`
      )
    }
    return data
  }
}
