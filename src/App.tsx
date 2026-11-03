import React, { useState, useEffect } from 'react'
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
  Coins,
  Lock,
  ChevronDown,
  ChevronRight,
  Info,
  Check,
  Copy,
  CheckCheck
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

// Initialize modular service singletons
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
  const [activeTab, setActiveTab] = useState<'dashboard' | 'create' | 'chat' | 'memories' | 'payout'>('dashboard')
  const [withMemory, setWithMemory] = useState<boolean>(true) // KEY DEMO TOGGLE
  const [selectedCycle, setSelectedCycle] = useState<number>(5)
  const [isVerifying, setIsVerifying] = useState<boolean>(false)
  const [copiedText, setCopiedText] = useState<string | null>(null)
  const [expandedReasoning, setExpandedReasoning] = useState<boolean>(true)

  // Stepped flow for Create Circle: 1 = Basics, 2 = Members, 3 = Pool Address, 4 = Review
  const [createStep, setCreateStep] = useState<number>(1)

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

  // New Member form state for stepped flow
  const [newMemberName, setNewMemberName] = useState('')
  const [newMemberAddress, setNewMemberAddress] = useState('')

  // Verification state store per member: cycle -> memberId -> VerificationResult
  const [verifications, setVerifications] = useState<Record<string, VerificationResult>>({
    'm1_5': { status: 'Verified', txDigest: '0x66ff11ab223390fe', amountReceived: 500, timestamp: '2026-09-01T08:30:00Z', rawNotes: 'Paid on time' },
    'm2_5': { status: 'Late', txDigest: '0x33aa88cc9911ef02', amountReceived: 500, timestamp: '2026-09-03T14:15:00Z', rawNotes: 'Paid 2 days late' },
    'm3_5': { status: 'Verified', txDigest: '0x88991122aabbccdd', amountReceived: 500, timestamp: '2026-09-01T09:12:00Z', rawNotes: 'Early bird deposit' },
    'm4_5': { status: 'Verified', txDigest: '0x4455667788990011', amountReceived: 500, timestamp: '2026-09-02T11:00:00Z', rawNotes: 'Standard deposit' },
    'm5_5': { status: 'Partial', txDigest: '0x1122334455667788', amountReceived: 250, timestamp: '2026-09-01T19:40:00Z', rawNotes: 'Split tranche 1 of 2' },
    'm6_5': { status: 'Pending', amountReceived: 0, rawNotes: "We couldn't confirm this payment yet on Sui" },

    // Cycle 1 Historical Records for Comparison
    'm1_1': { status: 'Verified', txDigest: '0x71fab41a990011', amountReceived: 500, timestamp: '2026-05-01T10:14:00Z' },
    'm2_1': { status: 'Late', txDigest: '0x90de88114422bb', amountReceived: 500, timestamp: '2026-05-03T16:30:00Z', rawNotes: 'Paid 2 days late (No memory active)' },
    'm3_1': { status: 'Verified', txDigest: '0x12bb33cc77aa11', amountReceived: 500, timestamp: '2026-05-01T09:00:00Z' },
    'm4_1': { status: 'Verified', txDigest: '0xaa44ee55112233', amountReceived: 500, timestamp: '2026-05-01T12:45:00Z' },
    'm5_1': { status: 'Verified', txDigest: '0x22117766889900', amountReceived: 500, timestamp: '2026-05-02T18:20:00Z' },
    'm6_1': { status: 'Verified', txDigest: '0xbb881199334455', amountReceived: 500, timestamp: '2026-05-01T14:10:00Z' }
  })

  // Memory store records
  const [memoriesList, setMemoriesList] = useState<MemoryRecord[]>(SEED_MEMORIES)

  // Chat state
  const [chatInput, setChatInput] = useState('')
  const [isChatTyping, setIsChatTyping] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'init-1',
      sender: 'steward',
      text: 'Hello! I am your Ajo Steward. I keep watch over your circle contributions on Sui, make sure every agreement is remembered, and offer gentle guidance whenever someone needs flexibility.',
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
      text: 'Yes, absolutely. Under our Cycle 4 agreement, Tunde has an approved 3-day grace period to match his salary date. Once his 500 USDC lands on Sui within 72 hours, his status stays in full good standing.',
      timestamp: '10:02 AM',
      citedMemories: [SEED_MEMORIES[0]]
    }
  ])

  // Active proposed memory awaiting confirmation
  const [proposedMemory, setProposedMemory] = useState<ProposedMemory | null>({
    id: 'prop-seed',
    category: 'Agreements',
    title: 'Swap payout turn for Cycle 6',
    quote: 'Zainab asked to swap her payout month with Chidi for equipment purchase.',
    suggestedAction: 'Ratify 1-cycle turn swap between Zainab Musa and Chidi Okonkwo.'
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

  // Copy helper
  const handleCopy = (text: string, id: string) => {
    navigator.clipboard?.writeText(text)
    setCopiedText(id)
    setTimeout(() => setCopiedText(null), 2000)
  }

  // Verify onchain action
  const handleVerifyOnchain = async () => {
    setIsVerifying(true)
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
      confirmedBy: 'Group consensus (5 of 6 agreed)',
      walrusBlobId: `walrus_${Math.random().toString(36).substring(2, 8)}_${Date.now().toString(36).substring(4)}`,
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
        text: `Noted and saved to group memory: "${newRecord.title}". The circle now remembers this agreement.`,
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
        text: 'No problem, we will leave circle agreements as they are.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ])
  }

  // Add Member
  const handleAddMember = () => {
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

  // Calculate verified pot for current cycle
  const verifiedCount = members.filter(m => {
    const r = verifications[`${m.id}_${selectedCycle}`]
    if (m.id === 'm2' && selectedCycle === 5) {
      return withMemory
    }
    return r?.status === 'Verified'
  }).length

  const totalPotValue = verifiedCount * contributionPerMember + (selectedCycle === 5 ? 250 : 0)

  return (
    <div className="min-h-screen bg-secondary text-primary font-sans flex flex-col items-center antialiased pb-24 md:pb-12">
      {/* Centered Mobile-First Column Container (max-w-xl on desktop) */}
      <div className="w-full max-w-xl mx-auto flex flex-col flex-1 px-md sm:px-lg">
        {/* Page Header Component (guidelines/layout-dashboard.md) */}
        <header className="sticky top-0 z-30 bg-primary border-b border-secondary p-xl -mx-md sm:-mx-lg mb-md flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-md min-w-0">
            <div className="w-10 h-10 rounded-lg bg-brand-solid flex items-center justify-center text-primary-on-brand shadow-xs shrink-0">
              <ShieldCheck className="size-5 text-fg-white shrink-0" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-xs">
                <h1 className="text-heading-xs font-semibold text-primary truncate">{circleName}</h1>
                <span className="w-2 h-2 rounded-full bg-success-primary inline-block shrink-0" />
              </div>
              <p className="text-sm text-tertiary">
                Cycle {selectedCycle} of 6 · <span className="tabular-nums font-medium text-primary">{totalPotValue.toLocaleString()} USDC</span> pot
              </p>
            </div>
          </div>

          {/* Button Component: secondary icon button (guidelines/components/button.md) */}
          <button
            onClick={handleVerifyOnchain}
            disabled={isVerifying}
            aria-label="Refresh from Sui"
            className="inline-flex items-center justify-center rounded-lg bg-primary p-md text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`size-4 text-fg-secondary shrink-0 ${isVerifying ? 'animate-spin text-fg-brand-primary' : ''}`} />
          </button>
        </header>

        {/* Card Component: Steward Mode Control (guidelines/components/card.md) */}
        <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs mb-lg">
          <div className="flex items-center justify-between mb-sm">
            <span className="text-sm font-medium text-secondary flex items-center gap-xs">
              <Brain className="size-4 text-fg-brand-primary shrink-0" />
              Steward Mode
            </span>
            <span className="text-xs text-tertiary">Tap to compare behavior</span>
          </div>

          {/* Radio / Segmented Toggle: Button Component recipes */}
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
              <CheckCircle2 className={`size-4 shrink-0 ${withMemory ? 'text-fg-white' : 'text-fg-quaternary'}`} />
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
              <Clock className={`size-4 shrink-0 ${!withMemory ? 'text-fg-warning-primary' : 'text-fg-quaternary'}`} />
              <span>Without memory</span>
            </button>
          </div>

          {/* Alert Component Recipe (guidelines/components/alert.md) */}
          <div className="mt-md flex gap-lg rounded-xl bg-utility-brand-50 p-xl">
            <Info className="mt-xxs size-5 shrink-0 text-utility-brand-600" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-utility-brand-600">
                {withMemory ? 'Memory-assisted reasoning is active' : 'Strict timestamp verification only'}
              </p>
              <p className="mt-xxs text-sm text-tertiary">
                {withMemory ? (
                  <>
                    Tunde's 2-day late payment in Cycle 5 is approved under our Cycle 4 grace agreement. Status is <strong className="text-utility-success-700">Verified</strong>.
                  </>
                ) : (
                  <>
                    Evaluating timestamps without memory. Tunde's payment is flagged as an <strong className="text-error-primary">Unexcused late payment</strong>.
                  </>
                )}
              </p>
            </div>
          </div>
        </section>

        {/* SCREEN 1: HOME (CIRCLE DASHBOARD) */}
        {activeTab === 'dashboard' && (
          <div className="space-y-lg">
            {/* Card Component: Pot Summary (guidelines/components/card.md) */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-sm text-tertiary">Pot this cycle</span>
                  <div className="mt-xs text-heading-md font-semibold text-primary tabular-nums">
                    {totalPotValue.toLocaleString()} <span className="text-sm font-normal text-tertiary">USDC</span>
                  </div>
                </div>
                {/* Badge Component: Tinted Pill (guidelines/components/badge.md) */}
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                  Cycle {selectedCycle} of 6
                </span>
              </div>

              {/* Progress Bar Component Recipe (guidelines/components/progress-bar.md) */}
              <div className="space-y-xs">
                <div className="flex justify-between text-sm text-tertiary">
                  <span>{verifiedCount} of 6 contributions verified</span>
                  <span className="tabular-nums font-semibold text-primary">{Math.round((totalPotValue / potPerCycle) * 100)}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-tertiary">
                  <div
                    className="h-full rounded-full bg-brand-solid transition-all duration-500 ease-out"
                    style={{ width: `${(totalPotValue / potPerCycle) * 100}%` }}
                  />
                </div>
              </div>

              {/* Next to receive banner inside card */}
              <div className="pt-md border-t border-secondary flex items-center justify-between">
                <div className="flex items-center gap-md">
                  <div className="w-10 h-10 rounded-full bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200 flex items-center justify-center font-bold text-xs shrink-0">
                    EN
                  </div>
                  <div>
                    <p className="text-xs text-tertiary">Next to receive pot:</p>
                    <p className="text-sm font-semibold text-primary">Emeka Nwosu</p>
                  </div>
                </div>
                {/* Button Component: Secondary Action (guidelines/components/button.md) */}
                <button
                  onClick={() => setActiveTab('payout')}
                  className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <span>Review payout</span>
                  <ChevronRight className="size-4 text-fg-quaternary shrink-0" />
                </button>
              </div>
            </section>

            {/* Card Component: Cycle Timeline Strip (guidelines/components/card.md) */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <div className="flex items-center justify-between mb-md">
                <span className="text-sm font-medium text-secondary">Cycle rotation</span>
                <span className="text-xs text-tertiary">Tap cycle to inspect</span>
              </div>
              <div className="flex items-center justify-between relative px-xs">
                {/* Connector line */}
                <div className="absolute left-6 right-6 top-4 h-0.5 bg-secondary -z-0" />

                {[1, 2, 3, 4, 5, 6].map(cNum => {
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
                        {isCompleted ? <Check className="size-4 text-fg-success-primary shrink-0" /> : cNum}
                      </div>
                      <span className={`text-xs ${isCurrent ? 'font-semibold text-brand-primary' : 'text-tertiary'}`}>
                        C{cNum}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>

            {/* Card Component: Member Avatars (guidelines/components/card.md) */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <div className="flex items-center justify-between mb-sm">
                <span className="text-sm font-medium text-secondary">Member circle</span>
                <span className="text-xs text-tertiary">Status rings</span>
              </div>
              <div className="flex items-center justify-between gap-xs overflow-x-auto pb-xs">
                {members.map(member => {
                  const recKey = `${member.id}_${selectedCycle}`
                  const raw = verifications[recKey]
                  const isVerified = member.id === 'm2' && selectedCycle === 5 ? withMemory : raw?.status === 'Verified'
                  const isPartial = raw?.status === 'Partial'
                  const isPending = raw?.status === 'Pending'
                  const isLate = member.id === 'm2' && selectedCycle === 5 ? !withMemory : raw?.status === 'Late'

                  const ringColor = isVerified
                    ? 'ring-2 ring-utility-success-600'
                    : isLate
                    ? 'ring-2 ring-error-primary'
                    : isPartial || isPending
                    ? 'ring-2 ring-warning-primary'
                    : 'ring-2 ring-utility-gray-200'

                  return (
                    <div key={member.id} className="flex flex-col items-center gap-xs min-w-[56px]">
                      <div className={`w-11 h-11 rounded-full p-0.5 bg-primary ${ringColor} flex items-center justify-center transition-all`}>
                        <div className={`w-full h-full rounded-full flex items-center justify-center text-xs font-semibold ${member.avatarColor}`}>
                          {member.name.split(' ').map(n => n[0]).join('')}
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

            {/* Table Component Recipe (guidelines/components/table.md) */}
            <div className="overflow-hidden rounded-xl border border-secondary bg-primary shadow-xs">
              <div className="p-xl border-b border-secondary flex items-center justify-between">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Contributions this cycle</h3>
                  <p className="mt-xs text-sm text-tertiary">Verified directly against Sui transaction records</p>
                </div>
                {/* Badge Component (guidelines/components/badge.md) */}
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700">
                  500 USDC each
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="sticky top-0 z-10 bg-secondary">
                    <tr className="border-b border-secondary text-left">
                      <th className="px-3xl py-md text-sm font-semibold text-quaternary">Member</th>
                      <th className="px-3xl py-md text-sm font-semibold text-quaternary">Amount</th>
                      <th className="px-3xl py-md text-sm font-semibold text-quaternary">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map(member => {
                      const recKey = `${member.id}_${selectedCycle}`
                      const raw = verifications[recKey] || { status: 'Pending', amountReceived: 0 }

                      let status: CycleStatus = raw.status
                      let statusLabel = 'Verified'
                      let badgeColor = 'utility-success'

                      if (member.id === 'm2' && selectedCycle === 5) {
                        if (withMemory) {
                          status = 'Verified'
                          statusLabel = 'Verified (Grace)'
                          badgeColor = 'utility-success'
                        } else {
                          status = 'Late'
                          statusLabel = 'Late'
                          badgeColor = 'utility-error'
                        }
                      } else if (raw.status === 'Partial') {
                        statusLabel = 'Partial'
                        badgeColor = 'utility-warning'
                      } else if (raw.status === 'Pending') {
                        statusLabel = 'Pending'
                        badgeColor = 'utility-warning'
                      }

                      const tx = raw.txDigest

                      return (
                        <tr
                          key={member.id}
                          className="border-b border-secondary hover:bg-secondary-hover transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring"
                        >
                          <td className="px-3xl py-xl text-md text-tertiary">
                            <div className="flex items-center gap-md min-w-0">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs shrink-0 ${member.avatarColor}`}>
                                {member.name.split(' ').map(n => n[0]).join('')}
                              </div>
                              <div className="min-w-0">
                                <p className="text-primary font-medium">{member.name}</p>
                                <div className="flex items-center gap-xs mt-xxs">
                                  {tx ? (
                                    <div className="flex items-center gap-xxs bg-secondary px-xs py-0.5 rounded text-xs text-secondary font-mono">
                                      <span>{tx.substring(0, 6)}...{tx.substring(tx.length - 4)}</span>
                                      <button
                                        onClick={() => handleCopy(tx, `tx-${member.id}`)}
                                        className="text-tertiary hover:text-primary p-xxs focus-visible:ring-2 focus-visible:ring-focus-ring rounded"
                                        title="Copy transaction hash"
                                      >
                                        {copiedText === `tx-${member.id}` ? <CheckCheck className="size-3 text-fg-success-primary shrink-0" /> : <Copy className="size-3 text-fg-quaternary shrink-0" />}
                                      </button>
                                      <a
                                        href={`https://suiscan.xyz/mainnet/tx/${tx}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-brand-primary hover:underline flex items-center gap-xxs"
                                        title="View on Sui"
                                      >
                                        <ExternalLink className="size-3 text-fg-brand-primary shrink-0" />
                                      </a>
                                    </div>
                                  ) : (
                                    <span className="text-xs text-tertiary">We couldn't confirm this payment yet</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>

                          <td className="px-3xl py-xl text-md text-tertiary tabular-nums font-medium text-primary">
                            {status === 'Verified' ? 500 : status === 'Partial' ? 250 : 0} <span className="text-xs font-normal text-tertiary">USDC</span>
                          </td>

                          <td className="px-3xl py-xl text-md text-tertiary">
                            {/* Badge Component: Tinted Pill (guidelines/components/badge.md) */}
                            <span className={`inline-flex items-center gap-xs rounded-full border border-${badgeColor}-200 bg-${badgeColor}-50 px-md py-xxs text-xs font-medium text-${badgeColor}-700`}>
                              {badgeColor === 'utility-success' && <CheckCircle2 className="size-3 text-fg-success-primary shrink-0" />}
                              {badgeColor === 'utility-error' && <AlertTriangle className="size-3 text-fg-error-primary shrink-0" />}
                              {badgeColor === 'utility-warning' && <Clock className="size-3 text-fg-warning-primary shrink-0" />}
                              <span>{statusLabel}</span>
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Tertiary Button: Set up another circle (guidelines/components/button.md) */}
            <div className="pt-sm flex justify-center">
              <button
                onClick={() => {
                  setCreateStep(1)
                  setActiveTab('create')
                }}
                className="inline-flex items-center gap-sm px-lg py-sm text-sm font-semibold text-brand-primary hover:text-brand-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <PlusCircle className="size-4 text-fg-brand-primary shrink-0" />
                <span>Set up another circle</span>
              </button>
            </div>
          </div>
        )}

        {/* SCREEN 2: CREATE CIRCLE (Stepped Flow with Input Recipes) */}
        {activeTab === 'create' && (
          <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-xl">
            {/* Stepped Progress Indicator */}
            <div>
              <div className="flex items-center justify-between text-xs font-medium text-secondary mb-sm">
                <span>Step {createStep} of 4</span>
                <span className="text-brand-primary font-semibold">
                  {createStep === 1 ? 'Circle basics' : createStep === 2 ? 'Members' : createStep === 3 ? 'Pool address' : 'Review & Confirm'}
                </span>
              </div>
              {/* Progress Bar Component Recipe */}
              <div className="h-2 w-full overflow-hidden rounded-full bg-tertiary">
                <div
                  className="h-full rounded-full bg-brand-solid transition-all"
                  style={{ width: `${(createStep / 4) * 100}%` }}
                />
              </div>
            </div>

            {/* Step 1: Basics */}
            {createStep === 1 && (
              <div className="space-y-lg">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Circle details</h3>
                  <p className="mt-xs text-sm text-tertiary">Name your savings group and set the contribution rules.</p>
                </div>

                <div className="space-y-md">
                  {/* Input & Field Component Recipe (guidelines/components/input.md) */}
                  <div className="flex flex-col gap-sm">
                    <label className="text-sm font-medium text-secondary">Circle name</label>
                    <input
                      type="text"
                      value={circleName}
                      onChange={e => setCircleName(e.target.value)}
                      placeholder="e.g. Lagos Techies Seed Circle"
                      className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                    <p className="text-xs text-tertiary">A memorable name your members recognize.</p>
                  </div>

                  <div className="grid grid-cols-2 gap-md">
                    {/* Disabled Input Component Recipe */}
                    <div className="flex flex-col gap-sm">
                      <label className="text-sm font-medium text-secondary">Contribution per cycle</label>
                      <input
                        type="number"
                        value={contributionPerMember}
                        disabled
                        className="rounded-md bg-disabled-subtle px-lg py-sm text-sm text-disabled border border-primary opacity-80 cursor-not-allowed tabular-nums"
                      />
                      <p className="text-xs text-tertiary">Each member pays 500 USDC.</p>
                    </div>

                    {/* Select Component Recipe (guidelines/components/select.md) */}
                    <div className="flex flex-col gap-sm">
                      <label className="text-sm font-medium text-secondary">Cycle length</label>
                      <select
                        value={cycleLength}
                        onChange={e => setCycleLength(e.target.value)}
                        className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        <option value="Weekly">Weekly</option>
                        <option value="Monthly">Monthly</option>
                        <option value="Bi-Weekly">Bi-Weekly</option>
                      </select>
                      <p className="text-xs text-tertiary">How often the pot rotates.</p>
                    </div>
                  </div>
                </div>

                {/* Primary Button Component (guidelines/components/button.md) */}
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

            {/* Step 2: Members */}
            {createStep === 2 && (
              <div className="space-y-lg">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Group members</h3>
                  <p className="mt-xs text-sm text-tertiary">Add the participants in this savings circle.</p>
                </div>

                <div className="space-y-xs max-h-56 overflow-y-auto">
                  {members.map((m, idx) => (
                    <div key={m.id} className="flex items-center justify-between p-md bg-secondary rounded-lg border border-secondary text-xs">
                      <div className="flex items-center gap-sm">
                        <span className="w-5 h-5 rounded-full bg-utility-brand-50 text-utility-brand-700 flex items-center justify-center font-bold text-xs">
                          {idx + 1}
                        </span>
                        <div>
                          <p className="font-semibold text-primary">{m.name}</p>
                          <p className="text-xs font-mono text-tertiary">{m.address}</p>
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-xs rounded-full border border-utility-success-200 bg-utility-success-50 px-md py-xxs text-xs font-medium text-utility-success-700">
                        <Check className="size-3 text-fg-success-primary shrink-0" /> Added
                      </span>
                    </div>
                  ))}
                </div>

                {/* Inline Add Member Fields (guidelines/components/input.md) */}
                <div className="p-md bg-secondary rounded-xl border border-secondary space-y-sm">
                  <p className="text-sm font-medium text-secondary">Invite another member</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
                    <input
                      type="text"
                      placeholder="Full Name (e.g. Dayo Alabi)"
                      value={newMemberName}
                      onChange={e => setNewMemberName(e.target.value)}
                      className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                    <input
                      type="text"
                      placeholder="Sui Address (0x...)"
                      value={newMemberAddress}
                      onChange={e => setNewMemberAddress(e.target.value)}
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
                    className="inline-flex items-center px-lg py-sm text-sm font-semibold text-secondary hover:text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setCreateStep(3)}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <span>Continue to pool vault</span>
                    <ArrowRight className="size-4 text-fg-white shrink-0" />
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Pool Address */}
            {createStep === 3 && (
              <div className="space-y-lg">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Sui pool address</h3>
                  <p className="mt-xs text-sm text-tertiary">
                    All funds are collected into this non-custodial multi-sig or smart contract vault.
                  </p>
                </div>

                {/* Alert Component Recipe (guidelines/components/alert.md) */}
                <div className="flex gap-lg rounded-xl bg-utility-brand-50 p-xl">
                  <ShieldCheck className="mt-xxs size-5 shrink-0 text-utility-brand-600" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-semibold text-utility-brand-600">Non-custodial advisory guarantee</p>
                    <p className="mt-xxs text-sm text-tertiary">
                      Ajo Steward never holds private keys or moves funds. All disbursements are signed directly by circle trustees.
                    </p>
                  </div>
                </div>

                {/* Input Component Recipe */}
                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Pool vault address</label>
                  <input
                    type="text"
                    value={poolAddress}
                    onChange={e => setPoolAddress(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <p className="text-xs text-tertiary">The onchain address monitored for incoming USDC deposits.</p>
                </div>

                <div className="pt-md flex items-center justify-between">
                  <button
                    onClick={() => setCreateStep(2)}
                    className="inline-flex items-center px-lg py-sm text-sm font-semibold text-secondary hover:text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setCreateStep(4)}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <span>Review circle</span>
                    <ArrowRight className="size-4 text-fg-white shrink-0" />
                  </button>
                </div>
              </div>
            )}

            {/* Step 4: Review */}
            {createStep === 4 && (
              <div className="space-y-lg">
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Ready to activate</h3>
                  <p className="mt-xs text-sm text-tertiary">Review your configuration before activating the steward.</p>
                </div>

                <div className="p-xl bg-secondary rounded-xl border border-secondary space-y-md text-sm">
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Circle name</span>
                    <span className="font-semibold text-primary">{circleName}</span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Contribution</span>
                    <span className="font-semibold text-primary tabular-nums">{contributionPerMember} USDC / member</span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Total pot per cycle</span>
                    <span className="font-semibold text-brand-primary tabular-nums">3,000 USDC</span>
                  </div>
                  <div className="flex justify-between pb-xs border-b border-secondary">
                    <span className="text-tertiary">Number of members</span>
                    <span className="font-semibold text-primary">{members.length} members ({members.length} cycles)</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-tertiary">Vault address</span>
                    <span className="font-mono text-primary truncate max-w-[200px]">{poolAddress}</span>
                  </div>
                </div>

                <div className="pt-md flex items-center justify-between">
                  <button
                    onClick={() => setCreateStep(3)}
                    className="inline-flex items-center px-lg py-sm text-sm font-semibold text-secondary hover:text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setActiveTab('dashboard')}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
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
            {/* Chat Header */}
            <div className="p-xl border-b border-secondary flex items-center justify-between bg-primary">
              <div className="flex items-center gap-md">
                <div className="w-10 h-10 rounded-lg bg-brand-solid text-primary-on-brand flex items-center justify-center shadow-xs shrink-0">
                  <Brain className="size-5 text-fg-white shrink-0" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-primary">Ajo AI Steward</h3>
                  <p className="text-xs text-secondary">
                    {withMemory ? `${memoriesList.length} circle agreements active` : 'Evaluating raw timestamps only'}
                  </p>
                </div>
              </div>

              {/* Badge Component (guidelines/components/badge.md) */}
              <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-solid" />
                Sui Verifier Live
              </span>
            </div>

            {/* Chat Bubbles Scroll Area */}
            <div className="flex-1 p-xl overflow-y-auto space-y-md bg-secondary">
              {messages.map(msg => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
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
                      <div className="mt-xs pt-xs border-t border-secondary text-xs">
                        <span className="font-semibold text-secondary flex items-center gap-xxs">
                          <Bookmark className="size-3 text-fg-brand-primary shrink-0" />
                          <span>Cited from memory:</span>
                        </span>
                        <p className="text-brand-primary font-medium mt-xxs">
                          "{msg.citedMemories[0].title}"
                        </p>
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-tertiary mt-xxs px-xs">{msg.timestamp}</span>
                </div>
              ))}

              {isChatTyping && (
                <div className="flex items-center gap-xs text-xs text-tertiary">
                  <RefreshCw className="size-3.5 animate-spin text-fg-brand-primary shrink-0" />
                  <span>Steward is checking circle agreements...</span>
                </div>
              )}
            </div>

            {/* Proposed Memory Inline Card */}
            {proposedMemory && (
              <div className="p-xl bg-utility-brand-50 border-t border-utility-brand-200 space-y-xs">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-brand-primary flex items-center gap-xxs">
                    <Sparkles className="size-3.5 shrink-0" />
                    Proposed circle agreement
                  </span>
                  <span className="text-xs text-tertiary">Awaiting group review</span>
                </div>
                <p className="text-sm font-semibold text-primary">{proposedMemory.title}</p>
                <p className="text-xs italic text-secondary">"{proposedMemory.quote}"</p>

                {/* Button Component: Primary & Secondary (guidelines/components/button.md) */}
                <div className="pt-xs flex items-center gap-sm">
                  <button
                    onClick={() => handleConfirmMemory(proposedMemory)}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <Check className="size-4 text-fg-white shrink-0" />
                    <span>Confirm & remember</span>
                  </button>
                  <button
                    onClick={handleRejectMemory}
                    className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    Not now
                  </button>
                </div>
              </div>
            )}

            {/* Suggested-Reply Chips Above Keyboard */}
            <div className="px-lg py-sm border-t border-secondary bg-primary flex items-center gap-xs overflow-x-auto whitespace-nowrap">
              <span className="text-xs text-tertiary shrink-0">Ask:</span>
              {[
                'Can Tunde pay late this month?',
                'Who might pay late?',
                'Who is the riskiest member before payout?'
              ].map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(chip)}
                  className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700 hover:bg-secondary-hover focus-visible:ring-2 focus-visible:ring-focus-ring shrink-0"
                >
                  {chip}
                </button>
              ))}
            </div>

            {/* Input Component Recipe (guidelines/components/input.md) */}
            <div className="p-xl border-t border-secondary bg-primary">
              <div className="flex items-center gap-sm">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
                  placeholder="Ask the steward about circle payments, rules..."
                  className="flex-1 rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
                <button
                  onClick={() => handleSendMessage()}
                  aria-label="Send message"
                  className="inline-flex items-center justify-center rounded-lg border border-transparent bg-brand-solid p-md text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring shrink-0"
                >
                  <Send className="size-4 text-fg-white shrink-0" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* SCREEN 4: MEMORY (Card list grouped under 3 categories) */}
        {activeTab === 'memories' && (
          <div className="space-y-xl">
            {/* Card Component Recipe (guidelines/components/card.md) */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <div className="flex items-center gap-md">
                <div className="w-10 h-10 rounded-lg bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200 flex items-center justify-center font-bold shrink-0">
                  <Brain className="size-5 text-fg-brand-primary shrink-0" />
                </div>
                <div>
                  <h3 className="text-heading-xs font-semibold text-primary">Group memory store</h3>
                  <p className="mt-xs text-sm text-tertiary">
                    Every consensus, grace period, and habit is cryptographically anchored.
                  </p>
                </div>
              </div>
            </section>

            {/* Grouped sections */}
            {(['Agreements', 'Member patterns', 'Reminder preferences'] as const).map(category => {
              const items = memoriesList.filter(m => m.category === category)
              return (
                <div key={category} className="space-y-md">
                  <div className="flex items-center justify-between px-xs">
                    <h4 className="text-sm font-semibold text-secondary uppercase tracking-wider">
                      {category} ({items.length})
                    </h4>
                    <span className="text-xs text-tertiary">Immutable records</span>
                  </div>

                  <div className="space-y-sm">
                    {items.map(mem => (
                      <section
                        key={mem.id}
                        className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-sm"
                      >
                        <div className="flex items-start justify-between gap-sm">
                          <div>
                            <h5 className="text-sm font-semibold text-primary">{mem.title}</h5>
                            <span className="text-xs text-tertiary">{mem.date} · Cycle {mem.cycle}</span>
                          </div>

                          {/* Badge Component: Tinted Pill (guidelines/components/badge.md) */}
                          <button
                            onClick={() => handleCopy(mem.walrusBlobId, mem.id)}
                            className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700 hover:bg-secondary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                            title="Click to copy Walrus blob ID"
                          >
                            <Lock className="size-3 text-fg-brand-primary shrink-0" />
                            <span>Saved on Walrus</span>
                            {copiedText === mem.id ? (
                              <CheckCheck className="size-3 text-fg-success-primary shrink-0" />
                            ) : (
                              <Copy className="size-3 text-fg-quaternary shrink-0" />
                            )}
                          </button>
                        </div>

                        {/* Plain English quote and rule */}
                        <div className="p-md bg-secondary rounded-lg border border-secondary text-xs">
                          <p className="italic text-secondary">"{mem.quote}"</p>
                          <p className="text-primary font-medium mt-xs pt-xs border-t border-secondary">
                            Rule: {mem.context}
                          </p>
                        </div>

                        {/* Confirmed chips */}
                        <div className="flex items-center justify-between text-xs text-tertiary">
                          <span className="inline-flex items-center gap-xs rounded-full border border-utility-success-200 bg-utility-success-50 px-md py-xxs text-xs font-medium text-utility-success-700">
                            <CheckCircle2 className="size-3 text-fg-success-primary shrink-0" />
                            {mem.confirmedBy}
                          </span>
                          <span className="text-tertiary font-mono">Blob: {mem.walrusBlobId.substring(0, 14)}...</span>
                        </div>
                      </section>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* SCREEN 5: PAYOUT RECOMMENDATIONS */}
        {activeTab === 'payout' && payoutRec && (
          <div className="space-y-lg">
            {/* Recommendation Hero Card Component (guidelines/components/card.md) */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
              <div className="flex items-center justify-between">
                {/* Badge Component: Tinted Pill (guidelines/components/badge.md) */}
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                  <Sparkles className="size-3 text-fg-brand-primary shrink-0" />
                  Steward recommendation
                </span>
                <span className="text-xs text-tertiary">Cycle {selectedCycle}</span>
              </div>

              <div className="flex items-center gap-md pt-xs">
                <div className="w-14 h-14 rounded-lg bg-brand-solid text-primary-on-brand flex items-center justify-center font-bold text-lg shadow-xs shrink-0">
                  {payoutRec.nextRecipient.name.split(' ').map((n: string) => n[0]).join('')}
                </div>
                <div>
                  <span className="text-xs text-tertiary">Suggested next recipient:</span>
                  <h3 className="text-heading-xs font-semibold text-primary">{payoutRec.nextRecipient.name}</h3>
                  <p className="text-xs font-mono text-tertiary">{payoutRec.nextRecipient.address}</p>
                </div>
              </div>

              <p className="text-sm text-secondary leading-relaxed pt-xs">
                {payoutRec.rationale}
              </p>

              <div className="pt-sm border-t border-secondary flex items-center justify-between">
                <span className="text-xs text-tertiary font-medium">Advisory only · Trustees sign payout</span>
                <span className="text-sm font-semibold text-brand-primary tabular-nums">3,000 USDC pot</span>
              </div>
            </section>

            {/* Expandable "Why this suggestion" Card */}
            <section className="rounded-xl border border-secondary bg-primary shadow-xs overflow-hidden">
              <button
                onClick={() => setExpandedReasoning(!expandedReasoning)}
                className="w-full p-xl flex items-center justify-between text-left hover:bg-secondary-hover focus-visible:ring-2 focus-visible:ring-focus-ring transition-colors"
              >
                <div className="flex items-center gap-sm">
                  <Bookmark className="size-4 text-fg-brand-primary shrink-0" />
                  <span className="text-sm font-semibold text-primary">
                    Why this suggestion (Memory citations)
                  </span>
                </div>
                {expandedReasoning ? <ChevronDown className="size-4 text-fg-secondary shrink-0" /> : <ChevronRight className="size-4 text-fg-secondary shrink-0" />}
              </button>

              {expandedReasoning && (
                <div className="p-xl pt-none border-t border-secondary bg-secondary space-y-sm text-xs">
                  <p className="text-secondary leading-relaxed">
                    The recommendation engine cross-references live Sui deposits with our Walrus memory store:
                  </p>
                  <ul className="space-y-xs">
                    <li className="flex items-start gap-xs text-secondary">
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-solid mt-1.5 shrink-0" />
                      <span>
                        <strong>Emeka's split pattern:</strong> Verified deposit of 250 USDC. Memory #2 confirms regular 48-hour completion.
                      </span>
                    </li>
                    <li className="flex items-start gap-xs text-secondary">
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-solid mt-1.5 shrink-0" />
                      <span>
                        <strong>Tunde's grace exemption:</strong> Protected under Cycle 4 consensus agreement. Verified in good standing.
                      </span>
                    </li>
                    <li className="flex items-start gap-xs text-secondary">
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-solid mt-1.5 shrink-0" />
                      <span>
                        <strong>Rotation integrity:</strong> Emeka is the rightful recipient under the founding genesis schedule.
                      </span>
                    </li>
                  </ul>
                </div>
              )}
            </section>

            {/* Risk Badge per Member with One-Line Reason */}
            <section className="rounded-xl border border-secondary bg-primary shadow-xs overflow-hidden">
              <div className="p-xl border-b border-secondary">
                <h4 className="text-heading-xs font-semibold text-primary">Member risk assessment</h4>
                <p className="mt-xs text-sm text-tertiary">Real-time risk scoring for Cycle {selectedCycle}</p>
              </div>

              <div className="divide-y divide-secondary">
                {payoutRec.memberRisks.map((item: any, idx: number) => {
                  let badgeFamily = 'utility-success'
                  let badgeLabel = 'Safe'

                  if (item.riskLevel.includes('Moderate')) {
                    badgeFamily = 'utility-warning'
                    badgeLabel = 'Pending follow-up'
                  } else if (item.riskLevel.includes('High')) {
                    badgeFamily = 'utility-error'
                    badgeLabel = 'Action needed'
                  } else if (item.riskLevel.includes('Zero')) {
                    badgeFamily = 'utility-success'
                    badgeLabel = 'Zero risk'
                  }

                  return (
                    <div key={idx} className="p-xl flex items-center justify-between gap-md hover:bg-secondary-hover transition-colors">
                      <div className="min-w-0">
                        <div className="flex items-center gap-sm">
                          <p className="text-sm font-semibold text-primary truncate">{item.member.name}</p>
                          {/* Badge Component (guidelines/components/badge.md) */}
                          <span className={`inline-flex items-center gap-xs rounded-full border border-${badgeFamily}-200 bg-${badgeFamily}-50 px-md py-xxs text-xs font-medium text-${badgeFamily}-700`}>
                            {badgeLabel}
                          </span>
                        </div>
                        <p className="text-xs text-secondary mt-xxs truncate">{item.reasoning}</p>
                      </div>

                      <span className="text-xs font-medium text-tertiary shrink-0 text-right">
                        {item.action}
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          </div>
        )}
      </div>

      {/* Tabs Navigation Component (guidelines/components/tabs.md) */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-primary border-t border-secondary shadow-lg">
        <div className="max-w-xl mx-auto flex items-center justify-around px-md py-xs">
          {[
            { id: 'dashboard', label: 'Home', icon: TrendingUp },
            { id: 'chat', label: 'Chat', icon: MessageSquare, badge: proposedMemory ? '1' : undefined },
            { id: 'memories', label: 'Memory', icon: Brain, badge: memoriesList.length.toString() },
            { id: 'payout', label: 'Payout', icon: Sparkles },
          ].map(tab => {
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
                  <Icon className={`size-5 shrink-0 ${isActive ? 'text-fg-brand-primary' : 'text-fg-quaternary'}`} />
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
