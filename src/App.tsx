import React, { useState, useEffect } from 'react'
import {
  ShieldCheck,
  Brain,
  Sparkles,
  TrendingUp,
  Clock,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  ExternalLink,
  PlusCircle,
  ArrowRight,
  MessageSquare,
  Bookmark,
  Send,
  RefreshCw,
  Coins,
  History,
  Lock,
  Calendar,
  Layers,
  ChevronRight,
  Info,
  Check,
  X
} from 'lucide-react'

import {
  CycleStatus,
  Member,
  VerificationResult,
  MemoryRecord,
  ProposedMemory
} from './services/types'
import { InMemoryMemoryStore } from './services/memoryStore'
import { SuiChainVerifier } from './services/chainVerifier'
import { AjoSteward } from './services/steward'
import { SEED_MEMORIES } from './services/seedData'

// Initialize isolated modular service singletons
const memoryStore = new InMemoryMemoryStore(SEED_MEMORIES)
const chainVerifier = new SuiChainVerifier()
const steward = new AjoSteward()

interface ChatMessage {
  id: string
  sender: 'user' | 'steward'
  text: string
  timestamp: string
  proposedMemory?: ProposedMemory
  citedMemories?: MemoryRecord[]
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'chat' | 'memories' | 'recommendations' | 'create'>('dashboard')
  const [withMemory, setWithMemory] = useState<boolean>(true) // KEY TOGGLE
  const [selectedCycle, setSelectedCycle] = useState<number>(5)
  const [isVerifying, setIsVerifying] = useState<boolean>(false)
  const [verifyNotice, setVerifyNotice] = useState<string | null>(null)

  // Circle Details
  const [circleName, setCircleName] = useState('Lagos Techies Seed Circle')
  const [potPerCycle] = useState(3000)
  const [contributionPerMember] = useState(500)
  const [poolAddress, setPoolAddress] = useState('0x7a8b849201bcde912c4998ef')
  const [cycleLength, setCycleLength] = useState('Monthly')

  // Members list (6 members for 6 cycles)
  const [members, setMembers] = useState<Member[]>([
    { id: 'm1', name: 'Amina Bello', address: '0x9a3e...c182', avatarColor: 'bg-utility-brand-50 text-utility-brand-700' },
    { id: 'm2', name: 'Tunde Ojo', address: '0x4f12...e890', avatarColor: 'bg-utility-warning-50 text-utility-warning-700' },
    { id: 'm3', name: 'Chidi Okonkwo', address: '0x18c9...71ab', avatarColor: 'bg-utility-success-50 text-utility-success-700' },
    { id: 'm4', name: 'Zainab Musa', address: '0xd24e...34fa', avatarColor: 'bg-utility-brand-50 text-brand-primary' },
    { id: 'm5', name: 'Emeka Nwosu', address: '0x88bb...601e', avatarColor: 'bg-utility-gray-50 text-secondary' },
    { id: 'm6', name: 'Folake Adeyemi', address: '0x334c...90de', avatarColor: 'bg-utility-brand-50 text-utility-brand-700' },
  ])

  // New Member form state
  const [newMemberName, setNewMemberName] = useState('')
  const [newMemberAddress, setNewMemberAddress] = useState('')

  // Verification state store per member: cycle -> memberId -> VerificationResult
  const [verifications, setVerifications] = useState<Record<string, VerificationResult>>({
    'm1_5': { status: 'Verified', txDigest: '0x66ff11ab223390fe', amountReceived: 500, timestamp: '2026-09-01T08:30:00Z', rawNotes: 'Paid on time' },
    'm2_5': { status: 'Late', txDigest: '0x33aa88cc9911ef02', amountReceived: 500, timestamp: '2026-09-03T14:15:00Z', rawNotes: 'Paid 2 days late' },
    'm3_5': { status: 'Verified', txDigest: '0x88991122aabbccdd', amountReceived: 500, timestamp: '2026-09-01T09:12:00Z', rawNotes: 'Early bird deposit' },
    'm4_5': { status: 'Verified', txDigest: '0x4455667788990011', amountReceived: 500, timestamp: '2026-09-02T11:00:00Z', rawNotes: 'Standard deposit' },
    'm5_5': { status: 'Partial', txDigest: '0x1122334455667788', amountReceived: 250, timestamp: '2026-09-01T19:40:00Z', rawNotes: 'Split tranche 1/2' },
    'm6_5': { status: 'Pending', amountReceived: 0, rawNotes: 'Awaiting deposit onchain' },

    // Cycle 1 Historical Records for Comparison
    'm1_1': { status: 'Verified', txDigest: '0x71fab41a990011', amountReceived: 500, timestamp: '2026-05-01T10:14:00Z' },
    'm2_1': { status: 'Late', txDigest: '0x90de88114422bb', amountReceived: 500, timestamp: '2026-05-03T16:30:00Z', rawNotes: 'Paid 2 days late (No memory existed)' },
    'm3_1': { status: 'Verified', txDigest: '0x12bb33cc77aa11', amountReceived: 500, timestamp: '2026-05-01T09:00:00Z' },
    'm4_1': { status: 'Verified', txDigest: '0xaa44ee55112233', amountReceived: 500, timestamp: '2026-05-01T12:45:00Z' },
    'm5_1': { status: 'Verified', txDigest: '0x22117766889900', amountReceived: 500, timestamp: '2026-05-02T18:20:00Z' },
    'm6_1': { status: 'Verified', txDigest: '0xbb881199334455', amountReceived: 500, timestamp: '2026-05-01T14:10:00Z' }
  })

  // Memory store records
  const [memoriesList, setMemoriesList] = useState<MemoryRecord[]>(SEED_MEMORIES)
  const [memoryFilterCategory, setMemoryFilterCategory] = useState<string>('All')

