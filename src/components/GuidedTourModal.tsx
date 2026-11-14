import React, { useState, useEffect, useCallback } from 'react'
import {
  X,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Sparkles,
  Layers,
  PlusCircle,
  Coins,
  Brain,
  ShieldCheck,
  Compass,
  FileText,
} from 'lucide-react'

export interface TourStep {
  title: string
  subtitle: string
  icon: React.ComponentType<{ className?: string }>
  badge: string
  description: string
  automatedNote?: string
  signatureNote?: string
  boundaryNote?: string
  suggestedAction?: {
    label: string
    tab: 'dashboard' | 'circles' | 'create' | 'chat' | 'memories' | 'payout'
  }
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: 'Welcome to Ajo Steward',
    subtitle: 'Verifiable, Non-Custodial Rotating Savings on Sui & Walrus',
    icon: Compass,
    badge: 'Overview',
    description:
      'Ajo Steward modernizes traditional rotating savings groups (Ajo, Esusu, Tanda). It removes the organizer’s recordkeeping burden by securing agreements on Walrus and verifying real member payments directly on the Sui blockchain.',
    boundaryNote:
      'The platform never holds custody of user funds or private keys. All transactions are authorized directly by members from their own connected Sui wallets on Sui Testnet.',
  },
  {
    title: 'Step 1: Create a Circle & Set Rotation Rules',
    subtitle: 'Define Contribution Amount, Token & Cadence',
    icon: PlusCircle,
    badge: 'Step 1 of 5',
    description:
      'Circle organizers configure the circle name, contribution token (SUI or USDC), rotation frequency (Daily, Weekly, Monthly, or 5-Minute Demo), and optional Circle Rules & Guidelines for the AI Steward. Wall-clock deadlines stay aligned across daylight-saving transitions in your chosen time zone.',
    automatedNote: 'Cycle deadlines and cadence durations are computed automatically.',
    signatureNote: 'The organizer signs 1 wallet transaction to deploy the Move shared vault object on Sui Testnet.',
    suggestedAction: {
      label: 'Open Circle Creator',
      tab: 'create',
    },
  },
  {
    title: 'Step 2: Add Members & Sequence Payouts',
    subtitle: 'Transparent Member Roster & Payout Order',
    icon: Layers,
    badge: 'Step 2 of 5',
    description:
      'Add participating member Sui wallet addresses and determine the exact payout order. Every participant knows in advance which cycle they are scheduled to receive the collective pot.',
    signatureNote: 'The organizer sets the roster during circle creation; members sign their own deposits when contributing.',
    suggestedAction: {
      label: 'View Circles & Rosters',
      tab: 'circles',
    },
  },
  {
    title: 'Step 3: Preserve Agreement to Walrus Memory',
    subtitle: 'Immutable, Cryptographically Verifiable Terms',
    icon: Brain,
    badge: 'Step 3 of 5',
    description:
      'Once rules are set, the circle agreement is saved to Walrus Mainnet. The public cryptographic Blob ID serves as a reference for semantic recall and group context across sessions.',
    boundaryNote:
      'Walrus stores agreement records for semantic recall across sessions; it does not custody tokens, verify blockchain transactions, or enforce group compliance.',
    suggestedAction: {
      label: 'Inspect Walrus Memories',
      tab: 'memories',
    },
  },
  {
    title: 'Step 4: Direct Non-Custodial Contributions',
    subtitle: 'Members Sign Deposits · Tatum Verifies On-Chain',
    icon: Coins,
    badge: 'Step 4 of 5',
    description:
      'When a cycle opens, members sign a wallet transaction depositing their contribution directly into the circle’s Move shared vault on Sui Testnet. Tatum Gateway queries transaction blocks and balance changes in real time to verify payment evidence without manual screenshots.',
    automatedNote: 'Tatum verifies cryptographic on-chain evidence automatically.',
    signatureNote: 'Members authorize their own deposits directly from their wallets.',
    boundaryNote:
      'Tatum queries Sui Testnet transaction blocks to verify payment evidence; it does not custody funds, sign transactions, or guarantee off-chain payment completion.',
    suggestedAction: {
      label: 'View Circle Dashboard',
      tab: 'dashboard',
    },
  },
  {
    title: 'Step 5: Payout Distribution & Contract Claims',
    subtitle: 'Scheduled Recipient Claims Directly to Wallet',
    icon: Sparkles,
    badge: 'Step 5 of 5',
    description:
      'When all members have contributed (or once the cycle deadline passes), the scheduled recipient claims the pot directly into their Sui wallet by signing an on-chain MoveCall, which advances rotation to the next cycle.',
    signatureNote: 'The scheduled recipient signs 1 transaction in their wallet to claim the accumulated cycle pot.',
    suggestedAction: {
      label: 'View Payout Page',
      tab: 'payout',
    },
  },
]

export interface GuidedTourModalProps {
  isOpen: boolean
  onClose: () => void
  onNavigateTab: (tabId: 'dashboard' | 'circles' | 'create' | 'chat' | 'memories' | 'payout') => void
  hasActiveCircle?: boolean
  activeCircleName?: string
}

