import {
  ChainVerifier,
  VerificationParams,
  VerificationResult,
  PolicyEvaluation,
  MemoryRecord,
} from './types'
import { getAuthHeaders } from './walletAuth'

export interface ExtendedVerificationParams extends VerificationParams {
  circleId?: string
  memberId?: string
  memberName?: string
  withMemory?: boolean
  memories?: MemoryRecord[]
  circleConfig?: any
}

export interface ExtendedVerificationResult extends VerificationResult {
  policy?: PolicyEvaluation
  elapsedDisplay?: string
  amountPaidByDeadline?: number
  amountRemainingOutstanding?: number
  isLateCompletion?: boolean
  historicalLateness?: {
    durableWalrusConfirmed?: boolean
    memoryId?: string
    walrusBlobId?: string
  }
}

export function makeClientDigestStoreKey(circleId: string, cycle: number, memberAddress: string): string {
  return `ajo_submitted_digests_${String(circleId || 'default').trim()}_${Number(cycle) || 1}_${String(memberAddress || '').trim().toLowerCase()}`
}

export function saveClientSubmittedDigest(circleId: string, cycle: number, memberAddress: string, txDigest: string): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return []
  const key = makeClientDigestStoreKey(circleId, cycle, memberAddress)
  try {
    const raw = localStorage.getItem(key)
    const list: string[] = raw ? JSON.parse(raw) : []
    const trimmed = txDigest.trim()
    if (trimmed && !list.includes(trimmed)) {
      list.push(trimmed)
      localStorage.setItem(key, JSON.stringify(list))
    }
    return list
  } catch {
    return []
  }
}

export function getClientSubmittedDigests(circleId: string, cycle: number, memberAddress: string): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return []
  const key = makeClientDigestStoreKey(circleId, cycle, memberAddress)
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function clearClientSubmittedDigests(circleId: string, cycle: number, memberAddress: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  const key = makeClientDigestStoreKey(circleId, cycle, memberAddress)
  try {
    localStorage.removeItem(key)
  } catch {}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * SuiChainVerifier connects to Tatum's Sui Gateway via the backend
 * `/api/tatum/sui/verify-contribution` route.
 *
 * Rules:
 * - Never marks a payment as paid without a matching on-chain transaction.
 * - Keeps chain facts (`Verified`, `Late`, `Partial`, `WrongToken`, `WrongAmount`, `Pending`, `Unverified`)
 *   strictly separate from group policy (`policy.policyStatus`).
 * - The server verifies transactions and recalls Walrus memories itself; client-supplied
 *   memories or chain results are never trusted by the server.
 * - Retries verification with bounded backoff if a just-submitted transaction is not yet indexed by Tatum.
 */
export class SuiChainVerifier implements ChainVerifier {
  async discoverContribution(params: {
    circleId: string
    cycle: number
    windowStart: string
    windowEnd: string
  }): Promise<ExtendedVerificationResult | null> {
    try {
      const response = await fetch('/api/tatum/sui/discover-contribution', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(params),
      })
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }

  async submitDigest(params: {
    circleId: string
    cycle: number
    memberAddress: string
    txDigest: string
  }): Promise<{ success: boolean; digests: string[] }> {
    try {
      const res = await fetch('/api/tatum/sui/submit-digest', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        return { success: false, digests: [] }
      }
      return await res.json()
    } catch {
      return { success: false, digests: [] }
    }
  }

  async getCircleVerifications(
    circleId: string,
    cycle: number,
    poolAddress?: string
  ): Promise<Record<string, ExtendedVerificationResult>> {
    try {
      const q = poolAddress ? `&poolAddress=${encodeURIComponent(poolAddress)}` : ''
      const res = await fetch(
        `/api/tatum/sui/verifications/${encodeURIComponent(circleId)}?cycle=${cycle}${q}`,
        {
          headers: getAuthHeaders(),
        }
      )
      if (!res.ok) return {}
      const data = await res.json()
      return data.verifications || {}
    } catch {
      return {}
    }
  }

  async verifyContribution(
    params: ExtendedVerificationParams,
    options: { maxRetries?: number; backoffMs?: number[] } = {}
  ): Promise<ExtendedVerificationResult> {
    const delays = options.backoffMs || [1500, 2500, 4000, 6000]
    const maxAttempts = (options.maxRetries ?? delays.length) + 1

    let lastResult: ExtendedVerificationResult | null = null

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch('/api/tatum/sui/verify-contribution', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            circleId: params.circleId,
            poolAddress: params.poolAddress,
            memberAddress: params.memberAddress,
            memberId: params.memberId,
            memberName: params.memberName,
            token: params.token,
            expectedAmount: params.expectedAmount,
            windowStart: params.windowStart,
            windowEnd: params.windowEnd,
            cycle: params.cycle,
            txDigest: params.txDigest,
            txDigests: params.txDigests,
            withMemory: params.withMemory,
            circleConfig: params.circleConfig,
          }),
        })

        if (!response.ok) {
          const errJson = await response.json().catch(() => ({}))
          lastResult = {
            status: 'Unverified',
            code: 'unverified',
            error: errJson.error || `HTTP ${response.status}: Failed to reach Sui gateway`,
            amountReceived: 0,
            rawNotes: errJson.error || 'Could not verify contribution on server.',
          }
          // Do not retry on authorization or bad request errors
          if (response.status === 400 || response.status === 401 || response.status === 403) {
            return lastResult
          }
        } else {
          const data: ExtendedVerificationResult = await response.json()
          lastResult = data

          // If successfully verified, late, or definite terminal result, return immediately
          if (
            data.status === 'Verified' ||
            data.status === 'Late' ||
            data.status === 'WrongToken' ||
            data.status === 'WrongAmount' ||
            data.status === 'Partial'
          ) {
            return data
          }

          // If not found yet and we have a specific txDigest submitted, it might still be indexing
          const isNotFound =
            data.status === 'Unverified' &&
            (String(data.error || '').toLowerCase().includes('not found') ||
              String(data.rawNotes || '').toLowerCase().includes('not found'))

          if (!isNotFound || !params.txDigest) {
            return data
          }
        }
      } catch (err: any) {
        lastResult = {
          status: 'Unverified',
          code: 'unverified',
          error: err.message || 'Network exception contacting Sui verifier',
          amountReceived: 0,
          rawNotes: 'Offline or connection timed out.',
        }
      }

      // If more attempts remain, sleep before next backoff retry
      if (attempt < maxAttempts - 1) {
        await sleep(delays[attempt] || 2000)
      }
    }

    // If still unverified after bounded backoff and a digest was provided, provide a clear indexing pending state
    if (params.txDigest && lastResult && lastResult.status === 'Unverified') {
      return {
        ...lastResult,
        code: 'indexing_pending',
        error:
          'Transaction broadcast to Sui Testnet. Tatum Gateway indexer is catching up with the block. Click "Retry verification" in a few seconds.',
        txDigest: params.txDigest,
        txDigests: params.txDigests || [params.txDigest],
      }
    }

    return (
      lastResult || {
        status: 'Unverified',
        code: 'unverified',
        error: 'Verification attempts exhausted without response.',
        amountReceived: 0,
      }
    )
  }

  async evaluatePolicy(params: {
    circleId: string
    cycle: number
    withMemory: boolean
    windowEnd: string
    memberId?: string
    memberAddress?: string
  }): Promise<PolicyEvaluation> {
    const res = await fetch('/api/tatum/sui/evaluate-policy', {
      method: 'POST',
      headers: getAuthHeaders(),
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
      headers: getAuthHeaders(),
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
