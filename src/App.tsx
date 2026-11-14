import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  ShieldCheck,
  Brain,
  Sparkles,
  TrendingUp,
  Clock,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  PlusCircle,
  ArrowRight,
  MessageSquare,
  Bookmark,
  Send,
  RefreshCw,
  Lock,
  ChevronDown,
  ChevronRight,
  Info,
  Check,
  Copy,
  CheckCheck,
  Wallet,
  Layers,
  Coins,
  FileText,
  RotateCcw,
  X,
  Loader2,
  UserCheck,
  Compass,
  LayoutDashboard,
  Bell,
} from 'lucide-react'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import {
  useCurrentAccount,
  useCurrentWallet,
  useCurrentNetwork,
  useDAppKit,
  useWallets,
} from '@mysten/dapp-kit-react'

import {
  CycleStatus,
  Member,
  MemoryCategory,
  MemoryRecord,
  ProposedMemory,
  WalrusRestoreOutcome,
} from './services/types'
import { WalrusMemoryStore, ConfirmationChallengeResponse } from './services/memoryStore'
import {
  CircleNotification,
  fetchNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
} from './services/notifications'
import {
  SuiChainVerifier,
  ExtendedVerificationResult,
  saveClientSubmittedDigest,
  getClientSubmittedDigests,
  clearClientSubmittedDigests,
} from './services/chainVerifier'
import { AjoSteward } from './services/steward'
import {
  requestWalletAuthChallenge,
  submitWalletAuthSignature,
  logoutWalletSession,
} from './services/walletAuth'

import {
  TokenConfig,
  getTokensForNetwork,
  findTokenByCoinType,
  findTokenBySymbol,
  toBaseUnits,
  toDisplayUnits,
  formatTokenAmount,
} from './services/tokens'
import {
  buildCreateCircleTx,
  buildAcceptCircleTx,
  buildContributeTx,
  buildClaimCycleTx,
  buildClaimRefundTx,
  buildDirectContributionTx,
  buildPublishPackageTx,
  normalizeSuiObjectId,
} from './services/contractTransactions'
import {
  fetchAjoConfig,
  fetchOnchainCircle,
  registerCircleInWalrus,
  fetchCirclesOverview,
  fetchGroupReport,
  fetchPackageBytecode,
  setAjoPackageId,
  inspectCreatedCircle,
  OnchainCircleState,
  GroupReportResponse,
  AjoConfigResponse,
} from './services/ajoClient'
import { TransactionReviewModal } from './components/TransactionReviewModal'
import { TokenLogo } from './components/TokenLogo'
import { TokenSelector } from './components/TokenSelector'
import { ExplorerLink } from './components/ExplorerLink'
import { verifyWalletBalance, BalanceCheckResult } from './services/suiCoins'
import { SchedulePicker } from './components/SchedulePicker'
import { GuidedTourModal } from './components/GuidedTourModal'
import { LandingPage } from './components/LandingPage'
import {
  detectUserTimeZone,
  formatRotationDuration,
  formatLocalDateTimeWithZone,
  calculateDaylightSavingAwareCycleEnd,
  validateSchedule,
} from './services/schedule'

const memoryStore = new WalrusMemoryStore()
const chainVerifier = new SuiChainVerifier()
const steward = new AjoSteward()

interface ChatMessage {
  id: string
  sender: 'user' | 'steward'
  text: string
  timestamp: string
  proposedMemory?: ProposedMemory
  citedMemories?: MemoryRecord[]
  citedTxDigests?: string[]
}

const AVATAR_PALETTE = [
  'bg-utility-brand-50 text-utility-brand-700',
  'bg-utility-warning-50 text-utility-warning-700',
  'bg-utility-success-50 text-utility-success-700',
  'bg-utility-gray-50 text-secondary',
]

function slugifyCircleId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Generate a globally unique, collision-free Circle ID.
 * Combines the human-readable slug with the organizer address and a unique timestamp suffix.
 * Prevents simultaneous circles with the same name from colliding or overwriting each other.
 */
function generateUniqueCircleId(name: string, organizerAddress?: string): string {
  const base = slugifyCircleId(name) || 'circle'
  const addrPart = organizerAddress
    ? organizerAddress.toLowerCase().replace(/^0x/, '').slice(0, 6)
    : Math.random().toString(36).slice(2, 8)
  const timePart = Date.now().toString(36)
  return `${base}-${addrPart}-${timePart}`
}

const ACTIVE_CIRCLE_STORAGE_KEY = 'ajo_active_circle_id'
const DRAFT_CIRCLE_STORAGE_KEY = 'ajo_create_circle_draft'

function clearSavedCircleDraft(): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.removeItem(DRAFT_CIRCLE_STORAGE_KEY)
  } catch {}
}

const CLAIMED_CYCLES_STORAGE_PREFIX = 'ajo_claimed_cycles_'

interface ClaimRecord {
  recipientAddress: string
  recipientName?: string
  txDigest?: string
  timestamp?: string
  amount?: number
}

function getClaimedCyclesForCircle(circleId: string): Record<number, ClaimRecord> {
  if (typeof window === 'undefined' || !window.localStorage || !circleId) return {}
  try {
    const raw = window.localStorage.getItem(`${CLAIMED_CYCLES_STORAGE_PREFIX}${circleId}`)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveClaimedCycleForCircle(
  circleId: string,
  cycle: number,
  claimInfo: ClaimRecord
): Record<number, ClaimRecord> {
  if (typeof window === 'undefined' || !window.localStorage || !circleId) return {}
  try {
    const existing = getClaimedCyclesForCircle(circleId)
    existing[cycle] = claimInfo
    window.localStorage.setItem(
      `${CLAIMED_CYCLES_STORAGE_PREFIX}${circleId}`,
      JSON.stringify(existing)
    )
    return existing
  } catch {
    return {}
  }
}

function getSavedCircleId(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(ACTIVE_CIRCLE_STORAGE_KEY)?.trim() || ''
  } catch {
    return ''
  }
}

function formatMoveAbortError(rawMessage?: string): string {
  const msg = String(rawMessage || 'Transaction failed.')
  const abortMatch = msg.match(/abort code:\s*(\d+)/i) || msg.match(/MoveAbort.*?,\s*(\d+)\)/i)
  if (!abortMatch) return msg
  const code = Number(abortMatch[1])
  const explanations: Record<number, string> = {
    6: 'Your connected wallet is not a registered member of this circle (E_NOT_MEMBER = 6).',
    7: 'Your wallet has already accepted this circle (E_ALREADY_ACCEPTED = 7).',
    9: 'This circle vault is not currently in an active state (E_NOT_ACTIVE = 9).',
    10: 'The cycle deadline has passed on this legacy vault contract (E_CYCLE_DEADLINE_PASSED = 10).',
    11: 'Your contribution for the active on-chain cycle is already fully paid (E_ALREADY_FULLY_PAID = 11). If all members have paid, the scheduled recipient must claim the current cycle pot so the contract advances to the next cycle.',
    12: 'Deposit amount exceeds your remaining owed contribution for this cycle (E_EXCEEDS_OWED = 12).',
    13: 'Before the cycle deadline, 100% of member contributions must be deposited before the pot can be claimed (E_CYCLE_NOT_FULLY_FUNDED = 13).',
    14: 'Only the scheduled recipient for the active on-chain cycle can execute claim_cycle (E_NOT_SCHEDULED_RECIPIENT = 14). Switch to the scheduled recipient wallet for the current on-chain cycle.',
    15: 'There are currently no claimable funds in the circle vault (E_NO_CLAIMABLE_FUNDS = 15).',
  }
  return explanations[code] ? `${explanations[code]} [Raw: ${msg}]` : msg
}

function getExecutedTransactionDigest(result: any): string {
  if (result?.$kind === 'FailedTransaction') {
    throw new Error(
      formatMoveAbortError(
        result.FailedTransaction.status.error?.message || 'The transaction failed on Sui.'
      )
    )
  }
  const digest = result?.digest || result?.Transaction?.digest || result?.effects?.transactionDigest
  if (!digest) {
    throw new Error('The wallet completed the request but did not return a transaction digest.')
  }
  return digest
}