export const GuidedTourModal: React.FC<GuidedTourModalProps> = ({
  isOpen,
  onClose,
  onNavigateTab,
  hasActiveCircle,
  activeCircleName,
}) => {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)

  // Handle keyboard navigation (Escape to close, Left/Right arrows to navigate)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowRight') {
        if (currentStepIndex < TOUR_STEPS.length - 1) {
          setCurrentStepIndex((prev) => prev + 1)
        }
      } else if (e.key === 'ArrowLeft') {
        if (currentStepIndex > 0) {
          setCurrentStepIndex((prev) => prev - 1)
        }
      }
    },
    [isOpen, currentStepIndex, onClose]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  if (!isOpen) return null

  const step = TOUR_STEPS[currentStepIndex]
  const Icon = step.icon
  const isFirst = currentStepIndex === 0
  const isLast = currentStepIndex === TOUR_STEPS.length - 1

  const handleNext = () => {
    if (isLast) {
      onClose()
    } else {
      setCurrentStepIndex((prev) => prev + 1)
    }
  }

  const handleBack = () => {
    if (!isFirst) {
      setCurrentStepIndex((prev) => prev - 1)
    }
  }

  const handleTakeAction = (tab: 'dashboard' | 'circles' | 'create' | 'chat' | 'memories' | 'payout') => {
    onClose()
    onNavigateTab(tab)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-md bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-modal-title"
    >
      <div className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl bg-primary border border-secondary shadow-2xl p-xl sm:p-2xl space-y-lg">
        {/* Top Header Row: Badge, Close Button */}
        <div className="flex items-center justify-between border-b border-secondary pb-md">
          <div className="flex items-center gap-xs">
            <span className="px-sm py-0.5 rounded-full text-xs font-semibold bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200">
              Step {currentStepIndex + 1} of {TOUR_STEPS.length}
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-xs text-tertiary hover:text-primary hover:bg-secondary transition-colors"
            aria-label="Close tour"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-secondary rounded-full h-1.5 overflow-hidden">
          <div
            className="bg-brand-solid h-full transition-all duration-300 ease-out rounded-full"
            style={{ width: `${((currentStepIndex + 1) / TOUR_STEPS.length) * 100}%` }}
          />
        </div>

        {/* Step Content */}
        <div className="space-y-md">
          <div className="flex items-start gap-md">
            <div className="size-12 rounded-xl bg-utility-brand-50 border border-utility-brand-200 flex items-center justify-center shrink-0 text-brand-primary">
              <Icon className="size-6 text-fg-brand-primary" />
            </div>
            <div>
              <h3 id="tour-modal-title" className="text-xl font-bold text-primary">
                {step.title}
              </h3>
              <p className="text-sm text-secondary mt-xxs font-medium">{step.subtitle}</p>
            </div>
          </div>

          <p className="text-base text-secondary leading-relaxed">{step.description}</p>

          {/* Context Callout Boxes */}
          {(step.automatedNote || step.signatureNote || step.boundaryNote) && (
            <div className="space-y-xs pt-xs">
              {step.automatedNote && (
                <div className="flex items-start gap-xs p-sm rounded-lg bg-secondary/60 border border-secondary text-xs sm:text-sm text-secondary">
                  <span className="font-semibold text-primary shrink-0">Automated:</span>
                  <span>{step.automatedNote}</span>
                </div>
              )}
              {step.signatureNote && (
                <div className="flex items-start gap-xs p-sm rounded-lg bg-utility-brand-50/70 border border-utility-brand-200 text-xs sm:text-sm text-utility-brand-800">
                  <span className="font-semibold text-brand-primary shrink-0">Wallet Signature:</span>
                  <span>{step.signatureNote}</span>
                </div>
              )}
              {step.boundaryNote && (
                <div className="flex items-start gap-xs p-sm rounded-lg bg-secondary/80 border border-secondary text-xs sm:text-sm text-tertiary">
                  <ShieldCheck className="size-4 text-fg-quaternary shrink-0 mt-0.5" />
                  <span>{step.boundaryNote}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom Actions Footer */}
        <div className="pt-md border-t border-secondary flex items-center justify-between gap-sm flex-wrap">
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-tertiary hover:text-primary font-medium transition-colors"
          >
            Skip tour
          </button>

          <div className="flex items-center gap-xs">
            {step.suggestedAction && (
              <button
                type="button"
                onClick={() => handleTakeAction(step.suggestedAction!.tab)}
                className="hidden sm:inline-flex items-center gap-xs px-md py-sm rounded-lg text-xs font-semibold text-brand-primary bg-utility-brand-50 border border-utility-brand-200 hover:bg-utility-brand-100 transition-colors"
              >
                <span>{step.suggestedAction.label}</span>
                <ArrowRight className="size-3" />
              </button>
            )}

            {!isFirst && (
              <button
                type="button"
                onClick={handleBack}
                className="inline-flex items-center gap-xs px-md py-sm rounded-lg text-xs font-semibold text-secondary bg-primary border border-primary hover:bg-secondary transition-colors"
              >
                <ArrowLeft className="size-3.5" />
                <span>Back</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleNext}
              className="inline-flex items-center gap-xs px-lg py-sm rounded-lg text-xs font-semibold text-primary-on-brand bg-brand-solid hover:bg-brand-solid-hover shadow-xs transition-colors"
            >
              <span>{isLast ? 'Finish Tour' : 'Next'}</span>
              <ArrowRight className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
