import React, { useState, useEffect, useCallback } from 'react'
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
} from 'lucide-react'

import {
  CycleStatus,
  Member,
  MemoryCategory,
  MemoryRecord,
  ProposedMemory,
  WalrusRestoreOutcome,
} from './services/types'
import { WalrusMemoryStore } from './services/memoryStore'
import { SuiChainVerifier, ExtendedVerificationResult } from './services/chainVerifier'
import { AjoSteward } from './services/steward'

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

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'create' | 'chat' | 'memories' | 'payout'>('dashboard')
  const [withMemory, setWithMemory] = useState<boolean>(true)
  const [selectedCycle, setSelectedCycle] = useState<number>(1)
  const [isVerifying, setIsVerifying] = useState<boolean>(false)
  const [copiedText, setCopiedText] = useState<string | null>(null)
  const [expandedReasoning, setExpandedReasoning] = useState<boolean>(true)

  // Integration health & configuration states
  const [rpcStatus, setRpcStatus] = useState<{
    connected: boolean
    configured?: boolean
    chain: string
    network: string
    error?: string
  }>({ connected: false, configured: false, chain: 'sui', network: 'unconfigured' })

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

  // Stepped flow for Create Circle: 1 = Basics, 2 = Members, 3 = Pool Address, 4 = Review
  const [createStep, setCreateStep] = useState<number>(1)

  // User-configured Circle Details (starts empty — no embedded sample records)
  const [circleId, setCircleId] = useState<string>('')
  const [circleName, setCircleName] = useState<string>('')
  const [contributionPerMember, setContributionPerMember] = useState<number>(0)
  const [tokenType, setTokenType] = useState<string>('')
  const [poolAddress, setPoolAddress] = useState<string>('')
  const [cycleLength, setCycleLength] = useState<string>('Monthly')
  const [windowStart, setWindowStart] = useState<string>(() => {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString()
  })
  const [windowEnd, setWindowEnd] = useState<string>(() => {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2, 23, 59, 59)).toISOString()
  })

  // Members list (starts empty — populated by user or loaded from registered server circle)
  const [members, setMembers] = useState<Member[]>([])
  const [newMemberName, setNewMemberName] = useState('')
  const [newMemberAddress, setNewMemberAddress] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  // Verification state store per member: `${member.id}_${cycle}` -> ExtendedVerificationResult
  const [verifications, setVerifications] = useState<Record<string, ExtendedVerificationResult>>({})
  const [digestInputs, setDigestInputs] = useState<Record<string, string>>({})
  const [verifyingMemberId, setVerifyingMemberId] = useState<string | null>(null)

  // Walrus Memory store records (starts empty — only real records from Walrus)
  const [memoriesList, setMemoriesList] = useState<MemoryRecord[]>([])
  const [isMemoryLoading, setIsMemoryLoading] = useState<boolean>(false)
  const [isMemoryWriting, setIsMemoryWriting] = useState<boolean>(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [restoreOutcome, setRestoreOutcome] = useState<WalrusRestoreOutcome | null>(null)
  const [lookupCircleSlug, setLookupCircleSlug] = useState<string>('')

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

  // Active proposed memory awaiting member confirmation
  const [proposedMemory, setProposedMemory] = useState<ProposedMemory | null>(null)

  // Payout recommendation state
  const [payoutRec, setPayoutRec] = useState<any>(null)
  const [payoutError, setPayoutError] = useState<string | null>(null)
  const [isPayoutLoading, setIsPayoutLoading] = useState<boolean>(false)

  // Check backend service statuses on boot
  const refreshServiceStatuses = useCallback(async () => {
    try {
      const [cfgRes, suiRes, memRes, stewRes] = await Promise.all([
        fetch('/api/config/status').then((r) => r.json()).catch(() => null),
        chainVerifier.checkRpcStatus(),
        memoryStore.checkHealth(),
        steward.checkStatus(),
      ])
      setRpcStatus(suiRes)
      setMemwalHealth(memRes)
      setStewardStatus(stewRes)
      if (cfgRes?.integrations?.tatum?.tokenType && !tokenType) {
        setTokenType(cfgRes.integrations.tatum.tokenType)
      }
    } catch {
      // Handled per-service
    }
  }, [tokenType])

  // Load any active circle registered on the server on boot
  useEffect(() => {
    refreshServiceStatuses()
    fetch('/api/memory/circles')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.circles) && data.circles.length > 0) {
          const latest = data.circles[data.circles.length - 1]
          setCircleId(latest.circleId)
          setLookupCircleSlug(latest.circleId)
          setCircleName(latest.circleName)
          setPoolAddress(latest.poolAddress)
          setContributionPerMember(latest.contributionPerMember)
          if (latest.tokenType) setTokenType(latest.tokenType)
          setCycleLength(latest.cycleLength || 'Monthly')
          setSelectedCycle(latest.currentCycle || 1)
          setMembers(latest.members || [])
          if (latest.members?.[0]?.id) setConfirmingMemberId(latest.members[0].id)
          memoryStore.setCircleId(latest.circleId)
        }
      })
      .catch(() => {})
  }, [refreshServiceStatuses])

  // Refresh memories from Walrus when circleId is active
  const refreshMemories = useCallback(async (targetCircleId?: string) => {
    const cid = (targetCircleId ?? circleId).trim()
    if (!cid) return
    setIsMemoryLoading(true)
    setMemoryError(null)
    try {
      memoryStore.setCircleId(cid)
      const records = await memoryStore.list()
      setMemoriesList(records)
    } catch (err: any) {
      setMemoryError(err.message || 'Failed to recall memories from Walrus')
    } finally {
      setIsMemoryLoading(false)
    }
  }, [circleId])

  useEffect(() => {
    if (circleId && memwalHealth.configured) {
      refreshMemories(circleId)
    }
  }, [circleId, memwalHealth.configured, refreshMemories])

  // Re-evaluate group policy whenever `withMemory` or `memoriesList` changes,
  // preserving the underlying chain status (`Late` remains `Late` as a chain fact).
  useEffect(() => {
    if (members.length === 0) return
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
            chainResult: existing,
            withMemory,
            windowEnd,
            memories: memoriesList,
            memberId: m.id,
            memberName: m.name,
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
  }, [withMemory, memoriesList, selectedCycle, windowEnd])

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
          { circleId, windowEnd }
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
  }, [activeTab, selectedCycle, members, verifications, memoriesList, withMemory, circleId, windowEnd])

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard?.writeText(text)
    setCopiedText(id)
    setTimeout(() => setCopiedText(null), 2000)
  }

  // Verify all members onchain
  const handleVerifyOnchain = async () => {
    if (members.length === 0 || !poolAddress || !tokenType) return
    setIsVerifying(true)
    try {
      await refreshServiceStatuses()
      const updated = { ...verifications }
      for (const m of members) {
        const res = await chainVerifier.verifyContribution({
          circleId: circleId || 'default',
          poolAddress,
          memberAddress: m.address,
          memberId: m.id,
          memberName: m.name,
          token: tokenType,
          expectedAmount: contributionPerMember,
          windowStart,
          windowEnd,
          cycle: selectedCycle,
          withMemory,
          memories: memoriesList,
        })
        updated[`${m.id}_${selectedCycle}`] = res
      }
      setVerifications(updated)
    } finally {
      setIsVerifying(false)
    }
  }

  // Verify a specific member's submitted transaction digest
  const handleVerifyMemberDigest = async (member: Member) => {
    const inputKey = `${member.id}_${selectedCycle}`
    const rawDigest = (digestInputs[inputKey] || '').trim()
    if (!rawDigest) return

    setVerifyingMemberId(member.id)
    try {
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
        txDigest: rawDigest,
        withMemory,
        memories: memoriesList,
      })
      setVerifications((prev) => ({
        ...prev,
        [inputKey]: res,
      }))
      setDigestInputs((prev) => ({ ...prev, [inputKey]: '' }))
    } finally {
      setVerifyingMemberId(null)
    }
  }

  // Rebuild / restore from Walrus action
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
      const outcome = await memoryStore.restore(15)
      setRestoreOutcome(outcome)
      setMemoriesList(outcome.records || [])
    } catch (err: any) {
      setMemoryError(err.message || 'Failed to restore memories from Walrus')
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

  // Confirm proposed memory -> writes to Walrus Mainnet and waits for real blob_id
  const handleConfirmMemory = async (prop: ProposedMemory) => {
    if (!circleId) {
      setMemoryError('Activate or register a circle before confirming memories.')
      return
    }
    const actorId = confirmingMemberId || members[0]?.id
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
      })

      await refreshMemories(circleId)
      setProposedMemory(null)

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          sender: 'steward',
          text: `Saved to Walrus Mainnet (Blob ID: ${newRecord.walrusBlobId}): "${newRecord.title}".`,
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

  // Reject proposed memory
  const handleRejectMemory = () => {
    setProposedMemory(null)
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
    } catch (err: any) {
      setMemoryError(err.message || 'Failed to propose memory')
    }
  }

  // Add Member in Create flow
  const handleAddMember = () => {
    if (!newMemberName.trim() || !newMemberAddress.trim()) return
    const nextIdx = members.length
    const newM: Member = {
      id: `m${nextIdx + 1}`,
      name: newMemberName.trim(),
      address: newMemberAddress.trim(),
      avatarColor: AVATAR_PALETTE[nextIdx % AVATAR_PALETTE.length],
    }
    setMembers((prev) => {
      const updated = [...prev, newM]
      if (!confirmingMemberId) setConfirmingMemberId(newM.id)
      return updated
    })
    setNewMemberName('')
    setNewMemberAddress('')
  }

  // Activate Circle in Step 4 of Create flow
  const handleActivateCircle = async () => {
    setCreateError(null)
    const slug = slugifyCircleId(circleName)
    if (!slug) {
      setCreateError('Please enter a valid circle name.')
      return
    }
    if (members.length === 0) {
      setCreateError('Please add at least one member to the circle.')
      return
    }
    if (!poolAddress.trim()) {
      setCreateError('Please enter a Sui pool vault address.')
      return
    }

    try {
      const registered = await memoryStore.registerCircle({
        circleId: slug,
        circleName: circleName.trim(),
        poolAddress: poolAddress.trim(),
        contributionPerMember: Number(contributionPerMember) || 0,
        tokenType: tokenType.trim(),
        cycleLength,
        currentCycle: selectedCycle,
        members,
        organizerAddress: members[0]?.address,
      })
      setCircleId(registered.circleId)
      setLookupCircleSlug(registered.circleId)
      if (!confirmingMemberId && members[0]?.id) {
        setConfirmingMemberId(members[0].id)
      }
      setActiveTab('dashboard')
      if (memwalHealth.configured) {
        await refreshMemories(registered.circleId)
      }
    } catch (err: any) {
      setCreateError(err.message || 'Failed to register circle on server')
    }
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

  const totalOnchainPotReceived = members.reduce((sum, m) => {
    const r = verifications[`${m.id}_${selectedCycle}`]
    if (!r || typeof r.amountReceived !== 'number') return sum
    if (r.status === 'Verified' || r.status === 'Late' || r.status === 'Partial') {
      return sum + r.amountReceived
    }
    return sum
  }, 0)

  const scheduledRecipient =
    members.length > 0 ? members[(selectedCycle - 1) % members.length] : null

  const tokenSymbol = tokenType
    ? tokenType.split('::').pop() || tokenType
    : 'TOKEN'

  const explorerNetwork =
    rpcStatus.network?.includes('testnet') ? 'testnet' : 'mainnet'

  return (
    <div className="min-h-screen bg-secondary text-primary font-sans flex flex-col items-center antialiased pb-24 md:pb-12">
      <div className="w-full max-w-xl mx-auto flex flex-col flex-1 px-md sm:px-lg">
        {/* Page Header Component */}
        <header className="sticky top-0 z-30 bg-primary border-b border-secondary p-xl -mx-md sm:-mx-lg mb-md flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-md min-w-0">
            <div className="w-10 h-10 rounded-lg bg-brand-solid flex items-center justify-center text-primary-on-brand shadow-xs shrink-0">
              <ShieldCheck className="size-5 text-fg-white shrink-0" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-xs">
                <h1 className="text-heading-xs font-semibold text-primary truncate">
                  {circleName || 'Ajo Savings Circle Steward'}
                </h1>
                <span
                  className={`w-2 h-2 rounded-full inline-block shrink-0 ${
                    rpcStatus.connected ? 'bg-success-primary' : 'bg-warning-primary'
                  }`}
                  title={
                    rpcStatus.connected
                      ? `Tatum Sui connected (${rpcStatus.network})`
                      : rpcStatus.error || 'Tatum Sui RPC not connected'
                  }
                />
              </div>
              <p className="text-sm text-tertiary">
                {members.length > 0 ? (
                  <>
                    Cycle {selectedCycle} of {totalCycles} ·{' '}
                    <span className="tabular-nums font-medium text-primary">
                      {totalOnchainPotReceived.toLocaleString()} {tokenSymbol}
                    </span>{' '}
                    verified on-chain
                  </>
                ) : (
                  'No active circle configured yet'
                )}
              </p>
            </div>
          </div>

          <button
            onClick={handleVerifyOnchain}
            disabled={isVerifying || members.length === 0}
            aria-label="Refresh from Sui"
            title="Re-verify submitted digests against Tatum Sui RPC"
            className="inline-flex items-center justify-center rounded-lg bg-primary p-md text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50 shrink-0"
          >
            <RefreshCw
              className={`size-4 text-fg-secondary shrink-0 ${
                isVerifying ? 'animate-spin text-fg-brand-primary' : ''
              }`}
            />
          </button>
        </header>

        {/* Steward Mode Control Card */}
        <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs mb-lg">
          <div className="flex items-center justify-between mb-sm">
            <span className="text-sm font-medium text-secondary flex items-center gap-xs">
              <Brain className="size-4 text-fg-brand-primary shrink-0" />
              Steward Mode
            </span>
            <span className="text-xs text-tertiary">
              {memwalHealth.connected
                ? `Walrus Mainnet active (${memoriesList.length} memories)`
                : 'Walrus Memory offline/unconfigured'}
            </span>
          </div>

          <div className="grid grid-cols-2 p-xxs bg-secondary rounded-lg border border-secondary gap-xs">
            <button
              type="button"
              onClick={() => setWithMemory(true)}
              className={`inline-flex items-center justify-center gap-xs rounded-lg px-lg py-sm text-sm font-semibold transition-all border ${
                withMemory
                  ? 'border-transparent bg-brand-solid text-primary-on-brand shadow-xs'
                  : 'border-transparent text-secondary hover:bg-primary-hover'
              } focus-visible:ring-2 focus-visible:ring-focus-ring`}
            >
              <CheckCircle2
                className={`size-4 shrink-0 ${withMemory ? 'text-fg-white' : 'text-fg-quaternary'}`}
              />
              <span>With memory</span>
            </button>
            <button
              type="button"
              onClick={() => setWithMemory(false)}
              className={`inline-flex items-center justify-center gap-xs rounded-lg px-lg py-sm text-sm font-semibold transition-all border ${
                !withMemory
                  ? 'border-primary bg-primary text-secondary shadow-xs'
                  : 'border-transparent text-secondary hover:bg-primary-hover'
              } focus-visible:ring-2 focus-visible:ring-focus-ring`}
            >
              <Clock
                className={`size-4 shrink-0 ${
                  !withMemory ? 'text-fg-warning-primary' : 'text-fg-quaternary'
                }`}
              />
              <span>Without memory</span>
            </button>
          </div>

          <div className="mt-md flex gap-lg rounded-xl bg-utility-brand-50 p-xl">
            <Info className="mt-xxs size-5 shrink-0 text-utility-brand-600" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-utility-brand-600">
                {withMemory
                  ? 'Walrus memory recall + policy evaluation active'
                  : 'Strict timestamp verification only (Walrus recall disabled)'}
              </p>
              <p className="mt-xxs text-sm text-tertiary">
                {withMemory ? (
                  <>
                    Chain facts (<strong className="text-primary">Verified</strong>,{' '}
                    <strong className="text-primary">Late</strong>,{' '}
                    <strong className="text-primary">Partial</strong>) are kept separate from group
                    policy. Confirmed Walrus agreements can excuse a late payment in policy without
                    altering the on-chain timestamp fact.
                  </>
                ) : (
                  <>
                    Evaluating on-chain transaction timestamps strictly against the cycle deadline
                    with memory recall disabled.
                  </>
                )}
              </p>
            </div>
          </div>
        </section>

        {/* SCREEN 1: HOME (CIRCLE DASHBOARD) */}
        {activeTab === 'dashboard' && (
          <div className="space-y-lg">
            {members.length === 0 ? (
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                <h3 className="text-heading-xs font-semibold text-primary">
                  No savings circle configured yet
                </h3>
                <p className="text-sm text-tertiary">
                  Start with a clean slate by creating your circle roster and Sui pool address, or
                  restore an existing circle namespace from Walrus Memory in the Memory tab.
                </p>
                <div className="flex flex-wrap gap-sm pt-xs">
                  <button
                    onClick={() => {
                      setCreateStep(1)
                      setActiveTab('create')
                    }}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <PlusCircle className="size-4 text-fg-white shrink-0" />
                    <span>Set up savings circle</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('memories')}
                    className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <Brain className="size-4 text-fg-brand-primary shrink-0" />
                    <span>Open Walrus Memory</span>
                  </button>
                </div>
              </section>
            ) : (
              <>
                {/* Pot Summary Card */}
                <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="text-sm text-tertiary">Verified on-chain pot this cycle</span>
                      <div className="mt-xs text-heading-md font-semibold text-primary tabular-nums">
                        {totalOnchainPotReceived.toLocaleString()}{' '}
                        <span className="text-sm font-normal text-tertiary">
                          / {potPerCycle.toLocaleString()} {tokenSymbol}
                        </span>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                      Cycle {selectedCycle} of {totalCycles}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="space-y-xs">
                    <div className="flex justify-between text-sm text-tertiary">
                      <span>
                        {chainVerifiedCount} on-time on-chain · {policyAcceptedCount} accepted by policy
                      </span>
                      <span className="tabular-nums font-semibold text-primary">
                        {potPerCycle > 0
                          ? Math.min(100, Math.round((totalOnchainPotReceived / potPerCycle) * 100))
                          : 0}
                        %
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-tertiary">
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
                  </div>

                  {scheduledRecipient && (
                    <div className="pt-md border-t border-secondary flex items-center justify-between">
                      <div className="flex items-center gap-md">
                        <div className="w-10 h-10 rounded-full bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200 flex items-center justify-center font-bold text-xs shrink-0">
                          {scheduledRecipient.name
                            .split(' ')
                            .map((n) => n[0])
                            .join('')}
                        </div>
                        <div>
                          <p className="text-xs text-tertiary">Scheduled cycle recipient:</p>
                          <p className="text-sm font-semibold text-primary">
                            {scheduledRecipient.name}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => setActiveTab('payout')}
                        className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        <span>Review payout</span>
                        <ChevronRight className="size-4 text-fg-quaternary shrink-0" />
                      </button>
                    </div>
                  )}
                </section>

                {/* Cycle Timeline Strip */}
                <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                  <div className="flex items-center justify-between mb-md">
                    <span className="text-sm font-medium text-secondary">Cycle rotation</span>
                    <span className="text-xs text-tertiary">Tap cycle to inspect</span>
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
                      const chainStatus = raw?.status
                      const ringColor =
                        chainStatus === 'Verified'
                          ? 'ring-2 ring-utility-success-600'
                          : chainStatus === 'Late' ||
                            chainStatus === 'WrongToken' ||
                            chainStatus === 'WrongAmount'
                          ? 'ring-2 ring-error-primary'
                          : chainStatus === 'Partial' || chainStatus === 'Pending'
                          ? 'ring-2 ring-warning-primary'
                          : 'ring-2 ring-utility-gray-200'

                      return (
                        <div key={member.id} className="flex flex-col items-center gap-xs min-w-[56px]">
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
                          <span className="text-xs text-primary font-medium truncate max-w-[56px] text-center">
                            {member.name.split(' ')[0]}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </section>

                {/* Contributions Table with Digest-First Verification + Separate Chain & Policy Status */}
                <div className="overflow-hidden rounded-xl border border-secondary bg-primary shadow-xs">
                  <div className="p-xl border-b border-secondary flex items-center justify-between">
                    <div>
                      <h3 className="text-heading-xs font-semibold text-primary">
                        Contributions this cycle
                      </h3>
                      <p className="mt-xs text-sm text-tertiary">
                        Submit a Sui transaction digest to verify via Tatum{' '}
                        <code className="font-mono text-xs">sui_getTransactionBlock</code>
                      </p>
                    </div>
                    <span className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700">
                      {contributionPerMember} {tokenSymbol} each
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 z-10 bg-secondary">
                        <tr className="border-b border-secondary text-left">
                          <th className="px-xl py-md text-sm font-semibold text-quaternary">
                            Member & Digest Verification
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
                          const chainStatus: CycleStatus = raw?.status || 'Unverified'
                          const policyStatus =
                            raw?.policy?.policyStatus ||
                            (raw
                              ? raw.status === 'Pending'
                                ? 'Pending contribution'
                                : 'Unverified'
                              : 'Not checked yet (submit tx digest)')

                          const chainBadgeColor =
                            chainStatus === 'Verified'
                              ? 'utility-success'
                              : chainStatus === 'Partial' || chainStatus === 'Pending'
                              ? 'utility-warning'
                              : 'utility-error'

                          const policyCounts = raw?.policy?.countsTowardPot ?? false
                          const policyBadgeColor = policyCounts
                            ? 'utility-success'
                            : raw?.policy?.policyVerdict === 'in_progress_known_pattern' ||
                              chainStatus === 'Pending'
                            ? 'utility-warning'
                            : 'utility-error'

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
                                    <p className="text-primary font-medium">{member.name}</p>
                                    <p className="text-xs font-mono text-tertiary truncate max-w-[220px]">
                                      {member.address}
                                    </p>

                                    {tx ? (
                                      <div className="flex items-center gap-xxs bg-secondary px-xs py-0.5 rounded text-xs text-secondary font-mono w-fit">
                                        <span>
                                          {tx.length > 14
                                            ? `${tx.substring(0, 6)}...${tx.substring(tx.length - 4)}`
                                            : tx}
                                        </span>
                                        <button
                                          onClick={() => handleCopy(tx, `tx-${member.id}`)}
                                          className="text-tertiary hover:text-primary p-xxs rounded"
                                          title="Copy transaction digest"
                                        >
                                          {copiedText === `tx-${member.id}` ? (
                                            <CheckCheck className="size-3 text-fg-success-primary shrink-0" />
                                          ) : (
                                            <Copy className="size-3 text-fg-quaternary shrink-0" />
                                          )}
                                        </button>
                                        <a
                                          href={`https://suiscan.xyz/${explorerNetwork}/tx/${encodeURIComponent(
                                            tx.split(',')[0].trim()
                                          )}`}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="text-brand-primary hover:underline flex items-center gap-xxs"
                                          title={`View on Suiscan (${explorerNetwork})`}
                                        >
                                          <ExternalLink className="size-3 text-fg-brand-primary shrink-0" />
                                        </a>
                                      </div>
                                    ) : (
                                      <span className="text-xs text-tertiary block">
                                        {raw?.error || raw?.rawNotes || 'No verified transaction digest'}
                                      </span>
                                    )}

                                    {/* Manual Digest Submission Input */}
                                    <div className="flex items-center gap-xs pt-xxs">
                                      <input
                                        type="text"
                                        value={digestInputs[recKey] || ''}
                                        onChange={(e) =>
                                          setDigestInputs((prev) => ({
                                            ...prev,
                                            [recKey]: e.target.value,
                                          }))
                                        }
                                        placeholder="Paste Sui tx digest..."
                                        className="rounded-md bg-primary px-sm py-xxs text-xs font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring w-36 sm:w-44"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => handleVerifyMemberDigest(member)}
                                        disabled={
                                          verifyingMemberId === member.id ||
                                          !(digestInputs[recKey] || '').trim()
                                        }
                                        className="inline-flex items-center justify-center rounded-md bg-primary px-sm py-xxs text-xs font-semibold text-brand-primary border border-primary shadow-xs hover:bg-primary-hover disabled:opacity-50"
                                      >
                                        {verifyingMemberId === member.id ? 'Checking...' : 'Verify'}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </td>

                              <td className="px-lg py-xl text-md text-tertiary tabular-nums font-medium text-primary align-top">
                                {raw?.amountReceived ?? 0}{' '}
                                <span className="text-xs font-normal text-tertiary">
                                  {tokenSymbol}
                                </span>
                              </td>

                              <td className="px-xl py-xl text-md text-tertiary align-top">
                                <div className="flex flex-col gap-xs items-start">
                                  <span
                                    className={`inline-flex items-center gap-xs rounded-full border border-${chainBadgeColor}-200 bg-${chainBadgeColor}-50 px-md py-xxs text-xs font-medium text-${chainBadgeColor}-700`}
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
                                    <span>Chain: {chainStatus}</span>
                                  </span>

                                  <span
                                    className={`inline-flex items-center gap-xs rounded-full border border-${policyBadgeColor}-200 bg-${policyBadgeColor}-50 px-md py-xxs text-xs font-medium text-${policyBadgeColor}-700`}
                                  >
                                    <span>Policy: {policyStatus}</span>
                                  </span>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            <div className="pt-sm flex justify-center">
              <button
                onClick={() => {
                  setCreateStep(1)
                  setActiveTab('create')
                }}
                className="inline-flex items-center gap-sm px-lg py-sm text-sm font-semibold text-brand-primary hover:text-brand-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <PlusCircle className="size-4 text-fg-brand-primary shrink-0" />
                <span>{members.length > 0 ? 'Edit or set up circle' : 'Create savings circle'}</span>
              </button>
            </div>
          </div>
        )}

        {/* SCREEN 2: CREATE CIRCLE */}
        {activeTab === 'create' && (
          <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-xl">
            <div>
              <div className="flex items-center justify-between text-xs font-medium text-secondary mb-sm">
                <span>Step {createStep} of 4</span>
                <span className="text-brand-primary font-semibold">
                  {createStep === 1
                    ? 'Circle basics'
                    : createStep === 2
                    ? 'Members'
                    : createStep === 3
                    ? 'Pool address'
                    : 'Review & Confirm'}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-tertiary">
                <div
                  className="h-full rounded-full bg-brand-solid transition-all"
                  style={{ width: `${(createStep / 4) * 100}%` }}
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
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Circle details</h3>
                  <p className="mt-xs text-sm text-tertiary">
                    Name your savings group and set the contribution rules and cycle window.
                  </p>
                </div>

                <div className="space-y-md">
                  <div className="flex flex-col gap-sm">
                    <label className="text-sm font-medium text-secondary">Circle name</label>
                    <input
                      type="text"
                      value={circleName}
                      onChange={(e) => setCircleName(e.target.value)}
                      placeholder="Enter circle name..."
                      className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-md">
                    <div className="flex flex-col gap-sm">
                      <label className="text-sm font-medium text-secondary">
                        Contribution per cycle
                      </label>
                      <input
                        type="number"
                        value={contributionPerMember || ''}
                        onChange={(e) => setContributionPerMember(Number(e.target.value) || 0)}
                        placeholder="Amount"
                        className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary tabular-nums focus-visible:ring-2 focus-visible:ring-focus-ring"
                      />
                    </div>

                    <div className="flex flex-col gap-sm">
                      <label className="text-sm font-medium text-secondary">Cycle length</label>
                      <select
                        value={cycleLength}
                        onChange={(e) => setCycleLength(e.target.value)}
                        className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        <option value="Weekly">Weekly</option>
                        <option value="Monthly">Monthly</option>
                        <option value="Bi-Weekly">Bi-Weekly</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex flex-col gap-sm">
                    <label className="text-sm font-medium text-secondary">
                      Sui Coin Type (Move type)
                    </label>
                    <input
                      type="text"
                      value={tokenType}
                      onChange={(e) => setTokenType(e.target.value)}
                      placeholder="0x2::sui::SUI"
                      className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-md">
                    <div className="flex flex-col gap-sm">
                      <label className="text-sm font-medium text-secondary">
                        Cycle Window Start (ISO UTC)
                      </label>
                      <input
                        type="text"
                        value={windowStart}
                        onChange={(e) => setWindowStart(e.target.value)}
                        className="rounded-md bg-primary px-lg py-sm text-xs font-mono text-primary border border-primary"
                      />
                    </div>
                    <div className="flex flex-col gap-sm">
                      <label className="text-sm font-medium text-secondary">
                        Cycle Deadline / Window End (ISO UTC)
                      </label>
                      <input
                        type="text"
                        value={windowEnd}
                        onChange={(e) => setWindowEnd(e.target.value)}
                        className="rounded-md bg-primary px-lg py-sm text-xs font-mono text-primary border border-primary"
                      />
                    </div>
                  </div>
                </div>

                <div className="pt-md flex justify-end">
                  <button
                    onClick={() => setCreateStep(2)}
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

                {members.length === 0 ? (
                  <p className="text-xs text-tertiary italic">No members added yet.</p>
                ) : (
                  <div className="space-y-xs max-h-56 overflow-y-auto">
                    {members.map((m, idx) => (
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
                            <p className="text-xs font-mono text-tertiary truncate">{m.address}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setMembers((prev) => prev.filter((item) => item.id !== m.id))
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
                    onClick={() => setCreateStep(3)}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover"
                  >
                    <span>Continue to pool vault</span>
                    <ArrowRight className="size-4 text-fg-white shrink-0" />
                  </button>
                </div>
              </div>
            )}

            {createStep === 3 && (
              <div className="space-y-lg">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Sui pool address</h3>
                  <p className="mt-xs text-sm text-tertiary">
                    All contributions are verified against incoming transfers to this Sui address.
                  </p>
                </div>

                <div className="flex gap-lg rounded-xl bg-utility-brand-50 p-xl">
                  <ShieldCheck
                    className="mt-xxs size-5 shrink-0 text-utility-brand-600"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-sm font-semibold text-utility-brand-600">
                      Non-custodial advisory guarantee
                    </p>
                    <p className="mt-xxs text-sm text-tertiary">
                      Ajo Steward never holds member wallet keys or moves circle funds.
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Pool vault address</label>
                  <input
                    type="text"
                    value={poolAddress}
                    onChange={(e) => setPoolAddress(e.target.value)}
                    placeholder="0x..."
                    className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

                <div className="pt-md flex items-center justify-between">
                  <button
                    onClick={() => setCreateStep(2)}
                    className="inline-flex items-center px-lg py-sm text-sm font-semibold text-secondary hover:text-primary"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setCreateStep(4)}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover"
                  >
                    <span>Review circle</span>
                    <ArrowRight className="size-4 text-fg-white shrink-0" />
                  </button>
                </div>
              </div>
            )}

            {createStep === 4 && (
              <div className="space-y-lg">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Ready to activate</h3>
                  <p className="mt-xs text-sm text-tertiary">
                    Review your configuration before registering the circle on the server.
                  </p>
                </div>

                <div className="p-xl bg-secondary rounded-xl border border-secondary space-y-md text-sm">
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Circle name</span>
                    <span className="font-semibold text-primary">{circleName || '—'}</span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Walrus namespace slug</span>
                    <span className="font-mono text-xs text-primary">
                      {slugifyCircleId(circleName) || '—'}
                    </span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Contribution</span>
                    <span className="font-semibold text-primary tabular-nums">
                      {contributionPerMember} {tokenSymbol} / member
                    </span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Total pot per cycle</span>
                    <span className="font-semibold text-brand-primary tabular-nums">
                      {potPerCycle.toLocaleString()} {tokenSymbol}
                    </span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Number of members</span>
                    <span className="font-semibold text-primary">
                      {members.length} members ({members.length} cycles)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-tertiary">Vault address</span>
                    <span className="font-mono text-primary truncate max-w-[200px]">
                      {poolAddress || '—'}
                    </span>
                  </div>
                </div>

                <div className="pt-md flex items-center justify-between">
                  <button
                    onClick={() => setCreateStep(3)}
                    className="inline-flex items-center px-lg py-sm text-sm font-semibold text-secondary hover:text-primary"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleActivateCircle}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover"
                  >
                    <span>Activate savings circle</span>
                    <Check className="size-4 text-fg-white shrink-0" />
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* SCREEN 3: STEWARD CHAT */}
        {activeTab === 'chat' && (
          <div className="rounded-xl border border-secondary bg-primary shadow-xs flex flex-col h-[620px] overflow-hidden">
            <div className="p-xl border-b border-secondary flex items-center justify-between bg-primary">
              <div className="flex items-center gap-md">
                <div className="w-10 h-10 rounded-lg bg-brand-solid text-primary-on-brand flex items-center justify-center shadow-xs shrink-0">
                  <Brain className="size-5 text-fg-white shrink-0" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-primary">Ajo AI Steward</h3>
                  <p className="text-xs text-secondary">
                    {withMemory
                      ? `Recalling from ${memoriesList.length} Walrus memories`
                      : 'Memory recall disabled (strict timestamp evaluation)'}
                  </p>
                </div>
              </div>

              <span
                className={`inline-flex items-center gap-xs rounded-full border px-md py-xxs text-xs font-medium ${
                  rpcStatus.connected
                    ? 'border-utility-brand-200 bg-utility-brand-50 text-utility-brand-700'
                    : 'border-utility-warning-200 bg-utility-warning-50 text-utility-warning-700'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    rpcStatus.connected ? 'bg-brand-solid' : 'bg-warning-primary'
                  }`}
                />
                {rpcStatus.connected
                  ? `Sui RPC (${rpcStatus.network})`
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
                      className={`max-w-[85%] sm:max-w-md p-md rounded-xl text-sm leading-relaxed shadow-xs ${
                        msg.sender === 'user'
                          ? 'bg-brand-solid text-primary-on-brand rounded-tr-none'
                          : 'bg-primary text-primary border border-secondary rounded-tl-none'
                      }`}
                    >
                      <p>{msg.text}</p>

                      {msg.citedMemories && msg.citedMemories.length > 0 && (
                        <div className="mt-xs pt-xs border-t border-secondary text-xs space-y-xxs">
                          <span className="font-semibold text-secondary flex items-center gap-xxs">
                            <Bookmark className="size-3 text-fg-brand-primary shrink-0" />
                            <span>Recalled Walrus memories cited:</span>
                          </span>
                          {msg.citedMemories.map((cm) => (
                            <p key={cm.walrusBlobId} className="text-brand-primary font-medium">
                              "{cm.title}" ·{' '}
                              <span className="font-mono text-[11px]">
                                Blob: {cm.walrusBlobId.slice(0, 12)}...
                              </span>
                            </p>
                          ))}
                        </div>
                      )}

                      {msg.citedTxDigests && msg.citedTxDigests.length > 0 && (
                        <div className="mt-xs pt-xs border-t border-secondary text-xs">
                          <span className="font-semibold text-secondary">
                            Cited Sui Tx Digests:{' '}
                          </span>
                          <span className="font-mono text-[11px] text-primary">
                            {msg.citedTxDigests.join(', ')}
                          </span>
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

                {members.length > 0 && (
                  <div className="flex items-center gap-xs pt-xxs">
                    <label className="text-xs text-secondary">Confirming member:</label>
                    <select
                      value={confirmingMemberId}
                      onChange={(e) => setConfirmingMemberId(e.target.value)}
                      className="rounded bg-primary px-sm py-xxs text-xs text-primary border border-primary"
                    >
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.address.slice(0, 8)}...)
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="pt-xs flex items-center gap-sm">
                  <button
                    onClick={() => handleConfirmMemory(proposedMemory)}
                    disabled={isMemoryWriting || !memwalHealth.configured}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover disabled:opacity-50"
                  >
                    <Check className="size-4 text-fg-white shrink-0" />
                    <span>
                      {isMemoryWriting ? 'Writing to Walrus Mainnet...' : 'Confirm & write to Walrus'}
                    </span>
                  </button>
                  <button
                    onClick={handleRejectMemory}
                    disabled={isMemoryWriting}
                    className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover"
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}

            <div className="px-lg py-sm border-t border-secondary bg-primary flex items-center gap-xs overflow-x-auto whitespace-nowrap">
              <span className="text-xs text-tertiary shrink-0">Ask:</span>
              {[
                'Can Tunde pay late this month?',
                'Who has a split payment habit?',
                'Who is the riskiest member before payout?',
              ].map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(chip)}
                  disabled={!stewardStatus.available || isChatTyping}
                  className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700 hover:bg-secondary-hover disabled:opacity-50 shrink-0"
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
        )}

        {/* SCREEN 4: WALRUS MEMORY */}
        {activeTab === 'memories' && (
          <div className="space-y-xl">
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
              <div className="flex items-center justify-between gap-md">
                <div className="flex items-center gap-md">
                  <div className="w-10 h-10 rounded-lg bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200 flex items-center justify-center font-bold shrink-0">
                    <Brain className="size-5 text-fg-brand-primary shrink-0" />
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
              <div className="pt-sm border-t border-secondary space-y-sm">
                <div className="flex flex-col sm:flex-row gap-sm">
                  <input
                    type="text"
                    value={lookupCircleSlug}
                    onChange={(e) => setLookupCircleSlug(e.target.value)}
                    placeholder="Circle ID slug (e.g. lagos-techies-seed-circle)"
                    className="flex-1 rounded-md bg-primary px-lg py-sm text-xs font-mono text-primary placeholder:text-placeholder border border-primary"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const slug = lookupCircleSlug.trim()
                      if (slug) {
                        setCircleId(slug)
                        refreshMemories(slug)
                      }
                    }}
                    disabled={isMemoryLoading || !memwalHealth.configured}
                    className="inline-flex items-center justify-center gap-xs rounded-lg bg-primary px-lg py-sm text-xs font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover disabled:opacity-50"
                  >
                    <RefreshCw className={`size-3.5 ${isMemoryLoading ? 'animate-spin' : ''}`} />
                    <span>Recall memories</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleRestoreFromWalrus}
                    disabled={isMemoryLoading || !memwalHealth.configured}
                    className="inline-flex items-center justify-center gap-xs rounded-lg bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover disabled:opacity-50"
                  >
                    <span>Rebuild index from Walrus</span>
                  </button>
                </div>

                {restoreOutcome && (
                  <div className="p-md rounded-lg bg-secondary border border-secondary text-xs space-y-xxs">
                    <p className="font-semibold text-primary">
                      Walrus Index Restore ({restoreOutcome.namespace}): restored=
                      {restoreOutcome.restoreResult.restored}, skipped=
                      {restoreOutcome.restoreResult.skipped}, failed=
                      {restoreOutcome.restoreResult.failed}, total=
                      {restoreOutcome.restoreResult.total}
                    </p>
                    <p className="text-tertiary">{restoreOutcome.limitationsNote}</p>
                  </div>
                )}

                {memoryError && (
                  <div className="p-md rounded-lg bg-utility-error-50 border border-error-subtle text-xs text-error-primary">
                    {memoryError}
                  </div>
                )}
              </div>
            </section>

            {/* Propose & Confirm Memory Section */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
              <h4 className="text-sm font-semibold text-primary">
                Propose circle memory (requires member confirmation before Walrus write)
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
                <select
                  value={manualCategory}
                  onChange={(e) => setManualCategory(e.target.value as MemoryCategory)}
                  className="rounded-md bg-primary px-lg py-sm text-xs text-primary border border-primary"
                >
                  <option value="Agreements">Agreements</option>
                  <option value="Member patterns">Member patterns</option>
                  <option value="Reminder preferences">Reminder preferences</option>
                </select>
                <select
                  value={manualMemberId}
                  onChange={(e) => setManualMemberId(e.target.value)}
                  className="rounded-md bg-primary px-lg py-sm text-xs text-primary border border-primary"
                >
                  <option value="">Circle-wide (or select member)</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.id})
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="text"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Memory title (e.g. Tunde 72-Hour Grace Rule)"
                className="w-full rounded-md bg-primary px-lg py-sm text-xs text-primary placeholder:text-placeholder border border-primary"
              />
              <input
                type="text"
                value={manualQuote}
                onChange={(e) => setManualQuote(e.target.value)}
                placeholder="Source quote or statement..."
                className="w-full rounded-md bg-primary px-lg py-sm text-xs text-primary placeholder:text-placeholder border border-primary"
              />
              <input
                type="text"
                value={manualRule}
                onChange={(e) => setManualRule(e.target.value)}
                placeholder="Policy rule / action summary..."
                className="w-full rounded-md bg-primary px-lg py-sm text-xs text-primary placeholder:text-placeholder border border-primary"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleProposeManualMemory}
                  className="inline-flex items-center gap-xs rounded-lg bg-primary px-lg py-sm text-xs font-semibold text-brand-primary border border-primary shadow-xs hover:bg-primary-hover"
                >
                  <span>Stage memory proposal</span>
                </button>
              </div>

              {proposedMemory && (
                <div className="p-md rounded-xl bg-utility-brand-50 border border-utility-brand-200 space-y-xs">
                  <p className="text-xs font-semibold text-brand-primary">
                    Pending Proposal: {proposedMemory.title}
                  </p>
                  <p className="text-xs italic text-secondary">"{proposedMemory.quote}"</p>
                  {members.length > 0 && (
                    <div className="flex items-center gap-xs">
                      <span className="text-xs text-secondary">Confirming member:</span>
                      <select
                        value={confirmingMemberId}
                        onChange={(e) => setConfirmingMemberId(e.target.value)}
                        className="rounded bg-primary px-sm py-xxs text-xs text-primary border border-primary"
                      >
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="flex gap-sm pt-xs">
                    <button
                      type="button"
                      onClick={() => handleConfirmMemory(proposedMemory)}
                      disabled={isMemoryWriting || !memwalHealth.configured}
                      className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs disabled:opacity-50"
                    >
                      <Check className="size-3.5 text-fg-white" />
                      <span>
                        {isMemoryWriting
                          ? 'Writing to Walrus Mainnet...'
                          : 'Confirm & write to Walrus'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRejectMemory}
                      disabled={isMemoryWriting}
                      className="inline-flex items-center rounded-lg bg-primary px-lg py-sm text-xs font-semibold text-secondary border border-primary"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Grouped Memory Cards */}
            {(['Agreements', 'Member patterns', 'Reminder preferences'] as const).map(
              (category) => {
                const items = memoriesList.filter((m) => m.category === category)
                return (
                  <div key={category} className="space-y-md">
                    <div className="flex items-center justify-between px-xs">
                      <h4 className="text-sm font-semibold text-secondary uppercase tracking-wider">
                        {category} ({items.length})
                      </h4>
                      <span className="text-xs text-tertiary">Walrus Mainnet blobs</span>
                    </div>

                    {items.length === 0 ? (
                      <div className="rounded-xl border border-secondary bg-primary p-xl text-xs text-tertiary italic">
                        No {category.toLowerCase()} recalled for this circle namespace yet.
                      </div>
                    ) : (
                      <div className="space-y-sm">
                        {items.map((mem) => (
                          <section
                            key={mem.walrusBlobId || mem.id}
                            className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-sm"
                          >
                            <div className="flex items-start justify-between gap-sm">
                              <div>
                                <h5 className="text-sm font-semibold text-primary">{mem.title}</h5>
                                <span className="text-xs text-tertiary">
                                  {mem.date} · Cycle {mem.cycle}
                                </span>
                              </div>

                              {/* Only show Saved on Walrus when a real walrusBlobId is present */}
                              {mem.walrusBlobId && (
                                <button
                                  onClick={() => handleCopy(mem.walrusBlobId, mem.id)}
                                  className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700 hover:bg-secondary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
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

                            <div className="p-md bg-secondary rounded-lg border border-secondary text-xs">
                              <p className="italic text-secondary">"{mem.quote}"</p>
                              <p className="text-primary font-medium mt-xs pt-xs border-t border-secondary">
                                Rule: {mem.context}
                              </p>
                            </div>

                            <div className="flex items-center justify-between text-xs text-tertiary flex-wrap gap-xs">
                              <span className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700">
                                <CheckCircle2 className="size-3 text-fg-brand-primary shrink-0" />
                                {mem.confirmedBy}
                              </span>
                              <span className="text-tertiary font-mono">
                                Blob: {mem.walrusBlobId}
                              </span>
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
        )}

        {/* SCREEN 5: PAYOUT RECOMMENDATIONS */}
        {activeTab === 'payout' && (
          <div className="space-y-lg">
            {members.length === 0 ? (
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs text-sm text-tertiary">
                Configure a circle and member roster first to view payout recommendations.
              </section>
            ) : isPayoutLoading ? (
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs flex items-center gap-sm text-sm text-tertiary">
                <RefreshCw className="size-4 animate-spin text-fg-brand-primary" />
                <span>Generating Steward payout recommendation...</span>
              </section>
            ) : payoutError ? (
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-sm">
                <h3 className="text-sm font-semibold text-error-primary">
                  Steward LLM Recommendation Unavailable
                </h3>
                <p className="text-xs text-secondary">{payoutError}</p>
                {scheduledRecipient && (
                  <p className="text-xs text-tertiary pt-xs border-t border-secondary">
                    Deterministic rotation schedule recipient for Cycle {selectedCycle}:{' '}
                    <strong className="text-primary">{scheduledRecipient.name}</strong> (
                    {scheduledRecipient.address})
                  </p>
                )}
              </section>
            ) : (
              payoutRec && (
                <>
                  <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                        <Sparkles className="size-3 text-fg-brand-primary shrink-0" />
                        Steward recommendation
                      </span>
                      <span className="text-xs text-tertiary">Cycle {selectedCycle}</span>
                    </div>

                    <div className="flex items-center gap-md pt-xs">
                      <div className="w-14 h-14 rounded-lg bg-brand-solid text-primary-on-brand flex items-center justify-center font-bold text-lg shadow-xs shrink-0">
                        {payoutRec.nextRecipient.name
                          .split(' ')
                          .map((n: string) => n[0])
                          .join('')}
                      </div>
                      <div>
                        <span className="text-xs text-tertiary">Suggested next recipient:</span>
                        <h3 className="text-heading-xs font-semibold text-primary">
                          {payoutRec.nextRecipient.name}
                        </h3>
                        <p className="text-xs font-mono text-tertiary">
                          {payoutRec.nextRecipient.address}
                        </p>
                      </div>
                    </div>

                    <p className="text-sm text-secondary leading-relaxed pt-xs">
                      {payoutRec.rationale}
                    </p>

                    <div className="pt-sm border-t border-secondary flex items-center justify-between">
                      <span className="text-xs text-tertiary font-medium">
                        Advisory only · Trustees sign payout
                      </span>
                      <span className="text-sm font-semibold text-brand-primary tabular-nums">
                        {totalOnchainPotReceived.toLocaleString()} {tokenSymbol} verified
                      </span>
                    </div>
                  </section>

                  <section className="rounded-xl border border-secondary bg-primary shadow-xs overflow-hidden">
                    <button
                      onClick={() => setExpandedReasoning(!expandedReasoning)}
                      className="w-full p-xl flex items-center justify-between text-left hover:bg-secondary-hover"
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
                      <div className="p-xl pt-none border-t border-secondary bg-secondary space-y-sm text-xs">
                        {withMemory && memoriesList.length > 0 ? (
                          <ul className="space-y-xs pt-sm">
                            {memoriesList.slice(0, 5).map((m) => (
                              <li
                                key={m.walrusBlobId}
                                className="flex items-start gap-xs text-secondary"
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-brand-solid mt-1.5 shrink-0" />
                                <span>
                                  <strong>{m.title}:</strong> {m.context}{' '}
                                  <span className="font-mono text-[11px] text-tertiary">
                                    (Blob: {m.walrusBlobId.slice(0, 12)}...)
                                  </span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-tertiary pt-sm">
                            {withMemory
                              ? 'No Walrus memories recalled for this circle.'
                              : 'Memory recall is disabled in Without Memory mode.'}
                          </p>
                        )}
                      </div>
                    )}
                  </section>

                  <section className="rounded-xl border border-secondary bg-primary shadow-xs overflow-hidden">
                    <div className="p-xl border-b border-secondary">
                      <h4 className="text-heading-xs font-semibold text-primary">
                        Member risk assessment
                      </h4>
                      <p className="mt-xs text-sm text-tertiary">
                        Real-time risk scoring for Cycle {selectedCycle}
                      </p>
                    </div>

                    <div className="divide-y divide-secondary">
                      {payoutRec.memberRisks.map((item: any, idx: number) => {
                        let badgeFamily = 'utility-success'
                        let badgeLabel = item.riskLevel

                        if (item.riskLevel.includes('Moderate')) {
                          badgeFamily = 'utility-warning'
                        } else if (item.riskLevel.includes('High')) {
                          badgeFamily = 'utility-error'
                        }

                        return (
                          <div
                            key={idx}
                            className="p-xl flex items-center justify-between gap-md hover:bg-secondary-hover transition-colors"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-sm">
                                <p className="text-sm font-semibold text-primary truncate">
                                  {item.member.name}
                                </p>
                                <span
                                  className={`inline-flex items-center gap-xs rounded-full border border-${badgeFamily}-200 bg-${badgeFamily}-50 px-md py-xxs text-xs font-medium text-${badgeFamily}-700`}
                                >
                                  {badgeLabel}
                                </span>
                              </div>
                              <p className="text-xs text-secondary mt-xxs">{item.reasoning}</p>
                              {item.citedBlob && (
                                <p className="text-[11px] font-mono text-brand-primary mt-xxs">
                                  Cited Walrus Blob: {item.citedBlob}
                                </p>
                              )}
                            </div>

                            <span className="text-xs font-medium text-tertiary shrink-0 text-right">
                              {item.action}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                </>
              )
            )}
          </div>
        )}
      </div>

      {/* Tabs Navigation Component */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-primary border-t border-secondary shadow-lg">
        <div className="max-w-xl mx-auto flex items-center justify-around px-md py-xs">
          {[
            { id: 'dashboard', label: 'Home', icon: TrendingUp },
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
              badge: memoriesList.length > 0 ? memoriesList.length.toString() : undefined,
            },
            { id: 'payout', label: 'Payout', icon: Sparkles },
          ].map((tab) => {
            const Icon = tab.icon
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex flex-col items-center justify-center gap-xxs py-xs px-md rounded-lg transition-all min-h-[48px] min-w-[56px] focus-visible:ring-2 focus-visible:ring-focus-ring ${
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
                    <span className="absolute -top-1 -right-2 bg-brand-solid text-primary-on-brand text-xs font-bold w-4 h-4 rounded-full flex items-center justify-center text-[10px]">
                      {tab.badge}
                    </span>
                  )}
                </div>
                <span className="text-xs">{tab.label}</span>
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
