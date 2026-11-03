import {
  ChainVerifier,
  VerificationParams,
  VerificationResult,
  PolicyEvaluation,
  MemoryRecord,
} from './types'

export interface ExtendedVerificationParams extends VerificationParams {
  circleId?: string
  memberId?: string
  memberName?: string
  withMemory?: boolean
  memories?: MemoryRecord[]
}

export interface ExtendedVerificationResult extends VerificationResult {
  policy?: PolicyEvaluation
}

/**
 * SuiChainVerifier connects to Tatum's Sui RPC gateway via the backend
 * `/api/tatum/sui/verify-contribution` route using official `sui_getTransactionBlock` lookups.
 *
 * Rules:
 * - Never marks a payment as paid without a matching on-chain transaction.
 * - Keeps chain facts (`Verified`, `Late`, `Partial`, `WrongToken`, `WrongAmount`, `Pending`, `Unverified`)
 *   strictly separate from group policy (`policy.policyStatus`).
 */
export class SuiChainVerifier implements ChainVerifier {
  async verifyContribution(params: ExtendedVerificationParams): Promise<ExtendedVerificationResult> {
    try {
      const response = await fetch('/api/tatum/sui/verify-contribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}))
        return {
          status: 'Unverified',
          code: 'unverified',
          error: errJson.error || `HTTP ${response.status}: Failed to reach Sui RPC gateway`,
          amountReceived: 0,
          rawNotes: 'Could not connect to chain verification backend.',
        }
      }

      return await response.json()
    } catch (err: any) {
      return {
        status: 'Unverified',
        code: 'unverified',
        error: err.message || 'Network exception contacting Sui verifier',
        amountReceived: 0,
        rawNotes: 'Offline or connection timed out.',
      }
    }
  }

  async evaluatePolicy(params: {
    chainResult: VerificationResult
    withMemory: boolean
    windowEnd: string
    memories: MemoryRecord[]
    memberId?: string
    memberName?: string
  }): Promise<PolicyEvaluation> {
    const res = await fetch('/api/tatum/sui/evaluate-policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Failed to evaluate policy`)
    }
    return data.policy
  }

  async clearMemberDigests(circleId: string, cycle: number, memberAddress: string): Promise<void> {
    await fetch('/api/tatum/sui/clear-digests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ circleId, cycle, memberAddress }),
    })
  }

  async checkRpcStatus(): Promise<{
    connected: boolean
    configured?: boolean
    chain: string
    network: string
    chainId?: string
    rpcUrl?: string
    error?: string
  }> {
    try {
      const res = await fetch('/api/tatum/sui/status')
      if (!res.ok) {
        return {
          connected: false,
          chain: 'sui',
          network: 'unconfigured',
          error: `HTTP ${res.status}`,
        }
      }
      return await res.json()
    } catch (e: any) {
      return {
        connected: false,
        chain: 'sui',
        network: 'unconfigured',
        error: e.message,
      }
    }
  }
}
