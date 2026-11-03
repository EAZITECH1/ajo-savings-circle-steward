import { ChainVerifier, VerificationParams, VerificationResult } from './types'

/**
 * SuiChainVerifier connects to Tatum's Sui RPC gateway via the server /api/tatum/sui-verify
 * route. Falls back gracefully with real failure diagnostics if network or key is missing.
 *
 * Rules:
 * - Never marks a payment as paid without a matching transaction.
 * - Handles partial payments, wrong token, wrong amount, late payments, and unverified.
 */
export class SuiChainVerifier implements ChainVerifier {
  // Tatum gateway RPC verification
  async verifyContribution(params: VerificationParams): Promise<VerificationResult> {
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
          error: errJson.error || `HTTP ${response.status}: Failed to reach Sui RPC gateway`,
          amountReceived: 0,
          rawNotes: 'Could not connect to chain verification backend.'
        }
      }

      const data = await response.json()
      return data
    } catch (err: any) {
      return {
        status: 'Unverified',
        error: err.message || 'Network exception contacting Sui verifier',
        amountReceived: 0,
        rawNotes: 'Offline or connection timed out.'
      }
    }
  }

  async checkRpcStatus(): Promise<{ connected: boolean; chain: string; network: string; rpcUrl?: string; error?: string }> {
    try {
      const res = await fetch('/api/tatum/sui/status')
      if (!res.ok) {
        return { connected: false, chain: 'sui', network: 'mainnet', error: `Status ${res.status}` }
      }
      return await res.json()
    } catch (e: any) {
      return { connected: false, chain: 'sui', network: 'mainnet', error: e.message }
    }
  }
}
