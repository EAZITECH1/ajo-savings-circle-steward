import React from 'react'
import {
  ShieldCheck,
  Brain,
  Sparkles,
  Layers,
  PlusCircle,
  Coins,
  ArrowRight,
  Compass,
  CheckCircle2,
  Clock,
  Lock,
  ExternalLink,
  Wallet,
  AlertCircle,
  FileText,
  MessageSquare,
  Users,
  Check,
} from 'lucide-react'
import { TokenLogo } from './TokenLogo'

export interface LandingPageProps {
  onNavigateTab: (tabId: 'dashboard' | 'circles' | 'create' | 'chat' | 'memories' | 'payout') => void
  onOpenTour: () => void
  onConnectWallet?: () => void
  onDisconnectWallet?: () => void
  currentAccountAddress?: string
  hasActiveCircle: boolean
  activeCircleName?: string
  activeCircleId?: string
  availableCirclesCount: number
  networkName: string
  isRpcConnected: boolean
  isWalrusConnected: boolean
}

interface ComparisonRow {
  area: string
  traditional: string
  ajoSteward: string
}

const COMPARISON_ROWS: ComparisonRow[] = [
  {
    area: 'Contribution currency',
    traditional: 'Cash or manual transfers arranged informally by the group.',
    ajoSteward: 'Members contribute the circle’s configured supported token (currently SUI or USDC) directly from their Sui wallets on Sui Testnet.',
  },
  {
    area: 'Who holds the money',
    traditional: 'One person (a collector or organizer holding cash or personal bank transfers).',
    ajoSteward: 'A Sui Move shared vault object on Sui Testnet that requires a scheduled member’s signed MoveCall to claim. Neither Ajo Steward, Tatum, nor any individual holds custody.',
  },
  {
    area: 'Payment records',
    traditional: 'Bank screenshots, chat receipts, or a handwritten notebook.',
    ajoSteward: 'Contributions are checked against Sui Testnet on-chain activity through Tatum Gateway. Tatum queries and indexes blockchain evidence without holding funds or signing transactions.',
  },
  {
    area: 'Group agreements',
    traditional: 'Often remembered informally, disputed later, or buried in chat logs.',
    ajoSteward: 'Circle rules, payout terms, and member decisions are saved as durable blobs on Walrus Mainnet for semantic recall across sessions, without on-chain enforcement or automatic penalties.',
  },
  {
    area: 'Contribution schedule',
    traditional: 'Coordinated manually through ad-hoc chat reminders and personal calendars.',
    ajoSteward: 'Configured contribution amount, cycle frequency, exact deadlines, and local time zones are clearly visible to all members in the app.',
  },
  {
    area: 'Payout order',
    traditional: 'Agreed verbally or decided ad-hoc by the organizer.',
    ajoSteward: 'The app displays the circle’s configured roster order and scheduled claim process, allowing the eligible member to claim directly to their wallet via on-chain MoveCall.',
  },
  {
    area: 'Missed or late contributions',
    traditional: 'Follow-up and records vary widely by organizer; disputes easily arise.',
    ajoSteward: 'On-chain Sui transaction timestamps verify timeliness; participation history is retained in Walrus Memory for context. The app provides factual evidence and advisory notes without automatic penalties or collateral.',
  },
  {
    area: 'Organizer workload',
    traditional: 'High manual burden tracking bank receipts, reconciling accounts, and chasing participants.',
    ajoSteward: 'Circle dashboard brings member status, verified contribution evidence, Walrus agreements, and payout information together in one place.',
  },
]