export type TabId = 'home' | 'dashboard' | 'circles' | 'create' | 'chat' | 'memories' | 'payout'

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('home')
  const [isTourOpen, setIsTourOpen] = useState<boolean>(false)

  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace('#', '')
      const validTabs: TabId[] = ['home', 'dashboard', 'circles', 'create', 'chat', 'memories', 'payout']
      if (validTabs.includes(hash as TabId)) {
        setActiveTab(hash as TabId)
      }
    }
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])
  const withMemory = true
  const [selectedCycle, setSelectedCycle] = useState<number>(1)
  const [copiedText, setCopiedText] = useState<string | null>(null)
  const [expandedReasoning, setExpandedReasoning] = useState<boolean>(true)

  // Integration health & configuration states
  const [rpcStatus, setRpcStatus] = useState<{
    connected: boolean
    configured?: boolean
    chain: string
    network: string
    error?: string
    loading?: boolean
  }>({ connected: false, configured: false, chain: 'sui', network: 'unconfigured', loading: true })

  const explorerNetwork =
    rpcStatus.network?.includes('testnet') ? 'testnet' : 'mainnet'

  const [memwalHealth, setMemwalHealth] = useState<{
    connected: boolean
    configured: boolean
    relayerUrl?: string
    accountId?: string
    error?: string
    issues?: string[]
  }>({ connected: false, configured: false })

  const [stewardStatus, setStewardStatus] = useState<{
    available: boolean
    status: string
    model: string | null
    missingVars: string[]
    issues: string[]
  }>({ available: false, status: 'unconfigured', model: null, missingVars: [], issues: [] })

  // Dedicated Create Circle Form State (never prefilled from active circle or drafts)
  const [createStep, setCreateStep] = useState<number>(1)
  const [createCircleName, setCreateCircleName] = useState<string>('')
  const [createContributionPerMember, setCreateContributionPerMember] = useState<number>(0)
  const [createTokenType, setCreateTokenType] = useState<string>('')
  const [createCycleLength, setCreateCycleLength] = useState<string>('Monthly')
  const [createTimeZone, setCreateTimeZone] = useState<string>(() => detectUserTimeZone())
  const [createWindowStart, setCreateWindowStart] = useState<string>(() => {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString()
  })
  const [createWindowEnd, setCreateWindowEnd] = useState<string>(() => {
    const now = new Date()
    const startIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString()
    try {
      return calculateDaylightSavingAwareCycleEnd(startIso, 'Monthly', detectUserTimeZone())
    } catch {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString()
    }
  })
  const [createMembers, setCreateMembers] = useState<Member[]>([])
  const [createProposedCircleId, setCreateProposedCircleId] = useState<string>('')
  const [createPoolAddress, setCreatePoolAddress] = useState<string>('')
  const [createCircleRules, setCreateCircleRules] = useState<string>('')

  // User-configured Circle Details (Active Circle displayed on Dashboard)
  const [circleId, setCircleId] = useState<string>(() => getSavedCircleId())
  useEffect(() => {
    if (!circleId || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(ACTIVE_CIRCLE_STORAGE_KEY, circleId)
    } catch {
      // Continue without same-browser circle recovery if storage is unavailable.
    }
  }, [circleId])
  const [circleName, setCircleName] = useState<string>('')
  const [contributionPerMember, setContributionPerMember] = useState<number>(0)
  const [tokenType, setTokenType] = useState<string>('')
  const [poolAddress, setPoolAddress] = useState<string>('')
  const [timeZone, setTimeZone] = useState<string>(() => detectUserTimeZone())
  const [cycleLength, setCycleLength] = useState<string>('Monthly')
  const [windowStart, setWindowStart] = useState<string>(() => {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString()
  })
  const [windowEnd, setWindowEnd] = useState<string>(() => {
    const now = new Date()
    const startIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString()
    try {
      return calculateDaylightSavingAwareCycleEnd(startIso, 'Monthly', detectUserTimeZone())
    } catch {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString()
    }
  })
  const [circleRules, setCircleRules] = useState<string>('')

  // Active Circle Members list (starts empty — populated from registered server circle)
  const [members, setMembers] = useState<Member[]>([])

  // Ensure any legacy saved circle draft is wiped on load
  useEffect(() => {
    clearSavedCircleDraft()
  }, [])
  const [newMemberName, setNewMemberName] = useState('')
  const [newMemberAddress, setNewMemberAddress] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [isDeployingVault, setIsDeployingVault] = useState(false)
  const [isActivatingCircle, setIsActivatingCircle] = useState(false)
  const [circleActivationNotice, setCircleActivationNotice] = useState<{
    state: 'saving' | 'saved' | 'error'
    message: string
    blobId?: string
  } | null>(null)

  // Auto-dismiss Walrus save toast notice after 7 seconds
  useEffect(() => {
    if (circleActivationNotice?.state === 'saved') {
      const timer = setTimeout(() => {
        setCircleActivationNotice(null)
      }, 7000)
      return () => clearTimeout(timer)
    }
  }, [circleActivationNotice])

  // Verification state store per member: `${member.id}_${cycle}` -> ExtendedVerificationResult
  const [verifications, setVerifications] = useState<Record<string, ExtendedVerificationResult>>({})
  const [verifyingMemberId, setVerifyingMemberId] = useState<string | null>(null)

  // Walrus Memory store records (starts empty — only real records from Walrus)
  const [memoriesList, setMemoriesList] = useState<MemoryRecord[]>([])
  const [isMemoryLoading, setIsMemoryLoading] = useState<boolean>(false)
  const [isMemoryWriting, setIsMemoryWriting] = useState<boolean>(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [restoreOutcome, setRestoreOutcome] = useState<WalrusRestoreOutcome | null>(null)
  const [lookupCircleSlug, setLookupCircleSlug] = useState<string>(() => getSavedCircleId())

  // Manual Memory Proposal form in Memory tab
  const [manualCategory, setManualCategory] = useState<MemoryCategory>('Agreements')
  const [manualTitle, setManualTitle] = useState<string>('')
  const [manualQuote, setManualQuote] = useState<string>('')
  const [manualRule, setManualRule] = useState<string>('')
  const [manualMemberId, setManualMemberId] = useState<string>('')
  const [confirmingMemberId, setConfirmingMemberId] = useState<string>('')

  // Chat state (starts empty — no fake initial chat messages)
  const [chatInput, setChatInput] = useState('')
  const [isChatTyping, setIsChatTyping] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])

  // Sui dApp Kit hooks & wallet connection state
  const dAppKit = useDAppKit()
  const currentAccount = useCurrentAccount()
  const currentWallet = useCurrentWallet()
  const currentNetwork = useCurrentNetwork()
  const detectedWallets = useWallets()
  const connectedMember = currentAccount?.address
    ? members.find(
        (member) =>
          normalizeSuiAddress(member.address) === normalizeSuiAddress(currentAccount.address),
      ) || null
    : null
  const poolAddressMember = poolAddress.trim()
    ? members.find(
        (member) => normalizeSuiAddress(member.address) === normalizeSuiAddress(poolAddress),
      ) || null
    : null
  const authAttemptRef = useRef(0)
  const connectedAddressRef = useRef<string | null>(currentAccount?.address || null)
  connectedAddressRef.current = currentAccount?.address || null
  const [showWalletModal, setShowWalletModal] = useState<boolean>(false)
  const [showAccountDropdown, setShowAccountDropdown] = useState<boolean>(false)
  const accountDropdownRef = useRef<HTMLDivElement | null>(null)

  // Close wallet account dropdown on click outside
  useEffect(() => {
    if (!showAccountDropdown) return
    const handleClickOutside = (e: MouseEvent) => {
      if (accountDropdownRef.current && !accountDropdownRef.current.contains(e.target as Node)) {
        setShowAccountDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showAccountDropdown])

  // Active proposed memory awaiting member confirmation
  const [proposedMemory, setProposedMemory] = useState<ProposedMemory | null>(null)
  const [activeProposalChallenge, setActiveProposalChallenge] =
    useState<ConfirmationChallengeResponse | null>(null)
  const [circleProposals, setCircleProposals] = useState<ProposedMemory[]>([])
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({})
  const [notifications, setNotifications] = useState<CircleNotification[]>([])
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState<number>(0)
  const [showNotificationsDropdown, setShowNotificationsDropdown] = useState<boolean>(false)
  const notificationsDropdownRef = useRef<HTMLDivElement | null>(null)

  // Wallet authentication state (authenticated Sui address and session)
  const [authenticatedWallet, setAuthenticatedWallet] = useState<string | null>(null)
  const [walletAuthError, setWalletAuthError] = useState<string | null>(null)
  const [isWalletAuthBusy, setIsWalletAuthBusy] = useState<boolean>(false)

  // Keep confirming member strictly bound to connected wallet (prevents impersonation)
  useEffect(() => {
    setConfirmingMemberId(connectedMember?.id || '')
  }, [connectedMember?.id])

  // Payout recommendation state
  const [payoutRec, setPayoutRec] = useState<any>(null)
  const [payoutError, setPayoutError] = useState<string | null>(null)
  const [isPayoutLoading, setIsPayoutLoading] = useState<boolean>(false)

  // Ajo On-chain Move Circle state, token selection, and overview
  const [ajoConfig, setAjoConfig] = useState<AjoConfigResponse | null>(null)
  const [onchainState, setOnchainState] = useState<OnchainCircleState | null>(null)
  const [isOnchainLoading, setIsOnchainLoading] = useState<boolean>(false)
  const [availableCircles, setAvailableCircles] = useState<any[]>([])
  const [selectedTokenSymbol, setSelectedTokenSymbol] = useState<'SUI' | 'USDC'>('SUI')

  // Detect whether active circle is configured with WAL or an unsupported token
  const isUnsupportedCircleToken = useMemo(() => {
    const tt = (tokenType || '').toLowerCase().trim()
    return tt.includes('wal') || tt.endsWith('::wal::wal')
  }, [tokenType])

  const isMatchingVault = Boolean(
    onchainState?.found &&
      poolAddress &&
      normalizeSuiAddress(onchainState.objectId) === normalizeSuiAddress(poolAddress),
  )

  const isVaultCompleted = Boolean(isMatchingVault && onchainState?.status === 3)

  const isVaultMismatched = Boolean(
    isMatchingVault &&
      onchainState?.name &&
      circleName &&
      onchainState.name.trim().toLowerCase() !== circleName.trim().toLowerCase(),
  )

  const isMoveCircleVault = Boolean(
    ajoConfig?.packageConfigured &&
      ajoConfig?.packageId &&
      isMatchingVault &&
      onchainState?.type?.includes('::circle::Circle<'),
  )

  // Track claimed cycles for this circle
  const [claimedCycles, setClaimedCycles] = useState<Record<number, ClaimRecord>>(() =>
    getClaimedCyclesForCircle(circleId)
  )

  // Authoritative scheduled recipient resolution:
  // 1. Follows the on-chain Move circle payoutOrder vector when deployed
  // 2. Fallback: ensures members who claimed in prior cycles are never scheduled again
  const scheduledRecipient = useMemo(() => {
    if (isMatchingVault && onchainState?.found && Array.isArray(onchainState.payoutOrder) && onchainState.payoutOrder.length > 0) {
      const orderIdx = (selectedCycle - 1) % onchainState.payoutOrder.length
      const targetAddress = onchainState.payoutOrder[orderIdx]
      if (targetAddress) {
        const found = members.find((m) => normalizeSuiAddress(m.address) === normalizeSuiAddress(targetAddress))
        if (found) return found
        return {
          id: `onchain_${targetAddress.slice(0, 8)}`,
          name: targetAddress.slice(0, 6) + '...' + targetAddress.slice(-4),
          address: targetAddress,
          avatarColor: 'bg-utility-brand-50 text-utility-brand-700',
        }
      }
    }

    if (members.length === 0) return null
    if (members.length === 1) return members[0]

    const claimedAddresses = new Set<string>()
    for (let c = 1; c < selectedCycle; c++) {
      if (claimedCycles[c]?.recipientAddress) {
        claimedAddresses.add(normalizeSuiAddress(claimedCycles[c].recipientAddress))
      } else if (isMatchingVault && onchainState?.payoutOrder && onchainState.payoutOrder[c - 1]) {
        claimedAddresses.add(normalizeSuiAddress(onchainState.payoutOrder[c - 1]))
      } else {
        const prevMember = members[(c - 1) % members.length]
        if (prevMember) claimedAddresses.add(normalizeSuiAddress(prevMember.address))
      }
    }

    const candidate = members[(selectedCycle - 1) % members.length]
    if (candidate && !claimedAddresses.has(normalizeSuiAddress(candidate.address))) {
      return candidate
    }

    const unclaimed = members.find((m) => !claimedAddresses.has(normalizeSuiAddress(m.address)))
    return unclaimed || candidate || members[0]
  }, [isMatchingVault, onchainState, selectedCycle, members, claimedCycles])

  useEffect(() => {
    if (circleId) {
      setClaimedCycles(getClaimedCyclesForCircle(circleId))
      setPayoutRec(null)
      setPayoutError(null)
      if (!poolAddress) {
        setOnchainState(null)
      }
    }
  }, [circleId, poolAddress])

  const isCycleClaimed = useCallback(
    (cycleNum: number): boolean => {
      if (isMatchingVault) {
        // 1. If circle status is 3 (STATUS_COMPLETED), all cycles in the circle have been claimed
        if (onchainState?.status === 3) return true
        // 2. In Move, current_cycle only increments after the current cycle pot is fully claimed.
        // So any cycle number strictly less than onchain currentCycle has already been claimed!
        if (onchainState?.currentCycle && cycleNum < onchainState.currentCycle) return true
      }
      // 3. Check client-persisted claim records
      if (claimedCycles[cycleNum]) return true
      return false
    },
    [isMatchingVault, onchainState, claimedCycles]
  )

  const claimedMemberIds = useMemo(() => {
    const claimedSet = new Set<string>()
    members.forEach((m, idx) => {
      const cycleNum = idx + 1
      if (isCycleClaimed(cycleNum)) {
        claimedSet.add(m.id)
      }
    })
    return Array.from(claimedSet)
  }, [members, isCycleClaimed])

  const actualVaultBalance = useMemo(() => {
    if (!isMatchingVault || !onchainState?.vaultBalance) return 0
    const tok = findTokenByCoinType(tokenType, explorerNetwork) || findTokenBySymbol('SUI', explorerNetwork)
    const decimals = tok?.decimals || 9
    try {
      return toDisplayUnits(onchainState.vaultBalance, decimals)
    } catch {
      return 0
    }
  }, [isMatchingVault, onchainState?.vaultBalance, tokenType, explorerNetwork])

  // Transaction Review & Signing Modal State
  const [txModal, setTxModal] = useState<{
    isOpen: boolean
    actionTitle: string
    actionDescription: string
    destinationObjectId?: string
    token: TokenConfig | null
    amountDisplay?: string
    amountBase?: bigint | string | number
    currentCycle?: number
    totalCycles?: number
    recipientAddress?: string
    recipientName?: string
    senderAddress?: string
    walletBalanceDisplay?: string
    isBalanceInsufficient?: boolean
    balanceErrorMessage?: string | null
    isSubmitting: boolean
    isSuccess: boolean
    verificationPending?: boolean
    verificationNotes?: string | null
    isVerifying?: boolean
    txDigest?: string | null
    errorMessage?: string | null
    isMoveVault?: boolean
    allowSplitPayment?: boolean
    maxAmount?: number
    selectedAmount?: number
    onSelectedAmountChange?: (amount: number) => void
    onConfirm: () => Promise<void>
    onRetryVerification?: () => Promise<void>
  }>({
    isOpen: false,
    actionTitle: '',
    actionDescription: '',
    token: null,
    isSubmitting: false,
    isSuccess: false,
    verificationPending: false,
    verificationNotes: null,
    isVerifying: false,
    onConfirm: async () => {},
  })

  // Group Report Modal State (open & free, no x402)
  const [groupReport, setGroupReport] = useState<GroupReportResponse | null>(null)
  const [isGeneratingReport, setIsGeneratingReport] = useState<boolean>(false)
  const [showReportModal, setShowReportModal] = useState<boolean>(false)

  // Check backend service statuses on boot
  const refreshServiceStatuses = useCallback(async () => {
    try {
      const [cfgSettled, suiSettled, memSettled, stewSettled] = await Promise.allSettled([
        fetch('/api/config/status').then((r) => r.json()),
        chainVerifier.checkRpcStatus(),
        memoryStore.checkHealth(),
        steward.checkStatus(),
      ])

      if (suiSettled.status === 'fulfilled' && suiSettled.value) {
        setRpcStatus({ ...suiSettled.value, loading: false })
      } else {
        setRpcStatus((prev) => ({ ...prev, loading: false }))
      }

      if (memSettled.status === 'fulfilled' && memSettled.value) {
        setMemwalHealth(memSettled.value)
      }

      if (stewSettled.status === 'fulfilled' && stewSettled.value) {
        setStewardStatus(stewSettled.value)
      }

      if (
        cfgSettled.status === 'fulfilled' &&
        cfgSettled.value?.integrations?.tatum?.tokenType &&
        !tokenType
      ) {
        setTokenType(cfgSettled.value.integrations.tatum.tokenType)
      }
    } catch {
      setRpcStatus((prev) => ({ ...prev, loading: false }))
    }
  }, [tokenType])

  const refreshOnchainCircle = useCallback(
    async (targetPoolAddress?: string) => {
      const pool = targetPoolAddress || poolAddress
      if (!pool || !pool.startsWith('0x')) return
      setIsOnchainLoading(true)
      try {
        const state = await fetchOnchainCircle(pool)
        setOnchainState(state)
        if (state.found) {
          if (state.currentCycle) setSelectedCycle(state.currentCycle)
          if (state.cycleDeadlineMs && state.cycleDeadlineMs > 0) {
            setWindowEnd(new Date(state.cycleDeadlineMs).toISOString())
          }
          if (state.name && !circleName) setCircleName(state.name)
          if (state.coinType && !tokenType) setTokenType(state.coinType)
        }
      } catch (err: any) {
        console.warn('On-chain circle refresh note:', err.message)
      } finally {
        setIsOnchainLoading(false)
      }
    },
    [poolAddress, circleName, tokenType]
  )

  const refreshAjoConfigAndCircles = useCallback(async () => {
    try {
      const [cfg, overviewCircles, walrusCircles] = await Promise.all([
        fetchAjoConfig().catch(() => null),
        fetchCirclesOverview().catch(() => []),
        authenticatedWallet ? memoryStore.listCircles().catch(() => []) : Promise.resolve([]),
      ])
      if (cfg) setAjoConfig(cfg)
      const map = new Map<string, any>()
      for (const c of overviewCircles || []) {
        if (c.circleId) map.set(c.circleId, c)
      }
      for (const c of walrusCircles || []) {
        if (c.circleId) map.set(c.circleId, { ...map.get(c.circleId), ...c })
      }
      const combined = Array.from(map.values())
      setAvailableCircles(combined)
    } catch (err) {
      console.warn('Config / overview refresh note:', err)
    }
  }, [authenticatedWallet])

  useEffect(() => {
    refreshAjoConfigAndCircles()
  }, [refreshAjoConfigAndCircles])

  useEffect(() => {
    if (poolAddress) {
      refreshOnchainCircle(poolAddress)
    }
  }, [poolAddress, refreshOnchainCircle])

  // Proactively verify and synchronize on-chain Circle vault state when switching to Dashboard
  useEffect(() => {
    if (activeTab === 'dashboard' && poolAddress) {
      if (
        !onchainState ||
        !onchainState.found ||
        !onchainState.type ||
        normalizeSuiAddress(onchainState.objectId) !== normalizeSuiAddress(poolAddress)
      ) {
        void refreshOnchainCircle(poolAddress)
      }
    }
  }, [activeTab, poolAddress, onchainState, refreshOnchainCircle])

  // Poll service health on mount and periodically every 20 seconds
  useEffect(() => {
    refreshServiceStatuses()
    const timer = setInterval(() => {
      refreshServiceStatuses()
    }, 20000)
    return () => clearInterval(timer)
  }, [refreshServiceStatuses])

  useEffect(() => {
    if (!authenticatedWallet) return
    let cancelled = false
    const loadOrRestoreActiveCircle = async () => {
      try {
        const circles = await memoryStore.listCircles()
        const savedCircleId = getSavedCircleId()
        let latest = null
        if (savedCircleId) {
          latest = circles.find((c) => c.circleId === savedCircleId) || null
        }
        if (!latest && circles.length > 0) {
          latest = circles[circles.length - 1]
        }
        if (!latest) {
          if (!savedCircleId) return
          memoryStore.setCircleId(savedCircleId)
          // Do not automatically restore stale state from Walrus on restart/refresh
          return
        }

        if (cancelled || !latest) return

        setCircleId(latest.circleId)
        setLookupCircleSlug(latest.circleId)
        setCircleName(latest.circleName)
        setPoolAddress(latest.poolAddress)
        setContributionPerMember(latest.contributionPerMember)
        if (latest.tokenType) setTokenType(latest.tokenType)
        setCycleLength(latest.cycleLength || 'Monthly')
        if (latest.timeZone) setTimeZone(latest.timeZone)
        if (latest.windowStart) setWindowStart(latest.windowStart)
        if (latest.windowEnd) setWindowEnd(latest.windowEnd)
        setCircleRules(latest.circleRules || '')
        setSelectedCycle(latest.currentCycle || 1)
        setMembers(latest.members || [])
        if (latest.members?.[0]?.id) setConfirmingMemberId(latest.members[0].id)
        memoryStore.setCircleId(latest.circleId)
        if (latest.poolAddress) {
          refreshOnchainCircle(latest.poolAddress)
        }
      } catch (error: any) {
        if (!cancelled) setMemoryError(error.message || 'Failed to restore the active circle from Walrus.')
      }
    }
    void loadOrRestoreActiveCircle()
    return () => { cancelled = true }
  }, [authenticatedWallet, refreshOnchainCircle])

  // Refresh memories from Walrus when circleId is active
  const refreshMemories = useCallback(async (targetCircleId?: string) => {
    const cid = (targetCircleId ?? circleId).trim()
    if (!cid) return
    setIsMemoryLoading(true)
    setMemoryError(null)
    try {
      memoryStore.setCircleId(cid)
      const [records, proposals, notifData] = await Promise.all([
        memoryStore.list(),
        memoryStore.listProposals(cid).catch(() => []),
        fetchNotifications(cid).catch(() => ({ notifications: [], unreadCount: 0 })),
      ])
      setMemoriesList(records)
      setCircleProposals(proposals)
      setNotifications(notifData.notifications)
      setUnreadNotificationsCount(notifData.unreadCount)
    } catch (err: any) {
      setMemoryError(err.message || 'Failed to recall memories from Walrus')
    } finally {
      setIsMemoryLoading(false)
    }
  }, [circleId])

  const isConnectedOrganizer = useMemo(() => {
    if (!currentAccount?.address || members.length === 0) return false
    return normalizeSuiAddress(currentAccount.address) === normalizeSuiAddress(members[0].address)
  }, [currentAccount?.address, members])

  const refreshNotificationsOnly = useCallback(async () => {
    if (!authenticatedWallet) return
    const data = await fetchNotifications(circleId || undefined).catch(() => ({
      notifications: [],
      unreadCount: 0,
    }))
    setNotifications(data.notifications)
    setUnreadNotificationsCount(data.unreadCount)
    if (circleId) {
      const props = await memoryStore.listProposals(circleId).catch(() => [])
      setCircleProposals(props)
    }
  }, [authenticatedWallet, circleId])

  useEffect(() => {
    if (!authenticatedWallet) return
    void refreshNotificationsOnly()
    const timer = setInterval(() => {
      void refreshNotificationsOnly()
    }, 15000)
    return () => clearInterval(timer)
  }, [authenticatedWallet, refreshNotificationsOnly])

  useEffect(() => {
    if (circleId && memwalHealth.configured && authenticatedWallet) {
      refreshMemories(circleId)
    }
  }, [circleId, memwalHealth.configured, authenticatedWallet, refreshMemories])

  // Refresh server-side verified contributions and locally stored submitted digests
  const refreshCircleVerifications = useCallback(
    async (targetCircleId?: string, targetCycle?: number) => {
      const cid = (targetCircleId ?? circleId).trim()
      const cyc = targetCycle ?? selectedCycle
      if (!cid || !authenticatedWallet) return

      try {
        let serverResults: Record<string, ExtendedVerificationResult> = {}
        try {
          serverResults = await chainVerifier.getCircleVerifications(cid, cyc, poolAddress)
        } catch (getErr: any) {
          if (getErr?.message?.includes('not registered') && poolAddress && members.length > 0) {
            await memoryStore.registerCircle({
              circleId: cid,
              circleName: circleName || cid,
              poolAddress,
              contributionPerMember,
              tokenType,
              cycleLength: cycleLength || 'Daily',
              currentCycle: cyc,
              members,
              timeZone,
              windowStart,
              windowEnd,
            })
            serverResults = await chainVerifier.getCircleVerifications(cid, cyc, poolAddress).catch(() => ({}))
          }
        }
        const merged: Record<string, ExtendedVerificationResult> = { ...serverResults }

        // Also check if client has any locally recorded digests that haven't been verified on server
        for (const m of members) {
          const recKey = `${m.id}_${cyc}`
          if (!merged[recKey] || merged[recKey].status !== 'Verified') {
            const localDigests = getClientSubmittedDigests(cid, cyc, m.address)
            if (localDigests.length > 0) {
              try {
                const res = await chainVerifier.verifyContribution({
                  circleId: cid,
                  poolAddress,
                  memberAddress: m.address,
                  memberId: m.id,
                  memberName: m.name,
                  token: tokenType || '0x2::sui::SUI',
                  expectedAmount: contributionPerMember || 1,
                  windowStart,
                  windowEnd,
                  cycle: cyc,
                  txDigests: localDigests,
                  withMemory,
                })
                merged[recKey] = res
              } catch {
                // Keep existing verification state on error
              }
            }
          }
        }

        // Recover payments from the connected member directly from Tatum when
        // a successful wallet transaction lost its digest before local storage.
        const connectedRosterMember = members.find(
          (member) => normalizeSuiAddress(member.address) === normalizeSuiAddress(authenticatedWallet || '')
        )
        if (connectedRosterMember) {
          const recKey = `${connectedRosterMember.id}_${cyc}`
          const existing = merged[recKey]
          if (!existing || (existing.status !== 'Verified' && existing.status !== 'Late' && existing.status !== 'WrongAmount')) {
            const discovered = await chainVerifier.discoverContribution({
              circleId: cid,
              cycle: cyc,
              windowStart,
              windowEnd,
            })
            if (discovered && (discovered.status === 'Verified' || discovered.status === 'Late')) {
              merged[recKey] = discovered
              if (Array.isArray(discovered.txDigests)) {
                for (const d of discovered.txDigests) {
                  saveClientSubmittedDigest(cid, cyc, connectedRosterMember.address, d)
                }
              }
            }
          }
        }

        setVerifications(merged)
      } catch (err: any) {
        console.warn('Failed to refresh circle verifications:', err.message)
      }
    },
    [circleId, selectedCycle, authenticatedWallet, members, poolAddress, tokenType, contributionPerMember, windowStart, windowEnd, withMemory]
  )

  // Reset verifications whenever circleId changes so prior circle payments never leak into new circles
  useEffect(() => {
    setVerifications({})
  }, [circleId])

  useEffect(() => {
    if (circleId && authenticatedWallet) {
      refreshCircleVerifications(circleId, selectedCycle)
    }
  }, [circleId, selectedCycle, authenticatedWallet, refreshCircleVerifications])

  // Re-evaluate group policy whenever `withMemory` or `memoriesList` changes,
  // preserving the underlying chain status (`Late` remains `Late` as a chain fact).
  useEffect(() => {
    if (members.length === 0 || !circleId || !authenticatedWallet) return
    let cancelled = false
    const updatePolicies = async () => {
      const updated = { ...verifications }
      let changed = false
      for (const m of members) {
        const key = `${m.id}_${selectedCycle}`
        const existing = updated[key]
        if (!existing) continue
        try {
          const policy = await chainVerifier.evaluatePolicy({
            circleId,
            cycle: selectedCycle,
            withMemory,
            windowEnd,
            memberId: m.id,
            memberAddress: m.address,
          })
          updated[key] = { ...existing, policy }
          changed = true
        } catch {
          // Keep existing policy evaluation if offline
        }
      }
      if (!cancelled && changed) {
        setVerifications(updated)
      }
    }
    updatePolicies()
    return () => {
      cancelled = true
    }
  }, [withMemory, memoriesList, selectedCycle, windowEnd, circleId, authenticatedWallet])

  // Load payout recommendations when Payout tab is opened
  useEffect(() => {
    if (activeTab !== 'payout' || members.length === 0) return
    let cancelled = false
    const runRec = async () => {
      setIsPayoutLoading(true)
      setPayoutError(null)
      try {
        const rec = await steward.generatePayoutRecommendation(
          selectedCycle,
          members,
          verifications,
          memoriesList,
          withMemory,
          { circleId, windowEnd, claimedMemberIds }
        )
        if (!cancelled) setPayoutRec(rec)
      } catch (err: any) {
        if (!cancelled) {
          setPayoutRec(null)
          setPayoutError(err.message || 'Steward LLM payout recommendation is unavailable.')
        }
      } finally {
        if (!cancelled) setIsPayoutLoading(false)
      }
    }
    runRec()
    return () => {
      cancelled = true
    }
  }, [activeTab, selectedCycle, members, verifications, memoriesList, withMemory, circleId, windowEnd, claimedMemberIds])

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard?.writeText(text)
    setCopiedText(id)
    setTimeout(() => setCopiedText(null), 2000)
  }

  // Authenticate session with server by signing a single-use challenge via connected Sui wallet
  const handleAuthenticateWithWallet = useCallback(async (addressToAuth?: string) => {
    const addr = addressToAuth || currentAccount?.address
    if (!addr) {
      setShowWalletModal(true)
      return
    }
    const authAttempt = ++authAttemptRef.current
    setIsWalletAuthBusy(true)
    setWalletAuthError(null)
    try {
      const challenge = await requestWalletAuthChallenge(addr)
      if (
        authAttempt !== authAttemptRef.current ||
        !connectedAddressRef.current ||
        normalizeSuiAddress(connectedAddressRef.current) !== normalizeSuiAddress(addr)
      ) {
        return
      }
      const { signature } = await dAppKit.signPersonalMessage({
        message: new TextEncoder().encode(challenge.message),
      })
      if (
        authAttempt !== authAttemptRef.current ||
        !connectedAddressRef.current ||
        normalizeSuiAddress(connectedAddressRef.current) !== normalizeSuiAddress(addr)
      ) {
        return
      }
      const session = await submitWalletAuthSignature({
        challengeId: challenge.challengeId,
        address: addr,
        signature,
      })
      if (
        authAttempt !== authAttemptRef.current ||
        !connectedAddressRef.current ||
        normalizeSuiAddress(connectedAddressRef.current) !== normalizeSuiAddress(addr)
      ) {
        await logoutWalletSession()
        return
      }
      setAuthenticatedWallet(session.walletAddress)
      setWalletAuthError(null)
    } catch (err: any) {
      console.error('Wallet authentication error:', err)
      if (err?.message?.includes('reject') || err?.message?.includes('User rejected')) {
        setWalletAuthError('Signature request rejected in wallet.')
      } else {
        setWalletAuthError(err.message || 'Wallet authentication failed')
      }
    } finally {
      setIsWalletAuthBusy(false)
    }
  }, [currentAccount?.address, dAppKit])

  // Connect a selected Sui wallet from dApp Kit
  const handleSelectWallet = async (wallet: any) => {
    try {
      setIsWalletAuthBusy(true)
      setWalletAuthError(null)
      await dAppKit.connectWallet({ wallet })
      setShowWalletModal(false)
    } catch (err: any) {
      console.error('Wallet connect error:', err)
      setWalletAuthError(err.message || 'Failed to connect wallet')
    } finally {
      setIsWalletAuthBusy(false)
    }
  }

  const handleSwitchAccount = (account: { address: string }) => {
    if (!currentWallet || account.address === currentAccount?.address) return
    // Invalidate an in-flight challenge for the previous account before switching.
    authAttemptRef.current += 1
    try {
      dAppKit.switchAccount({ account: account as any })
      setAuthenticatedWallet(null)
      setShowAccountDropdown(false)
      setWalletAuthError(null)
    } catch (err: any) {
      setWalletAuthError(err?.message || 'Could not switch the active wallet account.')
    }
  }

  // Disconnect connected wallet and revoke server session
  const handleDisconnectWallet = async () => {
    try {
      await dAppKit.disconnectWallet()
    } catch (err) {
      console.error('Disconnect error:', err)
    }
    await logoutWalletSession()
    setAuthenticatedWallet(null)
    setShowAccountDropdown(false)
  }

  // Open transaction review modal for member contribution (supports late contributions)
  const selectedContributionAmountRef = useRef<number>(0)

  const handleOpenContributeModal = async (targetAddress: string, owedAmount: number) => {
    if (isUnsupportedCircleToken || tokenType.toLowerCase().includes('wal')) {
      setWalletAuthError(
        'WAL is no longer supported as a contribution token. This circle can no longer accept new WAL contributions.'
      )
      return
    }
    if (!currentAccount) {
      setShowWalletModal(true)
      return
    }
    if (
      normalizeSuiAddress(currentAccount.address) !== normalizeSuiAddress(targetAddress) ||
      !connectedMember ||
      normalizeSuiAddress(authenticatedWallet || '') !== normalizeSuiAddress(currentAccount.address)
    ) {
      setWalletAuthError(
        'The connected and authenticated wallet must match the selected circle member before contributing.',
      )
      return
    }
    if (poolAddressMember) {
      setWalletAuthError(
        `The configured pool address belongs to ${poolAddressMember.name}. A member sending tokens to their own wallet is a self-transfer and does not fund a separate pool. Set a dedicated vault address first.`,
      )
      return
    }

    // Overpayment prevention: block duplicate contributions for the same cycle
    const existingRaw = verifications[`${connectedMember.id}_${selectedCycle}`]
    const isMoveVaultUnderfunded = Boolean(
      isMoveCircleVault && actualVaultBalance < potPerCycle && potPerCycle > 0
    )
    const alreadyPaid = existingRaw && (
      (existingRaw.status === 'Verified' || existingRaw.status === 'Late') &&
      ((existingRaw.amountReceived ?? 0) >= contributionPerMember || Boolean(existingRaw.policy?.countsTowardPot))
    )
    // Only block if already paid AND the Move vault is not underfunded (allowing members to fund contract vault if uncredited)
    if (alreadyPaid && !isMoveVaultUnderfunded) {
      setWalletAuthError(
        `You have already contributed for Cycle ${selectedCycle}. Additional contributions are blocked to prevent overpaying.`
      )
      return
    }

    const hasRealPendingDigest = Boolean(
      existingRaw?.status === 'Pending' &&
      (existingRaw?.txDigest || (existingRaw?.txDigests && existingRaw.txDigests.length > 0) || existingRaw?.code === 'indexing_pending')
    )
    if (hasRealPendingDigest) {
      setWalletAuthError(
        `A contribution transaction is currently pending verification for Cycle ${selectedCycle}. Please wait for verification to complete before attempting another contribution.`
      )
      return
    }

    // Cycle window start check: block contributing before the cycle window starts
    const startMs = Date.parse(windowStart)
    if (Number.isFinite(startMs) && Date.now() < startMs - 60000) {
      setWalletAuthError(
        `Cycle ${selectedCycle} has not started yet. Contributions open at ${formatLocalDateTimeWithZone(windowStart, timeZone, 'short')}.`
      )
      return
    }

    const token = findTokenByCoinType(tokenType, explorerNetwork) || findTokenBySymbol('SUI', explorerNetwork)
    const decimals = token?.decimals || 9
    const amountBase = toBaseUnits(owedAmount, decimals)
    const onchainDeadlineMs =
      isMatchingVault && onchainState?.cycleDeadlineMs && onchainState.cycleDeadlineMs > 0
        ? onchainState.cycleDeadlineMs
        : windowEnd
        ? Date.parse(windowEnd)
        : 0
    const isPastDeadline = onchainDeadlineMs > 0 && Date.now() > onchainDeadlineMs

    // Pre-flight wallet balance check for the configured token and network gas
    let preflightBalance: BalanceCheckResult = {
      hasSufficientBalance: true,
      heldBase: 0n,
      requiredBase: amountBase,
      heldDisplay: 'Checking...',
      requiredDisplay: `${owedAmount} ${token?.symbol || 'SUI'}`,
      selectedCoinObjectIds: [],
    }

    try {
      preflightBalance = await verifyWalletBalance({
        network: explorerNetwork,
        ownerAddress: currentAccount.address,
        coinType: token?.coinType || '0x2::sui::SUI',
        requiredAmountBase: amountBase,
        decimals,
        symbol: token?.symbol || 'SUI',
      })
    } catch (checkErr: any) {
      console.warn('Pre-flight balance check note:', checkErr.message)
    }

    // Ensure fresh on-chain Circle state is verified so the modal displays the Move vault disclosure accurately
    let activeOnchainForModal = onchainState
    if (
      poolAddress &&
      (!activeOnchainForModal ||
        !activeOnchainForModal.found ||
        !activeOnchainForModal.type ||
        normalizeSuiAddress(activeOnchainForModal.objectId) !== normalizeSuiAddress(poolAddress))
    ) {
      try {
        const fresh = await fetchOnchainCircle(poolAddress)
        if (fresh && fresh.found) {
          activeOnchainForModal = fresh
          setOnchainState(fresh)
        }
      } catch (err: any) {
        console.warn('Could not pre-fetch on-chain circle for modal:', err.message)
      }
    }

    const modalIsMoveVault = Boolean(
      ajoConfig?.packageConfigured &&
        ajoConfig?.packageId &&
        activeOnchainForModal?.found &&
        activeOnchainForModal?.type?.includes('::circle::Circle<') &&
        normalizeSuiAddress(activeOnchainForModal.objectId) === normalizeSuiAddress(poolAddress)
    )

    selectedContributionAmountRef.current = owedAmount

    setTxModal({
      isOpen: true,
      actionTitle: isPastDeadline ? 'Deposit Late Contribution' : 'Deposit Cycle Contribution',
      actionDescription: `Deposit ${owedAmount} ${token?.symbol || 'SUI'} directly into circle vault (${poolAddress ? poolAddress.slice(0, 10) + '...' : ''})`,
      destinationObjectId: poolAddress,
      token,
      amountDisplay: `${owedAmount} ${token?.symbol || 'SUI'}`,
      amountBase,
      currentCycle: selectedCycle,
      totalCycles: members.length,
      recipientAddress: scheduledRecipient?.address,
      recipientName: scheduledRecipient?.name,
      senderAddress: currentAccount.address,
      walletBalanceDisplay: preflightBalance.heldDisplay,
      isBalanceInsufficient: !preflightBalance.hasSufficientBalance,
      balanceErrorMessage: preflightBalance.errorMessage,
      isSubmitting: false,
      isSuccess: false,
      txDigest: null,
      errorMessage: null,
      isMoveVault: modalIsMoveVault,
      allowSplitPayment: modalIsMoveVault,
      maxAmount: owedAmount,
      selectedAmount: owedAmount,
      onSelectedAmountChange: (nextAmount: number) => {
        selectedContributionAmountRef.current = nextAmount
        const safeAmount = nextAmount > 0 ? nextAmount : 0
        const nextBase = toBaseUnits(safeAmount, decimals)
        const symbolLabel = token?.symbol || 'SUI'
        const gasReserve = symbolLabel === 'SUI' ? 10_000_000n : 0n
        const insufficient =
          safeAmount > 0 && preflightBalance.heldBase < nextBase + gasReserve
        setTxModal((prev) => ({
          ...prev,
          selectedAmount: nextAmount,
          amountBase: nextBase,
          amountDisplay: `${safeAmount} ${symbolLabel}`,
          actionDescription: `Deposit ${safeAmount} ${symbolLabel} directly into circle vault (${poolAddress ? poolAddress.slice(0, 10) + '...' : ''})`,
          isBalanceInsufficient: insufficient,
          balanceErrorMessage: insufficient
            ? `Your connected wallet holds ${preflightBalance.heldDisplay}, which is insufficient for ${safeAmount} ${symbolLabel}${symbolLabel === 'SUI' ? ' plus gas' : ''}.`
            : null,
        }))
      },
      onConfirm: async () => {
        setTxModal((prev) => ({ ...prev, isSubmitting: true, errorMessage: null }))
        try {
          const signingAddress = connectedAddressRef.current
          if (
            !signingAddress ||
            normalizeSuiAddress(signingAddress) !== normalizeSuiAddress(targetAddress)
          ) {
            throw new Error(
              'The active wallet changed after this contribution was prepared. Close this dialog and review the transaction again.',
            )
          }
          if (
            normalizeSuiAddress(targetAddress) === normalizeSuiAddress(poolAddress) ||
            members.some(
              (member) => normalizeSuiAddress(member.address) === normalizeSuiAddress(poolAddress),
            )
          ) {
            throw new Error(
              'This pool address belongs to a circle member. A self-transfer will not fund the pool. Update the circle to use a dedicated vault address before contributing.',
            )
          }
          const activeContributionAmount = modalIsMoveVault
            ? selectedContributionAmountRef.current
            : owedAmount
          if (
            !Number.isFinite(activeContributionAmount) ||
            activeContributionAmount <= 0 ||
            activeContributionAmount > owedAmount
          ) {
            throw new Error(
              `Enter a valid contribution tranche between 0 and ${owedAmount} ${token?.symbol || 'SUI'}.`
            )
          }
          const activeAmountBase = toBaseUnits(activeContributionAmount, decimals)

          // Re-verify balance and select fresh coin objects immediately before building
          const freshBalance = await verifyWalletBalance({
            network: explorerNetwork,
            ownerAddress: currentAccount.address,
            coinType: token?.coinType || '0x2::sui::SUI',
            requiredAmountBase: activeAmountBase,
            decimals,
            symbol: token?.symbol || 'SUI',
          })

          if (!freshBalance.hasSufficientBalance) {
            throw new Error(freshBalance.errorMessage || 'Insufficient balance to complete this contribution.')
          }

          // Always verify fresh on-chain Circle state before building contribution transaction
          let activeOnchain = onchainState
          if (
            !activeOnchain ||
            !activeOnchain.found ||
            !activeOnchain.type ||
            normalizeSuiAddress(activeOnchain.objectId) !== normalizeSuiAddress(poolAddress)
          ) {
            activeOnchain = await fetchOnchainCircle(poolAddress).catch(() => null)
            if (activeOnchain && activeOnchain.found) {
              setOnchainState(activeOnchain)
            }
          }

          // A circle contribution must ALWAYS execute as a Move shared-object call (ajo::circle::contribute)
          // so funds are locked into circle.vault: Balance<T> and recorded in cycle_contributions.
          const isMoveObject = Boolean(
            ajoConfig?.packageConfigured &&
            ajoConfig?.packageId &&
            activeOnchain?.found &&
            activeOnchain?.type?.includes('::circle::Circle<') &&
            normalizeSuiAddress(activeOnchain.objectId) === normalizeSuiAddress(poolAddress)
          )

          if (!isMoveObject) {
            throw new Error(
              `Cannot execute contribution: circle vault (${poolAddress ? poolAddress.slice(0, 8) + '...' + poolAddress.slice(-6) : 'unconfigured'}) is not verified as an active Ajo Move Circle object on-chain. Please ensure a dedicated Move vault is deployed.`
            )
          }

          const tx = buildContributeTx({
            packageId: ajoConfig!.packageId,
            circleObjectId: poolAddress,
            amountBase: activeAmountBase,
            coinType: token?.coinType || '0x2::sui::SUI',
            coinObjectIds: freshBalance.selectedCoinObjectIds,
            useAddressBalance: freshBalance.useAddressBalance,
          })

          const res = await dAppKit.signAndExecuteTransaction({ transaction: tx })
          const digest = getExecutedTransactionDigest(res)

          if (digest) {
            saveClientSubmittedDigest(circleId, selectedCycle, targetAddress, digest)
            void chainVerifier.submitDigest({
              circleId,
              cycle: selectedCycle,
              memberAddress: targetAddress,
              txDigest: digest,
            })
          }

          setTxModal((prev) => ({
            ...prev,
            isSubmitting: false,
            isSuccess: true,
            txDigest: digest,
            verificationPending: true,
            isVerifying: true,
            errorMessage: null,
          }))

          const contributingMember = members.find((m) => m.address.toLowerCase() === targetAddress.toLowerCase())
          const inputKey = contributingMember ? `${contributingMember.id}_${selectedCycle}` : ''

          const doVerify = async (attemptDigest: string) => {
            setTxModal((prev) => ({ ...prev, isVerifying: true }))
            try {
              let vRes: any = null
              // Bounded retry up to 3 times to gracefully accommodate initial Tatum block indexing delay
              for (let attempt = 1; attempt <= 3; attempt++) {
                vRes = await chainVerifier.verifyContribution({
                  circleId: circleId || 'default',
                  poolAddress,
                  memberAddress: targetAddress,
                  memberId: contributingMember?.id,
                  memberName: contributingMember?.name,
                  token: token?.coinType || tokenType || '0x2::sui::SUI',
                  expectedAmount: owedAmount,
                  windowStart,
                  windowEnd,
                  cycle: selectedCycle,
                  txDigest: attemptDigest,
                  withMemory,
                  circleConfig: {
                    circleId: circleId || 'default',
                    circleName: circleName || circleId || 'Ajo Circle',
                    poolAddress,
                    contributionPerMember: contributionPerMember || owedAmount,
                    tokenType: token?.coinType || tokenType,
                    cycleLength,
                    currentCycle: selectedCycle,
                    members,
                    timeZone,
                    windowStart,
                    windowEnd,
                  },
                })

                const isSuccess = vRes.status === 'Verified' || vRes.status === 'Late'
                if (isSuccess || attempt === 3) break

                // If not found yet because Tatum is still indexing, wait 2.5s and retry
                const isIndexing =
                  vRes.status === 'Unverified' &&
                  (vRes.error?.toLowerCase()?.includes('not found') ||
                    vRes.rawNotes?.toLowerCase()?.includes('not found') ||
                    vRes.error?.toLowerCase()?.includes('unavailable'))
                if (isIndexing) {
                  await new Promise((r) => setTimeout(r, 2500))
                } else {
                  // Final non-indexing outcome (Partial amount, timing window, etc.)
                  break
                }
              }

              const isSuccessVerified = vRes?.status === 'Verified' || vRes?.status === 'Late'
              if (inputKey && vRes) {
                setVerifications((prev) => ({
                  ...prev,
                  [inputKey]: vRes,
                }))
              }
              if (
                circleId &&
                (vRes?.historicalLateness?.walrusBlobId ||
                  vRes?.splitCompletion?.walrusBlobId ||
                  vRes?.reminderConversion?.walrusBlobId)
              ) {
                void refreshMemories(circleId)
              }
              const note = !isSuccessVerified
                ? (vRes?.rawNotes || vRes?.policy?.policyReason || vRes?.error || null)
                : null

              setTxModal((prev) => ({
                ...prev,
                isVerifying: false,
                verificationPending: !isSuccessVerified,
                verificationNotes: note,
              }))
            } catch (err: any) {
              setTxModal((prev) => ({
                ...prev,
                isVerifying: false,
                verificationPending: true,
                verificationNotes: err?.message || 'Verification attempt failed.',
              }))
            }
          }

          setTxModal((prev) => ({
            ...prev,
            onRetryVerification: () => doVerify(digest),
          }))

          if (digest) {
            await doVerify(digest)
          }

          if (poolAddress) refreshOnchainCircle(poolAddress)
          void refreshNotificationsOnly()
        } catch (err: any) {
          setTxModal((prev) => ({
            ...prev,
            isSubmitting: false,
            isVerifying: false,
            verificationPending: false,
            errorMessage: formatMoveAbortError(
              err?.message || 'Transaction signing was rejected or failed.'
            ),
          }))
        }
      },
    })
  }

  // Open transaction review modal for scheduled recipient claim (supports incremental claims)
  const handleOpenClaimModal = (claimableAmount: number) => {
    if (!currentAccount) {
      setShowWalletModal(true)
      return
    }
    if (!isMoveCircleVault) {
      setWalletAuthError(
        'Claims require a deployed Ajo Move Circle vault. A regular wallet address cannot be debited by this app.',
      )
      return
    }
    const token = findTokenByCoinType(tokenType, explorerNetwork) || findTokenBySymbol('SUI', explorerNetwork)
    const onchainDeadlineMs =
      isMatchingVault && onchainState?.cycleDeadlineMs && onchainState.cycleDeadlineMs > 0
        ? onchainState.cycleDeadlineMs
        : windowEnd
        ? Date.parse(windowEnd)
        : 0
    const isPastDeadline = onchainDeadlineMs > 0 && Date.now() > onchainDeadlineMs
    const isFullPot = claimableAmount >= potPerCycle
    const amountBase = toBaseUnits(claimableAmount, token?.decimals || 9)

    setTxModal({
      isOpen: true,
      actionTitle: isPastDeadline && !isFullPot ? 'Claim Incremental Vault Funds' : 'Claim Cycle Pot',
      actionDescription:
        isPastDeadline && !isFullPot
          ? `Claim ${claimableAmount} ${token?.symbol || 'SUI'} available in circle vault after deadline passed.`
          : `Release full cycle pot of ${claimableAmount} ${token?.symbol || 'SUI'} to your address.`,
      destinationObjectId: poolAddress,
      token,
      amountDisplay: `${claimableAmount} ${token?.symbol || 'SUI'}`,
      amountBase,
      currentCycle: selectedCycle,
      totalCycles: members.length,
      recipientAddress: currentAccount.address,
      recipientName: scheduledRecipient?.name,
      senderAddress: currentAccount.address,
      isSubmitting: false,
      isSuccess: false,
      txDigest: null,
      errorMessage: null,
      onConfirm: async () => {
        setTxModal((prev) => ({ ...prev, isSubmitting: true, errorMessage: null }))
        try {
          if (!isMoveCircleVault || !ajoConfig?.packageId) {
            throw new Error(
              'This address is not a deployed Ajo Move Circle vault. The app cannot claim funds from a regular wallet address.',
            )
          }
          const tx = buildClaimCycleTx({
            packageId: ajoConfig.packageId,
            circleObjectId: poolAddress,
            coinType: token?.coinType || '0x2::sui::SUI',
          })

          const res = await dAppKit.signAndExecuteTransaction({ transaction: tx })
          const digest = getExecutedTransactionDigest(res)
          setTxModal((prev) => ({
            ...prev,
            isSubmitting: false,
            isSuccess: true,
            txDigest: digest,
          }))

          if (circleId) {
            saveClaimedCycleForCircle(circleId, selectedCycle, {
              recipientAddress: currentAccount.address,
              recipientName: scheduledRecipient?.name,
              txDigest: digest,
              amount: claimableAmount,
              timestamp: new Date().toISOString(),
            })
            setClaimedCycles(getClaimedCyclesForCircle(circleId))
          }

          if (poolAddress) refreshOnchainCircle(poolAddress)
          void refreshNotificationsOnly()
        } catch (err: any) {
          setTxModal((prev) => ({
            ...prev,
            isSubmitting: false,
            errorMessage: formatMoveAbortError(
              err?.message || 'Claim transaction failed or was rejected.'
            ),
          }))
        }
      },
    })
  }

  // Synchronize authenticated session whenever connected account changes
  useEffect(() => {
    let cancelled = false
    if (!currentAccount?.address) {
      authAttemptRef.current += 1
      if (authenticatedWallet) {
        setAuthenticatedWallet(null)
        void logoutWalletSession()
      }
      return () => {
        cancelled = true
      }
    }
    const accountMatchesSession =
      authenticatedWallet &&
      normalizeSuiAddress(authenticatedWallet) === normalizeSuiAddress(currentAccount.address)
    if (accountMatchesSession) {
      return () => {
        cancelled = true
      }
    }

    // Never leave the previous member's authenticated session active after an account switch.
    if (authenticatedWallet) {
      setAuthenticatedWallet(null)
      void logoutWalletSession().finally(() => {
        if (
          !cancelled &&
          connectedAddressRef.current &&
          normalizeSuiAddress(connectedAddressRef.current) ===
            normalizeSuiAddress(currentAccount.address)
        ) {
          handleAuthenticateWithWallet(currentAccount.address)
        }
      })
    } else {
      handleAuthenticateWithWallet(currentAccount.address)
    }

    return () => {
      cancelled = true
    }
  }, [currentAccount?.address, authenticatedWallet, handleAuthenticateWithWallet])

  // Confirm proposed memory: signed by member's connected wallet (personal-message signature)
  const handleConfirmMemoryWithWallet = async (prop: ProposedMemory) => {
    if (!circleId) {
      setMemoryError('Activate or register a circle before confirming memories.')
      return
    }
    if (!currentAccount?.address) {
      setShowWalletModal(true)
      setMemoryError('Connect your Sui wallet (Slush) to sign memory confirmations.')
      return
    }

    const matchedMember = members.find(
      (m) => normalizeSuiAddress(m.address) === normalizeSuiAddress(currentAccount.address)
    )
    if (!matchedMember) {
      setMemoryError(
        `Connected wallet (${currentAccount.address.slice(0, 6)}...${currentAccount.address.slice(
          -4
        )}) is not a registered member of this circle roster. Switch to a registered member wallet to sign agreements.`
      )
      return
    }

    if (prop.memberId && prop.memberId !== matchedMember.id) {
      const targetName = members.find((m) => m.id === prop.memberId)?.name || prop.memberId
      setMemoryError(
        `Authorization error: This proposal specifically pertains to ${targetName}. Only ${targetName}'s wallet can sign this agreement.`
      )
      return
    }

    const actorId = matchedMember.id
    if (!actorId) {
      setMemoryError('Add and register at least one circle member to authorize memory confirmation.')
      return
    }

    setIsMemoryWriting(true)
    setMemoryError(null)
    try {
      let proposalId = prop.id
      if (!proposalId || !proposalId.startsWith('prop-')) {
        const staged = await memoryStore.propose({
          circleId,
          category: prop.category,
          title: prop.title,
          quote: prop.quote,
          suggestedAction: prop.suggestedAction || prop.title,
          memberId: prop.memberId || actorId,
          cycle: prop.cycle || selectedCycle,
          txDigest: prop.txDigest,
        })
        setProposedMemory(staged)
        proposalId = staged.id
      }

      const challenge = await memoryStore.requestConfirmationChallenge({
        circleId,
        proposalId,
        memberId: actorId,
      })

      // Prompt member's connected wallet (Slush / Wallet Standard) to sign challenge
      const { signature } = await dAppKit.signPersonalMessage({
        message: new TextEncoder().encode(challenge.message),
      })

      const newRecord = await memoryStore.confirmProposal({
        circleId,
        proposalId,
        proposal: {
          ...prop,
          circleId,
          cycle: prop.cycle || selectedCycle,
        },
        memberId: actorId,
        confirmationMode: 'wallet_signature_verified',
        challengeNonce: challenge.nonce,
        signature,
      })

      await refreshMemories(circleId)
      setProposedMemory(null)
      setActiveProposalChallenge(null)

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          sender: 'steward',
          text: `Saved to Walrus Mainnet (Blob ID: ${newRecord.walrusBlobId}): "${newRecord.title}" [${newRecord.confirmedBy}].`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          citedMemories: [newRecord],
        },
      ])
    } catch (err: any) {
      console.error('Memory confirmation error:', err)
      if (err?.message?.includes('reject') || err?.message?.includes('User rejected')) {
        setMemoryError('Signature request rejected in wallet.')
      } else {
        setMemoryError(err.message || 'Failed to write memory to Walrus')
      }
    } finally {
      setIsMemoryWriting(false)
    }
  }

  // Record an organizer-entered memory (without member wallet signature)
  const handleConfirmMemory = async (
    prop: ProposedMemory,
    mode: 'wallet_signature_verified' | 'organizer_entered' = 'organizer_entered'
  ) => {
    if (mode === 'wallet_signature_verified') {
      return handleConfirmMemoryWithWallet(prop)
    }
    if (!circleId) {
      setMemoryError('Activate or register a circle before confirming memories.')
      return
    }
    if (!currentAccount?.address) {
      setShowWalletModal(true)
      setMemoryError('Connect your Sui wallet to record agreements.')
      return
    }
    const matchedMember = members.find(
      (m) => normalizeSuiAddress(m.address) === normalizeSuiAddress(currentAccount.address)
    )
    if (!matchedMember) {
      setMemoryError(
        `Connected wallet (${currentAccount.address.slice(0, 6)}...${currentAccount.address.slice(
          -4
        )}) is not a registered member of this circle.`
      )
      return
    }
    if (prop.memberId && prop.memberId !== matchedMember.id) {
      const targetName = members.find((m) => m.id === prop.memberId)?.name || prop.memberId
      setMemoryError(
        `Authorization error: This proposal specifically pertains to ${targetName}. Only ${targetName} can record this entry.`
      )
      return
    }
    const actorId = matchedMember.id
    if (!actorId) {
      setMemoryError('Add and register at least one circle member to authorize memory confirmation.')
      return
    }

    setIsMemoryWriting(true)
    setMemoryError(null)
    try {
      const newRecord = await memoryStore.confirmProposal({
        circleId,
        proposalId: prop.id,
        proposal: {
          ...prop,
          circleId,
          cycle: prop.cycle || selectedCycle,
        },
        memberId: actorId,
        confirmationMode: 'organizer_entered',
      })

      await refreshMemories(circleId)
      setProposedMemory(null)
      setActiveProposalChallenge(null)

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          sender: 'steward',
          text: `Saved to Walrus Mainnet (Blob ID: ${newRecord.walrusBlobId}): "${newRecord.title}" [${newRecord.confirmedBy}].`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          citedMemories: [newRecord],
        },
      ])
    } catch (err: any) {
      setMemoryError(err.message || 'Failed to write memory to Walrus')
    } finally {
      setIsMemoryWriting(false)
    }
  }

  // Reject proposed memory (organizer server rejection or local cancel)
  const handleRejectMemory = async (targetProposalId?: string, reason?: string) => {
    const pid = targetProposalId || proposedMemory?.id
    if (pid && circleId && isConnectedOrganizer) {
      try {
        await memoryStore.rejectProposal({
          circleId,
          proposalId: pid,
          reason: reason || rejectionReasons[pid] || 'Rejected by circle organizer',
        })
        await refreshMemories(circleId)
      } catch (err: any) {
        setMemoryError(err.message || 'Failed to reject proposal')
      }
    }
    if (!targetProposalId || targetProposalId === proposedMemory?.id) {
      setProposedMemory(null)
      setActiveProposalChallenge(null)
    }
  }

  // Verify a specific member's captured transaction digest
  const handleVerifyMemberDigest = async (member: Member, overrideDigest?: string) => {
    const inputKey = `${member.id}_${selectedCycle}`
    const localDigests = getClientSubmittedDigests(circleId || 'default', selectedCycle, member.address)
    const existingVer = verifications[inputKey]
    const existingDigests = Array.isArray(existingVer?.txDigests)
      ? existingVer.txDigests
      : existingVer?.txDigest
      ? existingVer.txDigest.split(',').map((s) => s.trim()).filter(Boolean)
      : []

    const candidateDigests = Array.from(new Set([...localDigests, ...existingDigests]))
    let digestsToSend = overrideDigest
      ? (overrideDigest.includes(',') ? overrideDigest.split(',').map((s) => s.trim()).filter(Boolean) : [overrideDigest.trim()])
      : candidateDigests

    setVerifyingMemberId(member.id)
    try {
      if (digestsToSend.length === 0 && circleId) {
        const disc = await chainVerifier.discoverContribution({
          circleId,
          cycle: selectedCycle,
          windowStart,
          windowEnd,
        })
        if (disc && disc.status !== 'Pending') {
          setVerifications((prev) => ({ ...prev, [inputKey]: disc }))
          if (
            disc.historicalLateness?.walrusBlobId ||
            disc.splitCompletion?.walrusBlobId ||
            disc.reminderConversion?.walrusBlobId
          ) {
            void refreshMemories(circleId)
          }
          if (Array.isArray(disc.txDigests)) {
            for (const d of disc.txDigests) {
              saveClientSubmittedDigest(circleId, selectedCycle, member.address, d)
            }
          }
          return
        }
      }

      if (circleId && digestsToSend.length > 0) {
        for (const d of digestsToSend) {
          saveClientSubmittedDigest(circleId, selectedCycle, member.address, d)
          void chainVerifier.submitDigest({
            circleId,
            cycle: selectedCycle,
            memberAddress: member.address,
            txDigest: d,
          })
        }
      }

      const res = await chainVerifier.verifyContribution({
        circleId: circleId || 'default',
        poolAddress,
        memberAddress: member.address,
        memberId: member.id,
        memberName: member.name,
        token: tokenType,
        expectedAmount: contributionPerMember,
        windowStart,
        windowEnd,
        cycle: selectedCycle,
        txDigests: digestsToSend.length > 0 ? digestsToSend : undefined,
        txDigest: digestsToSend.length === 1 ? digestsToSend[0] : undefined,
        withMemory,
        memories: memoriesList,
        circleConfig: {
          circleId: circleId || 'default',
          circleName: circleName || circleId || 'Ajo Circle',
          poolAddress,
          contributionPerMember,
          tokenType,
          cycleLength,
          currentCycle: selectedCycle,
          members,
          timeZone,
          windowStart,
          windowEnd,
        },
      })
      setVerifications((prev) => ({
        ...prev,
        [inputKey]: res,
      }))
      if (
        circleId &&
        (res?.historicalLateness?.walrusBlobId ||
          res?.splitCompletion?.walrusBlobId ||
          res?.reminderConversion?.walrusBlobId)
      ) {
        void refreshMemories(circleId)
      }
    } finally {
      setVerifyingMemberId(null)
    }
  }

  // Dismiss an unverified transaction attempt and clear it from local storage
  const handleDismissMemberDigest = (member: Member) => {
    const inputKey = `${member.id}_${selectedCycle}`
    if (circleId) {
      clearClientSubmittedDigests(circleId, selectedCycle, member.address)
    }
    setVerifications((prev) => {
      const next = { ...prev }
      delete next[inputKey]
      return next
    })
  }

  // Persist active circle configuration & roster snapshot to Walrus Mainnet
  const handlePersistCircleConfig = async () => {
    if (!circleId) {
      setMemoryError('Activate or register a circle first before saving its configuration to Walrus.')
      return
    }
    setIsMemoryWriting(true)
    setMemoryError(null)
    try {
      const persisted = await memoryStore.persistCircleConfig({ circleId })
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          sender: 'steward',
          text: `Saved circle configuration v${persisted.version} to Walrus Mainnet (Blob ID: ${persisted.walrusBlobId}) [${persisted.confirmedBy}].`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ])
    } catch (err: any) {
      setMemoryError(err.message || 'Failed to persist circle configuration to Walrus')
    } finally {
      setIsMemoryWriting(false)
    }
  }

  // Rebuild / restore circle configuration, memories, and Tatum-reverified digests from Walrus
  const handleRestoreFromWalrus = async () => {
    const targetCircle = (lookupCircleSlug || circleId).trim()
    if (!targetCircle) {
      setMemoryError('Enter a Circle ID / namespace slug to restore from Walrus.')
      return
    }
    setIsMemoryLoading(true)
    setMemoryError(null)
    try {
      memoryStore.setCircleId(targetCircle)
      setCircleId(targetCircle)
      const outcome = await memoryStore.restore(25, { windowStart, windowEnd })
      setRestoreOutcome(outcome)
      setMemoriesList(outcome.records || [])
      if (outcome.circle) {
        setCircleName(outcome.circle.circleName)
        setPoolAddress(outcome.circle.poolAddress)
        setContributionPerMember(outcome.circle.contributionPerMember)
        setTokenType(outcome.circle.tokenType)
        setCycleLength(outcome.circle.cycleLength)
        if (outcome.circle.timeZone) setTimeZone(outcome.circle.timeZone)
        if (outcome.circle.windowStart) setWindowStart(outcome.circle.windowStart)
        if (outcome.circle.windowEnd) setWindowEnd(outcome.circle.windowEnd)
        setCircleRules(outcome.circle.circleRules || '')
        setSelectedCycle(outcome.circle.currentCycle)
        setMembers(outcome.circle.members)
        if (!confirmingMemberId && outcome.circle.members[0]?.id) {
          setConfirmingMemberId(outcome.circle.members[0].id)
        }
      }
      if (Array.isArray(outcome.tatumReverifications) && outcome.tatumReverifications.length > 0) {
        setVerifications((prev) => {
          const next = { ...prev }
          for (const rv of outcome.tatumReverifications!) {
            next[`${rv.memberId}_${rv.cycle}`] = {
              status: rv.status,
              code: rv.code as any,
              txDigest: rv.txDigests?.[0],
              txDigests: rv.txDigests,
              amountReceived: rv.amountReceived,
              network: rv.network,
              policy: rv.policy,
              error: rv.error,
            }
          }
          return next
        })
      }
    } catch (err: any) {
      setMemoryError(err.message || 'Failed to restore circle state from Walrus')
    } finally {
      setIsMemoryLoading(false)
    }
  }

  // Handle chat submission
  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || chatInput).trim()
    if (!text) return

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }

    setMessages((prev) => [...prev, userMsg])
    setChatInput('')
    setIsChatTyping(true)
    setChatError(null)

    try {
      const output = await steward.processChat(
        {
          circleId: circleId || undefined,
          circleName: circleName || undefined,
          message: text,
          currentCycle: selectedCycle,
          withMemory,
          contributionPerMember,
          tokenType,
          members,
          windowEnd,
        },
        memoriesList,
        verifications
      )

      const stewardMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: 'steward',
        text: output.reply,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        citedMemories: output.citedMemories,
        citedTxDigests: output.citedTxDigests,
        proposedMemory: output.proposedMemory,
      }

      setMessages((prev) => [...prev, stewardMsg])

      if (output.proposedMemory) {
        setProposedMemory(output.proposedMemory)
      }
    } catch (err: any) {
      setChatError(err.message || 'Steward LLM is unavailable.')
    } finally {
      setIsChatTyping(false)
    }
  }

  // Propose memory from the Memory tab
  const handleProposeManualMemory = async () => {
    if (!circleId) {
      setMemoryError('Activate a circle first (or enter a Circle ID) before proposing a memory.')
      return
    }
    if (!manualTitle.trim() || !manualQuote.trim()) {
      setMemoryError('Title and source quote are required to propose a circle memory.')
      return
    }
    setMemoryError(null)
    try {
      const prop = await memoryStore.propose({
        circleId,
        category: manualCategory,
        title: manualTitle.trim(),
        quote: manualQuote.trim(),
        suggestedAction: manualRule.trim() || manualTitle.trim(),
        memberId: manualMemberId || undefined,
        cycle: selectedCycle,
      })
      setProposedMemory(prop)
      setManualTitle('')
      setManualQuote('')
      setManualRule('')
      void refreshNotificationsOnly()
    } catch (err: any) {
      setMemoryError(err.message || 'Failed to propose memory')
    }
  }

  // Add Member in Create flow
  const handleAddMember = () => {
    if (!newMemberName.trim() || !newMemberAddress.trim()) return
    const nextIdx = createMembers.length
    const newM: Member = {
      id: `m${nextIdx + 1}`,
      name: newMemberName.trim(),
      address: newMemberAddress.trim(),
      avatarColor: AVATAR_PALETTE[nextIdx % AVATAR_PALETTE.length],
    }
    setCreateMembers((prev) => [...prev, newM])
    setNewMemberName('')
    setNewMemberAddress('')
  }

  const [isPublishingPackage, setIsPublishingPackage] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)

  const handlePublishPackage = async () => {
    if (!currentAccount) {
      setShowWalletModal(true)
      return
    }
    setIsPublishingPackage(true)
    setPublishError(null)
    try {
      const { modules, dependencies } = await fetchPackageBytecode()
      const tx = buildPublishPackageTx({
        modules,
        dependencies,
        senderAddress: currentAccount.address,
      })
      const res = await dAppKit.signAndExecuteTransaction({ transaction: tx })
      const digest = getExecutedTransactionDigest(res)
      if (!digest) {
        throw new Error('Package publish transaction did not return a valid digest.')
      }

      await new Promise((resolve) => setTimeout(resolve, 2000))
      let inspect = await inspectCreatedCircle(digest).catch(() => null)
      if (!inspect?.packageId) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        inspect = await inspectCreatedCircle(digest).catch(() => null)
      }

      const publishedPkgId = inspect?.packageId
      if (!publishedPkgId) {
        throw new Error(`Package was published (Tx: ${digest}), but package ID could not be retrieved from effects. Check the Sui explorer.`)
      }

      await setAjoPackageId(publishedPkgId)
      setCreateStep(3)
      await refreshAjoConfigAndCircles()
    } catch (err: any) {
      setPublishError(err.message || 'Failed to publish Move package to Sui Testnet')
    } finally {
      setIsPublishingPackage(false)
      setCreateStep(3)
    }
  }

  const startCreateNewCircle = useCallback(() => {
    clearSavedCircleDraft()
    setCreateStep(1)
    setCreateCircleName('')
    setCreateContributionPerMember(0)
    setCreateTokenType('')
    setCreateCycleLength('Monthly')
    setCreateTimeZone(detectUserTimeZone())
    const now = new Date()
    const startIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString()
    setCreateWindowStart(startIso)
    try {
      setCreateWindowEnd(calculateDaylightSavingAwareCycleEnd(startIso, 'Monthly', detectUserTimeZone()))
    } catch {
      setCreateWindowEnd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString())
    }
    setCreateMembers([])
    setCreateProposedCircleId('')
    setCreatePoolAddress('')
    setCreateCircleRules('')
    setCreateError(null)
    setCircleActivationNotice(null)
    setNewMemberName('')
    setNewMemberAddress('')
    setActiveTab('create')
    window.location.hash = 'create'
  }, [])

  const [isDeployingFreshVault, setIsDeployingFreshVault] = useState<boolean>(false)
  const handleDeployFreshVaultForCircle = async () => {
    if (!circleId || isDeployingFreshVault) return
    if (!currentAccount) {
      setShowWalletModal(true)
      return
    }
    if (!ajoConfig?.packageConfigured || !ajoConfig?.packageId) {
      alert('Move package is not configured on Sui testnet.')
      return
    }
    setIsDeployingFreshVault(true)
    try {
      const tok = findTokenByCoinType(tokenType, explorerNetwork) || findTokenBySymbol('SUI', explorerNetwork)
      const decimals = tok?.decimals || 9
      const amountBase = toBaseUnits(contributionPerMember, decimals)

      const durationMs =
        cycleLength.toLowerCase().includes('5 min')
          ? 5 * 60 * 1000
          : cycleLength === 'Daily'
          ? 24 * 60 * 60 * 1000
          : cycleLength === 'Weekly'
          ? 7 * 24 * 60 * 60 * 1000
          : cycleLength === 'Bi-Weekly'
          ? 14 * 24 * 60 * 60 * 1000
          : cycleLength === 'Yearly'
          ? 365 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000

      const memberAddresses = members.map((m) => m.address)

      const createTx = buildCreateCircleTx({
        packageId: ajoConfig.packageId,
        name: circleName.trim(),
        contributionAmountBase: amountBase,
        cycleDurationMs: BigInt(durationMs),
        members: memberAddresses,
        payoutOrder: memberAddresses,
        coinType: tok?.coinType || '0x2::sui::SUI',
      })

      const res = await dAppKit.signAndExecuteTransaction({ transaction: createTx })
      const digest = getExecutedTransactionDigest(res)
      if (!digest) {
        throw new Error('Circle vault creation transaction was rejected or failed.')
      }

      await new Promise((resolve) => setTimeout(resolve, 2000))
      let inspect = await inspectCreatedCircle(digest).catch(() => null)
      if (!inspect?.circleObjectId) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        inspect = await inspectCreatedCircle(digest).catch(() => null)
      }

      const freshVaultAddress = inspect?.circleObjectId || digest
      setPoolAddress(freshVaultAddress)
      setOnchainState(null)
      setPayoutRec(null)
      setPayoutError(null)

      await memoryStore.registerCircle({
        circleId,
        circleName: circleName.trim(),
        poolAddress: freshVaultAddress,
        contributionPerMember: Number(contributionPerMember) || 0,
        tokenType: tokenType.trim(),
        cycleLength,
        timeZone,
        windowStart,
        windowEnd,
        currentCycle: 1,
        members,
        organizerAddress: currentAccount?.address || members[0]?.address,
      })

      await refreshAjoConfigAndCircles()
      await refreshOnchainCircle(freshVaultAddress)
    } catch (err: any) {
      alert(`Failed to deploy fresh vault: ${err.message || err}`)
    } finally {
      setIsDeployingFreshVault(false)
    }
  }

  // Step 3 Phase 1: Deploy On-Chain Move Vault
  const handleDeployOnchainVault = async () => {
    if (isDeployingVault) return
    setCreateError(null)

    if (!currentAccount) {
      setShowWalletModal(true)
      return
    }

    if (!createCircleName.trim()) {
      setCreateError('Please enter a circle name.')
      setCreateStep(1)
      return
    }

    if (createMembers.length < 2) {
      setCreateError('A savings circle requires at least 2 members.')
      setCreateStep(2)
      return
    }

    if (createTokenType.toLowerCase().includes('wal')) {
      setCreateError('WAL is no longer supported as a contribution token. New circles must be created using SUI or USDC.')
      setCreateStep(1)
      return
    }

    if (!ajoConfig?.packageConfigured || !ajoConfig?.packageId) {
      setCreateError('Move package is not configured on Sui Testnet. Please publish the package first.')
      return
    }

    setIsDeployingVault(true)
    setCircleActivationNotice({
      state: 'saving',
      message: 'Instantiating Circle<T> Move shared vault object on Sui Testnet…',
    })

    try {
      const tok = findTokenByCoinType(createTokenType, explorerNetwork) || findTokenBySymbol('SUI', explorerNetwork)
      const decimals = tok?.decimals || 9
      const amountBase = toBaseUnits(createContributionPerMember, decimals)

      const durationMs =
        createCycleLength.toLowerCase().includes('5 min')
          ? 5 * 60 * 1000
          : createCycleLength === 'Daily'
          ? 24 * 60 * 60 * 1000
          : createCycleLength === 'Weekly'
          ? 7 * 24 * 60 * 60 * 1000
          : createCycleLength === 'Bi-Weekly'
          ? 14 * 24 * 60 * 60 * 1000
          : createCycleLength === 'Yearly'
          ? 365 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000

      const memberAddresses = createMembers.map((m) => m.address)

      const createTx = buildCreateCircleTx({
        packageId: ajoConfig.packageId,
        name: createCircleName.trim(),
        contributionAmountBase: amountBase,
        cycleDurationMs: BigInt(durationMs),
        members: memberAddresses,
        payoutOrder: memberAddresses,
        coinType: tok?.coinType || '0x2::sui::SUI',
      })

      const res = await dAppKit.signAndExecuteTransaction({ transaction: createTx })
      const digest = getExecutedTransactionDigest(res)
      if (!digest) {
        throw new Error('Circle vault deployment transaction was rejected or failed.')
      }

      await new Promise((resolve) => setTimeout(resolve, 2000))
      let inspect = await inspectCreatedCircle(digest).catch(() => null)
      if (!inspect?.circleObjectId) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        inspect = await inspectCreatedCircle(digest).catch(() => null)
      }

      const deployedVault = inspect?.circleObjectId || digest
      setCreatePoolAddress(deployedVault)

      setCircleActivationNotice({
        state: 'saved',
        message: `Move vault deployed on Sui Testnet (${deployedVault.slice(0, 8)}...${deployedVault.slice(-6)}). Now click "Activate Circle" to finalize!`,
      })
    } catch (err: any) {
      const msg = err.message || 'Failed to deploy on-chain Move vault'
      setCreateError(msg)
      setCircleActivationNotice({ state: 'error', message: msg })
    } finally {
      setIsDeployingVault(false)
    }
  }

  // Step 3 Phase 2: Save to Walrus & Activate Circle
  const handleActivateCircle = async () => {
    if (isActivatingCircle) return
    setCreateError(null)

    if (!createPoolAddress) {
      setCreateError('Please deploy the on-chain vault first.')
      return
    }

    if (!memwalHealth.configured) {
      setCreateError('Configure Walrus Memory before activating a circle. Circle setup and roster data must be saved to Walrus to survive a server restart.')
      return
    }

    const slug = createProposedCircleId || generateUniqueCircleId(createCircleName, currentAccount?.address || createMembers[0]?.address)
    if (!slug || !createCircleName.trim()) {
      setCreateError('Please enter a valid circle name.')
      return
    }

    setIsActivatingCircle(true)
    setCircleActivationNotice({
      state: 'saving',
      message: 'Saving circle agreement and member roster to Walrus Mainnet…',
    })

    try {
      const result = await memoryStore.registerCircle({
        circleId: slug,
        circleName: createCircleName.trim(),
        poolAddress: createPoolAddress,
        contributionPerMember: Number(createContributionPerMember) || 0,
        tokenType: createTokenType.trim(),
        cycleLength: createCycleLength,
        timeZone: createTimeZone,
        windowStart: createWindowStart,
        windowEnd: createWindowEnd,
        currentCycle: 1,
        members: createMembers,
        organizerAddress: currentAccount?.address || createMembers[0]?.address,
        ...(createCircleRules.trim() ? { circleRules: createCircleRules.trim() } : {}),
      })
      const registered = result.circle
      if (!registered?.circleId || !result.walrusBlobId) {
        throw new Error('The circle was registered, but Walrus did not confirm a saved configuration blob.')
      }
      clearSavedCircleDraft()

      // 1. Establish full active circle state for Dashboard
      const finalCircleId = registered.circleId
      const finalMembers = registered.members && registered.members.length > 0 ? registered.members : createMembers
      const finalName = registered.circleName || createCircleName.trim()
      const finalVault = createPoolAddress
      const finalContribution = registered.contributionPerMember ?? Number(createContributionPerMember) ?? 0
      const finalToken = registered.tokenType || createTokenType.trim()
      const finalCycleLength = registered.cycleLength || createCycleLength
      const finalTimeZone = registered.timeZone || createTimeZone
      const finalWindowStart = registered.windowStart || createWindowStart
      const finalWindowEnd = registered.windowEnd || createWindowEnd
      const finalCircleRules = registered.circleRules || createCircleRules.trim()

      setCircleId(finalCircleId)
      setLookupCircleSlug(finalCircleId)
      setCircleName(finalName)
      setPoolAddress(finalVault)
      setContributionPerMember(finalContribution)
      setTokenType(finalToken)
      setMembers(finalMembers)
      setCycleLength(finalCycleLength)
      setTimeZone(finalTimeZone)
      setWindowStart(finalWindowStart)
      setWindowEnd(finalWindowEnd)
      setCircleRules(finalCircleRules)

      setSelectedCycle(1)
      setOnchainState(null)
      setPayoutRec(null)
      setPayoutError(null)
      setVerifications({})
      setClaimedCycles({})

      try {
        localStorage.setItem(ACTIVE_CIRCLE_STORAGE_KEY, finalCircleId)
      } catch {}

      setCircleActivationNotice({
        state: 'saved',
        message: 'On-chain circle activated and saved to Walrus Mainnet.',
        blobId: result.walrusBlobId,
      })

      if (!confirmingMemberId && finalMembers?.[0]?.id) {
        setConfirmingMemberId(finalMembers[0].id)
      }

      // 2. Immediately switch tab to Dashboard and update URL hash so user lands on their live board
      setActiveTab('dashboard')
      window.location.hash = 'dashboard'

      // 3. Clear draft and reset form fields so future creations start totally blank
      clearSavedCircleDraft()
      setCreateStep(1)
      setCreateCircleName('')
      setCreateContributionPerMember(0)
      setCreateTokenType('')
      setCreateMembers([])
      setCreateProposedCircleId('')
      setCreatePoolAddress('')
      setCreateCircleRules('')
      setNewMemberName('')
      setNewMemberAddress('')

      // 4. Perform background refreshes non-blockingly
      void refreshAjoConfigAndCircles()
      if (finalVault) {
        void refreshOnchainCircle(finalVault)
      }
      if (memwalHealth.configured) {
        void refreshMemories(finalCircleId)
      }
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to deploy and register circle'
      setCreateError(errorMessage)
      setCircleActivationNotice({ state: 'error', message: errorMessage })
    } finally {
      setIsActivatingCircle(false)
    }
  }

  // Unified Single Action: First Deploy Vault, then Activate Circle
  const handleDeployOrActivateCircle = async () => {
    if (!currentAccount) {
      setShowWalletModal(true)
      return
    }
    if (!createPoolAddress) {
      await handleDeployOnchainVault()
    } else {
      if (!authenticatedWallet && currentAccount?.address) {
        await handleAuthenticateWithWallet(currentAccount.address)
      }
      await handleActivateCircle()
    }
  }

  // Switch the active circle from the Circles page
  const handleSwitchCircle = (selected: any) => {
    if (!selected?.circleId) return
    setCircleId(selected.circleId)
    setLookupCircleSlug(selected.circleId)
    setCircleName(selected.circleName || selected.name || '')
    setPoolAddress(selected.poolAddress || '')
    if (selected.poolAddress) {
      void refreshOnchainCircle(selected.poolAddress)
    } else {
      setOnchainState(null)
    }
    setPayoutRec(null)
    setPayoutError(null)
    setContributionPerMember(Number(selected.contributionPerMember) || 0)
    if (selected.tokenType) setTokenType(selected.tokenType)
    setCycleLength(selected.cycleLength || 'Monthly')
    if (selected.timeZone) setTimeZone(selected.timeZone)
    if (selected.windowStart) setWindowStart(selected.windowStart)
    if (selected.windowEnd) setWindowEnd(selected.windowEnd)
    setCircleRules(selected.circleRules || '')
    setSelectedCycle(selected.currentCycle || 1)
    setMembers(Array.isArray(selected.members) ? selected.members : [])
    if (selected.members?.[0]?.id) setConfirmingMemberId(selected.members[0].id)
    memoryStore.setCircleId(selected.circleId)
    setVerifications({})
    setClaimedCycles(getClaimedCyclesForCircle(selected.circleId))
    try {
      localStorage.setItem(ACTIVE_CIRCLE_STORAGE_KEY, selected.circleId)
    } catch {}
    if (selected.poolAddress) {
      refreshOnchainCircle(selected.poolAddress)
    }
    if (memwalHealth.configured) {
      refreshMemories(selected.circleId)
    }
    setActiveTab('dashboard')
    window.location.hash = 'dashboard'
  }

  // Totals derived purely from real verified results
  const totalCycles = Math.max(members.length, 1)
  const potPerCycle = members.length * contributionPerMember

  const chainVerifiedCount = members.filter((m) => {
    const r = verifications[`${m.id}_${selectedCycle}`]
    return r?.status === 'Verified'
  }).length

  const policyAcceptedCount = members.filter((m) => {
    const r = verifications[`${m.id}_${selectedCycle}`]
    return r?.policy ? r.policy.countsTowardPot : r?.status === 'Verified'
  }).length

  const verifiedContributionSum = useMemo(() => {
    return members.reduce((sum, m) => {
      const r = verifications[`${m.id}_${selectedCycle}`]
      if (!r || typeof r.amountReceived !== 'number') return sum
      if (r.status === 'Verified' || r.status === 'Late' || r.status === 'Partial' || r.status === 'WrongAmount') {
        return sum + r.amountReceived
      }
      return sum
    }, 0)
  }, [members, verifications, selectedCycle])

  const totalOnchainPotReceived = useMemo(() => {
    // If this cycle was already claimed, the full pot was received on-chain and disbursed to the recipient!
    if (isCycleClaimed(selectedCycle)) {
      return potPerCycle
    }

    // For a Move-backed circle, the on-chain Move contract vaultBalance is the single source of truth.
    // Never deceptively inflate the pot with Math.max.
    if (isMatchingVault && onchainState?.vaultBalance !== undefined) {
      return actualVaultBalance
    }

    return verifiedContributionSum
  }, [isCycleClaimed, selectedCycle, potPerCycle, isMatchingVault, onchainState?.vaultBalance, actualVaultBalance, verifiedContributionSum])

  const tokenSymbol = tokenType
    ? tokenType.split('::').pop() || tokenType
    : 'TOKEN'

  interface NavTabItem {
    id: TabId
    label: string
    icon: React.ComponentType<{ className?: string }>
    badge?: string
  }

  const navTabs: NavTabItem[] = [
    { id: 'home', label: 'Home', icon: Compass },
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'circles', label: 'Circles', icon: Layers },
    { id: 'create', label: 'Create Circle', icon: PlusCircle },
    {
      id: 'chat',
      label: 'Chat',
      icon: MessageSquare,
      badge: proposedMemory ? '1' : undefined,
    },
    {
      id: 'memories',
      label: 'Memory',
      icon: Brain,
    },
    { id: 'payout', label: 'Payout', icon: Sparkles },
  ]

  const stewardModeCard = (
    <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl shadow-xs space-y-xl">
      <div className="flex items-center justify-between mb-sm">
        <span className="text-sm font-semibold text-secondary flex items-center gap-xs">
          <Brain className="size-4 text-fg-brand-primary shrink-0" />
          Walrus Memory
        </span>
        <span className="text-xs text-tertiary">
          {memwalHealth.connected
            ? `Walrus active (${memoriesList.length} memories)`
            : 'Walrus offline'}
        </span>
      </div>

      <div className="flex gap-md rounded-xl bg-utility-brand-50 p-lg sm:p-xl">
        <Info className="mt-xxs size-4 shrink-0 text-utility-brand-600" aria-hidden="true" />
        <div className="space-y-xs">
          <p className="text-xs font-semibold text-utility-brand-600">
            Walrus recall + policy evaluation active
          </p>
          <p className="text-xs text-tertiary leading-relaxed">
            Chain facts (<strong className="text-primary">Verified</strong>,{' '}
            <strong className="text-primary">Late</strong>,{' '}
            <strong className="text-primary">Partial</strong>) are kept separate from group
            policy. Confirmed Walrus agreements and patterns inform Steward policy without altering
            on-chain timestamp facts.
          </p>
        </div>
      </div>
    </section>
  )

  return (
    <div className="min-h-screen bg-secondary text-primary font-sans flex flex-col antialiased pb-24 lg:pb-8">
      {/* Sticky Full-Width Header with Desktop Navigation & Prominent Wallet Control */}
      <header className="sticky top-0 z-30 bg-primary border-b border-secondary shadow-xs">
        <div className="max-w-7xl mx-auto px-md sm:px-lg lg:px-xl py-md sm:py-lg flex items-center justify-between gap-md lg:gap-xl">
          {/* Logo & Brand Trademark */}
          <button
            type="button"
            onClick={() => {
              setActiveTab('home')
              window.location.hash = 'home'
            }}
            className="flex items-center gap-sm sm:gap-md min-w-0 text-left hover:opacity-90 transition-opacity cursor-pointer focus-visible:outline-hidden group shrink-0"
            title="Go to Home"
          >
            <img
              src="/logo.png"
              alt="Ajo Steward"
              className="size-10 sm:size-11 object-contain shrink-0"
            />
            <div className="flex items-center gap-xs">
              <span className="text-xl sm:text-2xl font-bold text-primary tracking-tight whitespace-nowrap">
                Ajo Steward
              </span>
              <span
                className={`w-2 h-2 rounded-full inline-block shrink-0 ${
                  rpcStatus.connected
                    ? 'bg-success-primary'
                    : rpcStatus.loading
                    ? 'bg-quaternary animate-pulse'
                    : 'bg-warning-primary'
                }`}
                title={
                  rpcStatus.connected
                    ? `Tatum Sui connected (${rpcStatus.network})`
                    : rpcStatus.loading
                    ? 'Connecting to Tatum Sui...'
                    : rpcStatus.error || 'Tatum Sui RPC not connected'
                }
              />
            </div>
          </button>

          {/* Desktop Navigation Tabs — Responsive layout fitting clean on large screens */}
          <nav className="hidden lg:flex items-center gap-xs xl:gap-sm shrink-0">
            {navTabs.map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id

              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    if (tab.id === 'create') {
                      startCreateNewCircle()
                      return
                    }
                    setActiveTab(tab.id as any)
                    window.location.hash = tab.id
                  }}
                  className={`inline-flex items-center gap-xs xl:gap-sm px-md xl:px-lg py-sm rounded-lg text-xs xl:text-sm transition-all focus-visible:ring-2 focus-visible:ring-focus-ring outline-none ${
                    isActive
                      ? 'bg-brand-solid text-primary-on-brand font-semibold shadow-xs'
                      : 'text-secondary hover:text-primary hover:bg-secondary font-medium'
                  }`}
                >
                  <div className="relative flex items-center">
                    <Icon className="size-4 shrink-0" />
                    {tab.badge && (
                      <span
                        className={`ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                          isActive
                            ? 'bg-utility-brand-200 text-utility-brand-900'
                            : 'bg-brand-solid text-primary-on-brand'
                        }`}
                      >
                        {tab.badge}
                      </span>
                    )}
                  </div>
                  <span>{tab.label}</span>
                </button>
              )
            })}
          </nav>

          {/* Header Controls: Notifications + Single Clean "Connect Wallet" Action */}
          <div className="flex items-center gap-sm shrink-0">
            {currentAccount && (
              <div className="relative" ref={notificationsDropdownRef}>
                <button
                  type="button"
                  onClick={() => setShowNotificationsDropdown((prev) => !prev)}
                  aria-label="Circle notifications"
                  className="relative inline-flex items-center justify-center rounded-lg border border-secondary bg-primary p-sm text-secondary hover:bg-secondary hover:text-primary transition-colors shadow-xs"
                >
                  <Bell className="size-4 shrink-0" />
                  {unreadNotificationsCount > 0 && (
                    <span
                      aria-label={`${unreadNotificationsCount} unread notifications`}
                      className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-brand-solid ring-2 ring-primary"
                    />
                  )}
                </button>

                {showNotificationsDropdown && (
                  <div className="absolute right-0 mt-xs w-[calc(100vw-2rem)] sm:w-96 max-w-sm rounded-xl border border-secondary bg-primary shadow-lg z-50 overflow-hidden">
                    <div className="flex items-center justify-between px-lg py-md border-b border-secondary bg-secondary/40">
                      <div className="flex items-center gap-xs">
                        <Bell className="size-4 text-fg-brand-primary" />
                        <span className="text-xs font-semibold text-primary">
                          Circle Notifications
                        </span>
                        {unreadNotificationsCount > 0 && (
                          <span className="rounded-full bg-utility-brand-50 border border-utility-brand-200 px-2 py-0.5 text-[10px] font-semibold text-brand-primary">
                            {unreadNotificationsCount} unread
                          </span>
                        )}
                      </div>
                      {unreadNotificationsCount > 0 && (
                        <button
                          type="button"
                          onClick={async () => {
                            setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
                            setUnreadNotificationsCount(0)
                            await markAllNotificationsAsRead(circleId || undefined)
                            await refreshNotificationsOnly()
                          }}
                          className="text-[11px] font-medium text-brand-primary hover:underline"
                        >
                          Mark all read
                        </button>
                      )}
                    </div>

                    <div className="max-h-96 overflow-y-auto divide-y divide-secondary">
                      {notifications.length === 0 ? (
                        <div className="p-xl text-center text-xs text-tertiary">
                          No notifications for your active circles right now.
                        </div>
                      ) : (
                        notifications.map((notif) => (
                          <div
                            key={notif.id}
                            className={`p-md space-y-xs transition-colors ${
                              notif.read ? 'bg-primary' : 'bg-utility-brand-50/40'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-xs">
                              <span className="text-xs font-semibold text-primary">
                                {notif.title}
                              </span>
                              {!notif.read && (
                                <span className="w-2 h-2 rounded-full bg-brand-solid shrink-0 mt-1" />
                              )}
                            </div>
                            <p className="text-xs text-secondary leading-relaxed">
                              {notif.message}
                            </p>
                            <div className="flex items-center justify-between pt-xxs">
                              <span className="text-[10px] text-tertiary">
                                {notif.circleName}
                              </span>
                              <div className="flex items-center gap-sm">
                                {notif.actionTab && (
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      if (!notif.read) {
                                        setNotifications((prev) =>
                                          prev.map((n) => (n.id === notif.id ? { ...n, read: true } : n))
                                        )
                                        setUnreadNotificationsCount((c) => Math.max(0, c - 1))
                                      }
                                      await markNotificationAsRead(notif.id)
                                      await refreshNotificationsOnly()
                                      setShowNotificationsDropdown(false)
                                      const tab =
                                        notif.actionTab === 'overview'
                                          ? 'dashboard'
                                          : (notif.actionTab as TabId)
                                      setActiveTab(tab)
                                      window.location.hash = tab
                                    }}
                                    className="text-[11px] font-semibold text-brand-primary hover:underline"
                                  >
                                    View →
                                  </button>
                                )}
                                {!notif.read && (
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      setNotifications((prev) =>
                                        prev.map((n) => (n.id === notif.id ? { ...n, read: true } : n))
                                      )
                                      setUnreadNotificationsCount((c) => Math.max(0, c - 1))
                                      await markNotificationAsRead(notif.id)
                                      await refreshNotificationsOnly()
                                    }}
                                    className="text-[11px] text-tertiary hover:text-primary"
                                  >
                                    Mark as read
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            {currentAccount ? (
              <div className="relative" ref={accountDropdownRef}>
                <button
                  type="button"
                  onClick={() => setShowAccountDropdown((prev) => !prev)}
                  className="inline-flex items-center gap-xs rounded-lg bg-utility-brand-50 border border-utility-brand-200 px-md py-xs text-xs font-mono font-medium text-brand-primary hover:bg-utility-brand-100 transition-colors shadow-xs"
                >
                  <span className="w-2 h-2 rounded-full bg-utility-success-500 shrink-0" />
                  <span className="hidden sm:inline">
                    {currentAccount.address.slice(0, 6)}...{currentAccount.address.slice(-4)}
                  </span>
                  <span className="sm:hidden">
                    {currentAccount.address.slice(0, 4)}...
                  </span>
                  <ChevronDown className="size-3 text-fg-brand-primary shrink-0" />
                </button>

                {showAccountDropdown && (
                  <div className="absolute right-0 mt-xs w-64 rounded-xl bg-primary border border-secondary shadow-lg p-md z-50 space-y-sm">
                    <div className="flex items-center justify-between pb-xs border-b border-secondary">
                      <div className="flex items-center gap-xs">
                        <Wallet className="size-3.5 text-fg-brand-primary shrink-0" />
                        <span className="text-xs font-semibold text-primary font-sans">
                          {currentWallet?.name || 'Sui Wallet'}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono px-xs py-0.5 rounded bg-utility-brand-50 text-utility-brand-700 font-semibold border border-utility-brand-200 uppercase">
                        {currentNetwork || 'testnet'}
                      </span>
                    </div>

                    {currentWallet?.accounts && currentWallet.accounts.length > 1 && (
                      <div className="space-y-xxs">
                        <div className="text-[10px] text-tertiary font-sans font-medium">
                          Switch active account
                        </div>
                        <div className="max-h-40 overflow-y-auto space-y-xxs">
                          {currentWallet.accounts.map((account) => {
                            const accountMember = members.find(
                              (member) =>
                                normalizeSuiAddress(member.address) ===
                                normalizeSuiAddress(account.address),
                            )
                            const isSelected =
                              normalizeSuiAddress(account.address) ===
                              normalizeSuiAddress(currentAccount.address)
                            return (
                              <button
                                key={account.address}
                                type="button"
                                onClick={() => handleSwitchAccount(account)}
                                aria-current={isSelected ? 'true' : undefined}
                                className={`w-full flex items-center justify-between gap-sm rounded-md border px-xs py-sm text-left text-xs transition-colors ${
                                  isSelected
                                    ? 'border-utility-brand-300 bg-utility-brand-50 text-brand-primary'
                                    : 'border-secondary bg-primary text-secondary hover:bg-secondary-hover'
                                }`}
                              >
                                <span className="min-w-0">
                                  <span className="block truncate font-mono">
                                    {account.address.slice(0, 8)}...{account.address.slice(-6)}
                                  </span>
                                  <span className="block truncate text-[10px] text-tertiary">
                                    {accountMember?.name || 'Not a circle member'}
                                  </span>
                                </span>
                                {isSelected && <Check className="size-3 shrink-0" />}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    <div className="space-y-xxs">
                      <div className="text-[10px] text-tertiary font-sans font-medium">Sui Address</div>
                      <div className="flex items-center justify-between font-mono text-xs bg-secondary p-xs rounded-md border border-secondary">
                        <ExplorerLink
                          type="address"
                          value={currentAccount.address}
                          network={explorerNetwork}
                          shorten={true}
                          showCopy={true}
                        />
                      </div>
                    </div>

                    {members.find((m) => normalizeSuiAddress(m.address) === normalizeSuiAddress(currentAccount.address)) ? (
                      <div className="text-xs text-utility-success-700 bg-utility-success-50 border border-utility-success-200 p-xs rounded-md flex items-center gap-xs font-sans">
                        <CheckCircle2 className="size-3 shrink-0 text-fg-success-primary" />
                        <span className="truncate">
                          Member: <strong>{members.find((m) => normalizeSuiAddress(m.address) === normalizeSuiAddress(currentAccount.address))?.name}</strong>
                        </span>
                      </div>
                    ) : (
                      <div className="text-xs text-tertiary bg-secondary p-xs rounded-md font-sans">
                        Non-roster wallet (Guest)
                      </div>
                    )}

                    {!authenticatedWallet && (
                      <button
                        type="button"
                        onClick={() => handleAuthenticateWithWallet(currentAccount.address)}
                        disabled={isWalletAuthBusy}
                        className="w-full inline-flex items-center justify-center gap-xs rounded-lg bg-brand-solid py-xs text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover disabled:opacity-50"
                      >
                        <Lock className="size-3 text-fg-white shrink-0" />
                        <span>{isWalletAuthBusy ? 'Signing...' : 'Authorize Session'}</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={handleDisconnectWallet}
                      className="w-full text-center text-xs text-error-primary hover:text-error-hover py-xs font-semibold hover:bg-utility-error-50 rounded-md transition-colors"
                    >
                      Disconnect
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowWalletModal(true)}
                className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-md py-xs text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover transition-colors shrink-0"
              >
                <Wallet className="size-3 text-fg-white shrink-0" />
                <span>Connect wallet</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {circleActivationNotice && (
        <aside
          aria-live="polite"
          aria-atomic="true"
          className="fixed bottom-20 lg:bottom-6 left-md right-md sm:left-auto sm:right-6 z-50 sm:max-w-md sm:w-full pointer-events-none"
        >
          <div
            className={`pointer-events-auto rounded-xl border p-md shadow-lg backdrop-blur-md flex items-start gap-sm transition-all duration-300 animate-in slide-in-from-bottom-3 ${
              circleActivationNotice.state === 'error'
                ? 'border-utility-error-200 bg-utility-error-50/95 text-utility-error-900 shadow-utility-error-100'
                : circleActivationNotice.state === 'saved'
                ? 'border-utility-success-200 bg-utility-success-50/95 text-utility-success-900 shadow-utility-success-100'
                : 'border-utility-brand-200 bg-utility-brand-50/95 text-brand-primary'
            }`}
          >
            {circleActivationNotice.state === 'saving' ? (
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-brand-solid" />
            ) : circleActivationNotice.state === 'saved' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-utility-success-600" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-utility-error-600" />
            )}
            <div className="min-w-0 flex-1 space-y-xxs">
              <p className="text-xs font-semibold">
                {circleActivationNotice.state === 'saving'
                  ? 'Saving to Walrus Mainnet…'
                  : circleActivationNotice.state === 'saved'
                  ? 'Saved to Walrus'
                  : 'Walrus Save Error'}
              </p>
              <p className="text-xs opacity-90 leading-relaxed">{circleActivationNotice.message}</p>
              {circleActivationNotice.blobId && (
                <div className="flex items-center gap-xs pt-xxs text-xs">
                  <span className="opacity-80">Blob:</span>
                  <ExplorerLink
                    type="walrus-blob"
                    value={circleActivationNotice.blobId}
                    shorten={true}
                    showCopy={true}
                    linkClassName="text-current underline opacity-90 hover:opacity-100"
                  />
                </div>
              )}
            </div>
            {circleActivationNotice.state !== 'saving' && (
              <button
                type="button"
                onClick={() => setCircleActivationNotice(null)}
                className="rounded p-xs text-current opacity-60 hover:opacity-100 transition-opacity"
                aria-label="Dismiss Walrus save notice"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </aside>
      )}

      {/* Main Container */}
      <main className="w-full max-w-7xl mx-auto flex-1 px-md sm:px-xl lg:px-2xl py-xl sm:py-2xl lg:py-3xl flex flex-col">

        {/* SCREEN 0: PRODUCT LANDING PAGE */}
        {activeTab === 'home' && (
          <LandingPage
            onNavigateTab={(tab) => {
              if (tab === 'create') {
                startCreateNewCircle()
              } else {
                setActiveTab(tab)
                window.location.hash = tab
              }
            }}
            onOpenTour={() => setIsTourOpen(true)}
            onConnectWallet={() => setShowWalletModal(true)}
            onDisconnectWallet={handleDisconnectWallet}
            currentAccountAddress={currentAccount?.address}
            hasActiveCircle={Boolean(circleId && members.length > 0)}
            activeCircleName={circleName}
            activeCircleId={circleId}
            availableCirclesCount={availableCircles.length}
            networkName={rpcStatus.network?.includes('mainnet') ? 'Sui Mainnet' : 'Sui Testnet'}
            isRpcConnected={rpcStatus.connected}
            isWalrusConnected={memwalHealth.connected}
          />
        )}

        {/* SCREEN: CIRCLES LIST & SWITCHER */}
        {activeTab === 'circles' && (
          <div className="space-y-2xl sm:space-y-3xl w-full">
            {/* Header with Title and Create Button */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-md pb-lg border-b border-secondary">
              <div>
                <h2 className="text-display-xs sm:text-display-sm font-semibold text-primary">
                  Savings Circles
                </h2>
                <p className="text-xs sm:text-sm text-secondary mt-xxs">
                  Browse, manage, and switch between your decentralized Ajo savings circles on Sui & Walrus.
                </p>
              </div>
              <button
                type="button"
                onClick={() => startCreateNewCircle()}
                className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-lg py-md text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover shrink-0"
              >
                <PlusCircle className="size-4 shrink-0" />
                <span>Create New Circle</span>
              </button>
            </div>

            {/* Active Circle Highlight Card */}
            {circleId ? (
              <div className="rounded-xl border-2 border-utility-brand-300 bg-utility-brand-50/40 p-xl sm:p-2xl shadow-xs space-y-md">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-sm">
                  <div className="space-y-xxs">
                    <div className="flex items-center gap-xs flex-wrap">
                      <span className="px-sm py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-utility-brand-100 text-utility-brand-700 border border-utility-brand-200">
                        Active in App
                      </span>
                      <span className="text-xs font-mono text-tertiary">
                        ID: {circleId}
                      </span>
                      {isUnsupportedCircleToken && (
                        <span className="px-sm py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-utility-warning-100 text-utility-warning-800 border border-utility-warning-300">
                          Unsupported Token ({tokenSymbol})
                        </span>
                      )}
                    </div>
                    <h3 className="text-heading-md font-bold text-primary">
                      {circleName || 'Ajo Savings Circle'}
                    </h3>
                  </div>
                  <div className="flex items-center gap-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('dashboard')
                        window.location.hash = 'dashboard'
                      }}
                      className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover"
                    >
                      <span>Open Dashboard</span>
                      <ArrowRight className="size-3.5 shrink-0" />
                    </button>
                  </div>
                </div>

                {isUnsupportedCircleToken && (
                  <div className="rounded-lg bg-utility-warning-100/70 border border-utility-warning-300 p-sm flex items-start gap-xs text-xs text-utility-warning-900">
                    <AlertTriangle className="size-4 shrink-0 text-utility-warning-700 mt-0.5" />
                    <div>
                      <span className="font-semibold">Unsupported Contribution Token: </span>
                      <span>This circle was saved with {tokenSymbol} ({tokenType}). WAL is no longer supported as a contribution token and this circle can no longer accept new WAL contributions.</span>
                    </div>
                  </div>
                )}

                {/* Key Stats Bar */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-md pt-sm border-t border-utility-brand-200">
                  <div>
                    <span className="text-xs text-secondary">Contribution</span>
                    <p className="text-sm font-semibold text-primary">
                      {contributionPerMember} {tokenSymbol} / member
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-secondary">Cycle Pot</span>
                    <p className="text-sm font-semibold text-primary">
                      {(members.length * contributionPerMember).toFixed(2)} {tokenSymbol}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-secondary">Cadence</span>
                    <p className="text-sm font-semibold text-primary">
                      {cycleLength} (Cycle {selectedCycle} of {members.length || 1})
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-secondary">Members</span>
                    <p className="text-sm font-semibold text-primary">
                      {members.length} registered
                    </p>
                  </div>
                </div>

                {/* Roster preview & vault */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-sm text-xs text-secondary pt-xs border-t border-utility-brand-200">
                  <div className="flex items-center gap-xs">
                    <span className="text-tertiary">Vault:</span>
                    {poolAddress ? (
                      <ExplorerLink
                        type="object"
                        value={poolAddress}
                        network={explorerNetwork}
                        shorten={true}
                        showCopy={true}
                      />
                    ) : (
                      <span className="font-mono text-tertiary">Not configured</span>
                    )}
                  </div>
                  <div className="flex items-center gap-xs">
                    <span className="text-tertiary">Members:</span>
                    <div className="flex items-center -space-x-1">
                      {members.map((m) => (
                        <span
                          key={m.id}
                          title={`${m.name} (${m.address})`}
                          className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white border-2 border-white shadow-xs ${m.avatarColor || 'bg-brand-solid'}`}
                        >
                          {m.name.slice(0, 1).toUpperCase()}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {/* All Registered Circles Section */}
            <div className="space-y-md pt-md">
              <div className="flex items-center justify-between">
                <h3 className="text-heading-xs font-semibold text-primary">
                  All Circles ({availableCircles.length})
                </h3>
                <button
                  type="button"
                  onClick={() => refreshAjoConfigAndCircles()}
                  className="inline-flex items-center gap-xs text-xs text-secondary hover:text-primary transition-colors"
                >
                  <RefreshCw className="size-3.5 shrink-0" />
                  <span>Refresh List</span>
                </button>
              </div>

              {availableCircles.length === 0 ? (
                <div className="rounded-xl border border-secondary bg-primary p-2xl text-center space-y-sm">
                  <Layers className="size-8 text-fg-quaternary mx-auto" />
                  <p className="text-sm font-semibold text-primary">No other circles registered yet</p>
                  <p className="text-xs text-secondary max-w-sm mx-auto">
                    Create another savings circle to run concurrent groups with different members, tokens, or payout schedules.
                  </p>
                  <button
                    type="button"
                    onClick={() => startCreateNewCircle()}
                    className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover mt-sm"
                  >
                    <PlusCircle className="size-3.5 shrink-0" />
                    <span>Create Circle</span>
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-lg">
                  {availableCircles.map((circle) => {
                    const isCurrentActive = circle.circleId === circleId
                    const circleMembers = Array.isArray(circle.members) ? circle.members : []
                    const pot = (circleMembers.length * (Number(circle.contributionPerMember) || 0)).toFixed(2)
                    const isCircleWal = Boolean(circle.tokenType?.toLowerCase()?.includes('wal'))
                    const circleTok = circle.tokenType?.includes('usdc') || circle.tokenType?.includes('USDC')
                      ? 'USDC'
                      : isCircleWal
                      ? 'WAL'
                      : 'SUI'

                    return (
                      <div
                        key={circle.circleId}
                        className={`rounded-xl border p-xl space-y-md shadow-xs transition-all flex flex-col justify-between ${
                          isCurrentActive
                            ? 'border-brand-solid bg-utility-brand-50/30 ring-1 ring-brand-solid'
                            : 'border-secondary bg-primary hover:border-brand-subtle'
                        }`}
                      >
                        <div className="space-y-sm">
                          <div className="flex items-start justify-between gap-sm">
                            <div className="space-y-xxs">
                              <div className="flex items-center gap-xs flex-wrap">
                                <span className="font-mono text-[10px] text-tertiary">
                                  {circle.circleId}
                                </span>
                                {isCurrentActive && (
                                  <span className="px-xs py-0.5 rounded-full text-[10px] font-bold bg-utility-brand-100 text-utility-brand-700">
                                    Current
                                  </span>
                                )}
                                {isCircleWal && (
                                  <span className="px-xs py-0.5 rounded-full text-[10px] font-bold bg-utility-warning-100 text-utility-warning-800 border border-utility-warning-200">
                                    Unsupported
                                  </span>
                                )}
                              </div>
                              <h4 className="text-md font-bold text-primary">
                                {circle.circleName || circle.name || 'Ajo Circle'}
                              </h4>
                            </div>
                            <span
                              className={`px-sm py-xs rounded-md text-xs font-semibold shrink-0 border ${
                                isCircleWal
                                  ? 'bg-utility-warning-50 text-utility-warning-800 border-utility-warning-300'
                                  : 'bg-secondary text-primary border border-secondary'
                              }`}
                            >
                              {circle.contributionPerMember || 0} {circleTok}
                            </span>
                          </div>

                          {isCircleWal && (
                            <div className="rounded-lg bg-utility-warning-50 border border-utility-warning-200 p-xs text-[11px] text-utility-warning-800 flex items-start gap-xs">
                              <AlertTriangle className="size-3.5 shrink-0 text-utility-warning-600 mt-0.5" />
                              <div>
                                <strong className="font-semibold">Unsupported token (WAL): </strong>
                                <span>This circle was saved with WAL and can no longer accept new WAL contributions.</span>
                              </div>
                            </div>
                          )}

                          <div className="grid grid-cols-3 gap-sm py-xs border-y border-secondary text-xs">
                            <div>
                              <span className="text-tertiary">Total Pot</span>
                              <p className="font-semibold text-primary">{pot} {circleTok}</p>
                            </div>
                            <div>
                              <span className="text-tertiary">Cadence</span>
                              <p className="font-semibold text-primary">{circle.cycleLength || 'Monthly'}</p>
                            </div>
                            <div>
                              <span className="text-tertiary">Members</span>
                              <p className="font-semibold text-primary">{circleMembers.length}</p>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-xs text-secondary pt-xs border-t border-secondary">
                          <div className="min-w-0 pr-xs">
                            {circle.poolAddress ? (
                              <ExplorerLink
                                type="object"
                                value={circle.poolAddress}
                                network={explorerNetwork}
                                shorten={true}
                                showCopy={true}
                              />
                            ) : (
                              <span className="font-mono text-[11px] text-tertiary">No vault</span>
                            )}
                          </div>
                          {isCurrentActive ? (
                            <button
                              type="button"
                              onClick={() => {
                                setActiveTab('dashboard')
                                window.location.hash = 'dashboard'
                              }}
                              className="inline-flex items-center gap-xs text-xs font-semibold text-brand-primary hover:underline"
                            >
                              <span>View Dashboard</span>
                              <ArrowRight className="size-3.5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleSwitchCircle(circle)}
                              className="inline-flex items-center gap-xs rounded-lg bg-primary border border-primary px-md py-xs text-xs font-semibold text-secondary hover:text-primary hover:bg-secondary shadow-xs"
                            >
                              <span>Switch to Circle</span>
                              <ArrowRight className="size-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* SCREEN 1: HOME (CIRCLE DASHBOARD) */}
        {activeTab === 'dashboard' && (
          <div className="space-y-2xl sm:space-y-3xl w-full">
            {members.length === 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-2xl sm:gap-3xl lg:gap-4xl items-start w-full">
                {/* Left Column (8 cols): Setup Guide & Overview */}
                <div className="lg:col-span-8 space-y-2xl sm:space-y-3xl">
                  <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl lg:p-4xl shadow-xs space-y-2xl">
                    <div className="flex items-start gap-lg sm:gap-xl">
                      <img
                        src="/logo.png"
                        alt="Ajo Steward"
                        className="size-14 sm:size-16 object-contain shrink-0"
                      />
                      <div className="space-y-sm">
                        <h3 className="text-heading-sm font-semibold text-primary">
                          No savings circle configured yet
                        </h3>
                        <p className="text-md text-secondary leading-relaxed">
                          Start with a clean slate by creating your circle roster and deploying its on-chain Move vault, or
                          restore an existing circle namespace from Walrus Memory in the Memory tab.
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-md pt-xl border-t border-secondary">
                      <button
                        onClick={() => startCreateNewCircle()}
                        className="inline-flex items-center gap-md rounded-full bg-brand-solid px-2xl py-md text-sm font-bold text-primary-on-brand shadow-md shadow-brand-500/20 hover:bg-brand-solid-hover hover:shadow-lg hover:shadow-brand-500/25 transition-all ring-4 ring-utility-brand-100 border border-brand-solid focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center shrink-0">
                          <PlusCircle className="size-4 text-fg-white stroke-[2.5]" />
                        </div>
                        <span>Create savings circle</span>
                      </button>
                      <button
                        onClick={() => {
                          setActiveTab('memories')
                          window.location.hash = 'memories'
                        }}
                        className="inline-flex items-center gap-sm rounded-full bg-primary px-xl py-md text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        <Brain className="size-4 text-fg-brand-primary shrink-0" />
                        <span>Open Walrus Memory</span>
                      </button>
                    </div>
                  </section>
                </div>
                {/* Right Column (4 cols): Steward Reasoning Mode */}
                <div className="lg:col-span-4 space-y-2xl sm:space-y-3xl">
                  {stewardModeCard}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-2xl sm:gap-3xl lg:gap-4xl items-start">
                {/* Main Column - 8 cols on desktop */}
                <div className="lg:col-span-8 space-y-2xl sm:space-y-3xl">
                  {isUnsupportedCircleToken && (
                    <div className="p-xl rounded-xl bg-utility-warning-50 border border-utility-warning-300 text-utility-warning-900 space-y-xs">
                      <div className="flex items-center gap-xs font-semibold text-sm text-utility-warning-900">
                        <AlertTriangle className="size-4 text-utility-warning-600 shrink-0" />
                        <span>Unsupported Contribution Token: WAL</span>
                      </div>
                      <p className="text-xs text-utility-warning-800 leading-relaxed">
                        This circle was configured with token <strong>WAL</strong> (<span className="font-mono text-[11px]">{tokenType}</span>). WAL is no longer supported as a contribution token in Ajo Steward.
                      </p>
                      <p className="text-xs font-medium text-utility-warning-900 leading-relaxed">
                        This circle can no longer accept new WAL contributions. Existing circle records, roster, and immutable agreements remain preserved on Walrus Memory.
                      </p>
                    </div>
                  )}

                  {Boolean(isVaultMismatched || (isVaultCompleted && selectedCycle === 1 && Object.keys(verifications).length === 0)) && (
                    <div className="p-xl rounded-xl bg-utility-warning-50 border border-utility-warning-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-md">
                      <div className="flex items-start gap-sm">
                        <AlertTriangle className="size-5 text-utility-warning-600 shrink-0 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-utility-warning-800">
                            Reused or Completed Vault Detected for "{circleName}"
                          </h4>
                          <p className="text-xs text-utility-warning-700 mt-xxs">
                            This circle is linked to a Move vault ({poolAddress.slice(0, 8)}...{poolAddress.slice(-6)}) {onchainState?.name ? `created for "${onchainState.name}"` : 'that has already finished its rotation'}. Deploy a fresh dedicated vault on Sui Testnet for this circle.
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleDeployFreshVaultForCircle}
                        disabled={isDeployingFreshVault || !currentAccount}
                        className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover shrink-0 disabled:opacity-50"
                      >
                        {isDeployingFreshVault ? (
                          <>
                            <Loader2 className="size-3.5 animate-spin" />
                            <span>Deploying Dedicated Vault...</span>
                          </>
                        ) : (
                          <>
                            <ShieldCheck className="size-3.5" />
                            <span>Deploy Dedicated Vault (1-Click)</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}

                  {/* Pot Summary Card */}
                  <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl lg:p-4xl shadow-xs space-y-2xl">
                    {/* Circle Header Row */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-sm pb-xl border-b border-secondary">
                      <div className="min-w-0 space-y-xxs">
                        <div className="flex items-center gap-xs flex-wrap">
                          <span className="px-sm py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-utility-brand-50 text-brand-primary border border-utility-brand-200">
                            Active Circle
                          </span>
                          <span className="text-xs font-mono text-tertiary">
                            ID: {circleId}
                          </span>
                          {poolAddress && (
                            <span className="text-xs font-mono text-tertiary hidden sm:inline-flex items-center gap-1">
                              <span>· Vault:</span>
                              <ExplorerLink
                                type="object"
                                value={poolAddress}
                                network={explorerNetwork}
                                shorten={true}
                                showCopy={true}
                              />
                            </span>
                          )}
                        </div>
                        <h2 className="text-heading-md sm:text-heading-lg font-bold text-primary truncate">
                          {circleName || 'Ajo Savings Circle'}
                        </h2>
                      </div>
                      <div className="flex items-center gap-xs shrink-0">
                        <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                          Cycle {selectedCycle} of {totalCycles}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTab('circles')
                            window.location.hash = 'circles'
                          }}
                          className="inline-flex items-center gap-xxs px-sm py-1 rounded-lg text-xs font-semibold text-secondary hover:text-primary hover:bg-secondary border border-secondary shadow-2xs transition-colors"
                          title="Switch to another savings circle"
                        >
                          <Layers className="size-3 text-fg-quaternary" />
                          <span className="hidden sm:inline">Switch</span>
                        </button>
                      </div>
                    </div>

                    {circleRules.trim() && (
                      <div className="rounded-lg border border-secondary bg-secondary/40 p-md space-y-xxs">
                        <div className="flex items-center gap-xs text-xs font-semibold text-primary">
                          <ShieldCheck className="size-3.5 text-brand-primary shrink-0" />
                          <span>Circle Rules &amp; Guidelines</span>
                        </div>
                        <p className="text-xs text-secondary whitespace-pre-line break-words leading-relaxed">
                          {circleRules}
                        </p>
                      </div>
                    )}

                    <div className="flex items-start justify-between">
                      <div>
                        <span className="text-sm text-tertiary">Verified on-chain pot this cycle</span>
                        <div className="mt-xs text-heading-md font-semibold text-primary tabular-nums flex items-center gap-xs">
                          <TokenLogo symbol={tokenSymbol} className="size-6 shrink-0" />
                          <span>
                            {totalOnchainPotReceived.toLocaleString()}{' '}
                            <span className="text-sm font-normal text-tertiary">
                              / {potPerCycle.toLocaleString()} {tokenSymbol}
                            </span>
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="space-y-sm">
                      <div className="flex justify-between text-sm text-tertiary">
                        <span>
                          {isCycleClaimed(selectedCycle)
                            ? 'Cycle pot fully funded & claimed'
                            : `${chainVerifiedCount} on-time on-chain · ${policyAcceptedCount} accepted by policy`}
                        </span>
                        <span className="tabular-nums font-semibold text-primary">
                          {potPerCycle > 0
                            ? Math.min(100, Math.round((totalOnchainPotReceived / potPerCycle) * 100))
                            : 0}
                          %
                        </span>
                      </div>
                      <div className="h-2.5 w-full overflow-hidden rounded-full bg-tertiary">
                        <div
                          className="h-full rounded-full bg-brand-solid transition-all duration-500 ease-out"
                          style={{
                            width: `${
                              potPerCycle > 0
                                ? Math.min(100, Math.round((totalOnchainPotReceived / potPerCycle) * 100))
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                      {potPerCycle > 0 &&
                        totalOnchainPotReceived >= potPerCycle &&
                        !isCycleClaimed(selectedCycle) && (
                          <div className="p-md rounded-lg bg-utility-success-50 border border-utility-success-200 text-xs text-utility-success-700 flex items-center justify-between gap-sm flex-wrap">
                            <span>
                              <strong>All Cycle {selectedCycle} contributions complete!</strong>{' '}
                              {scheduledRecipient?.name || 'The scheduled recipient'} can now claim the{' '}
                              {potPerCycle.toLocaleString()} {tokenSymbol} pot to automatically advance the vault to Cycle{' '}
                              {selectedCycle + 1 <= totalCycles ? selectedCycle + 1 : selectedCycle}.
                            </span>
                            <button
                              type="button"
                              onClick={() => setActiveTab('payout')}
                              className="inline-flex items-center gap-xxs rounded-md bg-utility-success-700 px-md py-xs text-xs font-semibold text-fg-white hover:opacity-90"
                            >
                              <span>Claim & Advance Cycle</span>
                              <ArrowRight className="size-3.5" />
                            </button>
                          </div>
                        )}
                    </div>

                    {scheduledRecipient && (
                      <div className="pt-xl border-t border-secondary flex items-center justify-between">
                        <div className="flex items-center gap-lg">
                          <div className="w-12 h-12 rounded-full bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200 flex items-center justify-center font-bold text-sm shrink-0">
                            {scheduledRecipient.name
                              .split(' ')
                              .map((n) => n[0])
                              .join('')}
                          </div>
                          <div>
                            <p className="text-xs text-tertiary">Scheduled cycle recipient:</p>
                            <p className="text-md font-semibold text-primary">
                              {scheduledRecipient.name}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => setActiveTab('payout')}
                          className="inline-flex items-center gap-sm rounded-lg bg-primary px-xl py-md text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                        >
                          <span>Review payout</span>
                          <ChevronRight className="size-4 text-fg-quaternary shrink-0" />
                        </button>
                      </div>
                    )}
                  </section>

                  {/* Cycle Timeline Strip */}
                  <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl shadow-xs space-y-lg">
                    <div className="flex items-center justify-between mb-sm">
                      <span className="text-sm font-medium text-secondary">Cycle rotation</span>
                      <span className="text-xs text-tertiary">Click cycle to inspect</span>
                    </div>
                    <div className="flex items-center justify-between relative px-xs">
                      <div className="absolute left-6 right-6 top-4 h-0.5 bg-secondary -z-0" />

                      {Array.from({ length: totalCycles }, (_, i) => i + 1).map((cNum) => {
                        const isCurrent = cNum === selectedCycle
                        const isCompleted = cNum < selectedCycle
                        return (
                          <button
                            key={cNum}
                            onClick={() => setSelectedCycle(cNum)}
                            className="flex flex-col items-center gap-xs z-10 focus-visible:ring-2 focus-visible:ring-focus-ring rounded-full"
                          >
                            <div
                              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-all border ${
                                isCurrent
                                  ? 'border-brand bg-brand-solid text-primary-on-brand shadow-xs'
                                  : isCompleted
                                  ? 'border-utility-success-200 bg-utility-success-50 text-utility-success-700'
                                  : 'border-secondary bg-secondary text-quaternary hover:border-primary'
                              }`}
                            >
                              {isCompleted ? (
                                <Check className="size-4 text-fg-success-primary shrink-0" />
                              ) : (
                                cNum
                              )}
                            </div>
                            <span
                              className={`text-xs ${
                                isCurrent ? 'font-semibold text-brand-primary' : 'text-tertiary'
                              }`}
                            >
                              C{cNum}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </section>

                  {/* Member Avatars */}
                  <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                    <div className="flex items-center justify-between mb-sm">
                      <span className="text-sm font-medium text-secondary">Member circle</span>
                      <span className="text-xs text-tertiary">Chain status rings</span>
                    </div>
                    <div className="flex items-center justify-between gap-xs overflow-x-auto pb-xs">
                      {members.map((member) => {
                        const recKey = `${member.id}_${selectedCycle}`
                        const raw = verifications[recKey]
                        const hasRealPendingDigest = Boolean(
                          raw?.status === 'Pending' &&
                          (raw?.txDigest || (raw?.txDigests && raw?.txDigests.length > 0) || raw?.code === 'indexing_pending')
                        )
                        const chainStatus = raw?.status === 'Pending' && !hasRealPendingDigest ? 'Unverified' : raw?.status
                        const ringColor =
                          chainStatus === 'Verified'
                            ? 'ring-2 ring-utility-success-600'
                            : chainStatus === 'Late' ||
                              chainStatus === 'WrongToken' ||
                              chainStatus === 'WrongAmount'
                            ? 'ring-2 ring-error-primary'
                            : chainStatus === 'Partial' || (chainStatus === 'Pending' && hasRealPendingDigest)
                            ? 'ring-2 ring-warning-primary'
                            : 'ring-2 ring-utility-gray-200'

                        return (
                          <div key={member.id} className="flex flex-col items-center gap-xs min-w-[64px] max-w-[72px]">
                            <div
                              className={`w-11 h-11 rounded-full p-0.5 bg-primary ${ringColor} flex items-center justify-center transition-all`}
                            >
                              <div
                                className={`w-full h-full rounded-full flex items-center justify-center text-xs font-semibold ${member.avatarColor}`}
                              >
                                {member.name
                                  .split(' ')
                                  .map((n) => n[0])
                                  .join('')}
                              </div>
                            </div>
                            <span className="text-xs text-primary font-medium truncate max-w-[72px] text-center" title={member.name}>
                              {member.name.split(' ')[0]}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </section>

                  {/* Contributions Table with Digest-First Verification + Separate Chain & Policy Status */}
                  <div className="overflow-hidden rounded-xl border border-secondary bg-primary shadow-xs">
                    <div className="p-xl border-b border-secondary flex flex-wrap items-center justify-between gap-sm">
                      <div>
                        <h3 className="text-heading-xs font-semibold text-primary">
                          Contributions this cycle
                        </h3>
                        <p className="mt-xs text-sm text-tertiary">
                          On-chain member contributions verified via Tatum Sui Gateway
                        </p>
                        {currentAccount && (
                          <p className="mt-xs text-xs" role="status">
                            {connectedMember ? (
                              <span className="text-utility-success-700">
                                Connected as {connectedMember.name}
                              </span>
                            ) : (
                              <span className="text-utility-warning-700">
                                Connected wallet is not a member of this circle
                              </span>
                            )}
                          </p>
                        )}
                        {poolAddressMember && (
                          <div
                            className="mt-sm flex flex-wrap items-center justify-between gap-sm rounded-lg border border-utility-error-200 bg-utility-error-50 px-md py-sm text-xs text-utility-error-700"
                            role="alert"
                          >
                            <span>
                              Pool vault matches {poolAddressMember.name}’s member wallet. Contributions to the same address are self-transfers and will not fund a separate pool.
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setCreateStep(3)
                                setActiveTab('create')
                              }}
                              className="font-semibold underline underline-offset-2"
                            >
                              Change vault address
                            </button>
                          </div>
                        )}
                      </div>
                      <span className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700">
                        <TokenLogo symbol={tokenSymbol} className="size-3.5 shrink-0" />
                        <span>{contributionPerMember} {tokenSymbol} each</span>
                      </span>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="sticky top-0 z-10 bg-secondary">
                          <tr className="border-b border-secondary text-left">
                            <th className="px-xl py-md text-sm font-semibold text-quaternary">
                              Member & Contribution Status
                            </th>
                            <th className="px-lg py-md text-sm font-semibold text-quaternary">
                              Amount
                            </th>
                            <th className="px-xl py-md text-sm font-semibold text-quaternary">
                              Chain Fact & Group Policy
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((member) => {
                            const recKey = `${member.id}_${selectedCycle}`
                            const raw = verifications[recKey]
                            const hasRealPendingDigest = Boolean(
                              raw?.status === 'Pending' &&
                              (raw?.txDigest || (raw?.txDigests && raw?.txDigests.length > 0) || raw?.code === 'indexing_pending')
                            )
                            const chainStatus: CycleStatus =
                              raw?.status === 'Pending' && !hasRealPendingDigest
                                ? 'Unverified'
                                : raw?.status || 'Unverified'

                            const policyStatus =
                              raw?.policy?.policyStatus ||
                              (raw
                                ? raw.status === 'Pending'
                                  ? (hasRealPendingDigest ? 'Pending contribution' : 'Awaiting contribution')
                                  : 'Unverified'
                                : 'Awaiting contribution')

                            const chainBadgeColor =
                              chainStatus === 'Verified'
                                ? 'utility-success'
                                : chainStatus === 'Partial' || chainStatus === 'Pending' || chainStatus === 'WrongAmount'
                                ? 'utility-warning'
                                : 'utility-error'

                            const policyCounts = raw?.policy?.countsTowardPot ?? false
                            const policyBadgeColor = policyCounts
                              ? 'utility-success'
                              : raw?.policy?.policyVerdict === 'in_progress_known_pattern' ||
                                (chainStatus === 'Pending' && hasRealPendingDigest)
                              ? 'utility-warning'
                              : 'utility-error'

                            const statusBadgeStyle: Record<string, string> = {
                              'utility-success': 'border-utility-success-200 bg-utility-success-50 text-utility-success-700',
                              'utility-warning': 'border-utility-warning-200 bg-utility-warning-50 text-utility-warning-700',
                              'utility-error': 'border-utility-error-200 bg-utility-error-50 text-utility-error-700',
                            }

                            const tx = raw?.txDigest

                            return (
                              <tr
                                key={member.id}
                                className="border-b border-secondary hover:bg-secondary-hover transition-colors"
                              >
                                <td className="px-xl py-xl text-md text-tertiary">
                                  <div className="flex items-start gap-md min-w-0">
                                    <div
                                      className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs shrink-0 ${member.avatarColor}`}
                                    >
                                      {member.name
                                        .split(' ')
                                        .map((n) => n[0])
                                        .join('')}
                                    </div>
                                    <div className="min-w-0 flex-1 space-y-xs">
                                      <div className="flex items-center gap-xs flex-wrap">
                                        <p className="text-primary font-medium">{member.name}</p>
                                        {raw?.elapsedDisplay && (
                                          <span className="inline-flex items-center gap-xxs rounded-full border border-utility-warning-200 bg-utility-warning-50 px-sm py-0.5 text-[11px] font-medium text-utility-warning-700">
                                            <Clock className="size-3 text-fg-warning-primary shrink-0" />
                                            <span>{raw.elapsedDisplay}</span>
                                          </span>
                                        )}
                                      </div>
                                      <div className="text-xs font-mono text-tertiary">
                                        <ExplorerLink
                                          type="address"
                                          value={member.address}
                                          network={explorerNetwork}
                                          shorten={true}
                                          showCopy={true}
                                        />
                                      </div>

                                      {/* Breakdown: Paid by deadline vs Remaining */}
                                      {raw?.amountPaidByDeadline !== undefined &&
                                        raw.amountPaidByDeadline < contributionPerMember && (
                                          <p className="text-[11px] text-tertiary">
                                            Paid by deadline: <strong className="text-primary">{raw.amountPaidByDeadline}</strong> · Remaining: <strong className="text-primary">{raw.amountRemainingOutstanding ?? (contributionPerMember - raw.amountPaidByDeadline)}</strong> {tokenSymbol}
                                          </p>
                                        )}

                                      {/* Factual Historical Behavior Label */}
                                      {raw?.isLateCompletion && (
                                        <div className="flex items-center gap-xs flex-wrap pt-xxs">
                                          <span className="text-[10px] text-tertiary bg-secondary px-xs py-0.5 rounded border border-secondary">
                                            Historical contribution behavior
                                          </span>
                                          {raw?.historicalLateness?.durableWalrusConfirmed ? (
                                            <span className="inline-flex items-center gap-xs text-[10px] text-success-primary font-mono font-medium">
                                              <span>✓ Durably stored in Walrus Memory</span>
                                              {raw?.historicalLateness?.walrusBlobId && (
                                                <ExplorerLink
                                                  type="walrus-blob"
                                                  value={raw.historicalLateness.walrusBlobId}
                                                  shorten={true}
                                                />
                                              )}
                                            </span>
                                          ) : (
                                            <span className="text-[10px] text-tertiary font-mono">
                                              On-chain confirmed (Walrus sync pending)
                                            </span>
                                          )}
                                        </div>
                                      )}

                                      {/* Connected user contribution status & overpayment protection */}
                                      {currentAccount &&
                                        !poolAddressMember &&
                                        connectedMember?.id === member.id &&
                                        authenticatedWallet &&
                                        normalizeSuiAddress(authenticatedWallet) ===
                                          normalizeSuiAddress(currentAccount.address) && (
                                          <div className="pt-xs">
                                            {raw &&
                                            (raw.status === 'Verified' || raw.status === 'Late') &&
                                            ((raw.amountReceived ?? 0) >= contributionPerMember ||
                                              raw.policy?.countsTowardPot ||
                                              policyStatus.startsWith('Accepted')) ? (
                                              <div className="flex items-center gap-xs flex-wrap">
                                                <span className="inline-flex items-center gap-xxs px-sm py-1 rounded-lg text-xs font-semibold bg-utility-success-50 text-utility-success-700 border border-utility-success-200">
                                                  <CheckCheck className="size-3.5 text-fg-success-primary shrink-0" />
                                                  <span>Contributed for Cycle {selectedCycle}</span>
                                                </span>
                                                <span className="text-[11px] text-tertiary">
                                                  (Paid · Next contribution opens in Cycle{' '}
                                                  {selectedCycle + 1 <= totalCycles
                                                    ? selectedCycle + 1
                                                    : 'next circle'}
                                                  )
                                                </span>
                                              </div>
                                            ) : hasRealPendingDigest ? (
                                              <div className="flex items-center gap-xs">
                                                <span className="inline-flex items-center gap-xxs px-sm py-1 rounded-lg text-xs font-semibold bg-utility-warning-50 text-utility-warning-700 border border-utility-warning-200">
                                                  <Clock className="size-3.5 text-fg-warning-primary shrink-0" />
                                                  <span>Contribution Submitted (Pending Verification)</span>
                                                </span>
                                              </div>
                                            ) : Date.now() < Date.parse(windowStart) - 60000 ? (
                                              <div className="flex items-center gap-xs flex-wrap">
                                                <span className="inline-flex items-center gap-xxs px-sm py-1 rounded-lg text-xs font-semibold bg-secondary text-tertiary border border-secondary">
                                                  <Clock className="size-3.5 text-fg-quaternary shrink-0" />
                                                  <span>Cycle opens at {formatLocalDateTimeWithZone(windowStart, timeZone, 'short')}</span>
                                                </span>
                                              </div>
                                            ) : isUnsupportedCircleToken ? (
                                              <div className="flex items-center gap-xs flex-wrap">
                                                <span className="inline-flex items-center gap-xxs px-sm py-1 rounded-lg text-xs font-semibold bg-utility-warning-50 text-utility-warning-800 border border-utility-warning-300">
                                                  <AlertTriangle className="size-3.5 text-utility-warning-600 shrink-0" />
                                                  <span>Contributions Disabled: Unsupported Token (WAL)</span>
                                                </span>
                                                <span className="text-[11px] text-tertiary">
                                                  (Circle configured with WAL. New contributions are no longer accepted.)
                                                </span>
                                              </div>
                                            ) : (
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  handleOpenContributeModal(
                                                    member.address,
                                                    contributionPerMember - (raw?.status === 'Partial' ? (raw?.amountReceived ?? 0) : 0)
                                                  )
                                                }
                                                className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-md py-xs text-xs font-semibold text-primary-on-brand hover:bg-brand-solid-hover shadow-xs transition-colors"
                                              >
                                                <Coins className="size-3 text-fg-white shrink-0" />
                                                <span>
                                                  Contribute{' '}
                                                  {(
                                                    contributionPerMember -
                                                    (raw?.status === 'Partial' ? (raw?.amountReceived ?? 0) : 0)
                                                  ).toLocaleString()}{' '}
                                                  {tokenSymbol}
                                                  {Date.now() > Date.parse(windowEnd) ? ' (Late)' : ''}
                                                </span>
                                              </button>
                                            )}
                                          </div>
                                        )}

                                      {/* Plain-language Verification Pending indicator with Retry */}
                                      {tx && (chainStatus === 'Pending' || chainStatus === 'Unverified') && (
                                        <div className="flex items-center gap-xs pt-xxs">
                                          <span className="inline-flex items-center gap-xxs px-sm py-0.5 rounded-full text-[11px] font-medium bg-utility-warning-50 text-utility-warning-700 border border-utility-warning-200">
                                            <Clock className="size-3 text-fg-warning-primary shrink-0" />
                                            <span>{chainStatus === 'Pending' ? 'Verification Pending' : 'Verification Unconfirmed'}</span>
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => handleVerifyMemberDigest(member, tx)}
                                            disabled={verifyingMemberId === member.id}
                                            className="inline-flex items-center gap-xxs px-sm py-0.5 rounded-md bg-secondary hover:bg-secondary-hover text-xs font-semibold text-primary transition-colors border border-secondary"
                                          >
                                            {verifyingMemberId === member.id ? (
                                              <>
                                                <Loader2 className="size-3 animate-spin shrink-0 text-fg-warning-primary" />
                                                <span>Verifying...</span>
                                              </>
                                            ) : (
                                              <>
                                                <RotateCcw className="size-3 text-fg-quaternary shrink-0" />
                                                <span>Retry verification</span>
                                              </>
                                            )}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleDismissMemberDigest(member)}
                                            className="inline-flex items-center gap-xxs px-sm py-0.5 rounded-md bg-secondary hover:bg-secondary-hover text-xs font-medium text-tertiary hover:text-primary transition-colors border border-secondary"
                                            title="Dismiss unverified transaction attempt and clear saved digest"
                                          >
                                            <X className="size-3 text-fg-quaternary shrink-0" />
                                            <span>Dismiss</span>
                                          </button>
                                        </div>
                                      )}

                                      {/* Optional Transaction Details Disclosure (for troubleshooting) */}
                                      {tx ? (
                                        <details className="group text-xs text-tertiary pt-xxs">
                                          <summary className="cursor-pointer hover:text-primary transition-colors text-[11px] font-medium select-none list-none inline-flex items-center gap-xxs">
                                            <span className="text-quaternary group-open:rotate-90 transition-transform">▸</span>
                                            <span>Transaction details</span>
                                          </summary>
                                          <div className="mt-xs flex flex-wrap items-center gap-xs">
                                            {tx.split(',').map((singleTx, idx) => (
                                              <ExplorerLink
                                                key={idx}
                                                type="tx"
                                                value={singleTx.trim()}
                                                network={explorerNetwork}
                                                isPendingVerification={chainStatus === 'Pending' || chainStatus === 'Unverified'}
                                              />
                                            ))}
                                          </div>
                                        </details>
                                      ) : raw?.error ? (
                                        <span className="text-xs text-tertiary block pt-xxs">
                                          {raw.error}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                </td>

                                <td className="px-lg py-xl text-md text-tertiary tabular-nums font-medium text-primary align-top">
                                  <div className="flex items-center gap-xs">
                                    <TokenLogo symbol={tokenSymbol} className="size-4 shrink-0" />
                                    <span>{raw?.amountReceived ?? 0}</span>
                                    <span className="text-xs font-normal text-tertiary">
                                      {tokenSymbol}
                                    </span>
                                  </div>
                                </td>

                                <td className="px-xl py-xl text-md text-tertiary align-top">
                                  <div className="flex flex-col gap-xs items-start">
                                    <span
                                      className={`inline-flex items-center gap-xs rounded-full border px-md py-xxs text-xs font-medium ${
                                        statusBadgeStyle[chainBadgeColor] || statusBadgeStyle['utility-error']
                                      }`}
                                    >
                                      {chainBadgeColor === 'utility-success' && (
                                        <CheckCircle2 className="size-3 text-fg-success-primary shrink-0" />
                                      )}
                                      {chainBadgeColor === 'utility-error' && (
                                        <AlertTriangle className="size-3 text-fg-error-primary shrink-0" />
                                      )}
                                      {chainBadgeColor === 'utility-warning' && (
                                        <Clock className="size-3 text-fg-warning-primary shrink-0" />
                                      )}
                                      <span>Chain: {chainStatus === 'WrongAmount' ? 'Overpayment / Mismatch' : chainStatus}</span>
                                    </span>

                                    <span
                                      className={`inline-flex items-center gap-xs rounded-full border px-md py-xxs text-xs font-medium ${
                                        statusBadgeStyle[policyBadgeColor] || statusBadgeStyle['utility-error']
                                      }`}
                                    >
                                      <span>Policy: {policyStatus}</span>
                                    </span>

                                    {withMemory && raw?.policy?.citedMemory?.walrusBlobId && (
                                      <div className="inline-flex items-center gap-xs text-[11px] text-secondary pt-xxs flex-wrap">
                                        <span className="text-tertiary truncate max-w-[200px]" title={raw.policy.citedMemory.title}>
                                          Rule/Memory: {raw.policy.citedMemory.title}
                                        </span>
                                        <ExplorerLink
                                          type="walrus-blob"
                                          value={raw.policy.citedMemory.walrusBlobId}
                                          shorten={true}
                                        />
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* Sidebar Column - 4 cols on desktop */}
                <div className="lg:col-span-4 space-y-lg">
                  {stewardModeCard}

                  {scheduledRecipient && (
                    <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-secondary">Cycle Payout Target</span>
                        <span className="inline-flex items-center rounded-full border border-utility-brand-200 bg-utility-brand-50 px-sm py-xxs text-xs font-semibold text-utility-brand-700">
                          Cycle {selectedCycle}
                        </span>
                      </div>
                      <div className="flex items-center gap-md">
                        <div className="w-12 h-12 rounded-full bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200 flex items-center justify-center font-bold text-sm shrink-0">
                          {scheduledRecipient.name
                            .split(' ')
                            .map((n) => n[0])
                            .join('')}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-tertiary">Scheduled recipient:</p>
                          <p className="text-sm font-semibold text-primary truncate">
                            {scheduledRecipient.name}
                          </p>
                          <div className="pt-xxs">
                            <ExplorerLink
                              type="address"
                              value={scheduledRecipient.address}
                              network={explorerNetwork}
                            />
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => setActiveTab('payout')}
                        className="w-full inline-flex items-center justify-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        <span>Review payout details</span>
                        <ChevronRight className="size-4 text-fg-quaternary shrink-0" />
                      </button>
                    </section>
                  )}

                  <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                    <h4 className="text-sm font-semibold text-primary">Circle Overview</h4>
                    <div className="space-y-xs text-xs">
                      <div className="flex justify-between items-center text-secondary">
                        <span className="text-tertiary">Pool Address:</span>
                        {poolAddress ? (
                          <ExplorerLink
                            type="object"
                            value={poolAddress}
                            network={explorerNetwork}
                          />
                        ) : (
                          <span className="text-tertiary font-mono">Not set</span>
                        )}
                      </div>
                      <div className="flex justify-between text-secondary">
                        <span className="text-tertiary">Cycle Frequency:</span>
                        <span className="text-primary font-medium">{cycleLength}</span>
                      </div>
                      <div className="flex justify-between text-secondary">
                        <span className="text-tertiary">Time Zone:</span>
                        <span className="text-primary font-medium truncate max-w-[150px] text-right" title={timeZone}>{timeZone}</span>
                      </div>
                      <div className="flex justify-between text-secondary">
                        <span className="text-tertiary">Current Deadline:</span>
                        <span className="text-primary font-medium text-right text-[11px]" title={windowEnd}>
                          {formatLocalDateTimeWithZone(windowEnd, timeZone, 'short')}
                        </span>
                      </div>
                      <div className="flex justify-between text-secondary">
                        <span className="text-tertiary">Rotation Duration:</span>
                        <span className="text-primary font-medium">{formatRotationDuration(cycleLength, members.length)}</span>
                      </div>
                      <div className="flex justify-between text-secondary">
                        <span className="text-tertiary">Contribution:</span>
                        <span className="text-primary font-medium">{contributionPerMember} {tokenSymbol}</span>
                      </div>
                      <div className="flex justify-between text-secondary">
                        <span className="text-tertiary">Circle Members:</span>
                        <span className="text-primary font-medium">{members.length} members</span>
                      </div>
                    </div>
                    <div className="pt-sm border-t border-secondary flex flex-col gap-xs">
                      <button
                        onClick={() => setActiveTab('memories')}
                        className="w-full inline-flex items-center justify-center gap-xs rounded-lg bg-primary px-lg py-sm text-xs font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover"
                      >
                        <Brain className="size-3.5 text-fg-brand-primary shrink-0" />
                        <span>Open Walrus Memory</span>
                      </button>
                    </div>
                  </section>
                </div>
              </div>
            )}
          </div>
        )}

        {/* SCREEN 2: CREATE CIRCLE */}
        {activeTab === 'create' && (
          <div className="space-y-2xl sm:space-y-3xl w-full">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-2xl sm:gap-3xl lg:gap-4xl items-start w-full">
              {/* Left Column (8 cols): Step Form Wizard */}
              <div className="lg:col-span-8">
                <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl lg:p-4xl shadow-xs space-y-xl">
                  <div>
                    <div className="flex items-center justify-between text-xs font-medium text-secondary mb-sm">
                      <span>Step {createStep} of 3</span>
                      <span className="text-brand-primary font-semibold">
                        {createStep === 1
                          ? 'Circle basics'
                          : createStep === 2
                          ? 'Members'
                          : 'Review & Deploy'}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-tertiary">
                      <div
                        className="h-full rounded-full bg-brand-solid transition-all"
                        style={{ width: `${(createStep / 3) * 100}%` }}
                      />
                    </div>
                  </div>

            {createError && (
              <div className="p-md rounded-lg bg-utility-error-50 border border-error-subtle text-xs text-error-primary">
                {createError}
              </div>
            )}

            {createStep === 1 && (
              <div className="space-y-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-heading-xs font-semibold text-primary">Circle details</h3>
                    <p className="mt-xs text-sm text-tertiary">
                      Name your savings group and set the contribution rules and cycle window.
                    </p>
                  </div>
                  {(createCircleName || createMembers.length > 0 || createStep > 1) && (
                    <button
                      type="button"
                      onClick={() => {
                        startCreateNewCircle()
                      }}
                      className="text-xs text-tertiary hover:text-error-primary underline font-medium"
                    >
                      Clear Form
                    </button>
                  )}
                </div>

                <div className="space-y-md">
                  <div className="flex flex-col gap-sm">
                    <label className="text-sm font-medium text-secondary">Circle name</label>
                    <input
                      type="text"
                      value={createCircleName}
                      onChange={(e) => {
                        setCreateCircleName(e.target.value)
                        setCreateProposedCircleId('')
                      }}
                      placeholder="Enter circle name..."
                      className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </div>

                  <div className="flex flex-col gap-sm">
                    <label className="text-sm font-medium text-secondary">
                      Contribution per member per cycle
                    </label>
                    <input
                      type="number"
                      value={createContributionPerMember || ''}
                      onChange={(e) => setCreateContributionPerMember(Number(e.target.value) || 0)}
                      placeholder="Amount"
                      className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary tabular-nums focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </div>

                  <TokenSelector
                    selectedCoinType={createTokenType}
                    onSelectToken={(tok) => {
                      setCreateTokenType(tok.coinType)
                    }}
                    network={explorerNetwork}
                  />

                  <SchedulePicker
                    cycleLength={createCycleLength}
                    onCycleLengthChange={setCreateCycleLength}
                    windowStart={createWindowStart}
                    onWindowStartChange={setCreateWindowStart}
                    windowEnd={createWindowEnd}
                    onWindowEndChange={setCreateWindowEnd}
                    timeZone={createTimeZone}
                    onTimeZoneChange={setCreateTimeZone}
                    memberCount={createMembers.length || 1}
                  />

                  <div className="pt-md border-t border-secondary space-y-sm">
                    <div className="flex flex-wrap items-center justify-between gap-xs">
                      <label htmlFor="create-circle-rules" className="text-sm font-medium text-primary">
                        Circle Rules &amp; Guidelines{' '}
                        <span className="text-xs font-normal text-tertiary">(Optional)</span>
                      </label>
                      {createCircleRules.trim() && (
                        <button
                          type="button"
                          onClick={() => setCreateCircleRules('')}
                          className="text-xs font-medium text-tertiary hover:text-primary transition-colors"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-xs">
                      {[
                        {
                          label: '+ Grace Window',
                          rule: 'Members get a 48-hour grace period after the cycle due date before being marked late.',
                        },
                        {
                          label: '+ Split Payments Allowed',
                          rule: 'Split or partial payments are allowed as long as the full contribution arrives before the cycle deadline.',
                        },
                        {
                          label: '+ Reminder Policy',
                          rule: 'Send a gentle reminder 24 hours before each cycle deadline and escalate after 48 hours past due.',
                        },
                      ].map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() =>
                            setCreateCircleRules((prev) => {
                              const trimmed = prev.trim()
                              if (!trimmed) return preset.rule
                              if (trimmed.includes(preset.rule)) return prev
                              return `${trimmed}\n${preset.rule}`
                            })
                          }
                          className="px-sm py-1 rounded-full text-xs font-medium bg-secondary text-secondary hover:text-primary hover:bg-tertiary border border-secondary transition-colors"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>

                    <textarea
                      id="create-circle-rules"
                      rows={3}
                      value={createCircleRules}
                      onChange={(e) => setCreateCircleRules(e.target.value)}
                      placeholder="Write any grace windows, split-payment rules, emergency swap norms, or reminder guidelines for your AI Steward to remember..."
                      className="w-full px-md py-sm rounded-lg border border-primary bg-primary text-sm text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary resize-y"
                    />
                    <p className="text-xs text-tertiary leading-relaxed">
                      The Move contract enforces contribution amount, token type, and fixed payout order on-chain. Written circle rules are stored in Walrus Memory as group policy so your AI Steward can cite and apply them from Cycle 1.
                    </p>
                  </div>
                </div>

                <div className="pt-md flex justify-end">
                  <button
                    onClick={() => {
                      if (!createCircleName.trim()) {
                        setCreateError('Please enter a circle name.')
                        return
                      }
                      if (createContributionPerMember <= 0) {
                        setCreateError('Contribution amount must be greater than 0.')
                        return
                      }
                      if (createTokenType.toLowerCase().includes('wal')) {
                        setCreateError('WAL is no longer supported as a contribution token. Please select SUI or USDC.')
                        return
                      }
                      const v = validateSchedule(createWindowStart, createWindowEnd, createCycleLength, createTimeZone)
                      if (!v.valid) {
                        setCreateError(v.error || 'Invalid schedule.')
                        return
                      }
                      setCreateError(null)
                      setCreateStep(2)
                    }}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <span>Continue to members</span>
                    <ArrowRight className="size-4 text-fg-white shrink-0" />
                  </button>
                </div>
              </div>
            )}

            {createStep === 2 && (
              <div className="space-y-lg">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Group members</h3>
                  <p className="mt-xs text-sm text-tertiary">
                    Add the participants and their Sui wallet addresses.
                  </p>
                </div>

                {createMembers.length === 0 ? (
                  <p className="text-xs text-tertiary italic">No members added yet.</p>
                ) : (
                  <div className="space-y-xs max-h-56 overflow-y-auto">
                    {createMembers.map((m, idx) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between p-md bg-secondary rounded-lg border border-secondary text-xs"
                      >
                        <div className="flex items-center gap-sm min-w-0">
                          <span className="w-5 h-5 rounded-full bg-utility-brand-50 text-utility-brand-700 flex items-center justify-center font-bold text-xs shrink-0">
                            {idx + 1}
                          </span>
                          <div className="min-w-0">
                            <p className="font-semibold text-primary truncate">{m.name}</p>
                            <div className="mt-xxs">
                              <ExplorerLink
                                type="address"
                                value={m.address}
                                network={explorerNetwork}
                              />
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setCreateMembers((prev) => prev.filter((item) => item.id !== m.id))
                          }
                          className="text-xs text-tertiary hover:text-error-primary px-sm"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="p-md bg-secondary rounded-xl border border-secondary space-y-sm">
                  <p className="text-sm font-medium text-secondary">Add a member</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
                    <input
                      type="text"
                      placeholder="Full Name"
                      value={newMemberName}
                      onChange={(e) => setNewMemberName(e.target.value)}
                      className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                    <input
                      type="text"
                      placeholder="Sui Address (0x...)"
                      value={newMemberAddress}
                      onChange={(e) => setNewMemberAddress(e.target.value)}
                      className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </div>
                  <button
                    onClick={handleAddMember}
                    className="inline-flex items-center justify-center gap-sm w-full rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-brand-primary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    + Add to circle roster
                  </button>
                </div>

                <div className="pt-md flex items-center justify-between">
                  <button
                    onClick={() => setCreateStep(1)}
                    className="inline-flex items-center px-lg py-sm text-sm font-semibold text-secondary hover:text-primary"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => {
                      if (createMembers.length < 2) {
                        setCreateError('Add at least 2 members to the circle before continuing.')
                        return
                      }
                      setCreateError(null)
                      if (!createProposedCircleId) {
                        setCreateProposedCircleId(
                          generateUniqueCircleId(
                            createCircleName,
                            currentAccount?.address || createMembers[0]?.address
                          )
                        )
                      }
                      setCreateStep(3)
                    }}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover"
                  >
                    <span>Continue to review & deploy</span>
                    <ArrowRight className="size-4 text-fg-white shrink-0" />
                  </button>
                </div>
              </div>
            )}

            {createStep === 3 && (
              <div className="space-y-lg">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Review & Deploy Circle</h3>
                  <p className="mt-xs text-sm text-tertiary">
                    Review your circle rules. Next, you will deploy a dedicated on-chain Move vault object for this circle on Sui Testnet.
                  </p>
                </div>

                <div className="p-xl bg-secondary rounded-xl border border-secondary space-y-md text-sm">
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Circle name</span>
                    <span className="font-semibold text-primary">{createCircleName || '—'}</span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Circle ID (unique namespace)</span>
                    <span className="font-mono text-xs text-primary">
                      {createProposedCircleId || generateUniqueCircleId(createCircleName, currentAccount?.address || createMembers[0]?.address) || '—'}
                    </span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Contribution</span>
                    <span className="font-semibold text-primary tabular-nums">
                      {createContributionPerMember} {findTokenByCoinType(createTokenType, explorerNetwork)?.symbol || 'SUI'} / member
                    </span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Total pot per cycle</span>
                    <span className="font-semibold text-brand-primary tabular-nums">
                      {(createContributionPerMember * (createMembers.length || 1)).toLocaleString()} {findTokenByCoinType(createTokenType, explorerNetwork)?.symbol || 'SUI'}
                    </span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Number of members</span>
                    <span className="font-semibold text-primary">
                      {createMembers.length} members ({createMembers.length} cycles)
                    </span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Cycle cadence</span>
                    <span className="font-semibold text-primary">{createCycleLength}</span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Time zone</span>
                    <span className="font-medium text-primary">{createTimeZone}</span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Cycle 1 Window</span>
                    <span className="font-medium text-primary text-right text-xs">
                      {formatLocalDateTimeWithZone(createWindowStart, createTimeZone, 'short')} →{' '}
                      {formatLocalDateTimeWithZone(createWindowEnd, createTimeZone, 'short')}
                    </span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Rotation duration</span>
                    <span className="font-semibold text-primary">
                      {formatRotationDuration(createCycleLength, createMembers.length)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center pb-xs border-b border-secondary">
                    <span className="text-tertiary">Vault Type</span>
                    <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded text-xs border border-emerald-200">
                      <ShieldCheck className="size-3.5" />
                      Move Circle&lt;{findTokenByCoinType(createTokenType, explorerNetwork)?.symbol || 'SUI'}&gt; Shared Object
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-tertiary">On-Chain Vault</span>
                    {createPoolAddress ? (
                      <ExplorerLink
                        type="object"
                        value={createPoolAddress}
                        network={explorerNetwork}
                      />
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-tertiary bg-secondary px-2 py-0.5 rounded border border-secondary">
                        <Clock className="size-3 text-tertiary" />
                        Not yet deployed (click below)
                      </span>
                    )}
                  </div>
                </div>

                {/* Move Smart Contract Deployment Card (Only shown if package is not configured) */}
                {!ajoConfig?.packageConfigured && (
                  <div className="p-xl rounded-xl bg-utility-warning-50 border border-utility-warning-200 space-y-sm">
                    <div className="flex items-start gap-sm">
                      <AlertTriangle className="size-5 text-utility-warning-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-utility-warning-800">
                          Ajo Move Smart Contract Not Yet Published on Sui Testnet
                        </p>
                        <p className="text-xs text-utility-warning-700 mt-xxs">
                          The Ajo Move bytecode is compiled and ready in the project. Click below to publish it to Sui Testnet in 1 transaction with your connected wallet.
                        </p>
                      </div>
                    </div>
                    {publishError && (
                      <div className="p-sm rounded bg-utility-error-50 text-utility-error-700 text-xs">
                        {publishError}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={handlePublishPackage}
                      disabled={isPublishingPackage || !currentAccount}
                      className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover disabled:opacity-50"
                    >
                      {isPublishingPackage ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          <span>Publishing Move Contract...</span>
                        </>
                      ) : (
                        <>
                          <Lock className="size-3.5" />
                          <span>Publish Move Contract to Testnet (1-Click)</span>
                        </>
                      )}
                    </button>
                  </div>
                )}

                <p className="rounded-lg border border-utility-brand-200 bg-utility-brand-50 p-md text-sm text-brand-primary">
                  {!createPoolAddress
                    ? 'First, deploy your dedicated on-chain Move vault to Sui Testnet. Once confirmed, you will activate the circle and save its rules to Walrus Memory.'
                    : 'Vault object deployed on Sui Testnet! Click "Activate Circle" below to anchor your rules and member roster to Walrus Memory and launch your dashboard.'}
                </p>

                <div className="pt-md flex items-center justify-between">
                  <button
                    onClick={() => setCreateStep(2)}
                    className="inline-flex items-center px-lg py-sm text-sm font-semibold text-secondary hover:text-primary"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleDeployOrActivateCircle}
                    disabled={
                      !currentAccount ||
                      isDeployingVault ||
                      isActivatingCircle ||
                      (!createPoolAddress ? !ajoConfig?.packageConfigured : !memwalHealth.configured)
                    }
                    className={`inline-flex items-center justify-center gap-sm rounded-lg px-xl py-md text-sm font-semibold transition-all shadow-xs ${
                      !createPoolAddress
                        ? 'bg-brand-solid text-primary-on-brand hover:bg-brand-solid-hover'
                        : 'bg-utility-brand-600 text-primary-on-brand hover:bg-utility-brand-700 ring-2 ring-utility-brand-300'
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    {!currentAccount ? (
                      <span>Connect Wallet to Deploy</span>
                    ) : isDeployingVault ? (
                      <>
                        <Loader2 className="size-4 shrink-0 animate-spin" />
                        <span>Deploying On-Chain Vault…</span>
                      </>
                    ) : isActivatingCircle ? (
                      <>
                        <Loader2 className="size-4 shrink-0 animate-spin" />
                        <span>Saving to Walrus & Activating Circle…</span>
                      </>
                    ) : !createPoolAddress ? (
                      <>
                        <ShieldCheck className="size-4 shrink-0" />
                        <span>Deploy On-Chain Vault</span>
                        <ArrowRight className="size-4 shrink-0" />
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="size-4 shrink-0" />
                        <span>Activate Circle</span>
                        <Sparkles className="size-4 shrink-0" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Right Column (4 cols): Live Circle Overview & Protocol Trust */}
        <div className="lg:col-span-4 space-y-xl">
          {/* Live Circle Preview Card */}
          <div className="rounded-xl border border-secondary bg-primary p-xl sm:p-2xl shadow-xs space-y-lg">
            <div className="flex items-center justify-between pb-md border-b border-secondary">
              <span className="text-xs font-semibold uppercase tracking-wider text-tertiary">Live Circle Preview</span>
              <span className="inline-flex items-center gap-xs text-xs font-medium text-brand-secondary bg-brand-50 px-sm py-xs rounded-full border border-brand-200">
                Step {createStep}/3
              </span>
            </div>

            <div>
              <h4 className="text-heading-xs font-semibold text-primary truncate">
                {createCircleName || 'Untitled Savings Circle'}
              </h4>
              <div className="flex items-center gap-xs text-xs text-secondary mt-xs">
                <TokenLogo symbol={findTokenByCoinType(createTokenType, explorerNetwork)?.symbol || 'SUI'} className="size-3.5 shrink-0" />
                <span>
                  {createCycleLength} rotation • {findTokenByCoinType(createTokenType, explorerNetwork)?.symbol || 'SUI'} • {createTimeZone}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-md p-md rounded-lg bg-secondary/50 border border-secondary">
              <div>
                <p className="text-xs text-tertiary">Per member</p>
                <div className="flex items-center gap-xs mt-xxs">
                  <TokenLogo symbol={findTokenByCoinType(createTokenType, explorerNetwork)?.symbol || 'SUI'} className="size-4 shrink-0" />
                  <p className="text-base font-semibold text-primary tabular-nums">
                    {createContributionPerMember} {findTokenByCoinType(createTokenType, explorerNetwork)?.symbol || 'SUI'}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-tertiary">Round pot</p>
                <div className="flex items-center gap-xs mt-xxs">
                  <TokenLogo symbol={findTokenByCoinType(createTokenType, explorerNetwork)?.symbol || 'SUI'} className="size-4 shrink-0" />
                  <p className="text-base font-semibold text-brand-primary tabular-nums">
                    {createContributionPerMember * (createMembers.length || 1)} {findTokenByCoinType(createTokenType, explorerNetwork)?.symbol || 'SUI'}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-sm">
              <div className="flex items-center justify-between text-xs text-secondary">
                <span>Roster size</span>
                <span className="font-semibold text-primary">{createMembers.length} members</span>
              </div>
              <div className="flex items-center justify-between text-xs text-secondary">
                <span>Rotation duration</span>
                <span className="font-semibold text-primary">
                  {formatRotationDuration(createCycleLength, createMembers.length)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-secondary">
                <span>Cycle 1 window</span>
                <span className="font-medium text-primary text-right text-[11px] truncate max-w-[170px]" title={`${createWindowStart} to ${createWindowEnd}`}>
                  {formatLocalDateTimeWithZone(createWindowStart, createTimeZone, 'short')}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-secondary">
                <span>Pool vault</span>
                <span className="font-mono text-xs text-primary truncate max-w-[140px]" title={createPoolAddress}>
                  {createPoolAddress ? `${createPoolAddress.slice(0, 6)}...${createPoolAddress.slice(-4)}` : 'Pending vault deployment'}
                </span>
              </div>
            </div>

            <div className="pt-md border-t border-secondary space-y-xs">
              <p className="text-xs font-medium text-secondary">Member Roster ({createMembers.length})</p>
              <div className="space-y-xs max-h-48 overflow-y-auto pr-xs">
                {createMembers.map((m, idx) => (
                  <div key={idx} className="flex items-center justify-between text-xs p-xs rounded bg-primary border border-secondary">
                    <span className="font-medium text-primary">#{idx + 1} {m.name}</span>
                    <span className="font-mono text-tertiary">{m.address ? `${m.address.slice(0, 6)}...` : 'No address'}</span>
                  </div>
                ))}
              </div>
              {createCircleRules.trim() && (
                <div className="pt-sm border-t border-secondary space-y-xs">
                  <p className="text-xs font-medium text-secondary">Circle Rules &amp; Guidelines</p>
                  <p className="text-xs text-tertiary whitespace-pre-line break-words rounded-lg bg-primary border border-secondary p-sm">
                    {createCircleRules.trim()}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Walrus Native Escrow Note */}
          <div className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
            <div className="flex items-center gap-sm text-brand-primary">
              <ShieldCheck className="size-5 shrink-0" />
              <h5 className="text-sm font-semibold text-primary">Walrus Native Agreement</h5>
            </div>
            <p className="text-xs text-secondary leading-relaxed">
              Once activated, circle metadata, payout order commitments, and member addresses are permanently anchored to Walrus with cryptographic integrity.
            </p>
            <div className="flex items-center gap-xs text-xs font-medium text-fg-success-primary">
              <CheckCircle2 className="size-4 shrink-0" />
              <span>Zero off-chain custody risk</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )}

        {/* SCREEN 3: STEWARD CHAT */}
        {activeTab === 'chat' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-lg items-start">
            <div className="lg:col-span-8 rounded-xl border border-secondary bg-primary shadow-xs flex flex-col h-[640px] lg:h-[720px] overflow-hidden">
              <div className="p-xl border-b border-secondary flex items-center justify-between bg-primary">
                <div className="flex items-center gap-md">
                  <div className="w-10 h-10 rounded-lg bg-brand-solid text-primary-on-brand flex items-center justify-center shadow-xs shrink-0">
                    <Brain className="size-5 text-fg-white shrink-0" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-primary">Ajo AI Steward</h3>
                    <p className="text-xs text-secondary">
                      Recalling from Walrus Memory
                    </p>
                  </div>
                </div>

                <span
                  className={`inline-flex items-center gap-xs rounded-full border px-md py-xxs text-xs font-medium ${
                    rpcStatus.connected
                      ? 'border-utility-brand-200 bg-utility-brand-50 text-utility-brand-700'
                      : rpcStatus.loading
                      ? 'border-secondary bg-secondary text-tertiary'
                      : 'border-utility-warning-200 bg-utility-warning-50 text-utility-warning-700'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      rpcStatus.connected
                        ? 'bg-brand-solid'
                        : rpcStatus.loading
                        ? 'bg-quaternary animate-pulse'
                        : 'bg-warning-primary'
                    }`}
                  />
                  {rpcStatus.connected
                    ? `Sui RPC (${rpcStatus.network})`
                    : rpcStatus.loading
                    ? 'Connecting to Sui RPC...'
                    : 'Sui RPC Unconfigured/Offline'}
                </span>
              </div>

              {!stewardStatus.available && (
                <div className="p-md bg-utility-warning-50 border-b border-utility-warning-200 text-xs text-utility-warning-700">
                  Steward LLM is currently unavailable (missing or invalid{' '}
                  <code className="font-mono">
                    {stewardStatus.missingVars?.join(', ') || 'LLM_API_KEY, LLM_BASE_URL, LLM_MODEL'}
                  </code>
                  ). No canned responses are substituted.
                </div>
              )}

              <div className="flex-1 p-xl overflow-y-auto space-y-md bg-secondary">
                {messages.length === 0 ? (
                  <div className="text-center py-xl text-xs text-tertiary space-y-xs">
                    <p className="font-medium text-secondary">No chat messages yet.</p>
                    <p>
                      Ask the Steward about member contributions, grace rules, or propose a new circle
                      agreement.
                    </p>
                  </div>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${
                        msg.sender === 'user' ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div
                        className={`max-w-[85%] sm:max-w-lg lg:max-w-xl p-md rounded-xl text-sm leading-relaxed shadow-xs ${
                          msg.sender === 'user'
                            ? 'bg-brand-solid text-primary-on-brand rounded-tr-none'
                            : 'bg-primary text-primary border border-secondary rounded-tl-none'
                        }`}
                      >
                        <p>{msg.text}</p>

                        {msg.citedMemories && msg.citedMemories.length > 0 && (
                          <div className="mt-xs pt-xs border-t border-secondary text-xs space-y-xs">
                            <span className="font-semibold text-secondary flex items-center gap-xxs">
                              <Bookmark className="size-3 text-fg-brand-primary shrink-0" />
                              <span>Recalled Walrus memories cited:</span>
                            </span>
                            <div className="space-y-xs">
                              {msg.citedMemories.map((cm) => (
                                <div key={cm.walrusBlobId} className="flex flex-wrap items-center gap-xs">
                                  <span className="text-secondary font-medium">"{cm.title}"</span>
                                  <ExplorerLink type="walrus-blob" value={cm.walrusBlobId} />
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {msg.citedTxDigests && msg.citedTxDigests.length > 0 && (
                          <div className="mt-xs pt-xs border-t border-secondary text-xs space-y-xs">
                            <span className="font-semibold text-secondary">
                              Cited Sui Tx Digests:
                            </span>
                            <div className="flex flex-wrap gap-xs">
                              {msg.citedTxDigests.map((d) => (
                                <ExplorerLink key={d} type="tx" value={d} network={explorerNetwork} />
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      <span className="text-xs text-tertiary mt-xxs px-xs">{msg.timestamp}</span>
                    </div>
                  ))
                )}

                {isChatTyping && (
                  <div className="flex items-center gap-xs text-xs text-tertiary">
                    <RefreshCw className="size-3.5 animate-spin text-fg-brand-primary shrink-0" />
                    <span>Steward is querying Walrus memory & LLM...</span>
                  </div>
                )}

                {chatError && (
                  <div className="p-md rounded-lg bg-utility-error-50 border border-error-subtle text-xs text-error-primary">
                    {chatError}
                  </div>
                )}
              </div>

              {/* Proposed Memory Inline Confirmation Card */}
              {proposedMemory && (
                <div className="p-xl bg-utility-brand-50 border-t border-utility-brand-200 space-y-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-brand-primary flex items-center gap-xxs">
                      <Sparkles className="size-3.5 shrink-0" />
                      Proposed circle memory ({proposedMemory.category})
                    </span>
                    <span className="text-xs text-tertiary">Awaiting member confirmation</span>
                  </div>
                  <p className="text-sm font-semibold text-primary">{proposedMemory.title}</p>
                  <p className="text-xs italic text-secondary">"{proposedMemory.quote}"</p>

                  {/* Identity & Authorization Indicator (Prevent Impersonation) */}
                  {connectedMember ? (
                    <div className="flex flex-col gap-xxs pt-xxs">
                      <div className="flex items-center gap-xs">
                        <span className="text-xs text-secondary">Confirming as:</span>
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          {connectedMember.name} ({connectedMember.address.slice(0, 6)}...{connectedMember.address.slice(-4)})
                        </span>
                      </div>
                      {proposedMemory.memberId && proposedMemory.memberId !== connectedMember.id && (
                        <div className="p-xs rounded-md bg-utility-warning-50 border border-utility-warning-200 text-utility-warning-700 text-xs mt-xxs">
                          ⚠️ This proposal specifically pertains to {members.find((m) => m.id === proposedMemory.memberId)?.name || proposedMemory.memberId}. Only their wallet can sign it.
                        </div>
                      )}
                    </div>
                  ) : currentAccount?.address ? (
                    <div className="p-xs rounded-md bg-utility-error-50 border border-utility-error-200 text-utility-error-700 text-xs">
                      ⚠️ Connected wallet ({currentAccount.address.slice(0, 6)}...{currentAccount.address.slice(-4)}) is not in this circle's member roster. Switch to a registered member wallet ({members.map((m) => m.name).join(', ')}) to sign agreements.
                    </div>
                  ) : (
                    <div className="flex items-center gap-xs pt-xxs">
                      <span className="text-xs text-tertiary">Connect member wallet to sign agreement</span>
                    </div>
                  )}

                  <div className="pt-xs flex flex-wrap items-center gap-sm">
                    <button
                      type="button"
                      onClick={() => {
                        if (!currentAccount) {
                          setShowWalletModal(true)
                        } else {
                          handleConfirmMemoryWithWallet(proposedMemory)
                        }
                      }}
                      disabled={
                        isMemoryWriting ||
                        !memwalHealth.configured ||
                        Boolean(currentAccount && !connectedMember) ||
                        Boolean(proposedMemory.memberId && connectedMember && proposedMemory.memberId !== connectedMember.id)
                      }
                      className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover disabled:opacity-50"
                    >
                      <Lock className="size-3.5 text-fg-white shrink-0" />
                      <span>
                        {isMemoryWriting
                          ? 'Signing & Writing to Walrus...'
                          : !currentAccount
                          ? 'Connect Wallet to Sign Memory'
                          : !connectedMember
                          ? 'Wallet Not Registered'
                          : proposedMemory.memberId && proposedMemory.memberId !== connectedMember.id
                          ? 'Not Your Proposal to Sign'
                          : 'Sign with Wallet & Write to Walrus'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmMemory(proposedMemory, 'organizer_entered')}
                      disabled={
                        isMemoryWriting ||
                        !memwalHealth.configured ||
                        !connectedMember ||
                        Boolean(proposedMemory.memberId && proposedMemory.memberId !== connectedMember.id)
                      }
                      className="inline-flex items-center gap-sm rounded-lg bg-primary px-md py-sm text-xs font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover disabled:opacity-50"
                      title="Organizer-entered record (distinct from member-signed confirmation)"
                    >
                      <span>Record as Organizer-Entered</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRejectMemory}
                      disabled={isMemoryWriting}
                      className="inline-flex items-center gap-sm rounded-lg bg-primary px-md py-sm text-xs font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}

              <div className="px-lg py-sm border-t border-secondary bg-primary flex flex-wrap items-center gap-xs">
                <span className="text-xs text-tertiary shrink-0">Ask:</span>
                {[
                  'Is any late payment covered by a recorded grace rule?',
                  'Who has a split payment habit?',
                  'Who is the riskiest member before payout?',
                ].map((chip, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSendMessage(chip)}
                    disabled={!stewardStatus.available || isChatTyping}
                    className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700 hover:bg-secondary-hover disabled:opacity-50 text-left max-w-full"
                  >
                    {chip}
                  </button>
                ))}
              </div>

              <div className="p-xl border-t border-secondary bg-primary">
                <div className="flex items-center gap-sm">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                    disabled={!stewardStatus.available || isChatTyping}
                    placeholder={
                      stewardStatus.available
                        ? 'Ask the steward about circle payments, rules...'
                        : 'Configure LLM_API_KEY, LLM_BASE_URL, LLM_MODEL to enable chat'
                    }
                    className="flex-1 rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60"
                  />
                  <button
                    onClick={() => handleSendMessage()}
                    disabled={!stewardStatus.available || isChatTyping || !chatInput.trim()}
                    aria-label="Send message"
                    className="inline-flex items-center justify-center rounded-lg border border-transparent bg-brand-solid p-md text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover disabled:opacity-50 shrink-0"
                  >
                    <Send className="size-4 text-fg-white shrink-0" />
                  </button>
                </div>
              </div>
            </div>

            {/* Desktop Context & Intelligence Sidebar */}
            <div className="hidden lg:flex lg:col-span-4 flex-col gap-lg">
              {/* Circle Context Card */}
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                <div className="flex items-center gap-sm">
                  <ShieldCheck className="size-5 text-fg-brand-primary shrink-0" />
                  <h3 className="text-sm font-semibold text-primary">Circle Context</h3>
                </div>
                <div className="space-y-xs text-xs">
                  <div className="flex justify-between text-secondary">
                    <span className="text-tertiary">Circle:</span>
                    <span className="font-semibold text-primary">{circleName || 'Untitled Circle'}</span>
                  </div>
                  <div className="flex justify-between text-secondary">
                    <span className="text-tertiary">Current Cycle:</span>
                    <span className="font-semibold text-primary">Cycle {selectedCycle} of {totalCycles}</span>
                  </div>
                  <div className="flex justify-between text-secondary">
                    <span className="text-tertiary">Verified Pot:</span>
                    <span className="font-semibold text-primary font-mono tabular-nums">{totalOnchainPotReceived.toLocaleString()} {tokenSymbol}</span>
                  </div>
                  <div className="flex justify-between text-secondary">
                    <span className="text-tertiary">Members:</span>
                    <span className="font-semibold text-primary">{members.length} members</span>
                  </div>
                </div>
              </section>

              {/* Steward Intelligence Card */}
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                <div className="flex items-center gap-sm">
                  <Brain className="size-5 text-fg-brand-primary shrink-0" />
                  <h3 className="text-sm font-semibold text-primary">Steward Intelligence</h3>
                </div>
                <p className="text-xs text-tertiary leading-relaxed">
                  The Steward provides advisory insights based on group agreements recalled from Walrus Mainnet alongside Sui Testnet transaction evidence verified via Tatum.
                </p>
                <div className="pt-xs border-t border-secondary space-y-xs text-xs">
                  <div className="flex justify-between">
                    <span className="text-tertiary">Mode:</span>
                    <span className="font-semibold text-brand-primary">With Walrus Memory</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-tertiary">Recalled Blobs:</span>
                    <span className="font-semibold text-primary">{memoriesList.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-tertiary">Sui Gateway:</span>
                    <span className="font-semibold text-utility-success-700">Tatum Connected</span>
                  </div>
                </div>
              </section>

              {/* Pending & Recent Agreement Proposals Card (Organizer Sign / Reject) */}
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-primary">Proposed Agreements</h3>
                  <span className="text-xs text-tertiary">
                    {circleProposals.filter((p) => p.status === 'pending').length} pending
                  </span>
                </div>
                {circleProposals.length === 0 ? (
                  <p className="text-xs text-tertiary leading-relaxed">
                    No pending or rejected agreement proposals for this circle. Members can propose agreements from the Walrus Memory tab; non-organizer proposals appear here for the organizer to sign or reject.
                  </p>
                ) : (
                  <div className="space-y-sm max-h-80 overflow-y-auto">
                    {circleProposals.map((prop) => {
                      const isPending = prop.status === 'pending'
                      const isRejected = prop.status === 'rejected'
                      const needsOrg = Boolean(prop.requiresOrganizerApproval)
                      return (
                        <div
                          key={prop.id}
                          className={`p-md rounded-lg border text-xs space-y-xs ${
                            isRejected
                              ? 'bg-utility-error-50 border-utility-error-200'
                              : 'bg-utility-brand-50/50 border-utility-brand-200'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-xs">
                            <span className="font-semibold text-primary">{prop.title}</span>
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                isRejected
                                  ? 'bg-utility-error-100 text-utility-error-700'
                                  : 'bg-utility-warning-100 text-utility-warning-700'
                              }`}
                            >
                              {isRejected
                                ? 'Rejected'
                                : needsOrg
                                ? 'Needs Organizer Signature'
                                : 'Pending Signature'}
                            </span>
                          </div>
                          <p className="italic text-secondary">"{prop.quote}"</p>
                          {prop.proposedBy && (
                            <p className="text-[11px] text-tertiary">
                              Proposed by: {prop.proposedBy}
                            </p>
                          )}
                          {isRejected && prop.rejectionReason && (
                            <p className="text-[11px] font-medium text-utility-error-700">
                              Reason: {prop.rejectionReason}
                            </p>
                          )}
                          {isPending && isConnectedOrganizer && (
                            <div className="pt-xs space-y-xs">
                              <input
                                type="text"
                                value={rejectionReasons[prop.id] || ''}
                                onChange={(e) =>
                                  setRejectionReasons((prev) => ({
                                    ...prev,
                                    [prop.id]: e.target.value,
                                  }))
                                }
                                placeholder="Optional rejection reason..."
                                className="w-full rounded-md bg-primary px-sm py-xs text-xs text-primary border border-secondary"
                              />
                              <div className="flex items-center gap-xs">
                                <button
                                  type="button"
                                  disabled={isMemoryWriting}
                                  onClick={() => handleConfirmMemoryWithWallet(prop)}
                                  className="inline-flex items-center gap-xxs rounded-md bg-brand-solid px-md py-xs text-xs font-semibold text-primary-on-brand hover:bg-brand-solid-hover disabled:opacity-50"
                                >
                                  <Lock className="size-3" />
                                  <span>Sign & Write to Walrus</span>
                                </button>
                                <button
                                  type="button"
                                  disabled={isMemoryWriting}
                                  onClick={() =>
                                    handleRejectMemory(prop.id, rejectionReasons[prop.id])
                                  }
                                  className="inline-flex items-center gap-xxs rounded-md bg-utility-error-50 border border-utility-error-200 px-md py-xs text-xs font-semibold text-utility-error-700 hover:bg-utility-error-100 disabled:opacity-50"
                                >
                                  <X className="size-3" />
                                  <span>Reject</span>
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              {/* Suggested Questions Card */}
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-sm">
                <h3 className="text-sm font-semibold text-primary">Suggested Inquiries</h3>
                <p className="text-xs text-tertiary">
                  Click any prompt below to ask the Steward:
                </p>
                <div className="space-y-xs pt-xs">
                  {[
                    'Is any late payment covered by a recorded grace rule?',
                    'Who has a split payment habit?',
                    'Who is the riskiest member before payout?',
                    'What are our current circle contribution rules?',
                  ].map((prompt, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleSendMessage(prompt)}
                      disabled={!stewardStatus.available || isChatTyping}
                      className="w-full text-left p-sm rounded-lg bg-secondary hover:bg-secondary-hover text-xs text-secondary hover:text-primary transition-colors border border-secondary disabled:opacity-50"
                    >
                      "{prompt}"
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </div>
        )}

        {/* SCREEN 4: WALRUS MEMORY */}
        {activeTab === 'memories' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-2xl sm:gap-3xl lg:gap-4xl items-start w-full">
            {/* Left Column (5 cols on desktop): Walrus Controls & Propose Form */}
            <div className="lg:col-span-5 space-y-2xl sm:space-y-3xl">
              <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl lg:p-4xl shadow-xs space-y-xl">
                <div className="flex items-center justify-between gap-md">
                  <div className="flex items-center gap-lg">
                    <div className="w-12 h-12 rounded-xl bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200 flex items-center justify-center font-bold shrink-0">
                      <Brain className="size-6 text-fg-brand-primary shrink-0" />
                    </div>
                    <div>
                      <h3 className="text-heading-xs font-semibold text-primary">
                        Walrus Memory store
                      </h3>
                      <p className="mt-xs text-sm text-tertiary">
                        Real encrypted semantic memory on Walrus Mainnet via{' '}
                        <code className="font-mono text-xs">@mysten-incubation/memwal</code>.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Rebuild / Restore Index from Walrus Controls */}
                <div className="pt-lg border-t border-secondary space-y-lg">
                  <p className="text-xs text-secondary leading-relaxed">
                    Persistence note: Confirmed group memories are persisted on Walrus Mainnet and can
                    be restored below via semantic recall. In compliance with the preview container
                    constraints (no runtime database or disk writes), active circle rosters, wallet
                    sessions, and pending proposals live in server memory; payment evidence is verified
                    live against Sui via Tatum.
                  </p>
                  <div className="flex flex-col gap-sm">
                    <div>
                      <div className="flex items-center justify-between text-xs text-secondary mb-xs">
                        <span className="font-semibold text-primary flex items-center gap-xs">
                          <Lock className="size-3 text-fg-brand-primary shrink-0" />
                          <span>Circle Namespace ID</span>
                        </span>
                        <span className="text-[10px] uppercase font-bold text-utility-brand-700 bg-utility-brand-50 px-2 py-0.5 rounded border border-utility-brand-200">
                          Immutable on Walrus
                        </span>
                      </div>
                      <div className="flex items-center justify-between w-full rounded-lg bg-secondary/60 px-md py-sm border border-secondary">
                        <span className="font-mono text-xs text-primary font-medium truncate select-all">
                          {circleId || lookupCircleSlug || 'No circle selected'}
                        </span>
                        {(circleId || lookupCircleSlug) && (
                          <button
                            type="button"
                            onClick={() => handleCopy(circleId || lookupCircleSlug, 'walrus-namespace')}
                            className="text-xs text-brand-primary hover:underline font-medium ml-sm shrink-0 flex items-center gap-1"
                            title="Copy Circle ID"
                          >
                            {copiedText === 'walrus-namespace' ? (
                              <>
                                <CheckCheck className="size-3 text-fg-success-primary shrink-0" />
                                <span>Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="size-3 text-fg-quaternary shrink-0" />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-sm pt-xs">
                      <button
                        type="button"
                        onClick={() => {
                          const slug = (circleId || lookupCircleSlug).trim()
                          if (slug) {
                            refreshMemories(slug)
                          }
                        }}
                        disabled={isMemoryLoading || !memwalHealth.configured || (!circleId && !lookupCircleSlug)}
                        className="inline-flex items-center justify-center gap-xs rounded-lg bg-primary px-lg py-sm text-xs font-semibold text-secondary border border-secondary shadow-xs hover:bg-secondary hover:text-primary disabled:opacity-50 transition-colors"
                      >
                        <RefreshCw className={`size-3.5 ${isMemoryLoading ? 'animate-spin' : ''}`} />
                        <span>Recall memories</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleRestoreFromWalrus}
                        disabled={isMemoryLoading || !memwalHealth.configured || (!circleId && !lookupCircleSlug)}
                        className="inline-flex items-center justify-center gap-xs rounded-lg bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover disabled:opacity-50 transition-colors"
                      >
                        <span>Restore circle</span>
                      </button>
                    </div>
                  </div>

                  {restoreOutcome && (
                    <div className="p-xl rounded-xl bg-secondary border border-secondary text-xs space-y-sm">
                      <div className="flex flex-wrap items-center justify-between gap-xs">
                        <p className="font-semibold text-primary">
                          Walrus Recovery ({restoreOutcome.namespace}): restored=
                          {restoreOutcome.restoreResult.restored}, skipped=
                          {restoreOutcome.restoreResult.skipped}, failed=
                          {restoreOutcome.restoreResult.failed}, total=
                          {restoreOutcome.restoreResult.total}
                        </p>
                        <span
                          className={`inline-flex items-center rounded-md px-sm py-xxs text-xs font-semibold border ${
                            restoreOutcome.recoveryStatus === 'complete'
                              ? 'bg-utility-success-50 text-utility-success-700 border-utility-success-200'
                              : restoreOutcome.recoveryStatus === 'conflict'
                              ? 'bg-utility-error-50 text-utility-error-700 border-utility-error-200'
                              : 'bg-utility-warning-50 text-utility-warning-700 border-utility-warning-200'
                          }`}
                        >
                          {restoreOutcome.recoveryStatus === 'complete'
                            ? 'Recovery Complete'
                            : restoreOutcome.recoveryStatus === 'conflict'
                            ? 'Conflicts Detected — Review Required'
                            : 'Incomplete Recovery'}
                        </span>
                      </div>
                      {restoreOutcome.conflicts && restoreOutcome.conflicts.length > 0 && (
                        <div className="p-md rounded-lg bg-utility-error-50 border border-error-subtle text-error-primary space-y-xxs">
                          <p className="font-semibold">Surfaced Conflicts (not silently resolved):</p>
                          {restoreOutcome.conflicts.map((c, idx) => (
                            <div key={idx} className="flex flex-wrap items-center gap-xs">
                              <span>• [{c.type}] {c.reason}</span>
                              {c.blobIds && c.blobIds.length > 0 && (
                                <div className="inline-flex flex-wrap items-center gap-xxs">
                                  <span>(Blobs:</span>
                                  {c.blobIds.map((b) => (
                                    <ExplorerLink key={b} type="walrus-blob" value={b} />
                                  ))}
                                  <span>)</span>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {((restoreOutcome.missingFields && restoreOutcome.missingFields.length > 0) ||
                        (restoreOutcome.missingBlobIds && restoreOutcome.missingBlobIds.length > 0)) && (
                        <div className="p-md rounded-lg bg-utility-warning-50 border border-utility-warning-200 text-utility-warning-700 space-y-xxs">
                          {restoreOutcome.missingFields && restoreOutcome.missingFields.length > 0 && (
                            <p>Missing fields: {restoreOutcome.missingFields.join(', ')}</p>
                          )}
                          {restoreOutcome.missingBlobIds && restoreOutcome.missingBlobIds.length > 0 && (
                            <div className="flex flex-wrap items-center gap-xs">
                              <span>Unrecalled blob IDs:</span>
                              {restoreOutcome.missingBlobIds.map((b) => (
                                <ExplorerLink key={b} type="walrus-blob" value={b} />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {restoreOutcome.recoveryPath && restoreOutcome.recoveryPath.length > 0 && (
                        <div className="text-secondary space-y-xxs">
                          <p className="font-semibold">Recovery path:</p>
                          {restoreOutcome.recoveryPath.map((step, idx) => (
                            <p key={idx}>• {step}</p>
                          ))}
                        </div>
                      )}
                      <p className="text-tertiary">{restoreOutcome.limitationsNote}</p>
                    </div>
                  )}

                  {memoryError && (
                    <div className="p-lg rounded-xl bg-utility-error-50 border border-error-subtle text-xs text-error-primary">
                      {memoryError}
                    </div>
                  )}
                </div>
              </section>

              {/* Propose & Confirm Memory Section */}
              <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl lg:p-4xl shadow-xs space-y-xl">
                <div className="space-y-xs">
                  <h4 className="text-sm font-semibold text-primary">
                    Propose circle memory
                  </h4>
                  <p className="text-xs text-tertiary">
                    {!isConnectedOrganizer && manualCategory === 'Agreements'
                      ? "Sent to the circle organizer's Steward Chat for approval & signature before writing to Walrus"
                      : 'Requires wallet signature before permanent Walrus storage'}
                  </p>
                </div>

                {/* Quick Templates */}
                <div className="space-y-xs">
                  <span className="text-[11px] font-medium text-tertiary">
                    Quick templates (optional)
                  </span>
                  <div className="flex flex-wrap gap-xs">
                    {[
                      {
                        label: 'Grace Window',
                        category: 'Agreements' as MemoryCategory,
                        title: `10 Minutes Grace Window for Cycle ${selectedCycle}`,
                        quote: `Group agreed to allow a 10 minutes grace window for Cycle ${selectedCycle} contributions without marking as unexcused.`,
                      },
                      {
                        label: '2-Tranche Split',
                        category: 'Member patterns' as MemoryCategory,
                        title: `Two-Tranche Split Pattern (Cycle ${selectedCycle})`,
                        quote: `Member prefers splitting Cycle ${selectedCycle} contribution into 2 tranches within the 48-hour split window.`,
                      },
                      {
                        label: 'Reminder Cadence',
                        category: 'Reminder preferences' as MemoryCategory,
                        title: 'Evening 6pm Reminder Opt-In',
                        quote: 'Member opted in to receive contribution reminders at 6pm local time 24 hours before cycle deadline.',
                      },
                      {
                        label: 'Payout Swap Note',
                        category: 'Agreements' as MemoryCategory,
                        title: `Cycle ${selectedCycle} Payout Order Swap Agreement`,
                        quote: `Members agreed to swap Cycle ${selectedCycle} payout order off-chain (advisory note; Move contract payout_order remains fixed).`,
                      },
                    ].map((tpl) => (
                      <button
                        key={tpl.label}
                        type="button"
                        onClick={() => {
                          setManualCategory(tpl.category)
                          setManualTitle(tpl.title)
                          setManualQuote(tpl.quote)
                          setManualRule(tpl.quote)
                        }}
                        className="rounded-full bg-secondary hover:bg-secondary-hover border border-secondary px-md py-xxs text-[11px] font-medium text-secondary hover:text-primary transition-colors"
                      >
                        + {tpl.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-md">
                  <label className="space-y-xxs block">
                    <span className="text-[11px] font-medium text-secondary">Category</span>
                    <select
                      value={manualCategory}
                      onChange={(e) => setManualCategory(e.target.value as MemoryCategory)}
                      className="w-full rounded-md bg-primary px-lg py-md text-xs text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      <option value="Agreements">Agreements (Grace, Payout Swap)</option>
                      <option value="Member patterns">Member patterns (Split Payments)</option>
                      <option value="Reminder preferences">Reminder preferences (Opt-in)</option>
                    </select>
                  </label>
                  <label className="space-y-xxs block">
                    <span className="text-[11px] font-medium text-secondary">Applies to</span>
                    <select
                      value={manualMemberId}
                      onChange={(e) => setManualMemberId(e.target.value)}
                      className="w-full rounded-md bg-primary px-lg py-md text-xs text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      <option value="">All members (Circle-wide)</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.id})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="space-y-xxs block">
                  <span className="text-[11px] font-medium text-secondary">Title</span>
                  <input
                    type="text"
                    value={manualTitle}
                    onChange={(e) => setManualTitle(e.target.value)}
                    placeholder={`e.g. 10 Minutes Grace Window for Cycle ${selectedCycle}`}
                    className="w-full rounded-md bg-primary px-lg py-md text-xs text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </label>

                <label className="space-y-xxs block">
                  <span className="text-[11px] font-medium text-secondary">
                    Agreement / Rule Details
                  </span>
                  <textarea
                    rows={3}
                    value={manualQuote}
                    onChange={(e) => {
                      setManualQuote(e.target.value)
                      setManualRule(e.target.value)
                    }}
                    placeholder="Describe what was agreed or the member preference (include duration like '10 minutes' and cycle like 'Cycle 2' if applicable)..."
                    className="w-full rounded-md bg-primary px-lg py-md text-xs text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </label>

                <div className="flex justify-end pt-sm">
                  <button
                    type="button"
                    onClick={handleProposeManualMemory}
                    className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-xl py-md text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <span>
                      {!isConnectedOrganizer && manualCategory === 'Agreements'
                        ? 'Submit to Organizer for Approval'
                        : 'Stage Proposal for Signature'}
                    </span>
                  </button>
                </div>

                {proposedMemory && (
                  <div className="p-xl rounded-xl bg-utility-brand-50 border border-utility-brand-200 space-y-md">
                    <p className="text-xs font-semibold text-brand-primary">
                      Pending Proposal: {proposedMemory.title}
                    </p>
                    <p className="text-xs italic text-secondary">"{proposedMemory.quote}"</p>
                    {/* Identity & Authorization Indicator (Prevent Impersonation) */}
                    {connectedMember ? (
                      <div className="flex flex-col gap-xxs pt-xxs">
                        <div className="flex items-center gap-xs">
                          <span className="text-xs text-secondary">Confirming as:</span>
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            {connectedMember.name} ({connectedMember.address.slice(0, 6)}...{connectedMember.address.slice(-4)})
                          </span>
                        </div>
                        {proposedMemory.requiresOrganizerApproval && !isConnectedOrganizer ? (
                          <div className="p-xs rounded-md bg-utility-warning-50 border border-utility-warning-200 text-utility-warning-700 text-xs mt-xxs">
                            ⏳ Since you are not the circle organizer, this agreement proposal has been sent to the organizer's Steward Chat page for signature before writing to Walrus. You will receive a notification once the organizer signs or rejects it.
                          </div>
                        ) : (
                          proposedMemory.memberId &&
                          proposedMemory.memberId !== connectedMember.id &&
                          !isConnectedOrganizer && (
                            <div className="p-xs rounded-md bg-utility-warning-50 border border-utility-warning-200 text-utility-warning-700 text-xs mt-xxs">
                              ⚠️ This proposal specifically pertains to {members.find((m) => m.id === proposedMemory.memberId)?.name || proposedMemory.memberId}. Only their wallet or the circle organizer can sign it.
                            </div>
                          )
                        )}
                      </div>
                    ) : currentAccount?.address ? (
                      <div className="p-xs rounded-md bg-utility-error-50 border border-utility-error-200 text-utility-error-700 text-xs">
                        ⚠️ Connected wallet ({currentAccount.address.slice(0, 6)}...{currentAccount.address.slice(-4)}) is not in this circle's member roster. Switch to a registered member wallet ({members.map((m) => m.name).join(', ')}) to sign agreements.
                      </div>
                    ) : (
                      <div className="flex items-center gap-xs pt-xxs">
                        <span className="text-xs text-tertiary">Connect member wallet to sign agreement</span>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-sm pt-xs">
                      <button
                        type="button"
                        onClick={() => {
                          if (!currentAccount) {
                            setShowWalletModal(true)
                          } else {
                            handleConfirmMemoryWithWallet(proposedMemory)
                          }
                        }}
                        disabled={
                          isMemoryWriting ||
                          !memwalHealth.configured ||
                          Boolean(currentAccount && !connectedMember) ||
                          Boolean(proposedMemory.requiresOrganizerApproval && !isConnectedOrganizer) ||
                          Boolean(
                            !proposedMemory.requiresOrganizerApproval &&
                              proposedMemory.memberId &&
                              connectedMember &&
                              proposedMemory.memberId !== connectedMember.id
                          )
                        }
                        className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-xl py-md text-xs font-semibold text-primary-on-brand shadow-xs disabled:opacity-50 hover:bg-brand-solid-hover"
                      >
                        <Lock className="size-3.5 text-fg-white" />
                        <span>
                          {isMemoryWriting
                            ? 'Signing & Writing to Walrus...'
                            : !currentAccount
                            ? 'Connect Wallet to Sign Memory'
                            : !connectedMember
                            ? 'Wallet Not Registered'
                            : proposedMemory.requiresOrganizerApproval && !isConnectedOrganizer
                            ? 'Awaiting Organizer Signature in Chat'
                            : !proposedMemory.requiresOrganizerApproval &&
                              proposedMemory.memberId &&
                              proposedMemory.memberId !== connectedMember.id
                            ? 'Not Your Proposal to Sign'
                            : 'Sign with Wallet & Write to Walrus'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConfirmMemory(proposedMemory, 'organizer_entered')}
                        disabled={
                          isMemoryWriting ||
                          !memwalHealth.configured ||
                          !connectedMember ||
                          Boolean(proposedMemory.memberId && proposedMemory.memberId !== connectedMember.id)
                        }
                        className="inline-flex items-center gap-xs rounded-lg bg-primary px-lg py-md text-xs font-semibold text-secondary border border-primary disabled:opacity-50"
                      >
                        <span>Record as Organizer-Entered</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleRejectMemory}
                        disabled={isMemoryWriting}
                        className="inline-flex items-center rounded-lg bg-primary px-xl py-md text-xs font-semibold text-secondary border border-primary"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>

            {/* Right Column (7 cols on desktop): Grouped Memory Cards */}
            <div className="lg:col-span-7 space-y-2xl sm:space-y-3xl">
              {(['Agreements', 'Member patterns', 'Reminder preferences'] as const).map(
                (category) => {
                  const items = memoriesList.filter((m) => m.category === category)
                  return (
                    <div key={category} className="space-y-lg">
                      <div className="flex items-center justify-between px-xs">
                        <h4 className="text-sm font-semibold text-secondary uppercase tracking-wider">
                          {category} ({items.length})
                        </h4>
                        <span className="text-xs text-tertiary">Walrus Mainnet blobs</span>
                      </div>

                      {items.length === 0 ? (
                        <div className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl text-sm text-tertiary italic shadow-xs">
                          No {category.toLowerCase()} recalled for this circle namespace yet.
                        </div>
                      ) : (
                        <div className="space-y-md sm:space-y-lg">
                          {items.map((mem) => (
                            <section
                              key={mem.walrusBlobId || mem.id}
                              className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl shadow-xs space-y-md"
                            >
                              <div className="flex items-start justify-between gap-md">
                                <div>
                                  <h5 className="text-md font-semibold text-primary">{mem.title}</h5>
                                  <span className="text-xs text-tertiary">
                                    {mem.date} · Cycle {mem.cycle}
                                  </span>
                                </div>

                                {mem.walrusBlobId && (
                                  <button
                                    onClick={() => handleCopy(mem.walrusBlobId, mem.id)}
                                    className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700 hover:bg-secondary-hover focus-visible:ring-2 focus-visible:ring-focus-ring shrink-0"
                                    title="Click to copy real Walrus blob ID"
                                  >
                                    <Lock className="size-3 text-fg-brand-primary shrink-0" />
                                    <span>Saved on Walrus</span>
                                    {copiedText === mem.id ? (
                                      <CheckCheck className="size-3 text-fg-success-primary shrink-0" />
                                    ) : (
                                      <Copy className="size-3 text-fg-quaternary shrink-0" />
                                    )}
                                  </button>
                                )}
                              </div>

                              <div className="p-lg sm:p-xl bg-secondary rounded-xl border border-secondary text-xs space-y-xs">
                                <p className="italic text-secondary">"{mem.quote}"</p>
                                <p className="text-primary font-medium mt-xs pt-xs border-t border-secondary">
                                  Rule: {mem.context}
                                </p>
                              </div>

                              <div className="flex items-center justify-between text-xs text-tertiary flex-wrap gap-xs pt-xs">
                                <span className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700">
                                  <CheckCircle2 className="size-3 text-fg-brand-primary shrink-0" />
                                  {mem.confirmedBy}
                                </span>
                                <ExplorerLink type="walrus-blob" value={mem.walrusBlobId} />
                              </div>
                            </section>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                }
              )}
            </div>
          </div>
        )}

        {/* SCREEN 5: PAYOUT RECOMMENDATIONS */}
        {activeTab === 'payout' && (
          <div className="w-full space-y-2xl sm:space-y-3xl">
            {Boolean(isVaultMismatched || (isVaultCompleted && selectedCycle === 1 && Object.keys(verifications).length === 0)) && (
              <div className="p-xl rounded-xl bg-utility-warning-50 border border-utility-warning-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-md">
                <div className="flex items-start gap-sm">
                  <AlertTriangle className="size-5 text-utility-warning-600 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="text-sm font-semibold text-utility-warning-800">
                      Reused or Completed Vault Detected for "{circleName}"
                    </h4>
                    <p className="text-xs text-utility-warning-700 mt-xxs">
                      This circle is linked to a Move vault ({poolAddress.slice(0, 8)}...{poolAddress.slice(-6)}) {onchainState?.name ? `created for "${onchainState.name}"` : 'that has already finished its rotation'}. Deploy a fresh dedicated vault on Sui Testnet for this circle.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleDeployFreshVaultForCircle}
                  disabled={isDeployingFreshVault || !currentAccount}
                  className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover shrink-0 disabled:opacity-50"
                >
                  {isDeployingFreshVault ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      <span>Deploying Dedicated Vault...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="size-3.5" />
                      <span>Deploy Dedicated Vault (1-Click)</span>
                    </>
                  )}
                </button>
              </div>
            )}
            {members.length === 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-2xl sm:gap-3xl lg:gap-4xl items-start w-full">
                {/* Left Column (8 cols): Payout Setup Prompt */}
                <div className="lg:col-span-8 space-y-2xl sm:space-y-3xl">
                  <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl lg:p-4xl shadow-xs space-y-2xl">
                    <div className="flex items-start gap-lg sm:gap-xl">
                      <div className="w-14 h-14 rounded-xl bg-utility-brand-50 text-brand-primary border border-utility-brand-200 flex items-center justify-center shrink-0">
                        <Sparkles className="size-7 text-fg-brand-primary" />
                      </div>
                      <div className="space-y-sm">
                        <h3 className="text-heading-sm font-semibold text-primary">
                          Payout Recommendations
                        </h3>
                        <p className="text-md text-secondary leading-relaxed">
                          Configure a circle and member roster first to view payout recommendations. Once members and on-chain Sui Testnet contributions are verified, the Steward LLM assesses rotation order, emergency grace agreements, and payout eligibility.
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-md pt-xl border-t border-secondary">
                      <button
                        onClick={() => startCreateNewCircle()}
                        className="inline-flex items-center gap-md rounded-full bg-brand-solid px-2xl py-md text-sm font-bold text-primary-on-brand shadow-md shadow-brand-500/20 hover:bg-brand-solid-hover hover:shadow-lg hover:shadow-brand-500/25 transition-all ring-4 ring-utility-brand-100 border border-brand-solid focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center shrink-0">
                          <PlusCircle className="size-4 text-fg-white stroke-[2.5]" />
                        </div>
                        <span>Configure Circle Roster</span>
                      </button>
                    </div>
                  </section>
                </div>

                {/* Right Column (4 cols): Information Card */}
                <div className="lg:col-span-4 space-y-2xl sm:space-y-3xl">
                  <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl shadow-xs space-y-lg">
                    <h4 className="text-sm font-semibold text-primary">How Payouts Work</h4>
                    <p className="text-sm text-secondary leading-relaxed">
                      The Steward evaluates verified on-chain Sui Testnet contributions, recalls agreements from Walrus Memory, and provides an advisory distribution recommendation. The eligible recipient claims the pot directly via their Sui wallet.
                    </p>
                  </section>
                </div>
              </div>
            ) : isPayoutLoading ? (
              <section className="w-full rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl lg:p-4xl shadow-xs flex items-center gap-md text-sm text-tertiary">
                <RefreshCw className="size-5 animate-spin text-fg-brand-primary" />
                <span>Generating Steward payout recommendation...</span>
              </section>
            ) : payoutError ? (
              <section className="w-full rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl lg:p-4xl shadow-xs space-y-md">
                <h3 className="text-sm font-semibold text-error-primary">
                  Steward LLM Recommendation Unavailable
                </h3>
                <p className="text-sm text-secondary">{payoutError}</p>
                {scheduledRecipient && (
                  <p className="text-xs text-tertiary pt-md border-t border-secondary">
                    Deterministic rotation schedule recipient for Cycle {selectedCycle}:{' '}
                    <strong className="text-primary">{scheduledRecipient.name}</strong> (
                    {scheduledRecipient.address})
                  </p>
                )}
              </section>
            ) : (
              payoutRec && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-2xl sm:gap-3xl lg:gap-4xl items-start">
                  {/* Left Column (6 cols on desktop): Recommendation & Citations */}
                  <div className="lg:col-span-6 space-y-2xl sm:space-y-3xl">
                    <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl lg:p-4xl shadow-xs space-y-xl">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                          <Sparkles className="size-3 text-fg-brand-primary shrink-0" />
                          Steward recommendation
                        </span>
                        <span className="text-xs text-tertiary">Cycle {selectedCycle}</span>
                      </div>

                      {payoutRec.nextRecipient ? (
                        <div className="flex items-center gap-lg pt-sm">
                          <div className="w-14 h-14 rounded-xl bg-brand-solid text-primary-on-brand flex items-center justify-center font-bold text-lg shadow-xs shrink-0">
                            {payoutRec.nextRecipient.name
                              .split(' ')
                              .map((n: string) => n[0])
                              .join('')}
                          </div>
                          <div className="space-y-xxs min-w-0">
                            <span className="text-xs text-tertiary">Suggested next recipient:</span>
                            <h3 className="text-heading-xs font-semibold text-primary truncate">
                              {payoutRec.nextRecipient.name}
                            </h3>
                            <div className="mt-xxs">
                              <ExplorerLink
                                type="address"
                                value={payoutRec.nextRecipient.address}
                                network={explorerNetwork}
                              />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="pt-sm space-y-xs">
                          <div className="flex items-center gap-xs text-utility-success-700 font-semibold text-sm">
                            <CheckCircle2 className="size-4 shrink-0" />
                            <span>Circle Rotation Complete</span>
                          </div>
                          <p className="text-xs text-secondary">
                            All members in this circle have received their payout pots.
                          </p>
                        </div>
                      )}

                      <p className="text-sm text-secondary leading-relaxed pt-xs">
                        {payoutRec.rationale}
                      </p>

                      <div className="pt-md border-t border-secondary flex items-center justify-between">
                        <span className="text-xs text-tertiary font-medium">
                          Advisory only · Scheduled recipient signs on-chain claim
                        </span>
                        <span className="text-sm font-semibold text-brand-primary tabular-nums">
                          {totalOnchainPotReceived.toLocaleString()} {tokenSymbol} verified
                        </span>
                      </div>
                    </section>

                    {/* On-Chain Move Pot Claim & Incremental Release Section */}
                    <section className="rounded-xl border border-secondary bg-primary p-2xl sm:p-3xl shadow-xs space-y-lg">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-sm">
                          <ShieldCheck className="size-5 text-fg-brand-primary shrink-0" />
                          <h4 className="text-sm font-semibold text-primary">
                            Move Contract Vault Claim
                          </h4>
                        </div>
                        <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-sm py-xxs text-xs font-medium text-utility-brand-700">
                          {isMatchingVault && onchainState?.status === 3
                            ? 'Rotation Completed'
                            : isCycleClaimed(selectedCycle)
                            ? 'Claimed'
                            : Date.now() > Date.parse(windowEnd)
                            ? 'Deadline Passed'
                            : 'Active Cycle'}
                        </span>
                      </div>

                      {isUnsupportedCircleToken && (
                        <div className="p-md rounded-lg bg-utility-warning-50 border border-utility-warning-200 text-xs text-utility-warning-800 leading-relaxed space-y-xxs">
                          <div className="flex items-center gap-xs font-semibold text-utility-warning-900">
                            <AlertTriangle className="size-3.5 text-utility-warning-600 shrink-0" />
                            <span>Unsupported Contribution Token: WAL</span>
                          </div>
                          <p>
                            This circle was created with token <strong>WAL</strong>. WAL is no longer supported for new contributions. Existing funds in the on-chain vault ({actualVaultBalance.toLocaleString()} {tokenSymbol}) can still be claimed by the scheduled recipient.
                          </p>
                        </div>
                      )}

                      {isMatchingVault && onchainState?.status === 3 ? (
                        <div className="rounded-xl border-2 border-utility-brand-200 bg-utility-brand-50/50 p-xl space-y-sm text-center">
                          <Sparkles className="size-6 text-brand-primary mx-auto mb-xs" />
                          <h4 className="text-sm font-bold text-primary">Savings Circle Rotation Completed!</h4>
                          <p className="text-xs text-secondary max-w-sm mx-auto">
                            All {members.length} cycles have been funded and payouts have been successfully claimed by all {members.length} members.
                          </p>
                        </div>
                      ) : isCycleClaimed(selectedCycle) ? (
                        <div className="rounded-xl border border-utility-success-200 bg-utility-success-50 p-xl space-y-sm">
                          <div className="flex items-center gap-sm">
                            <CheckCircle2 className="size-5 text-utility-success-600 shrink-0" />
                            <div>
                              <h4 className="text-sm font-semibold text-utility-success-800">
                                Cycle {selectedCycle} Payout Claimed
                              </h4>
                              <p className="text-xs text-utility-success-700 mt-xxs">
                                The cycle pot of {potPerCycle} {tokenSymbol} was successfully claimed by{' '}
                                <strong className="font-semibold">{scheduledRecipient?.name || 'Scheduled Recipient'}</strong>.
                              </p>
                            </div>
                          </div>
                          {claimedCycles[selectedCycle]?.txDigest && (
                            <div className="pt-xs border-t border-utility-success-200/60 flex items-center justify-between text-xs text-utility-success-700">
                              <span className="font-medium">Claim Transaction:</span>
                              <ExplorerLink
                                type="tx"
                                value={claimedCycles[selectedCycle].txDigest}
                                network={explorerNetwork}
                              />
                            </div>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="rounded-xl bg-secondary p-lg border border-secondary text-xs space-y-xs">
                            <div className="flex justify-between">
                              <span className="text-tertiary">Currently in Vault:</span>
                              <span className="font-bold text-primary tabular-nums">
                                {actualVaultBalance.toLocaleString()} {tokenSymbol}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-tertiary">Cycle Target Pot:</span>
                              <span className="font-semibold text-primary tabular-nums">
                                {potPerCycle.toLocaleString()} {tokenSymbol}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-tertiary">Scheduled Recipient:</span>
                              <span className="font-semibold text-primary">
                                {scheduledRecipient?.name || 'Unknown'}
                              </span>
                            </div>
                          </div>

                          {/* Payout Swap Advisory Guardrail (Loop 5) */}
                          {payoutRec?.payoutSwapAdvisory?.detected && (
                            <div className="p-md rounded-lg bg-utility-warning-50 border border-utility-warning-200 text-xs text-utility-warning-800 leading-relaxed flex items-start gap-xs">
                              <AlertTriangle className="size-4 text-utility-warning-600 shrink-0 mt-0.5" />
                              <div className="space-y-xs">
                                <div>
                                  <strong>Payout Swap Advisory:</strong>{' '}
                                  {payoutRec.payoutSwapAdvisory.advisoryNote}
                                </div>
                                {payoutRec.payoutSwapAdvisory.walrusBlobId && (
                                  <div>
                                    <ExplorerLink
                                      type="walrus"
                                      id={payoutRec.payoutSwapAdvisory.walrusBlobId}
                                      label={`Agreement Blob: ${payoutRec.payoutSwapAdvisory.walrusBlobId.slice(0, 10)}...`}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Vault Discrepancy Notice */}
                          {Boolean(isMatchingVault && actualVaultBalance < verifiedContributionSum && !isCycleClaimed(selectedCycle)) && (
                            <div className="p-md rounded-lg bg-utility-warning-50 border border-utility-warning-200 text-xs text-utility-warning-800 leading-relaxed flex items-start gap-xs">
                              <AlertTriangle className="size-4 text-utility-warning-600 shrink-0 mt-0.5" />
                              <div>
                                <strong>Vault Funding Notice:</strong> The on-chain Move vault holds {actualVaultBalance.toLocaleString()} {tokenSymbol}, but member transfer records indicate {verifiedContributionSum.toLocaleString()} {tokenSymbol}. The remaining member should complete their deposit directly through the Move contract so the full {potPerCycle.toLocaleString()} {tokenSymbol} pot is claimable.
                              </div>
                            </div>
                          )}

                          {/* Move Contract Rules Notice */}
                          {(() => {
                            const onchainDeadlineMs =
                              isMatchingVault && onchainState?.cycleDeadlineMs && onchainState.cycleDeadlineMs > 0
                                ? onchainState.cycleDeadlineMs
                                : windowEnd
                                ? Date.parse(windowEnd)
                                : 0
                            const isDeadlinePassedOnchain = onchainDeadlineMs > 0 && Date.now() > onchainDeadlineMs
                            const isPotFullyFunded = actualVaultBalance >= potPerCycle && potPerCycle > 0

                            if (isPotFullyFunded) {
                              return (
                                <div className="p-md rounded-lg bg-utility-success-50 border border-utility-success-200 text-xs text-utility-success-700 leading-relaxed">
                                  <strong>100% Pot Funded:</strong> All members have contributed. The scheduled recipient ({scheduledRecipient?.name || 'recipient'}) can now claim the full {actualVaultBalance.toLocaleString()} {tokenSymbol} pot!
                                </div>
                              )
                            }
                            if (!isDeadlinePassedOnchain && !isPotFullyFunded) {
                              return (
                                <div className="p-md rounded-lg bg-utility-warning-50 border border-utility-warning-200 text-xs text-utility-warning-700 leading-relaxed">
                                  <strong>Awaiting full funding:</strong> Cycle vault currently has {actualVaultBalance.toLocaleString()}/{potPerCycle.toLocaleString()} {tokenSymbol}. Per Move contract safety rules, claims before the deadline require 100% full funding. Awaiting contributions from remaining members.
                                </div>
                              )
                            }
                            if (isDeadlinePassedOnchain && !isPotFullyFunded && actualVaultBalance > 0) {
                              return (
                                <div className="p-md rounded-lg bg-utility-brand-50 border border-utility-brand-200 text-xs text-brand-primary leading-relaxed">
                                  <strong>Deadline passed:</strong> The cycle deadline has passed on-chain. The Move contract allows the scheduled recipient to incrementally claim the amount currently available in the vault ({actualVaultBalance.toLocaleString()} {tokenSymbol}).
                                </div>
                              )
                            }
                            return null
                          })()}

                          {!isMoveCircleVault && (
                            <div
                              className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-xs leading-relaxed text-utility-warning-700"
                              role="alert"
                            >
                              <strong>Contract vault required for claims:</strong> the configured address is not a deployed Ajo Move Circle object.
                            </div>
                          )}

                          {/* Recipient Claim Action */}
                          {currentAccount &&
                          scheduledRecipient &&
                          normalizeSuiObjectId(currentAccount.address) ===
                            normalizeSuiObjectId(scheduledRecipient.address) ? (
                            <div className="pt-sm border-t border-secondary">
                              {(() => {
                                const onchainDeadlineMs =
                                  isMatchingVault && onchainState?.cycleDeadlineMs && onchainState.cycleDeadlineMs > 0
                                    ? onchainState.cycleDeadlineMs
                                    : windowEnd
                                    ? Date.parse(windowEnd)
                                    : 0
                                const isDeadlinePassedOnchain = onchainDeadlineMs > 0 && Date.now() > onchainDeadlineMs
                                const isPotFullyFunded = actualVaultBalance >= potPerCycle && potPerCycle > 0

                                return (
                                  <button
                                    type="button"
                                    onClick={() => handleOpenClaimModal(actualVaultBalance)}
                                    disabled={
                                      !isMoveCircleVault ||
                                      actualVaultBalance === 0 ||
                                      (!isDeadlinePassedOnchain && !isPotFullyFunded)
                                    }
                                    className="w-full inline-flex items-center justify-center gap-sm px-xl py-md rounded-lg bg-brand-solid text-primary-on-brand text-sm font-semibold hover:bg-brand-solid-hover shadow-xs transition-colors disabled:opacity-50"
                                  >
                                    <Sparkles className="size-4 text-fg-white shrink-0" />
                                    <span>
                                      {actualVaultBalance === 0
                                        ? 'No Funds in Vault to Claim'
                                        : isPotFullyFunded
                                        ? `Claim Full Cycle Pot (${actualVaultBalance.toLocaleString()} ${tokenSymbol})`
                                        : `Claim Available Vault Funds (${actualVaultBalance.toLocaleString()} ${tokenSymbol})`}
                                    </span>
                                  </button>
                                )
                              })()}
                            </div>
                          ) : (
                            <p className="text-xs text-tertiary pt-xs">
                              Only the scheduled recipient ({scheduledRecipient?.name || 'listed recipient'}) can claim funds from the contract vault.
                            </p>
                          )}
                        </>
                      )}
                    </section>

                    <section className="rounded-xl border border-secondary bg-primary shadow-xs overflow-hidden">
                      <button
                        onClick={() => setExpandedReasoning(!expandedReasoning)}
                        className="w-full p-2xl sm:p-3xl flex items-center justify-between text-left hover:bg-secondary-hover"
                      >
                        <div className="flex items-center gap-sm">
                          <Bookmark className="size-4 text-fg-brand-primary shrink-0" />
                          <span className="text-sm font-semibold text-primary">
                            Why this suggestion (Walrus Memory citations)
                          </span>
                        </div>
                        {expandedReasoning ? (
                          <ChevronDown className="size-4 text-fg-secondary shrink-0" />
                        ) : (
                          <ChevronRight className="size-4 text-fg-secondary shrink-0" />
                        )}
                      </button>

                      {expandedReasoning && (
                        <div className="p-2xl sm:p-3xl pt-none border-t border-secondary bg-secondary space-y-md text-xs">
                          {withMemory && memoriesList.length > 0 ? (
                            (() => {
                              const citedBlobSet = new Set(
                                (payoutRec?.memberRisks || [])
                                  .map((r: any) => r.citedBlob)
                                  .filter(Boolean)
                              )
                              const orderedMemories = [...memoriesList].sort((a, b) => {
                                const aCited = citedBlobSet.has(a.walrusBlobId) ? 1 : 0
                                const bCited = citedBlobSet.has(b.walrusBlobId) ? 1 : 0
                                return bCited - aCited
                              })
                              return (
                                <ul className="space-y-sm pt-md">
                                  {orderedMemories.slice(0, 6).map((m) => {
                                    const isActivelyCited = citedBlobSet.has(m.walrusBlobId)
                                    return (
                                      <li
                                        key={m.walrusBlobId}
                                        className="flex items-start gap-sm text-secondary"
                                      >
                                        <span
                                          className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                                            isActivelyCited
                                              ? 'bg-utility-success-500'
                                              : 'bg-brand-solid'
                                          }`}
                                        />
                                        <div className="flex flex-wrap items-center gap-xs">
                                          {isActivelyCited && (
                                            <span className="px-xs py-0.5 rounded text-[10px] font-semibold bg-utility-success-50 text-utility-success-700 border border-utility-success-200">
                                              Cited in Cycle {selectedCycle}
                                            </span>
                                          )}
                                          <span>
                                            <strong>{m.title}:</strong> {m.context}
                                          </span>
                                          <ExplorerLink type="walrus-blob" value={m.walrusBlobId} />
                                        </div>
                                      </li>
                                    )
                                  })}
                                </ul>
                              )
                            })()
                          ) : (
                            <p className="text-tertiary pt-md">
                              No Walrus memories recalled for this circle.
                            </p>
                          )}
                        </div>
                      )}
                    </section>
                  </div>

                  {/* Right Column (6 cols on desktop): Member Risk Assessment */}
                  <div className="lg:col-span-6 space-y-2xl sm:space-y-3xl">
                    <section className="rounded-xl border border-secondary bg-primary shadow-xs overflow-hidden">
                      <div className="p-xl sm:p-2xl border-b border-secondary flex items-center justify-between">
                        <div>
                          <h4 className="text-heading-xs font-semibold text-primary">
                            Member risk assessment
                          </h4>
                          <p className="mt-xxs text-xs text-tertiary">
                            Real-time risk scoring for Cycle {selectedCycle}
                          </p>
                        </div>
                        <span className="text-xs font-medium text-tertiary bg-secondary px-sm py-xs rounded-md border border-secondary">
                          {payoutRec.memberRisks?.length || 0} members
                        </span>
                      </div>

                      <div className="divide-y divide-secondary">
                        {payoutRec.memberRisks.map((item: any, idx: number) => {
                          const isLow = item.riskLevel === 'Zero Risk' || item.riskLevel === 'Low Risk'
                          const isModerate = item.riskLevel === 'Moderate Risk'
                          const badgeClasses = isLow
                            ? 'bg-utility-success-50 text-utility-success-700 border-utility-success-200'
                            : isModerate
                            ? 'bg-utility-warning-50 text-utility-warning-800 border-utility-warning-300'
                            : 'bg-utility-error-50 text-utility-error-700 border-utility-error-200'

                          const dotColor = isLow
                            ? 'bg-utility-success-500'
                            : isModerate
                            ? 'bg-utility-warning-500'
                            : 'bg-utility-error-500'

                          const memberObj = members.find((m) => m.id === item.member.id) || item.member
                          const hasClaimed = claimedMemberIds.includes(item.member.id)

                          return (
                            <div
                              key={item.member.id || idx}
                              className="p-xl sm:p-2xl space-y-md hover:bg-secondary-hover/30 transition-colors"
                            >
                              {/* Top row: Avatar + Name + Address + Badges */}
                              <div className="flex items-start justify-between gap-md flex-wrap">
                                <div className="flex items-center gap-sm min-w-0">
                                  <div
                                    className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0 ${
                                      memberObj?.avatarColor || 'bg-brand-solid'
                                    }`}
                                  >
                                    {memberObj?.name?.slice(0, 1).toUpperCase() || 'M'}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-xs">
                                      <p className="text-sm font-semibold text-primary truncate">
                                        {memberObj?.name}
                                      </p>
                                      {hasClaimed && (
                                        <span className="px-xs py-0.5 rounded text-[10px] font-bold bg-utility-brand-50 text-brand-primary border border-utility-brand-200">
                                          Claimed Pot
                                        </span>
                                      )}
                                    </div>
                                    <p className="font-mono text-[11px] text-tertiary truncate">
                                      {memberObj?.address ? `${memberObj.address.slice(0, 8)}...${memberObj.address.slice(-6)}` : ''}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex items-center gap-xs shrink-0">
                                  <span
                                    className={`inline-flex items-center gap-1.5 rounded-full border px-sm py-0.5 text-xs font-semibold ${badgeClasses}`}
                                  >
                                    <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                                    <span>{item.riskLevel}</span>
                                  </span>
                                </div>
                              </div>

                              {/* Reasoning Paragraph — Full width with comfortable line height */}
                              <div className="text-xs text-secondary leading-relaxed bg-secondary/50 rounded-lg p-sm border border-secondary">
                                <p className="font-semibold text-primary mb-xxs">Steward Assessment:</p>
                                <p className="text-secondary">{item.reasoning}</p>
                              </div>

                              {/* Bottom row: Recommended Action + Cited Tatum Tx & Walrus Blob */}
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-xs text-xs pt-xs flex-wrap">
                                <div className="flex items-center gap-xs text-tertiary">
                                  <span className="font-semibold text-secondary">Action:</span>
                                  <span className="text-primary font-medium">{item.action}</span>
                                </div>

                                <div className="flex items-center gap-xs flex-wrap">
                                  {item.txDigest && (
                                    <ExplorerLink
                                      type="tx"
                                      value={item.txDigest}
                                      network={explorerNetwork}
                                      shorten={true}
                                    />
                                  )}
                                  {item.citedBlob && (
                                    <div className="flex items-center gap-xs font-mono text-[11px] text-brand-primary bg-utility-brand-50 px-sm py-0.5 rounded border border-utility-brand-200 shrink-0">
                                      <Bookmark className="size-3 shrink-0" />
                                      <ExplorerLink
                                        type="walrus-blob"
                                        value={item.citedBlob}
                                        shorten={true}
                                        showCopy={true}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </main>

      {/* Wallet Connection Modal (Slush & Wallet Standard) */}
      {showWalletModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-md">
          <div className="relative w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-2xl bg-primary border border-secondary shadow-xl p-xl space-y-lg animate-in fade-in duration-150">
            <div className="flex items-center justify-between pb-sm border-b border-secondary">
              <div className="flex items-center gap-sm">
                <div className="w-8 h-8 rounded-lg bg-utility-brand-50 border border-utility-brand-200 flex items-center justify-center text-brand-primary">
                  <Wallet className="size-4 text-fg-brand-primary shrink-0" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-primary">Connect Sui Wallet</h3>
                  <p className="text-xxs text-tertiary">Select Slush or an installed Sui wallet</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowWalletModal(false)}
                className="text-tertiary hover:text-primary p-xs rounded-lg hover:bg-secondary text-sm"
              >
                ✕
              </button>
            </div>

            {detectedWallets.length > 0 ? (
              <div className="space-y-xs">
                {detectedWallets.map((wallet) => (
                  <button
                    key={wallet.name}
                    type="button"
                    onClick={() => handleSelectWallet(wallet)}
                    className="flex items-center justify-between w-full p-md rounded-xl border border-secondary bg-primary hover:bg-secondary hover:border-brand-primary transition-all text-left group"
                  >
                    <div className="flex items-center gap-md min-w-0">
                      {wallet.icon ? (
                        <img src={wallet.icon} alt={wallet.name} className="size-8 rounded-lg shrink-0 object-contain" />
                      ) : (
                        <div className="size-8 rounded-lg bg-brand-solid text-primary-on-brand flex items-center justify-center font-bold text-xs shrink-0">
                          {wallet.name.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-primary truncate group-hover:text-brand-primary">
                          {wallet.name}
                        </div>
                        {wallet.name.toLowerCase().includes('slush') && (
                          <span className="text-[10px] text-brand-primary font-medium">Recommended for Sui</span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-tertiary group-hover:text-brand-primary font-semibold shrink-0 ml-sm">
                      Connect →
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-xl rounded-xl bg-utility-brand-50 border border-utility-brand-200 text-center space-y-md">
                <div className="w-12 h-12 mx-auto rounded-full bg-utility-brand-100 flex items-center justify-center text-brand-primary">
                  <Wallet className="size-6 text-fg-brand-primary" />
                </div>
                <div className="space-y-xs">
                  <h4 className="text-sm font-semibold text-primary">No Sui Wallet Detected</h4>
                  <p className="text-xs text-secondary max-w-xs mx-auto leading-relaxed">
                    Install <strong>Slush</strong> (or any Sui Wallet Standard browser extension) to connect your account and sign circle agreements.
                  </p>
                </div>
                <a
                  href="https://slushwallet.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover transition-colors"
                >
                  <span>Install Slush Wallet</span>
                  <ExternalLink className="size-3 text-fg-white shrink-0" />
                </a>
              </div>
            )}

            {walletAuthError && (
              <p className="text-xs text-error-primary font-medium text-center">{walletAuthError}</p>
            )}
          </div>
        </div>
      )}

      {/* Transaction Review & Signing Modal (Non-Custodial Wallet Direct Execution) */}
      <TransactionReviewModal
        isOpen={txModal.isOpen}
        onClose={() => setTxModal((prev) => ({ ...prev, isOpen: false, errorMessage: null }))}
        onConfirm={txModal.onConfirm}
        actionTitle={txModal.actionTitle}
        actionDescription={txModal.actionDescription}
        circleName={circleName || 'Ajo Savings Circle'}
        circleId={circleId || 'default'}
        destinationObjectId={txModal.destinationObjectId || poolAddress}
        token={txModal.token}
        amountDisplay={txModal.amountDisplay}
        amountBase={txModal.amountBase}
        currentCycle={txModal.currentCycle || selectedCycle}
        totalCycles={members.length || totalCycles}
        recipientAddress={txModal.recipientAddress}
        recipientName={txModal.recipientName}
        senderAddress={txModal.senderAddress || currentAccount?.address}
        walletBalanceDisplay={txModal.walletBalanceDisplay}
        isBalanceInsufficient={txModal.isBalanceInsufficient}
        balanceErrorMessage={txModal.balanceErrorMessage}
        isSubmitting={txModal.isSubmitting}
        isSuccess={txModal.isSuccess}
        verificationPending={txModal.verificationPending}
        verificationNotes={txModal.verificationNotes}
        isVerifying={txModal.isVerifying}
        onRetryVerification={txModal.onRetryVerification}
        txDigest={txModal.txDigest}
        errorMessage={txModal.errorMessage}
        network={rpcStatus.network?.includes('mainnet') ? 'mainnet' : 'testnet'}
        isMoveVault={txModal.isMoveVault !== undefined ? txModal.isMoveVault : isMoveCircleVault}
        allowSplitPayment={txModal.allowSplitPayment}
        maxAmount={txModal.maxAmount}
        selectedAmount={txModal.selectedAmount}
        onSelectedAmountChange={txModal.onSelectedAmountChange}
      />

      {/* Guided Tour Modal */}
      <GuidedTourModal
        isOpen={isTourOpen}
        onClose={() => setIsTourOpen(false)}
        onNavigateTab={(tab) => {
          if (tab === 'create') {
            startCreateNewCircle()
          } else {
            setActiveTab(tab)
            window.location.hash = tab
          }
        }}
        hasActiveCircle={Boolean(circleId && members.length > 0)}
        activeCircleName={circleName}
      />

      {/* Tabs Navigation Component (Mobile & Tablet) */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-primary border-t border-secondary shadow-lg">
        <div className="max-w-md mx-auto flex items-center justify-around px-xs py-1">
          {navTabs
            .filter((tab) => tab.id !== 'create')
            .map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id

              return (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id as any)
                    window.location.hash = tab.id
                  }}
                  className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 py-1.5 px-0.5 rounded-lg transition-all min-h-[48px] focus-visible:ring-2 focus-visible:ring-focus-ring ${
                    isActive
                      ? 'text-brand-primary font-semibold'
                      : 'text-tertiary hover:text-secondary font-medium'
                  }`}
                >
                  <div className="relative">
                    <Icon
                      className={`size-5 shrink-0 ${
                        isActive ? 'text-fg-brand-primary' : 'text-fg-quaternary'
                      }`}
                    />
                    {tab.badge && (
                      <span className="absolute -top-1 -right-1.5 bg-brand-solid text-primary-on-brand text-xs font-bold w-4 h-4 rounded-full flex items-center justify-center text-[10px]">
                        {tab.badge}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] sm:text-xs truncate max-w-full text-center">
                    {tab.label}
                  </span>
                </button>
              )
            })}
        </div>
      </nav>
    </div>
  )
}