  // Chat state
  const [chatInput, setChatInput] = useState('')
  const [isChatTyping, setIsChatTyping] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'init-1',
      sender: 'steward',
      text: 'Greetings. I am your Ajo Steward for the Lagos Techies Seed Circle. I verify USDC contributions on Sui, enforce agreed grace exceptions, and maintain our immutable group memory.',
      timestamp: '10:00 AM'
    },
    {
      id: 'init-2',
      sender: 'user',
      text: 'Can Tunde pay late this month?',
      timestamp: '10:02 AM'
    },
    {
      id: 'init-3',
      sender: 'steward',
      text: 'Yes. Under the agreement ratified in Cycle 4 (Blob: walrus_blob_9x8f02a99e71b2k37q), Tunde has an approved 3-day grace window due to monthly contractor payroll dates. As long as his 500 USDC deposit arrives on Sui within 72 hours, his status remains Verified without penalty.',
      timestamp: '10:02 AM',
      citedMemories: [SEED_MEMORIES[0]]
    }
  ])

  // Active proposed memory awaiting confirmation
  const [proposedMemory, setProposedMemory] = useState<ProposedMemory | null>({
    id: 'prop-seed',
    category: 'Agreements',
    title: 'Cycle 6 Recipient Rotation Swap',
    quote: 'Zainab requested swapping payout slot with Chidi for Cycle 6 due to an upcoming equipment purchase.',
    suggestedAction: 'Ratify 1-cycle rotation swap between Zainab Musa and Chidi Okonkwo.'
  })

  // Recommendations state
  const [payoutRec, setPayoutRec] = useState<any>(null)

  // Load memories from MemoryStore
  const refreshMemories = async () => {
    const records = await memoryStore.list()
    setMemoriesList(records)
  }

  // Load recommendations
  useEffect(() => {
    const runRec = async () => {
      const rec = await steward.generatePayoutRecommendation(
        selectedCycle,
        members,
        verifications,
        memoriesList,
        withMemory
      )
      setPayoutRec(rec)
    }
    runRec()
  }, [selectedCycle, members, verifications, memoriesList, withMemory])

  // Verify onchain action
  const handleVerifyOnchain = async () => {
    setIsVerifying(true)
    setVerifyNotice(null)

    try {
      const updated = { ...verifications }
      for (const m of members) {
        const res = await chainVerifier.verifyContribution({
          poolAddress,
          memberAddress: m.address,
          token: '0x2::usdc::USDC',
          expectedAmount: contributionPerMember,
          windowStart: '2026-09-01T00:00:00Z',
          windowEnd: '2026-09-01T23:59:59Z',
          cycle: selectedCycle
        })
        updated[`${m.id}_${selectedCycle}`] = res
      }
      setVerifications(updated)
      setVerifyNotice(`Verified 6 Sui member balances against pool ${poolAddress.substring(0, 10)}...`)
    } catch (e: any) {
      setVerifyNotice(`Verification error: ${e.message}`)
    } finally {
      setIsVerifying(false)
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
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    setMessages(prev => [...prev, userMsg])
    setChatInput('')
    setIsChatTyping(true)

    try {
      const output = await steward.processChat(
        {
          message: text,
          currentCycle: selectedCycle,
          withMemory
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
        proposedMemory: output.proposedMemory
      }

      setMessages(prev => [...prev, stewardMsg])

      if (output.proposedMemory) {
        setProposedMemory(output.proposedMemory)
      }
    } finally {
      setIsChatTyping(false)
    }
  }

  // Confirm proposed memory
  const handleConfirmMemory = async (prop: ProposedMemory) => {
    const newRecord = await memoryStore.remember({
      category: prop.category,
      title: prop.title,
      quote: prop.quote,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      cycle: selectedCycle,
      confirmedBy: 'Circle Consensus (Quorum reached)',
      walrusBlobId: `walrus_blob_${Math.random().toString(36).substring(2, 9)}_${Date.now().toString(36)}`,
      context: prop.suggestedAction,
      memberId: prop.memberId
    })

    await refreshMemories()
    setProposedMemory(null)

    setMessages(prev => [
      ...prev,
      {
        id: Date.now().toString(),
        sender: 'steward',
        text: `Confirmed and committed to Walrus: "${newRecord.title}". The blob is permanently indexed into our reasoning engine.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        citedMemories: [newRecord]
      }
    ])
  }

  // Reject proposed memory
  const handleRejectMemory = () => {
    setProposedMemory(null)
    setMessages(prev => [
      ...prev,
      {
        id: Date.now().toString(),
        sender: 'steward',
        text: 'The proposed agreement was rejected and has not been added to circle memory.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ])
  }

  // Add Member
  const handleAddMember = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newMemberName.trim() || !newMemberAddress.trim()) return

    const newM: Member = {
      id: `m${members.length + 1}`,
      name: newMemberName.trim(),
      address: newMemberAddress.trim(),
      avatarColor: 'bg-utility-brand-50 text-utility-brand-700'
    }

    setMembers(prev => [...prev, newM])
    setNewMemberName('')
    setNewMemberAddress('')
  }

  return (
    <div className="min-h-screen bg-secondary text-primary font-sans flex flex-col">
      {/* Top Navigation & App Shell */}
      <header className="bg-primary border-b border-secondary sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-xl py-md flex flex-wrap items-center justify-between gap-md">
          {/* Logo & Subtitle */}
          <div className="flex items-center gap-md">
            <div className="w-10 h-10 rounded-lg bg-brand-solid flex items-center justify-center text-primary-on-brand shadow-xs">
              <ShieldCheck className="w-6 h-6 text-fg-white" />
            </div>
            <div>
              <div className="flex items-center gap-sm">
                <h1 className="text-heading-xs font-semibold text-primary">Ajo Steward</h1>
                <span className="bg-utility-brand-50 border border-utility-brand-200 text-utility-brand-700 text-xs font-medium px-md py-xxs rounded-full">
                  Sui USDC
                </span>
                <span className="bg-utility-success-50 border border-utility-success-200 text-utility-success-700 text-xs font-medium px-md py-xxs rounded-full flex items-center gap-xs">
                  <span className="w-1.5 h-1.5 rounded-full bg-success-primary inline-block" />
                  Non-Custodial Advisory
                </span>
              </div>
              <p className="text-xs text-secondary mt-xxs">
                Rotating savings circle engine · Onchain Sui verifier · Cryptographic Walrus group memory
              </p>
            </div>
          </div>

          {/* Key Demo Toggle: Steward with memory / without memory */}
          <div className="flex items-center gap-md">
            <div className="bg-secondary p-xs rounded-lg border border-secondary flex items-center gap-sm">
              <span className="text-xs font-medium text-secondary pl-xs">Steward Engine:</span>
              <button
                type="button"
                onClick={() => setWithMemory(!withMemory)}
                className={`flex items-center gap-xs px-md py-xs rounded-md text-xs font-semibold transition-all border ${
                  withMemory
                    ? 'bg-utility-brand-50 border-utility-brand-200 text-utility-brand-700'
                    : 'bg-utility-warning-50 border-utility-warning-200 text-utility-warning-700'
                }`}
              >
                {withMemory ? (
                  <>
                    <Brain className="w-3.5 h-3.5 text-fg-brand-primary" />
                    <span>With Memory (Context-Aware)</span>
                  </>
                ) : (
                  <>
                    <History className="w-3.5 h-3.5 text-fg-warning-primary" />
                    <span>Without Memory (Strict Rules)</span>
                  </>
                )}
              </button>
            </div>

            <button
              onClick={handleVerifyOnchain}
              disabled={isVerifying}
              className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 text-fg-secondary ${isVerifying ? 'animate-spin' : ''}`} />
              <span>{isVerifying ? 'Querying Sui...' : 'Verify on Sui'}</span>
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="max-w-7xl mx-auto px-xl flex items-center gap-sm border-t border-secondary overflow-x-auto">
          {[
            { id: 'dashboard', label: 'Circle Dashboard', icon: TrendingUp },
            { id: 'chat', label: 'Steward Chat', icon: MessageSquare, badge: proposedMemory ? '1' : undefined },
            { id: 'memories', label: 'Walrus Memory Store', icon: Brain, badge: memoriesList.length.toString() },
            { id: 'recommendations', label: 'Payout Recommendation', icon: Sparkles },
            { id: 'create', label: 'Circle Settings', icon: PlusCircle },
          ].map(tab => {
            const Icon = tab.icon
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-xs py-sm px-md text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? 'border-brand text-brand-primary font-semibold'
                    : 'border-transparent text-secondary hover:text-primary hover:border-secondary'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-fg-brand-primary' : 'text-fg-quaternary'}`} />
                <span>{tab.label}</span>
                {tab.badge && (
                  <span className="bg-utility-brand-50 text-utility-brand-700 text-xs px-xs py-none rounded-full border border-utility-brand-200">
                    {tab.badge}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-xl py-xl flex-1 w-full space-y-xl">
        {/* Verification Status Banner if refreshed */}
        {verifyNotice && (
          <div className="p-md rounded-xl bg-utility-brand-50 border border-utility-brand-200 text-xs text-utility-brand-700 flex items-center justify-between">
            <div className="flex items-center gap-sm">
              <CheckCircle2 className="w-4 h-4 text-fg-brand-primary" />
              <span>{verifyNotice}</span>
            </div>
            <button onClick={() => setVerifyNotice(null)} className="text-secondary hover:text-primary">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* KEY DEMO CALLOUT: Cycle 1 vs Cycle 5 Late Payment Comparison */}
        <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-md">
            <div className="flex items-start gap-md">
              <div className="p-xs rounded-lg bg-utility-brand-50 border border-utility-brand-200 text-utility-brand-700 mt-xxs">
                <Sparkles className="w-5 h-5 text-fg-brand-primary" />
              </div>
              <div>
                <div className="flex items-center gap-sm">
                  <h2 className="text-sm font-semibold text-primary">
                    Core Demo Moment: Memory Context Evolution
                  </h2>
                  <span className={`text-xs px-sm py-xxs rounded-full border font-medium ${
                    withMemory ? 'bg-utility-brand-50 border-utility-brand-200 text-utility-brand-700' : 'bg-utility-warning-50 border-utility-warning-200 text-utility-warning-700'
                  }`}>
                    {withMemory ? 'Engine: With Memory' : 'Engine: Without Memory'}
                  </span>
                </div>
                <p className="text-xs text-secondary mt-xxs max-w-3xl leading-relaxed">
                  {withMemory ? (
                    <span>
                      <strong>Cycle 5 (Current):</strong> Tunde submitted 500 USDC 2 days after deadline. Because <strong>Memory #1 (Cycle 4 3-day grace)</strong> is active, the Steward recognizes this as an approved exception and marks his status as <strong>Verified</strong>.
                    </span>
                  ) : (
                    <span className="text-error-primary">
                      <strong>Without Memory Active:</strong> The verifier evaluates only raw timestamps. Tunde's 2-day late payment is flagged as an <strong>Unexcused Late Default</strong>, triggering penalty warnings.
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-sm">
              <button
                type="button"
                onClick={() => setWithMemory(!withMemory)}
                className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-xs font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <span>Toggle: {withMemory ? 'Simulate Without Memory' : 'Restore With Memory'}</span>
                <ArrowRight className="w-3.5 h-3.5 text-fg-quaternary" />
              </button>
            </div>
          </div>
        </section>

        {/* SCREEN 1: CIRCLE DASHBOARD */}
        {activeTab === 'dashboard' && (
          <div className="space-y-xl">
            {/* Metric Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-lg">
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <div className="flex items-center justify-between mb-sm">
                  <span className="text-sm text-tertiary">Accumulated Pot (Cycle {selectedCycle} of 6)</span>
                  <Coins className="w-4 h-4 text-fg-brand-primary" />
                </div>
                <div className="text-heading-sm font-semibold text-primary">
                  {selectedCycle === 5
                    ? (withMemory ? '2,750 / 3,000' : '2,250 / 3,000')
                    : '3,000 / 3,000'}{' '}
                  <span className="text-sm font-normal text-tertiary">USDC</span>
                </div>
                <div className="mt-sm flex items-center gap-xs text-xs text-secondary">
                  <Clock className="w-3.5 h-3.5 text-fg-quaternary" />
                  <span>Cycle contribution window closes in 18 hours</span>
                </div>
              </section>

              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <div className="flex items-center justify-between mb-sm">
                  <span className="text-sm text-tertiary">Scheduled Recipient This Cycle</span>
                  <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                    Cycle 5 Turn
                  </span>
                </div>
                <div className="flex items-center gap-md">
                  <div className="w-10 h-10 rounded-full bg-utility-brand-50 text-utility-brand-700 flex items-center justify-center font-bold text-sm border border-utility-brand-200">
                    EN
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-primary">Emeka Nwosu</h3>
                    <p className="text-xs font-mono text-secondary">0x88bb...601e</p>
                  </div>
                </div>
                <p className="mt-sm text-xs text-tertiary">
                  Receives full pot of 3,000 USDC upon 6/6 verified deposits.
                </p>
              </section>

              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <div className="flex items-center justify-between mb-sm">
                  <span className="text-sm text-tertiary">Sui Non-Custodial Pool Vault</span>
                  <Lock className="w-4 h-4 text-fg-quaternary" />
                </div>
                <div className="text-xs font-mono text-primary bg-secondary px-sm py-xs rounded border border-secondary truncate">
                  {poolAddress}
                </div>
                <div className="mt-sm flex items-center justify-between text-xs">
                  <span className="text-secondary">Token:</span>
                  <span className="font-semibold text-primary">USDC (Sui Mainnet)</span>
                </div>
              </section>
            </div>

            {/* Cycle Timeline Bar */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-md mb-md">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Rotating Pot Timeline</h3>
                  <p className="text-xs text-secondary mt-xxs">
                    Every member receives the rotating payout once over the 6-cycle circle lifetime
                  </p>
                </div>
                <div className="flex items-center gap-xs">
                  {[1, 2, 3, 4, 5, 6].map(cycleNum => (
                    <button
                      key={cycleNum}
                      onClick={() => setSelectedCycle(cycleNum)}
                      className={`px-md py-xs rounded-lg text-xs font-medium border transition-colors ${
                        selectedCycle === cycleNum
                          ? 'bg-utility-brand-50 border-utility-brand-200 text-utility-brand-700 font-semibold'
                          : 'bg-primary border-primary text-secondary hover:bg-secondary'
                      }`}
                    >
                      Cycle {cycleNum} {cycleNum === 1 ? '(Gen)' : cycleNum === 5 ? '(Current)' : ''}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-6 gap-md mt-md">
                {members.map((m, idx) => {
                  const cNum = idx + 1
                  const isCurrent = cNum === selectedCycle
                  const isPast = cNum < selectedCycle
                  return (
                    <div
                      key={m.id}
                      onClick={() => setSelectedCycle(cNum)}
                      className={`p-md rounded-xl border cursor-pointer transition-all ${
                        isCurrent
                          ? 'border-brand bg-utility-brand-50 shadow-xs'
                          : isPast
                          ? 'border-secondary bg-primary opacity-80'
                          : 'border-secondary bg-secondary'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-xs">
                        <span className="text-xs font-semibold text-quaternary">Cycle {cNum}</span>
                        {isPast && <CheckCircle2 className="w-3.5 h-3.5 text-fg-success-primary" />}
                        {isCurrent && <span className="w-2 h-2 rounded-full bg-brand-solid animate-pulse" />}
                      </div>
                      <p className="text-sm font-semibold text-primary truncate">{m.name}</p>
                      <p className="text-xs text-tertiary">3,000 USDC Pot</p>
                    </div>
                  )
                })}
              </div>
            </section>

            {/* Member Contributions Table */}
            <div className="overflow-hidden rounded-xl border border-secondary bg-primary">
              <div className="p-xl border-b border-secondary flex flex-wrap items-center justify-between gap-md">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">
                    Cycle {selectedCycle} Contribution Verification Log
                  </h3>
                  <p className="text-xs text-secondary mt-xxs">
                    Chain verification checked against Sui pool address. Payments with missing transactions are never marked as paid.
                  </p>
                </div>
                <div className="flex items-center gap-xs">
                  <span className="text-xs text-secondary">
                    Showing: <strong>{members.length} Members</strong>
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="sticky top-0 z-10 bg-secondary">
                    <tr className="border-b border-secondary text-left">
                      <th className="px-3xl py-md text-sm font-semibold text-quaternary">Member</th>
                      <th className="px-3xl py-md text-sm font-semibold text-quaternary">Expected / Received</th>
                      <th className="px-3xl py-md text-sm font-semibold text-quaternary">Status</th>
                      <th className="px-3xl py-md text-sm font-semibold text-quaternary">Sui Transaction Digest</th>
                      <th className="px-3xl py-md text-sm font-semibold text-quaternary">Steward Memory Insight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map(member => {
                      const recKey = `${member.id}_${selectedCycle}`
                      const rawRecord = verifications[recKey] || {
                        status: 'Pending' as CycleStatus,
                        amountReceived: 0,
                        rawNotes: 'Awaiting deposit'
                      }

                      // Apply memory rule logic for Tunde in Cycle 5:
                      // If withMemory is true -> Verified with Grace
                      // If withMemory is false -> Late
                      let effectiveStatus: CycleStatus = rawRecord.status
                      let effectiveNote = rawRecord.rawNotes || ''

                      if (member.id === 'm2' && selectedCycle === 5) {
                        if (withMemory) {
                          effectiveStatus = 'Verified'
                          effectiveNote = 'Verified under Cycle 4 Grace Agreement'
                        } else {
                          effectiveStatus = 'Late'
                          effectiveNote = 'Paid 2 days late (Violation without memory)'
                        }
                      }

                      return (
                        <tr
                          key={member.id}
                          className="border-b border-secondary hover:bg-secondary-hover transition-colors"
                        >
                          {/* Member info */}
                          <td className="px-3xl py-xl text-md text-tertiary">
                            <div className="flex items-center gap-sm">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${member.avatarColor}`}>
                                {member.name.split(' ').map(n => n[0]).join('')}
                              </div>
                              <div>
                                <p className="font-medium text-primary text-sm">{member.name}</p>
                                <p className="text-xs font-mono text-quaternary">{member.address}</p>
                              </div>
                            </div>
                          </td>

                          {/* Amounts */}
                          <td className="px-3xl py-xl text-md text-tertiary">
                            <div className="text-primary font-medium text-sm">
                              {rawRecord.amountReceived || 0} / {contributionPerMember} USDC
                            </div>
                            <div className="w-24 bg-secondary rounded-full h-1.5 mt-xs overflow-hidden border border-secondary">
                              <div
                                className="bg-brand-solid h-full rounded-full"
                                style={{ width: `${((rawRecord.amountReceived || 0) / contributionPerMember) * 100}%` }}
                              />
                            </div>
                          </td>

                          {/* Status Badge */}
                          <td className="px-3xl py-xl text-md text-tertiary">
                            {effectiveStatus === 'Verified' && (
                              <span className="inline-flex items-center gap-xs rounded-full border border-utility-success-200 bg-utility-success-50 px-md py-xxs text-xs font-medium text-utility-success-700">
                                <CheckCircle2 className="w-3.5 h-3.5 text-fg-success-primary" />
                                <span>Verified</span>
                              </span>
                            )}
                            {effectiveStatus === 'Late' && (
                              <span className="inline-flex items-center gap-xs rounded-full border border-utility-warning-200 bg-utility-warning-50 px-md py-xxs text-xs font-medium text-utility-warning-700">
                                <AlertTriangle className="w-3.5 h-3.5 text-fg-warning-primary" />
                                <span>Late Payment</span>
                              </span>
                            )}
                            {effectiveStatus === 'Partial' && (
                              <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                                <Clock className="w-3.5 h-3.5 text-fg-brand-primary" />
                                <span>Partial (Split)</span>
                              </span>
                            )}
                            {effectiveStatus === 'Pending' && (
                              <span className="inline-flex items-center gap-xs rounded-full border border-secondary bg-secondary px-md py-xxs text-xs font-medium text-secondary">
                                <Clock className="w-3.5 h-3.5 text-fg-quaternary" />
                                <span>Pending</span>
                              </span>
                            )}
                            {effectiveStatus === 'Unverified' && (
                              <span className="inline-flex items-center gap-xs rounded-full border border-error-subtle bg-utility-error-50 px-md py-xxs text-xs font-medium text-error-primary">
                                <HelpCircle className="w-3.5 h-3.5 text-fg-error-primary" />
                                <span>Unverified</span>
                              </span>
                            )}
                          </td>

                          {/* Sui Tx Digest with link */}
                          <td className="px-3xl py-xl text-md text-tertiary font-mono text-xs">
                            {rawRecord.txDigest ? (
                              <a
                                href={`https://suiscan.xyz/mainnet/tx/${rawRecord.txDigest}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-brand-primary hover:underline flex items-center gap-xxs"
                              >
                                <span>{rawRecord.txDigest}</span>
                                <ExternalLink className="w-3 h-3 text-fg-brand-primary" />
                              </a>
                            ) : (
                              <span className="text-quaternary">No matching Sui tx</span>
                            )}
                          </td>

                          {/* Steward Memory Insight */}
                          <td className="px-3xl py-xl text-md text-tertiary text-xs">
                            {member.id === 'm2' && (
                              <span className={withMemory ? 'text-utility-brand-700 font-semibold' : 'text-error-primary font-semibold'}>
                                {withMemory
                                  ? 'Exempt: Protected by Cycle 4 Consensus Agreement (3-day grace)'
                                  : 'Violation: 2 days late without logged exception'}
                              </span>
                            )}
                            {member.id === 'm5' && (
                              <span className="text-secondary">
                                {withMemory
                                  ? 'Pattern recognized: Tranche 2/2 expected within 48h'
                                  : 'Warning: 250 USDC deficit'}
                              </span>
                            )}
                            {member.id === 'm6' && (
                              <span className="text-secondary">
                                {withMemory ? 'Preference applied: Quiet reminder mode' : 'Standard alert triggered'}
                              </span>
                            )}
                            {['m1', 'm3', 'm4'].includes(member.id) && (
                              <span className="text-tertiary">Reliable onchain contributor</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* SCREEN 2: STEWARD CHAT */}
        {activeTab === 'chat' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-xl">
            {/* Conversation Window */}
            <div className="lg:col-span-2 rounded-xl border border-secondary bg-primary shadow-xs flex flex-col h-[640px]">
              {/* Header */}
              <div className="p-lg border-b border-secondary flex items-center justify-between">
                <div className="flex items-center gap-sm">
                  <div className="w-9 h-9 rounded-full bg-brand-solid text-primary-on-brand flex items-center justify-center">
                    <Brain className="w-4 h-4 text-fg-white" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-primary">Ajo AI Steward</h3>
                    <p className="text-xs text-secondary">
                      Context: {withMemory ? `${memoriesList.length} Walrus-backed Group Memories` : 'Memory disabled (Strict rules)'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-xs text-xs">
                  <span className="w-2 h-2 rounded-full bg-success-primary" />
                  <span className="text-secondary">Sui Verifier Live</span>
                </div>
              </div>

              {/* Message List */}
              <div className="flex-1 p-xl overflow-y-auto space-y-lg">
                {messages.map(msg => (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-lg p-md rounded-xl text-sm leading-relaxed ${
                        msg.sender === 'user'
                          ? 'bg-brand-solid text-primary-on-brand rounded-tr-none'
                          : 'bg-secondary text-primary border border-secondary rounded-tl-none'
                      }`}
                    >
                      <p>{msg.text}</p>

                      {msg.citedMemories && msg.citedMemories.length > 0 && (
                        <div className="mt-sm pt-xs border-t border-secondary text-xs">
                          <p className="font-semibold text-secondary flex items-center gap-xxs">
                            <Bookmark className="w-3 h-3 text-fg-brand-primary" />
                            <span>Cited Walrus Memory:</span>
                          </p>
                          <ul className="mt-xxs space-y-xxs">
                            {msg.citedMemories.map((c, i) => (
                              <li key={i} className="text-brand-primary font-medium">
                                "{c.title}" (Blob: {c.walrusBlobId.substring(0, 16)}...)
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-quaternary mt-xxs px-xs">{msg.timestamp}</span>
                  </div>
                ))}

                {isChatTyping && (
                  <div className="flex items-center gap-xs text-xs text-tertiary">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-fg-secondary" />
                    <span>Ajo Steward is consulting Sui verification state & Walrus memory...</span>
                  </div>
                )}
              </div>

              {/* Input Area */}
              <div className="p-md border-t border-secondary bg-primary">
                <div className="flex items-center gap-sm">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
                    placeholder="Ask steward: 'Can Tunde pay late?', 'Who is the riskiest member?'..."
                    className="flex-1 rounded-lg bg-secondary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <button
                    onClick={() => handleSendMessage()}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <Send className="w-4 h-4 text-fg-white" />
                    <span className="hidden sm:inline">Ask</span>
                  </button>
                </div>
                <div className="mt-sm flex flex-wrap items-center gap-xs text-xs text-tertiary">
                  <span>Suggested queries:</span>
                  <button
                    onClick={() => handleSendMessage('Can Tunde pay late this month?')}
                    className="text-brand-primary hover:underline"
                  >
                    "Can Tunde pay late this month?"
                  </button>
                  <span>·</span>
                  <button
                    onClick={() => handleSendMessage('Who is the riskiest member before payout?')}
                    className="text-brand-primary hover:underline"
                  >
                    "Who is the riskiest member?"
                  </button>
                  <span>·</span>
                  <button
                    onClick={() => handleSendMessage('What is Emeka payment habit?')}
                    className="text-brand-primary hover:underline"
                  >
                    "Emeka payment habit"
                  </button>
                </div>
              </div>
            </div>

            {/* Side Panel: Proposed Memory Proposal Action Card */}
            <div className="space-y-lg">
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <div className="flex items-center justify-between mb-md">
                  <h3 className="text-sm font-semibold text-primary flex items-center gap-xs">
                    <Sparkles className="w-4 h-4 text-fg-brand-primary" />
                    <span>Proposed Memory for Ratification</span>
                  </h3>
                  <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                    Awaiting Quorum
                  </span>
                </div>

                {proposedMemory ? (
                  <div className="p-md rounded-lg bg-secondary border border-secondary space-y-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-brand-primary">{proposedMemory.category}</span>
                      <span className="text-xs text-tertiary">Cycle {selectedCycle}</span>
                    </div>
                    <p className="text-sm font-medium text-primary">{proposedMemory.title}</p>
                    <blockquote className="text-xs italic text-secondary border-l-2 border-brand pl-sm">
                      "{proposedMemory.quote}"
                    </blockquote>
                    <p className="text-xs text-tertiary">{proposedMemory.suggestedAction}</p>

                    <div className="pt-sm border-t border-secondary flex items-center gap-sm">
                      <button
                        onClick={() => handleConfirmMemory(proposedMemory)}
                        className="flex-1 inline-flex items-center justify-center gap-xs rounded-lg border border-transparent bg-brand-solid px-md py-xs text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover"
                      >
                        <Check className="w-3.5 h-3.5 text-fg-white" />
                        <span>Confirm & Store Blob</span>
                      </button>
                      <button
                        onClick={handleRejectMemory}
                        className="inline-flex items-center justify-center gap-xs rounded-lg bg-primary px-md py-xs text-xs font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Reject</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-lg text-center text-xs text-tertiary">
                    No memories currently awaiting quorum. Propose an exception or rule in the chat above to trigger a memory proposal.
                  </div>
                )}
              </section>

              {/* Protocol Spec Overview */}
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                <h3 className="text-sm font-semibold text-primary">Steward Architecture & Guarantees</h3>
                <div className="space-y-sm text-xs">
                  <div className="flex justify-between py-xs border-b border-secondary">
                    <span className="text-secondary">Chain Verifier</span>
                    <span className="font-semibold text-primary">Tatum Sui RPC Gateway</span>
                  </div>
                  <div className="flex justify-between py-xs border-b border-secondary">
                    <span className="text-secondary">Memory Protocol</span>
                    <span className="font-semibold text-primary">Walrus Decentralized Blobs</span>
                  </div>
                  <div className="flex justify-between py-xs border-b border-secondary">
                    <span className="text-secondary">Consensus Quorum</span>
                    <span className="font-semibold text-primary">4 of 6 (66% Threshold)</span>
                  </div>
                  <div className="flex justify-between py-xs">
                    <span className="text-secondary">Execution Model</span>
                    <span className="font-semibold text-utility-success-700">Strictly Non-Custodial</span>
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}

        {/* SCREEN 3: WALRUS MEMORY STORE */}
        {activeTab === 'memories' && (
          <div className="space-y-xl">
            {/* Memory Header Card */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs flex flex-wrap items-center justify-between gap-md">
              <div>
                <h3 className="text-heading-xs font-semibold text-primary">
                  Walrus Memory Proof Store ({memoriesList.length} Active Records)
                </h3>
                <p className="text-xs text-secondary mt-xxs max-w-2xl">
                  Every exception, consensus vote, member behavioral habit, and reminder preference is permanently recorded as an immutable Walrus blob proof.
                </p>
              </div>
              <div className="flex items-center gap-sm">
                <span className="text-xs font-mono bg-secondary px-md py-xs rounded-lg border border-secondary text-secondary">
                  Storage Node: walrus-testnet.sui
                </span>
              </div>
            </section>

            {/* Category Filter Tabs */}
            <div className="flex items-center gap-xs">
              {['All', 'Agreements', 'Member patterns', 'Reminder preferences'].map(cat => (
                <button
                  key={cat}
                  onClick={() => setMemoryFilterCategory(cat)}
                  className={`px-md py-xs rounded-lg text-xs font-medium border transition-colors ${
                    memoryFilterCategory === cat
                      ? 'bg-utility-brand-50 border-utility-brand-200 text-utility-brand-700 font-semibold'
                      : 'bg-primary border-primary text-secondary hover:bg-secondary'
                  }`}
                >
                  {cat} ({cat === 'All' ? memoriesList.length : memoriesList.filter(m => m.category === cat).length})
                </button>
              ))}
            </div>

            {/* Memory Cards Grid */}
            <div className="space-y-md">
              {memoriesList
                .filter(m => memoryFilterCategory === 'All' || m.category === memoryFilterCategory)
                .map(mem => (
                  <section
                    key={mem.id}
                    className="rounded-xl border border-secondary bg-primary p-xl shadow-xs hover:border-brand transition-all"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-md">
                      <div>
                        <div className="flex items-center gap-sm mb-xs">
                          <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                            {mem.category}
                          </span>
                          <span className="text-xs text-tertiary">Cycle {mem.cycle}</span>
                          <span className="text-xs text-tertiary">· {mem.date}</span>
                        </div>
                        <h4 className="text-base font-semibold text-primary">{mem.title}</h4>
                      </div>

                      {/* Walrus proof badge */}
                      <div className="flex items-center gap-xs bg-secondary border border-secondary px-md py-xs rounded-md text-xs font-mono">
                        <Lock className="w-3.5 h-3.5 text-fg-brand-primary" />
                        <span className="text-secondary">{mem.walrusBlobId}</span>
                        <ExternalLink className="w-3 h-3 text-fg-quaternary" />
                      </div>
                    </div>

                    <div className="mt-md p-md bg-secondary rounded-lg border border-secondary">
                      <p className="text-sm italic text-secondary">"{mem.quote}"</p>
                    </div>

                    <div className="mt-md flex flex-wrap items-center justify-between text-xs text-tertiary gap-sm">
                      <div className="flex items-center gap-sm">
                        <span>Ratified by: <strong className="text-primary">{mem.confirmedBy}</strong></span>
                        <span>·</span>
                        <span>Operational rule: <span className="text-secondary">{mem.context}</span></span>
                      </div>
                    </div>
                  </section>
                ))}
            </div>
          </div>
        )}

        {/* SCREEN 4: PAYOUT RECOMMENDATIONS */}
        {activeTab === 'recommendations' && payoutRec && (
          <div className="space-y-xl">
            {/* Header */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-md">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">
                    AI Steward Payout Recommendation Engine
                  </h3>
                  <p className="text-xs text-secondary mt-xxs">
                    Synthesizes onchain contributions with group memory to determine safe recipient and highlight member risks.
                  </p>
                </div>
                <div className="flex items-center gap-xs">
                  <span className="text-xs font-semibold text-secondary">Status:</span>
                  <span className="inline-flex items-center gap-xs rounded-full border border-utility-success-200 bg-utility-success-50 px-md py-xxs text-xs font-medium text-utility-success-700">
                    Cycle {selectedCycle} Advisory Ready
                  </span>
                </div>
              </div>
            </section>

            {/* Recipient Suggestion Card */}
            <section className="rounded-xl border border-brand bg-primary p-xl shadow-xs">
              <div className="flex items-start justify-between mb-md">
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                  Primary Recommendation
                </span>
                <span className="text-sm font-semibold text-primary">Cycle {selectedCycle} Pot: 3,000 USDC</span>
              </div>

              <div className="flex flex-wrap items-center gap-xl">
                <div className="w-16 h-16 rounded-full bg-utility-brand-50 text-utility-brand-700 flex items-center justify-center font-bold text-xl border border-utility-brand-200">
                  {payoutRec.nextRecipient.name.split(' ').map((n: string) => n[0]).join('')}
                </div>
                <div className="space-y-xxs">
                  <h4 className="text-heading-sm font-bold text-primary">Release Pot to {payoutRec.nextRecipient.name}</h4>
                  <p className="text-xs font-mono text-tertiary">Address: {payoutRec.nextRecipient.address} (Sui)</p>
                  <p className="text-sm text-secondary max-w-2xl mt-xs leading-relaxed">
                    {payoutRec.rationale}
                  </p>
                </div>
              </div>

              <div className="mt-xl pt-lg border-t border-secondary flex flex-wrap items-center justify-between gap-md text-xs">
                <div className="flex items-center gap-sm">
                  <ShieldCheck className="w-4 h-4 text-fg-success-primary" />
                  <span className="text-secondary">
                    Non-custodial advisory note: The Steward never moves funds. Circle multi-sig signers execute the payout.
                  </span>
                </div>
                <button className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-xs font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover">
                  Export Payout Multi-Sig Payload
                </button>
              </div>
            </section>

            {/* Member Risk Breakdown */}
            <div className="overflow-hidden rounded-xl border border-secondary bg-primary shadow-xs">
              <div className="p-xl border-b border-secondary">
                <h4 className="text-sm font-semibold text-primary">Member Risk Breakdown & Walrus Memory Reasoning</h4>
                <p className="text-xs text-secondary mt-xxs">
                  Real-time correlation of verified onchain deposits against historical exceptions
                </p>
              </div>

              <div className="divide-y divide-secondary">
                {payoutRec.memberRisks.map((item: any, idx: number) => (
                  <div key={idx} className="p-xl hover:bg-secondary-hover transition-colors">
                    <div className="flex flex-wrap items-center justify-between gap-sm mb-xs">
                      <div className="flex items-center gap-sm">
                        <span className="font-semibold text-sm text-primary">{item.member.name}</span>
                        <span className="text-xs font-mono text-quaternary">{item.member.address}</span>
                      </div>
                      <span className={`inline-flex items-center gap-xs rounded-full border px-md py-xxs text-xs font-medium ${item.badgeClass}`}>
                        {item.riskLevel}
                      </span>
                    </div>
                    <p className="text-xs text-secondary mt-xxs leading-relaxed">{item.reasoning}</p>
                    <div className="mt-sm flex flex-wrap items-center justify-between gap-sm text-xs">
                      <span className="text-tertiary">
                        <strong>Recommended Action:</strong> {item.action}
                      </span>
                      {item.citedBlob && (
                        <span className="font-mono text-quaternary flex items-center gap-xxs">
                          <Lock className="w-3 h-3 text-fg-brand-primary" />
                          <span>Proof: {item.citedBlob.substring(0, 16)}...</span>
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* SCREEN 5: CREATE / EDIT CIRCLE */}
        {activeTab === 'create' && (
          <div className="max-w-2xl mx-auto rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-xl">
            <div>
              <h3 className="text-heading-xs font-semibold text-primary">Circle Configuration</h3>
              <p className="text-xs text-secondary mt-xxs">
                Configure rotating savings parameters, pool smart contract vault, and member invitations.
              </p>
            </div>

            <div className="space-y-lg">
              <div>
                <label className="block text-xs font-semibold text-secondary uppercase mb-xs">
                  Circle Name
                </label>
                <input
                  type="text"
                  value={circleName}
                  onChange={e => setCircleName(e.target.value)}
                  className="w-full rounded-lg bg-secondary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-md">
                <div>
                  <label className="block text-xs font-semibold text-secondary uppercase mb-xs">
                    Contribution Amount (USDC)
                  </label>
                  <input
                    type="number"
                    value={contributionPerMember}
                    disabled
                    className="w-full rounded-lg bg-secondary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring opacity-80"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-secondary uppercase mb-xs">
                    Cycle Length
                  </label>
                  <select
                    value={cycleLength}
                    onChange={e => setCycleLength(e.target.value)}
                    className="w-full rounded-lg bg-secondary px-lg py-sm text-sm text-primary border border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <option value="Weekly">Weekly</option>
                    <option value="Monthly">Monthly</option>
                    <option value="Bi-Weekly">Bi-Weekly</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-secondary uppercase mb-xs">
                  Sui Pool Address (Non-Custodial Multi-sig / Vault)
                </label>
                <input
                  type="text"
                  value={poolAddress}
                  onChange={e => setPoolAddress(e.target.value)}
                  className="w-full rounded-lg bg-secondary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>

              {/* Members Section */}
              <div>
                <div className="flex items-center justify-between mb-xs">
                  <label className="text-xs font-semibold text-secondary uppercase">
                    Circle Members ({members.length})
                  </label>
                </div>

                <div className="space-y-xs mb-md">
                  {members.map(m => (
                    <div key={m.id} className="flex items-center justify-between p-sm bg-secondary rounded-lg border border-secondary text-xs">
                      <span className="font-medium text-primary">{m.name}</span>
                      <span className="font-mono text-tertiary">{m.address}</span>
                      <CheckCircle2 className="w-4 h-4 text-fg-success-primary" />
                    </div>
                  ))}
                </div>

                {/* Add member form */}
                <form onSubmit={handleAddMember} className="p-md rounded-lg bg-secondary border border-secondary space-y-sm">
                  <p className="text-xs font-semibold text-primary">Invite Additional Member</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
                    <input
                      type="text"
                      placeholder="Member Name (e.g. Kolawole)"
                      value={newMemberName}
                      onChange={e => setNewMemberName(e.target.value)}
                      className="rounded-lg bg-primary px-md py-xs text-xs text-primary border border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                    <input
                      type="text"
                      placeholder="Sui Address (0x...)"
                      value={newMemberAddress}
                      onChange={e => setNewMemberAddress(e.target.value)}
                      className="rounded-lg bg-primary px-md py-xs text-xs font-mono text-primary border border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </div>
                  <button
                    type="submit"
                    className="inline-flex items-center gap-sm rounded-lg bg-primary px-md py-xs text-xs font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover"
                  >
                    <PlusCircle className="w-3.5 h-3.5 text-fg-brand-primary" />
                    <span>Add Member to Circle</span>
                  </button>
                </form>
              </div>

              <button
                type="button"
                onClick={() => setActiveTab('dashboard')}
                className="w-full inline-flex items-center justify-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover"
              >
                Save Circle Configuration
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-secondary bg-primary py-md px-xl text-center text-xs text-tertiary">
        Ajo Steward · Advisory & Non-Custodial Rotating Savings Engine · Tatum Sui RPC Gateway & Walrus Proof Blobs
      </footer>
    </div>
  )
}