export const LandingPage: React.FC<LandingPageProps> = ({
  onNavigateTab,
  onOpenTour,
  onConnectWallet,
  onDisconnectWallet,
  currentAccountAddress,
  hasActiveCircle,
  activeCircleName,
  activeCircleId,
  availableCirclesCount,
  networkName,
  isRpcConnected,
  isWalrusConnected,
}) => {
  return (
    <div className="w-full space-y-4xl sm:space-y-5xl animate-in fade-in duration-300 pb-3xl">
      {/* 1. HERO SECTION */}
      <section className="relative pt-xl sm:pt-2xl lg:pt-3xl space-y-2xl">
        <div className="max-w-4xl mx-auto text-center space-y-xl">
          {/* Tagline Badge */}
          <div className="inline-flex items-center gap-xs px-lg py-xs rounded-full text-xs sm:text-sm font-semibold bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200 shadow-2xs">
            <span className="w-2.5 h-2.5 rounded-full bg-utility-brand-500 animate-pulse" />
            <span>Built on Sui Move & Walrus Protocol</span>
          </div>

          {/* Headline */}
          <h1 className="text-3xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-primary leading-[1.15]">
            Run savings circles with clear agreements and verifiable contributions.
          </h1>

          {/* Subhead - Enlarged to match Revoir reference style */}
          <p className="text-lg sm:text-xl lg:text-2xl text-secondary leading-relaxed max-w-3xl mx-auto font-normal">
            Members contribute SUI or USDC on Sui Testnet directly from their own Sui wallets. Tatum Gateway queries and verifies
            on-chain payment evidence, while Walrus Memory stores circle agreements for semantic recall.
          </p>

          {/* Primary & Secondary Call to Actions */}
          <div className="flex flex-wrap items-center justify-center gap-md pt-sm">
            <button
              type="button"
              onClick={() => onNavigateTab('create')}
              className="inline-flex items-center gap-xs rounded-xl bg-brand-solid px-2xl py-lg text-base sm:text-lg font-semibold text-primary-on-brand shadow-md hover:bg-brand-solid-hover transition-all focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <PlusCircle className="size-5 shrink-0" />
              <span>Create a circle</span>
            </button>

            {hasActiveCircle ? (
              <button
                type="button"
                onClick={() => onNavigateTab('dashboard')}
                className="inline-flex items-center gap-xs rounded-xl bg-primary border border-secondary px-2xl py-lg text-base sm:text-lg font-semibold text-secondary hover:text-primary hover:bg-secondary shadow-xs transition-colors"
              >
                <span>Open my dashboard</span>
                <ArrowRight className="size-5 shrink-0" />
              </button>
            ) : availableCirclesCount > 0 ? (
              <button
                type="button"
                onClick={() => onNavigateTab('circles')}
                className="inline-flex items-center gap-xs rounded-xl bg-primary border border-secondary px-2xl py-lg text-base sm:text-lg font-semibold text-secondary hover:text-primary hover:bg-secondary shadow-xs transition-colors"
              >
                <span>View my circles ({availableCirclesCount})</span>
                <ArrowRight className="size-5 shrink-0" />
              </button>
            ) : null}

            <button
              type="button"
              onClick={onOpenTour}
              className="inline-flex items-center gap-xs rounded-xl bg-utility-brand-50 border border-utility-brand-200 px-xl py-lg text-base sm:text-lg font-semibold text-brand-primary hover:bg-utility-brand-100 transition-colors"
            >
              <Compass className="size-5 shrink-0" />
              <span>Take a tour</span>
            </button>
          </div>

          {/* Live Status Indicators (Real, Non-Fabricated) */}
          <div className="pt-sm flex flex-wrap items-center justify-center gap-md text-sm text-tertiary">
            <div className="flex items-center gap-xs">
              <span className={`w-2.5 h-2.5 rounded-full ${isRpcConnected ? 'bg-utility-success-500' : 'bg-utility-warning-500'}`} />
              <span>Tatum {networkName || 'Sui Testnet'}: {isRpcConnected ? 'Connected' : 'Connecting...'}</span>
            </div>
            <span>·</span>
            <div className="flex items-center gap-xs">
              <span className={`w-2.5 h-2.5 rounded-full ${isWalrusConnected ? 'bg-utility-success-500' : 'bg-utility-warning-500'}`} />
              <span>Walrus Mainnet Memory: {isWalrusConnected ? 'Active' : 'Offline'}</span>
            </div>
          </div>
        </div>

        {/* Product Preview (Faithful composition of real application UI) */}
        <div className="max-w-4xl mx-auto rounded-2xl border border-secondary bg-primary shadow-xl overflow-hidden">
          <div className="px-xl py-md border-b border-secondary bg-secondary/30 flex items-center justify-between text-xs">
            <div className="flex items-center gap-xs">
              <div className="size-2 rounded-full bg-red-400" />
              <div className="size-2 rounded-full bg-yellow-400" />
              <div className="size-2 rounded-full bg-green-400" />
              <span className="ml-xs font-semibold text-primary">Ajo Steward · Product Interface</span>
            </div>
            <span className="font-mono text-tertiary text-[11px] uppercase">
              {networkName || 'Sui Testnet'}
            </span>
          </div>

          <div className="p-xl sm:p-2xl space-y-xl bg-gradient-to-b from-primary to-secondary/20">
            {/* Header Mock */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-md pb-md border-b border-secondary">
              <div className="flex items-center gap-md">
                <img
                  src="/logo.png"
                  alt="Ajo Steward"
                  className="size-10 sm:size-11 object-contain shrink-0"
                />
                <div>
                  <div className="flex items-center gap-xs">
                    <span className="px-sm py-0.5 rounded text-[10px] font-bold bg-utility-brand-50 text-brand-primary border border-utility-brand-200">
                      Active Circle
                    </span>
                    <span className="text-xs text-tertiary">Cycle 1 of 2</span>
                  </div>
                  <h3 className="text-lg font-bold text-primary mt-xxs">
                    {hasActiveCircle ? activeCircleName : 'Community Techies Savings Circle'}
                  </h3>
                </div>
              </div>
              <div className="flex items-center gap-xs">
                <span className="inline-flex items-center gap-xxs px-sm py-1 rounded-full text-xs font-medium bg-utility-success-50 text-utility-success-700 border border-utility-success-200">
                  <CheckCircle2 className="size-3.5 text-fg-success-primary" />
                  <span>On-Chain Verified</span>
                </span>
              </div>
            </div>

            {/* Pot Progress Card Preview */}
            <div className="rounded-xl border border-secondary bg-primary p-lg sm:p-xl space-y-md shadow-xs">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs text-tertiary">Verified on-chain pot this cycle</span>
                  <div className="mt-xxs text-xl font-bold text-primary flex items-center gap-xs">
                    <TokenLogo symbol="USDC" className="size-5 shrink-0" />
                    <span>0.2 USDC <span className="text-xs font-normal text-tertiary">/ 0.2 USDC</span></span>
                  </div>
                </div>
                <span className="px-sm py-0.5 rounded-full text-xs font-semibold bg-utility-brand-50 text-brand-primary border border-utility-brand-200">
                  100% Fully Funded
                </span>
              </div>

              {/* Progress bar */}
              <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
                <div className="h-full bg-brand-solid rounded-full w-full" />
              </div>

              {/* Roster preview */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm pt-xs">
                <div className="flex items-center justify-between p-sm rounded-lg bg-secondary/40 border border-secondary text-xs">
                  <div className="flex items-center gap-xs">
                    <div className="size-6 rounded-full bg-utility-brand-500 text-white font-bold flex items-center justify-center text-[10px]">I</div>
                    <span className="font-semibold text-primary">Israel</span>
                  </div>
                  <span className="font-semibold text-utility-success-700">0.1 USDC · Verified</span>
                </div>
                <div className="flex items-center justify-between p-sm rounded-lg bg-secondary/40 border border-secondary text-xs">
                  <div className="flex items-center gap-xs">
                    <div className="size-6 rounded-full bg-purple-500 text-white font-bold flex items-center justify-center text-[10px]">D</div>
                    <span className="font-semibold text-primary">Daniel</span>
                  </div>
                  <span className="font-semibold text-utility-success-700">0.1 USDC · Verified</span>
                </div>
              </div>
            </div>

            {/* Non-custodial banner */}
            <div className="flex items-center justify-between text-xs text-secondary px-sm">
              <span className="flex items-center gap-xs">
                <ShieldCheck className="size-4 text-fg-brand-primary shrink-0" />
                <span>Move shared vault object on Sui Testnet. Members sign their own deposits and claims.</span>
              </span>
              <span className="font-mono text-tertiary text-[11px] hidden sm:inline">
                Tatum Gateway Verified
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 2. HOW IT WORKS */}
      <section id="how-it-works" className="space-y-2xl max-w-5xl mx-auto">
        <div className="text-center space-y-sm">
          <span className="text-xs sm:text-sm font-bold text-brand-primary uppercase tracking-wider">
            Clear Operational Workflow
          </span>
          <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-primary">
            How Ajo Savings Circles Work
          </h2>
          <p className="text-base sm:text-lg lg:text-xl text-secondary max-w-3xl mx-auto leading-relaxed">
            Every step is transparent. The app automates recordkeeping and payment verification,
            while members authorize all financial actions with their own Sui wallets.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-xl">
          {/* Step 1 */}
          <div className="rounded-xl border border-secondary bg-primary p-xl space-y-md shadow-xs hover:border-primary transition-colors">
            <div className="flex items-center justify-between">
              <span className="size-9 rounded-lg bg-utility-brand-50 border border-utility-brand-200 flex items-center justify-center font-bold text-base text-brand-primary">
                1
              </span>
              <span className="text-xs font-semibold text-tertiary">Step 1</span>
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Define Circle Rules</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Set the contribution amount, select the token (SUI or USDC), and choose the rotation cadence with automatic daylight-saving timezone alignment.
            </p>
          </div>

          {/* Step 2 */}
          <div className="rounded-xl border border-secondary bg-primary p-xl space-y-md shadow-xs hover:border-primary transition-colors">
            <div className="flex items-center justify-between">
              <span className="size-9 rounded-lg bg-utility-brand-50 border border-utility-brand-200 flex items-center justify-center font-bold text-base text-brand-primary">
                2
              </span>
              <span className="text-xs font-semibold text-tertiary">Step 2</span>
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Add Members & Payout Order</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Input member Sui wallet addresses and establish the fixed payout sequence so every member knows the exact cycle they will claim the pot.
            </p>
          </div>

          {/* Step 3 */}
          <div className="rounded-xl border border-secondary bg-primary p-xl space-y-md shadow-xs hover:border-primary transition-colors">
            <div className="flex items-center justify-between">
              <span className="size-9 rounded-lg bg-utility-brand-50 border border-utility-brand-200 flex items-center justify-center font-bold text-base text-brand-primary">
                3
              </span>
              <span className="text-xs font-semibold text-tertiary">Step 3</span>
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Commit to Walrus Memory</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Save the confirmed circle agreement to Walrus Mainnet. The public Walrus Blob ID serves as a reference for semantic recall and group context across sessions.
            </p>
          </div>

          {/* Step 4 */}
          <div className="rounded-xl border border-secondary bg-primary p-xl space-y-md shadow-xs hover:border-primary transition-colors">
            <div className="flex items-center justify-between">
              <span className="size-9 rounded-lg bg-utility-brand-50 border border-utility-brand-200 flex items-center justify-center font-bold text-base text-brand-primary">
                4
              </span>
              <span className="text-xs font-semibold text-tertiary">Step 4</span>
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Sign Member Deposits</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              When a cycle opens, members sign a wallet transaction depositing their exact contribution into the circle’s Move shared vault object on Sui Testnet. No third party ever holds custody.
            </p>
          </div>

          {/* Step 5 */}
          <div className="rounded-xl border border-secondary bg-primary p-xl space-y-md shadow-xs hover:border-primary transition-colors">
            <div className="flex items-center justify-between">
              <span className="size-9 rounded-lg bg-utility-brand-50 border border-utility-brand-200 flex items-center justify-center font-bold text-base text-brand-primary">
                5
              </span>
              <span className="text-xs font-semibold text-tertiary">Step 5</span>
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">On-Chain Tatum Gateway Verification</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Tatum Gateway queries Sui Testnet transaction blocks and balance changes to verify on-chain payment evidence in real time. Tatum does not hold funds or sign transactions.
            </p>
          </div>

          {/* Step 6 */}
          <div className="rounded-xl border border-secondary bg-primary p-xl space-y-md shadow-xs hover:border-primary transition-colors">
            <div className="flex items-center justify-between">
              <span className="size-9 rounded-lg bg-utility-brand-50 border border-utility-brand-200 flex items-center justify-center font-bold text-base text-brand-primary">
                6
              </span>
              <span className="text-xs font-semibold text-tertiary">Step 6</span>
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Claim Payouts Directly</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              The scheduled recipient claims the accumulated cycle pot by signing a MoveCall to the shared vault object on Sui Testnet, advancing rotation to the next cycle.
            </p>
          </div>
        </div>

        {/* Clear automated vs signature box */}
        <div className="rounded-xl border border-utility-brand-200 bg-utility-brand-50/50 p-xl text-sm sm:text-base space-y-sm">
          <div className="flex items-center gap-xs font-bold text-brand-primary text-base sm:text-lg">
            <ShieldCheck className="size-5 shrink-0" />
            <span>Transparency Guarantee: Automated vs. Wallet-Authorized Actions</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-md text-secondary pt-xxs">
            <div className="leading-relaxed">
              <strong className="text-primary font-semibold">Automated by the App:</strong> Tatum Gateway transaction verification queries, cycle deadline countdowns, and rotation advancement checks.
            </div>
            <div className="leading-relaxed">
              <strong className="text-primary font-semibold">Requires Member Wallet Signatures:</strong> Deploying the Move vault object, depositing contribution funds, approving circle terms, and claiming payouts.
            </div>
          </div>
        </div>
      </section>

      {/* 3. WHY USE IT / PROBLEM & SOLUTION */}
      <section className="space-y-2xl max-w-5xl mx-auto">
        <div className="text-center space-y-sm">
          <span className="text-xs sm:text-sm font-bold text-brand-primary uppercase tracking-wider">
            Real Problems Solved
          </span>
          <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-primary">
            Why Traditional Savings Circles Switch
          </h2>
          <p className="text-base sm:text-lg lg:text-xl text-secondary max-w-3xl mx-auto leading-relaxed">
            Eliminate forgotten promises, screenshot disputes, and the heavy manual recordkeeping burden carried by group organizers.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-xl">
          {/* Problem 1 */}
          <div className="rounded-xl border border-secondary bg-primary p-xl space-y-md shadow-xs">
            <div className="p-xs rounded-lg bg-utility-error-50 text-utility-error-700 w-fit">
              <FileText className="size-5" />
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Forgotten Group Agreements</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              In traditional groups, rules discussed in WhatsApp or Telegram chats get buried. When disputes arise over deadlines or payout orders, there is no single source of truth.
            </p>
            <div className="pt-xs border-t border-secondary text-sm font-semibold text-brand-primary">
              ✓ Stored in Walrus Memory with verifiable Blob ID references for semantic recall.
            </div>
          </div>

          {/* Problem 2 */}
          <div className="rounded-xl border border-secondary bg-primary p-xl space-y-md shadow-xs">
            <div className="p-xs rounded-lg bg-utility-warning-50 text-utility-warning-700 w-fit">
              <Clock className="size-5" />
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Organizer Bookkeeping Burnout</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Circle leaders spend hours tracking bank alerts, reconciling spreadsheets, and sending awkward reminders to members who forgot to pay on time.
            </p>
            <div className="pt-xs border-t border-secondary text-sm font-semibold text-brand-primary">
              ✓ Checked through Tatum Gateway querying on-chain Sui Testnet transactions.
            </div>
          </div>

          {/* Problem 3 */}
          <div className="rounded-xl border border-secondary bg-primary p-xl space-y-md shadow-xs">
            <div className="p-xs rounded-lg bg-utility-brand-50 text-utility-brand-700 w-fit">
              <Lock className="size-5" />
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Receipt Disputes & Custody Risk</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Self-reported receipts and screenshots can be faked or delayed. Centralized organizers holding all funds pose an accidental loss or default risk.
            </p>
            <div className="pt-xs border-t border-secondary text-sm font-semibold text-brand-primary">
              ✓ Non-custodial Sui Move shared vault objects with wallet-signed claims.
            </div>
          </div>
        </div>

        {/* Boundary Disclosures */}
        <div className="rounded-xl border border-secondary bg-secondary/30 p-xl text-sm sm:text-base text-secondary space-y-sm">
          <p className="font-bold text-primary text-base sm:text-lg">Cryptographic Trust Boundaries:</p>
          <ul className="list-disc list-inside space-y-xs text-secondary leading-relaxed">
            <li>Walrus preserves verified agreements; it does not custody tokens, guarantee member repayment, or force off-chain actions.</li>
            <li>Tatum Gateway queries the Sui blockchain for verifiable evidence; it never touches user funds or executes transactions.</li>
            <li>Members maintain 100% custody of their private keys and assets at all times.</li>
          </ul>
        </div>
      </section>

      {/* 4. FEATURE OVERVIEW */}
      <section className="space-y-xl max-w-5xl mx-auto">
        <div className="text-center space-y-xs">
          <span className="text-xs sm:text-sm font-bold text-brand-primary uppercase tracking-wider">
            Existing Capabilities
          </span>
          <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-primary">
            Built for Real Circle Operations
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-md">
          {/* Feature 1 */}
          <div
            onClick={() => onNavigateTab('dashboard')}
            className="rounded-xl border border-secondary bg-primary p-xl space-y-sm hover:border-primary cursor-pointer transition-all shadow-xs group"
          >
            <div className="flex items-center justify-between">
              <div className="size-10 rounded-lg bg-utility-brand-50 flex items-center justify-center text-brand-primary">
                <ShieldCheck className="size-5" />
              </div>
              <ArrowRight className="size-4 text-tertiary group-hover:text-primary transition-colors" />
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Non-Custodial Move Vaults</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Shared Sui objects enforce deposit limits, contribution deadlines, and recipient claim authorizations on-chain.
            </p>
          </div>

          {/* Feature 2 */}
          <div
            onClick={() => onNavigateTab('dashboard')}
            className="rounded-xl border border-secondary bg-primary p-xl space-y-sm hover:border-primary cursor-pointer transition-all shadow-xs group"
          >
            <div className="flex items-center justify-between">
              <div className="size-10 rounded-lg bg-utility-brand-50 flex items-center justify-center text-brand-primary">
                <CheckCircle2 className="size-5" />
              </div>
              <ArrowRight className="size-4 text-tertiary group-hover:text-primary transition-colors" />
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Real-Time Verification</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Tatum Gateway queries Sui transaction digests, balance changes, and Move events with retry backoff.
            </p>
          </div>

          {/* Feature 3 */}
          <div
            onClick={() => onNavigateTab('memories')}
            className="rounded-xl border border-secondary bg-primary p-xl space-y-sm hover:border-primary cursor-pointer transition-all shadow-xs group"
          >
            <div className="flex items-center justify-between">
              <div className="size-10 rounded-lg bg-utility-brand-50 flex items-center justify-center text-brand-primary">
                <Brain className="size-5" />
              </div>
              <ArrowRight className="size-4 text-tertiary group-hover:text-primary transition-colors" />
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Walrus Memory Store</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Recalls confirmed circle agreements, grace rules, and payment policies from permanent Walrus blobs.
            </p>
          </div>

          {/* Feature 4 */}
          <div
            onClick={() => onNavigateTab('chat')}
            className="rounded-xl border border-secondary bg-primary p-xl space-y-sm hover:border-primary cursor-pointer transition-all shadow-xs group"
          >
            <div className="flex items-center justify-between">
              <div className="size-10 rounded-lg bg-utility-brand-50 flex items-center justify-center text-brand-primary">
                <MessageSquare className="size-5" />
              </div>
              <ArrowRight className="size-4 text-tertiary group-hover:text-primary transition-colors" />
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">AI Steward Intelligence</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Evaluates member lateness against past grace agreements and provides advisory payout recommendations.
            </p>
          </div>

          {/* Feature 5 */}
          <div
            onClick={() => onNavigateTab('payout')}
            className="rounded-xl border border-secondary bg-primary p-xl space-y-sm hover:border-primary cursor-pointer transition-all shadow-xs group"
          >
            <div className="flex items-center justify-between">
              <div className="size-10 rounded-lg bg-utility-brand-50 flex items-center justify-center text-brand-primary">
                <Sparkles className="size-5" />
              </div>
              <ArrowRight className="size-4 text-tertiary group-hover:text-primary transition-colors" />
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Payout Claims & Rotation</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Scheduled recipients claim the pot directly into their wallets; Move contracts advance cycle numbers automatically.
            </p>
          </div>

          {/* Feature 6 */}
          <div
            onClick={() => onNavigateTab('circles')}
            className="rounded-xl border border-secondary bg-primary p-xl space-y-sm hover:border-primary cursor-pointer transition-all shadow-xs group"
          >
            <div className="flex items-center justify-between">
              <div className="size-10 rounded-lg bg-utility-brand-50 flex items-center justify-center text-brand-primary">
                <Layers className="size-5" />
              </div>
              <ArrowRight className="size-4 text-tertiary group-hover:text-primary transition-colors" />
            </div>
            <h4 className="text-base sm:text-lg font-bold text-primary">Multi-Circle Management</h4>
            <p className="text-sm sm:text-base text-secondary leading-relaxed">
              Create and participate in multiple distinct savings circles concurrently with independent tokens and rosters.
            </p>
          </div>
        </div>
      </section>

      {/* 5. TRADITIONAL AJO VS. AJO STEWARD COMPARISON */}
      <section className="space-y-xl max-w-5xl mx-auto">
        <div className="text-center space-y-xs">
          <span className="text-xs sm:text-sm font-bold text-brand-primary uppercase tracking-wider">
            Transparent Comparison
          </span>
          <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-primary">
            Traditional ajo vs. Ajo Steward
          </h2>
          <p className="text-base sm:text-lg text-secondary max-w-2xl mx-auto leading-relaxed">
            See how on-chain verification, non-custodial vaults, and decentralized Walrus Memory compare to an informal, collector-run savings circle.
          </p>
        </div>

        {/* Desktop Table View (md and up) */}
        <div className="hidden md:block rounded-2xl border border-secondary overflow-hidden bg-primary shadow-xs">
          <table className="w-full text-left border-collapse table-fixed">
            <thead>
              <tr className="border-b border-secondary">
                <th className="w-1/4 py-lg px-xl text-xs sm:text-sm font-bold text-secondary uppercase tracking-wider bg-secondary/40">
                  Area
                </th>
                <th className="w-[37.5%] py-lg px-xl text-xs sm:text-sm font-bold text-secondary uppercase tracking-wider bg-secondary/40">
                  Traditional savings circle
                </th>
                <th className="w-[37.5%] py-lg px-xl text-xs sm:text-sm font-bold text-brand-primary uppercase tracking-wider bg-utility-brand-50/70 border-l border-utility-brand-100">
                  With Ajo Steward
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-secondary/60">
              {COMPARISON_ROWS.map((row, idx) => (
                <tr key={idx} className="hover:bg-secondary/20 transition-colors">
                  <td className="py-lg px-xl text-sm sm:text-base font-bold text-primary align-top">
                    {row.area}
                  </td>
                  <td className="py-lg px-xl text-sm sm:text-base text-secondary leading-relaxed align-top">
                    {row.traditional}
                  </td>
                  <td className="py-lg px-xl text-sm sm:text-base text-primary font-medium leading-relaxed align-top bg-utility-brand-50/20 border-l border-utility-brand-100">
                    <div className="flex items-start gap-xs">
                      <Check className="size-4 text-brand-primary shrink-0 mt-1" />
                      <span>{row.ajoSteward}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile Stacked Card View (< md) */}
        <div className="block md:hidden space-y-md">
          {COMPARISON_ROWS.map((row, idx) => (
            <div
              key={idx}
              className="rounded-xl border border-secondary bg-primary p-lg space-y-sm shadow-xs"
            >
              <h4 className="text-base font-bold text-primary border-b border-secondary pb-xs">
                {row.area}
              </h4>
              <div className="space-y-xs text-sm">
                <div className="rounded-lg bg-secondary/40 p-md space-y-xxs">
                  <span className="text-[11px] font-bold text-tertiary uppercase tracking-wider">
                    Traditional savings circle
                  </span>
                  <p className="text-secondary leading-relaxed">{row.traditional}</p>
                </div>
                <div className="rounded-lg bg-utility-brand-50/60 border border-utility-brand-200 p-md space-y-xxs">
                  <span className="text-[11px] font-bold text-brand-primary uppercase tracking-wider">
                    With Ajo Steward
                  </span>
                  <div className="flex items-start gap-xs pt-xxs">
                    <Check className="size-4 text-brand-primary shrink-0 mt-0.5" />
                    <p className="text-primary font-medium leading-relaxed">{row.ajoSteward}</p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 6. TRUST & NETWORK STATUS */}
      <section className="max-w-5xl mx-auto rounded-2xl border border-secondary bg-primary p-xl sm:p-2xl space-y-md shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-md pb-md border-b border-secondary">
          <div>
            <h3 className="text-base sm:text-lg font-bold text-primary">Configured Network & Protocol Integrity</h3>
            <p className="text-sm sm:text-base text-secondary mt-xxs">
              Live status confirmed via direct API queries. No synthetic or simulated metrics.
            </p>
          </div>
          <span className="inline-flex items-center gap-xs px-sm py-1 rounded-full text-xs sm:text-sm font-semibold bg-utility-warning-50 text-utility-warning-800 border border-utility-warning-200">
            <AlertCircle className="size-4 shrink-0" />
            <span>Testnet Environment (No monetary value)</span>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-md text-xs sm:text-sm">
          <div className="p-lg rounded-lg bg-secondary/40 border border-secondary space-y-xs">
            <span className="text-tertiary text-xs sm:text-sm">Active Chain & Network</span>
            <p className="text-base sm:text-lg font-bold text-primary uppercase">{networkName || 'Sui Testnet'}</p>
            <p className="text-xs sm:text-sm text-secondary leading-relaxed">Tokens (SUI, USDC) are testnet assets on Sui Testnet.</p>
          </div>
          <div className="p-lg rounded-lg bg-secondary/40 border border-secondary space-y-xs">
            <span className="text-tertiary text-xs sm:text-sm">Verification Gateway</span>
            <p className="text-base sm:text-lg font-bold text-primary">{isRpcConnected ? 'Tatum Sui Gateway Active' : 'Connecting to Tatum...'}</p>
            <p className="text-xs sm:text-sm text-secondary leading-relaxed">Queries Sui Testnet fullnodes for balance changes and events (no custody).</p>
          </div>
          <div className="p-lg rounded-lg bg-secondary/40 border border-secondary space-y-xs">
            <span className="text-tertiary text-xs sm:text-sm">Decentralized Agreement Storage</span>
            <p className="text-base sm:text-lg font-bold text-primary">{isWalrusConnected ? 'Walrus Protocol Active' : 'Walrus Offline'}</p>
            <p className="text-xs sm:text-sm text-secondary leading-relaxed">Stores circle agreements on Walrus Mainnet for semantic recall across sessions.</p>
          </div>
        </div>
      </section>

      {/* 7. FINAL CALL TO ACTION */}
      <section className="max-w-4xl mx-auto rounded-2xl border-2 border-utility-brand-300 bg-gradient-to-b from-utility-brand-50/60 to-primary p-2xl sm:p-3xl text-center space-y-lg shadow-md">
        <div className="max-w-2xl mx-auto space-y-sm">
          <h3 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-primary">
            Ready to start a savings circle with your group?
          </h3>
          <p className="text-base sm:text-lg lg:text-xl text-secondary leading-relaxed">
            Create your circle in under 2 minutes, invite your members, and let Move smart contract vaults and Tatum Gateway handle verification.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-md pt-xs">
          <button
            type="button"
            onClick={() => onNavigateTab('create')}
            className="inline-flex items-center gap-xs rounded-xl bg-brand-solid px-2xl py-lg text-base sm:text-lg font-semibold text-primary-on-brand shadow-sm hover:bg-brand-solid-hover transition-colors"
          >
            <PlusCircle className="size-5 shrink-0" />
            <span>Create a circle</span>
          </button>

          <button
            type="button"
            onClick={onOpenTour}
            className="inline-flex items-center gap-xs rounded-xl bg-primary border border-secondary px-2xl py-lg text-base sm:text-lg font-semibold text-secondary hover:text-primary hover:bg-secondary shadow-xs transition-colors"
          >
            <Compass className="size-5 shrink-0" />
            <span>Take the guided tour</span>
          </button>

          {hasActiveCircle && (
            <button
              type="button"
              onClick={() => onNavigateTab('dashboard')}
              className="inline-flex items-center gap-xs rounded-xl bg-primary border border-secondary px-2xl py-lg text-base sm:text-lg font-semibold text-brand-primary hover:bg-secondary shadow-xs transition-colors"
            >
              <span>Go to dashboard</span>
              <ArrowRight className="size-5 shrink-0" />
            </button>
          )}
        </div>
      </section>

      {/* 8. FULL-WIDTH 4-COLUMN FOOTER */}
      <footer className="w-full pt-3xl border-t border-secondary text-sm text-secondary">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2xl pb-2xl">
          {/* Col 1: Ajo Steward */}
          <div className="space-y-sm">
            <div className="flex items-center gap-xs">
              <img
                src="/logo.png"
                alt="Ajo Steward"
                className="size-8 sm:size-9 object-contain shrink-0"
              />
              <span className="font-bold text-base text-primary">Ajo Steward</span>
            </div>
            <p className="text-sm text-secondary leading-relaxed">
              Non-custodial rotating savings circles (Ajo, Esusu, Tanda) powered by Sui Move shared vault objects on Sui Testnet and Walrus Memory for agreement persistence.
            </p>
            <div className="pt-xs text-xs text-tertiary">
              Built on Sui Move · Walrus Protocol · Tatum Gateway
            </div>
          </div>

          {/* Col 2: Product */}
          <div className="space-y-sm">
            <h4 className="font-semibold text-base text-primary">Product</h4>
            <ul className="space-y-sm">
              <li>
                <button
                  type="button"
                  onClick={() => onNavigateTab('circles')}
                  className="hover:text-primary transition-colors"
                >
                  Browse Circles
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onNavigateTab('create')}
                  className="hover:text-primary transition-colors"
                >
                  Create Circle
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onNavigateTab('dashboard')}
                  className="hover:text-primary transition-colors"
                >
                  Circle Dashboard
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onNavigateTab('payout')}
                  className="hover:text-primary transition-colors"
                >
                  Payout & Claims
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onNavigateTab('memories')}
                  className="hover:text-primary transition-colors"
                >
                  Walrus Memory
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onNavigateTab('chat')}
                  className="hover:text-primary transition-colors"
                >
                  Steward AI Chat
                </button>
              </li>
            </ul>
          </div>

          {/* Col 3: Resources */}
          <div className="space-y-sm">
            <h4 className="font-semibold text-base text-primary">Resources</h4>
            <ul className="space-y-sm">
              <li>
                <a
                  href="#how-it-works"
                  className="hover:text-primary transition-colors"
                >
                  How It Works
                </a>
              </li>
              <li>
                <button
                  type="button"
                  onClick={onOpenTour}
                  className="hover:text-primary transition-colors text-left"
                >
                  Take Guided Tour
                </button>
              </li>
              <li>
                <a
                  href="https://suiscan.xyz/testnet"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-xxs hover:text-primary transition-colors"
                >
                  <span>Sui Testnet Explorer</span>
                  <ExternalLink className="size-3.5" />
                </a>
              </li>
              <li>
                <a
                  href="https://docs.walrus.site"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-xxs hover:text-primary transition-colors"
                >
                  <span>Walrus Documentation</span>
                  <ExternalLink className="size-3.5" />
                </a>
              </li>
              <li>
                <a
                  href="https://tatum.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-xxs hover:text-primary transition-colors"
                >
                  <span>Tatum Sui Gateway</span>
                  <ExternalLink className="size-3.5" />
                </a>
              </li>
            </ul>
          </div>

          {/* Col 4: Account */}
          <div className="space-y-sm">
            <h4 className="font-semibold text-base text-primary">Account</h4>
            {currentAccountAddress ? (
              <div className="space-y-xs">
                <div className="p-sm rounded-lg bg-secondary/50 border border-secondary space-y-xxs">
                  <span className="text-xs text-tertiary">Connected Sui Wallet</span>
                  <p className="font-mono text-sm text-primary truncate">
                    {currentAccountAddress.slice(0, 10)}...{currentAccountAddress.slice(-6)}
                  </p>
                </div>
                {onDisconnectWallet && (
                  <button
                    type="button"
                    onClick={onDisconnectWallet}
                    className="w-full text-left text-xs sm:text-sm font-semibold text-error-primary hover:underline"
                  >
                    Disconnect Wallet
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-xs">
                <p className="text-sm text-secondary">
                  Connect your Sui wallet (Slush or any Wallet Standard) to participate in circles.
                </p>
                {onConnectWallet && (
                  <button
                    type="button"
                    onClick={onConnectWallet}
                    className="inline-flex items-center gap-xs px-md py-sm rounded-lg bg-brand-solid text-sm font-semibold text-primary-on-brand hover:bg-brand-solid-hover transition-colors shadow-xs"
                  >
                    <Wallet className="size-4" />
                    <span>Connect Wallet</span>
                  </button>
                )}
              </div>
            )}
            <div className="pt-xs text-xs text-tertiary">
              Status: <span className="text-primary font-medium">{networkName || 'Sui Testnet'}</span>
            </div>
          </div>
        </div>

        {/* Bottom divider and copyright */}
        <div className="pt-lg border-t border-secondary flex flex-col sm:flex-row sm:items-center justify-between gap-sm text-xs text-tertiary">
          <p>© {new Date().getFullYear()} Ajo Steward. Non-custodial, open decentralized protocol.</p>
          <p>Educational Testnet deployment · Members maintain complete key custody.</p>
        </div>
      </footer>
    </div>
  )
}
