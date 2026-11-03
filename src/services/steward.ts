import {
  Steward,
  StewardChatInput,
  StewardChatOutput,
  MemoryRecord,
  VerificationResult,
  Member,
} from './types'

/**
 * Real server-backed AjoSteward implementation.
 * Delegates all reasoning to the server `/api/steward/*` endpoints, which recall
 * Walrus memories (when `withMemory === true`), evaluate verified Sui chain status,
 * invoke the configured LLM, and validate structured citations with Zod.
 * Never falls back to canned or hardcoded responses.
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
    input: StewardChatInput & { windowEnd?: string },
    memories: MemoryRecord[],
    verifications: Record<string, VerificationResult>
  ): Promise<StewardChatOutput> {
    const res = await fetch('/api/steward/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...input,
        memories,
        verifications,
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
    members: Member[],
    verifications: Record<string, VerificationResult>,
    memories: MemoryRecord[],
    withMemory: boolean,
    extra?: { circleId?: string; windowEnd?: string }
  ) {
    const res = await fetch('/api/steward/payout-recommendation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        circleId: extra?.circleId,
        windowEnd: extra?.windowEnd,
        cycle,
        members,
        verifications,
        memories,
        withMemory,
      }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Steward payout recommendation is unavailable`)
    }
    return data
  }
}
