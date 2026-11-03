// Core interfaces and domain models for Ajo Steward

export type CycleStatus = 'Verified' | 'Pending' | 'Late' | 'Partial' | 'Unverified'

export interface Member {
  id: string
  name: string
  address: string
  avatarColor: string
}

export interface VerificationParams {
  poolAddress: string
  memberAddress: string
  token: string
  expectedAmount: number
  windowStart: string
  windowEnd: string
  cycle: number
}

export interface VerificationResult {
  status: CycleStatus
  txDigest?: string
  amountReceived?: number
  timestamp?: string
  tokenReceived?: string
  error?: string
  rawNotes?: string
}

/**
 * ChainVerifier Interface
 * Verifies contributions onchain. Handles partial payments, wrong token,
 * wrong amount, late payments, and "unverified" when chain data is unavailable.
 * Never marks a payment as paid without a matching transaction.
 */
export interface ChainVerifier {
  verifyContribution(params: VerificationParams): Promise<VerificationResult>
  checkRpcStatus(): Promise<{ connected: boolean; chain: string; network: string; rpcUrl?: string; error?: string }>
}

export type MemoryCategory = 'Agreements' | 'Member patterns' | 'Reminder preferences'

export interface MemoryRecord {
  id: string
  category: MemoryCategory
  title: string
  quote: string
  date: string
  cycle: number
  confirmedBy: string
  walrusBlobId: string
  context: string
  memberId?: string
}

/**
 * MemoryStore Interface
 * Stores and recalls group memories (decisions, exceptions, patterns, preferences).
 * Includes Walrus blob proof references.
 */
export interface MemoryStore {
  remember(record: Omit<MemoryRecord, 'id'>): Promise<MemoryRecord>
  recall(query: string, options?: { category?: MemoryCategory; memberId?: string; cycle?: number }): Promise<MemoryRecord[]>
  list(): Promise<MemoryRecord[]>
}

export interface ProposedMemory {
  id: string
  category: MemoryCategory
  title: string
  quote: string
  suggestedAction: string
  memberId?: string
}

export interface StewardChatInput {
  message: string
  memberAddress?: string
  currentCycle: number
  withMemory: boolean
}

export interface StewardChatOutput {
  reply: string
  proposedMemory?: ProposedMemory
  citedMemories: MemoryRecord[]
  riskAssessment?: {
    memberId: string
    riskLevel: 'Zero Risk' | 'Low Risk' | 'Moderate Risk' | 'High Risk'
    note: string
  }
}

/**
 * Steward Interface
 * Takes chat input plus recalled memories plus verification results
 * and returns an advisory reply plus optional proposed memories.
 */
export interface Steward {
  processChat(
    input: StewardChatInput,
    memories: MemoryRecord[],
    verifications: Record<string, VerificationResult>
  ): Promise<StewardChatOutput>

  generatePayoutRecommendation(
    cycle: number,
    members: Member[],
    verifications: Record<string, VerificationResult>,
    memories: MemoryRecord[],
    withMemory: boolean
  ): Promise<{
    nextRecipient: Member
    rationale: string
    memberRisks: Array<{
      member: Member
      riskLevel: string
      badgeClass: string
      reasoning: string
      action: string
      citedBlob?: string
    }>
  }>
}
