// Core interfaces and domain models for Ajo Steward

export type CycleStatus =
  | 'Verified'
  | 'Pending'
  | 'Late'
  | 'Partial'
  | 'WrongToken'
  | 'WrongAmount'
  | 'Unverified'

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
  txDigest?: string
  txDigests?: string[]
}

export interface VerificationResult {
  status: CycleStatus
  code?: 'verified' | 'partial' | 'wrong_token' | 'wrong_amount' | 'late' | 'pending' | 'unverified'
  txDigest?: string
  txDigests?: string[]
  amountReceived?: number
  timestamp?: string
  tokenReceived?: string
  hoursLate?: number
  network?: string
  error?: string
  rawNotes?: string
}

export interface PolicyEvaluation {
  chainStatus: CycleStatus
  policyStatus: string
  policyVerdict: 'good_standing' | 'excused_by_agreement' | 'in_progress_known_pattern' | 'violation' | 'deficit' | 'rejected' | 'pending' | 'unverified'
  countsTowardPot: boolean
  policyReason: string
  citedMemory?: MemoryRecord | null
}

/**
 * ChainVerifier Interface
 * Verifies contributions onchain via Tatum Sui RPC.
 * Handles partial payments, wrong token, wrong amount, late payments,
 * and "Unverified" when chain data is unavailable or digest is invalid/unknown.
 * Never marks a payment as paid without a matching transaction.
 */
export interface ChainVerifier {
  verifyContribution(params: VerificationParams): Promise<VerificationResult>
  checkRpcStatus(): Promise<{ connected: boolean; chain: string; network: string; rpcUrl?: string; error?: string }>
}

export type MemoryCategory = 'Agreements' | 'Member patterns' | 'Reminder preferences'
export type MemoryType = 'agreement' | 'member_pattern' | 'reminder_preference' | 'verified_payment_event'

export interface MemoryRecord {
  id: string
  circleId?: string
  memoryType?: MemoryType
  category: MemoryCategory
  title: string
  quote: string
  date: string
  cycle: number
  confirmedBy: string
  confirmedByList?: string[]
  confirmationType?: 'wallet_signature_verified' | 'organizer_entered' | 'recalled'
  walrusBlobId: string
  context: string
  memberId?: string
  memberIds?: string[]
  txDigest?: string
  distance?: number
  namespace?: string
  owner?: string
  createdAt?: string
}

export interface WalrusRestoreOutcome {
  namespace: string
  restoreResult: {
    restored: number
    skipped: number
    failed: number
    total: number
    namespace: string
    owner: string
    truncated: boolean
  }
  records: MemoryRecord[]
  limitationsNote: string
}

/**
 * MemoryStore Interface
 * Stores and recalls group memories (decisions, exceptions, patterns, preferences)
 * via Walrus Memory (@mysten-incubation/memwal) on the server.
 */
export interface MemoryStore {
  remember(record: Omit<MemoryRecord, 'id'>): Promise<MemoryRecord>
  recall(query: string, options?: { category?: MemoryCategory; memberId?: string; cycle?: number }): Promise<MemoryRecord[]>
  list(): Promise<MemoryRecord[]>
}

export interface ProposedMemory {
  id: string
  circleId?: string
  memoryType?: MemoryType
  category: MemoryCategory
  title: string
  quote: string
  suggestedAction: string
  memberId?: string
  memberIds?: string[]
  cycle?: number
  txDigest?: string
}

export interface StewardChatInput {
  circleId?: string
  circleName?: string
  message: string
  memberAddress?: string
  currentCycle: number
  withMemory: boolean
  contributionPerMember?: number
  tokenType?: string
  members?: Member[]
}

export interface StewardChatOutput {
  reply: string
  proposedMemory?: ProposedMemory
  citedMemories: MemoryRecord[]
  citedTxDigests?: string[]
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
