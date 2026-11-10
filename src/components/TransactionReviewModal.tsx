import React from 'react'
import {
  AlertTriangle,
  Loader2,
  ExternalLink,
  CheckCircle2,
  X,
  ArrowRight,
  Wallet,
  Clock,
  RotateCcw,
} from 'lucide-react'
import { TokenConfig } from '../services/tokens'
import { TokenLogo } from './TokenLogo'
import { ExplorerLink } from './ExplorerLink'

export interface TransactionReviewProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
  onRetryVerification?: () => Promise<void>
  verificationPending?: boolean
  verificationNotes?: string | null
  isVerifying?: boolean
  actionTitle: string
  actionDescription: string
  circleName: string
  circleId: string
  destinationObjectId?: string
  token: TokenConfig | null
  amountDisplay?: string
  amountBase?: bigint | string | number
  currentCycle?: number
  totalCycles?: number
  recipientAddress?: string
  recipientName?: string
  isSubmitting: boolean
  isSuccess: boolean
  txDigest?: string | null
  errorMessage?: string | null
  network: string
  walletBalanceDisplay?: string
  isBalanceInsufficient?: boolean
  balanceErrorMessage?: string | null
  senderAddress?: string
  isMoveVault?: boolean
}

export const TransactionReviewModal: React.FC<TransactionReviewProps> = ({
  isOpen,
  onClose,
  onConfirm,
  onRetryVerification,
  verificationPending = false,
  verificationNotes = null,
  isVerifying = false,
  actionTitle,
  actionDescription,
  circleName,
  circleId,
  destinationObjectId,
  token,
  amountDisplay,
  amountBase,
  currentCycle,
  totalCycles,
  recipientAddress,
  recipientName,
  isSubmitting,
  isSuccess,
  txDigest,
  errorMessage,
  network,
  walletBalanceDisplay,
  isBalanceInsufficient = false,
  balanceErrorMessage,
  senderAddress,
  isMoveVault = false,
}) => {
  if (!isOpen) return null

  const explorerBase =
    network === 'mainnet'
      ? 'https://suiscan.xyz/mainnet/tx'
      : 'https://suiscan.xyz/testnet/tx'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-md sm:p-lg bg-backdrop/80 backdrop-blur-xs">
      <div className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-xl border border-secondary bg-primary shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header - Fixed */}
        <div className="p-lg sm:p-xl border-b border-secondary flex items-center justify-between bg-primary shrink-0">
          <div className="flex items-center gap-md min-w-0">
            <img
              src="/logo.png"
              alt="Ajo Steward"
              className="size-10 sm:size-11 object-contain shrink-0"
            />
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-primary truncate">{actionTitle}</h3>
              <p className="text-xs text-secondary truncate">{actionDescription}</p>
            </div>
          </div>
          {!isSubmitting && (
            <button
              onClick={onClose}
              className="text-tertiary hover:text-primary p-xs rounded-lg hover:bg-secondary transition-colors shrink-0 ml-sm"
              aria-label="Close modal"
            >
              <X className="size-5" />
            </button>
          )}
        </div>

        {/* Content Body - Scrollable */}
        <div className="p-lg sm:p-xl space-y-lg overflow-y-auto flex-1 min-h-0">
          {/* Success / Pending State */}
          {isSuccess && txDigest ? (
            <div
              className={`p-lg rounded-xl border space-y-md text-center ${
                verificationPending
                  ? 'bg-utility-warning-50 border-utility-warning-200'
                  : 'bg-utility-success-50 border-utility-success-200'
              }`}
            >
              <div
                className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center ${
                  verificationPending
                    ? 'bg-utility-warning-100 text-utility-warning-700'
                    : 'bg-utility-success-100 text-utility-success-700'
                }`}
              >
                {verificationPending ? (
                  <Clock className="size-6 text-fg-warning-primary shrink-0" />
                ) : (
                  <CheckCircle2 className="size-6 text-fg-success-primary shrink-0" />
                )}
              </div>
              <div>
                <h4
                  className={`text-sm font-semibold ${
                    verificationPending ? 'text-utility-warning-700' : 'text-utility-success-700'
                  }`}
                >
                  {verificationPending
                    ? 'Transaction Broadcast — Verification Pending'
                    : 'Transaction Confirmed & Verified on Sui'}
                </h4>
                <p className="text-xs text-secondary mt-xs">
                  {verificationPending
                    ? verificationNotes ||
                      'The on-chain transaction completed on Sui. Tatum Gateway is currently indexing the block. You can retry verification now or check back shortly.'
                    : 'The on-chain transaction completed and was verified successfully.'}
                </p>
              </div>
              <div className="pt-sm border-t border-utility-secondary flex flex-col items-center gap-xs">
                {txDigest && (
                  <div className="inline-flex items-center gap-xs text-xs">
                    <span className="text-tertiary">Tx Digest:</span>
                    <ExplorerLink
                      type="tx"
                      value={txDigest}
                      network={network}
                      shorten={true}
                      showCopy={true}
                    />
                  </div>
                )}
                {verificationPending && onRetryVerification && (
                  <button
                    type="button"
                    onClick={onRetryVerification}
                    disabled={isVerifying}
                    className="mt-xs inline-flex items-center gap-xs px-md py-xs rounded-lg bg-primary border border-secondary text-xs font-semibold text-primary hover:bg-secondary transition-colors"
                  >
                    {isVerifying ? (
                      <>
                        <Loader2 className="size-3 animate-spin shrink-0 text-fg-warning-primary" />
                        <span>Checking Tatum Gateway...</span>
                      </>
                    ) : (
                      <>
                        <RotateCcw className="size-3 shrink-0 text-fg-quaternary" />
                        <span>Retry Verification</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Pre-flight Insufficient Balance Alert */}
              {isBalanceInsufficient && (
                <div className="p-md rounded-lg bg-utility-warning-50 border border-utility-warning-200 flex items-start gap-sm">
                  <AlertTriangle className="size-4 text-warning-primary shrink-0 mt-0.5" />
                  <div className="space-y-xs min-w-0">
                    <p className="text-xs font-semibold text-warning-primary">Insufficient Balance for Transaction</p>
                    <p className="text-xs text-secondary leading-relaxed break-words">
                      {balanceErrorMessage ||
                        `Your connected wallet holds ${walletBalanceDisplay || '0'}, which is insufficient for the required ${amountDisplay}.`}
                    </p>
                  </div>
                </div>
              )}

              {/* Transaction Spec Details Table */}
              <div className="rounded-lg border border-secondary bg-secondary/30 divide-y divide-secondary text-xs">
                <div className="p-md flex items-center justify-between gap-sm">
                  <span className="text-tertiary shrink-0">Circle</span>
                  <span className="font-semibold text-primary truncate text-right">{circleName}</span>
                </div>

                {currentCycle !== undefined && (
                  <div className="p-md flex items-center justify-between gap-sm">
                    <span className="text-tertiary shrink-0">Cycle Window</span>
                    <span className="font-semibold text-primary text-right">
                      Cycle {currentCycle} {totalCycles ? `of ${totalCycles}` : ''}
                    </span>
                  </div>
                )}

                {senderAddress && (
                  <div className="p-md flex items-center justify-between gap-sm">
                    <span className="text-tertiary shrink-0">Signing Wallet</span>
                    <ExplorerLink
                      type="address"
                      value={senderAddress}
                      network={network}
                      shorten={true}
                      showCopy={true}
                    />
                  </div>
                )}

                {destinationObjectId && (
                  <div className="p-md flex items-center justify-between gap-sm">
                    <span className="text-tertiary shrink-0">Destination Vault</span>
                    <ExplorerLink
                      type="object"
                      value={destinationObjectId}
                      network={network}
                      shorten={true}
                      showCopy={true}
                    />
                  </div>
                )}

                {token && (
                  <div className="p-md space-y-xs">
                    <div className="flex items-center justify-between gap-sm">
                      <span className="text-tertiary shrink-0">Configured Token</span>
                      <div className="inline-flex items-center gap-xs font-semibold text-brand-primary">
                        <TokenLogo symbol={token.symbol} className="size-4 shrink-0" />
                        <span>{token.symbol} ({token.decimals} decimals)</span>
                      </div>
                    </div>
                    <div className="p-xs rounded border border-secondary bg-primary/70 overflow-hidden max-w-full break-all">
                      <ExplorerLink
                        type="coin"
                        value={token.coinType}
                        network={network}
                        shorten={false}
                        showCopy={true}
                      />
                    </div>
                  </div>
                )}

                {walletBalanceDisplay && (
                  <div className="p-md flex items-center justify-between gap-sm bg-primary/20">
                    <span className="text-tertiary shrink-0 flex items-center gap-xs">
                      <Wallet className="size-3.5" />
                      <span>Wallet Balance</span>
                    </span>
                    <span className={`font-semibold tabular-nums text-right ${isBalanceInsufficient ? 'text-utility-error-600' : 'text-primary'}`}>
                      {walletBalanceDisplay}
                    </span>
                  </div>
                )}

                {amountDisplay && (
                  <div className="p-md flex items-center justify-between gap-sm bg-primary/40">
                    <span className="text-secondary font-medium shrink-0">Exact Amount Due</span>
                    <div className="text-right">
                      <div className="text-sm font-bold text-primary tabular-nums">
                        {amountDisplay}
                      </div>
                      {amountBase !== undefined && (
                        <div className="text-[10px] text-tertiary tabular-nums font-mono">
                          {amountBase.toString()} base units
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {recipientAddress && (
                  <div className="p-md flex items-center justify-between gap-sm">
                    <span className="text-tertiary shrink-0">Scheduled Recipient</span>
                    <div className="text-right min-w-0">
                      {recipientName && (
                        <div className="font-semibold text-primary truncate">{recipientName}</div>
                      )}
                      <ExplorerLink
                        type="address"
                        value={recipientAddress}
                        network={network}
                        shorten={true}
                        showCopy={true}
                      />
                    </div>
                  </div>
                )}

                <div className="p-md flex items-center justify-between gap-sm">
                  <span className="text-tertiary shrink-0">Target Network</span>
                  <span className="inline-flex items-center gap-xs font-semibold text-primary">
                    <span className="w-2 h-2 rounded-full bg-success-primary shrink-0" />
                    Sui {network.toUpperCase()}
                  </span>
                </div>
              </div>

              {/* Error Alert with Scrollable Body */}
              {errorMessage && (
                <div className="p-md rounded-lg bg-utility-error-50 border border-error-subtle flex items-start gap-sm">
                  <AlertTriangle className="size-4 text-error-primary shrink-0 mt-0.5" />
                  <div className="space-y-xs min-w-0 flex-1">
                    <p className="text-xs font-semibold text-error-primary">Transaction Failed</p>
                    <div className="text-xs text-error-primary/90 leading-relaxed break-all max-h-36 overflow-y-auto">
                      {errorMessage}
                    </div>
                  </div>
                </div>
              )}

              {/* Safety Disclosures */}
              <div className="p-md rounded-lg bg-utility-brand-50 border border-utility-brand-200 text-xs text-utility-brand-700 leading-relaxed">
                {isMoveVault ? (
                  <>
                    <strong>Ajo Move vault object ({network === 'mainnet' ? 'Sui Mainnet' : 'Sui Testnet'}):</strong> You will review and sign this transaction in your connected Sui wallet. The deployed shared object holds the circle's funds until claimed; neither Ajo Steward nor Tatum holds custody.
                  </>
                ) : (
                  <>
                    <strong>External wallet address:</strong> You will sign a direct token transfer to this address. The app cannot enforce vault rules or initiate claims from a regular wallet address. Confirm this is a dedicated address you trust before proceeding.
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer Actions - Fixed */}
        <div className="p-lg sm:p-xl border-t border-secondary flex items-center justify-end gap-md bg-secondary/30 shrink-0">
          {isSuccess ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-xs px-xl py-sm rounded-lg bg-brand-solid text-primary-on-brand text-sm font-semibold hover:bg-brand-solid-hover shadow-xs transition-colors"
            >
              <span>Done</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="px-lg py-sm rounded-lg text-sm font-semibold text-secondary hover:text-primary hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={isSubmitting || isBalanceInsufficient}
                title={isBalanceInsufficient ? 'Cannot sign with insufficient wallet balance' : undefined}
                className="inline-flex items-center gap-xs px-xl py-sm rounded-lg bg-brand-solid text-primary-on-brand text-sm font-semibold hover:bg-brand-solid-hover shadow-xs disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin shrink-0" />
                    <span>Review in Wallet...</span>
                  </>
                ) : (
                  <>
                    <span>Confirm & Sign in Wallet</span>
                    <ArrowRight className="size-4 shrink-0" />
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
