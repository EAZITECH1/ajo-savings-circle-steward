import React, { useState } from 'react'
import { ExternalLink, Copy, CheckCheck, AlertCircle } from 'lucide-react'
import {
  getSuiTxUrl,
  getSuiAccountUrl,
  getSuiObjectUrl,
  getSuiCoinUrl,
  getWalrusBlobUrl,
  shortenIdentifier,
  QUARANTINED_SYNTHETIC_BLOB_IDS,
  resolveSuiNetwork,
} from '../services/explorerLinks'

export interface ExplorerLinkProps {
  type: 'tx' | 'address' | 'object' | 'coin' | 'walrus-blob'
  value?: string | null
  network?: string
  label?: string
  shorten?: boolean
  prefixLen?: number
  suffixLen?: number
  showCopy?: boolean
  showIcon?: boolean
  mono?: boolean
  className?: string
  linkClassName?: string
  isPendingVerification?: boolean
  evidenceStatus?: 'Verified' | 'Pending' | 'Unverified' | 'Late' | null
}

export const ExplorerLink: React.FC<ExplorerLinkProps> = ({
  type,
  value,
  network = 'testnet',
  label,
  shorten = true,
  prefixLen,
  suffixLen,
  showCopy = true,
  showIcon = true,
  mono = true,
  className = '',
  linkClassName = '',
  isPendingVerification = false,
  evidenceStatus,
}) => {
  const [copied, setCopied] = useState(false)

  if (!value || typeof value !== 'string' || !value.trim()) {
    return <span className="text-quaternary text-xs italic">None</span>
  }

  const cleanVal = value.trim()
  const isQuarantined = type === 'walrus-blob' && QUARANTINED_SYNTHETIC_BLOB_IDS.has(cleanVal)

  // Determine URL based on reference type
  let explorerUrl: string | null = null
  let titleAttr = ''
  let resolvedNet = resolveSuiNetwork(network)

  if (type === 'tx') {
    explorerUrl = getSuiTxUrl(cleanVal, network)
    titleAttr = explorerUrl
      ? `View transaction ${cleanVal} on Suiscan (${resolvedNet})`
      : 'Invalid or unresolved transaction digest'
  } else if (type === 'address') {
    explorerUrl = getSuiAccountUrl(cleanVal, network)
    titleAttr = explorerUrl
      ? `View account address ${cleanVal} on Suiscan (${resolvedNet})`
      : 'Invalid or unresolved Sui address'
  } else if (type === 'object') {
    explorerUrl = getSuiObjectUrl(cleanVal, network)
    titleAttr = explorerUrl
      ? `View object/vault ${cleanVal} on Suiscan (${resolvedNet})`
      : 'Invalid or unresolved Sui object ID'
  } else if (type === 'coin') {
    explorerUrl = getSuiCoinUrl(cleanVal, network)
    titleAttr = explorerUrl
      ? `View token contract ${cleanVal} on Suiscan (${resolvedNet})`
      : 'Invalid or unresolved Sui coin type'
  } else if (type === 'walrus-blob') {
    explorerUrl = getWalrusBlobUrl(cleanVal, 'mainnet')
    titleAttr = explorerUrl
      ? `View public stored blob record on Walruscan (Walrus Mainnet)`
      : isQuarantined
      ? 'Quarantined synthetic blob ID — public retrieval disabled'
      : 'Invalid or malformed Walrus blob ID'
  }

  const displayText = label
    ? label
    : shorten
    ? shortenIdentifier(cleanVal, prefixLen ?? (type === 'coin' ? 12 : 6), suffixLen ?? (type === 'coin' ? 8 : 4))
    : cleanVal

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(cleanVal)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.warn('Copy failed:', err)
    }
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 flex-wrap max-w-full min-w-0 ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      {explorerUrl && !isQuarantined ? (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={titleAttr}
          aria-label={titleAttr}
          onClick={(e) => e.stopPropagation()}
          className={`inline-flex items-center gap-1 text-brand-primary hover:text-brand-primary-hover hover:underline font-medium transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring outline-none rounded max-w-full min-w-0 ${
            mono ? 'font-mono' : ''
          } ${linkClassName}`}
        >
          <span className="truncate max-w-[160px] xs:max-w-[220px] sm:max-w-[340px] md:max-w-[460px] min-w-0">
            {displayText}
          </span>
          {showIcon && <ExternalLink className="size-3 shrink-0 text-fg-brand-primary opacity-80 group-hover:opacity-100" />}
        </a>
      ) : (
        <span
          className={`inline-flex items-center gap-1 text-secondary max-w-full min-w-0 ${
            mono ? 'font-mono' : ''
          } ${linkClassName}`}
          title={titleAttr || cleanVal}
        >
          <span className="truncate max-w-[160px] xs:max-w-[220px] sm:max-w-[340px] md:max-w-[460px] min-w-0">
            {displayText}
          </span>
          {isQuarantined ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-utility-error-700 bg-utility-error-50 px-1.5 py-0.5 rounded border border-utility-error-200">
              <AlertCircle className="size-2.5 shrink-0" />
              <span>Quarantined</span>
            </span>
          ) : !resolvedNet && type !== 'walrus-blob' ? (
            <span className="text-[10px] text-tertiary">(Network unconfigured)</span>
          ) : null}
        </span>
      )}

      {/* Accuracy status label for pending evidence or payment verification */}
      {isPendingVerification && (
        <span className="text-[10px] font-medium text-utility-warning-700 bg-utility-warning-50 px-1.5 py-0.5 rounded border border-utility-warning-200">
          Pending Verification
        </span>
      )}

      {showCopy && (
        <button
          type="button"
          onClick={handleCopy}
          aria-label={`Copy ${type} identifier: ${cleanVal}`}
          title={copied ? 'Copied to clipboard!' : `Copy full ${type}`}
          className="p-0.5 rounded text-fg-quaternary hover:text-secondary hover:bg-secondary transition-colors focus-visible:ring-1 focus-visible:ring-focus-ring outline-none shrink-0"
        >
          {copied ? (
            <CheckCheck className="size-3 text-fg-success-primary" />
          ) : (
            <Copy className="size-3" />
          )}
        </button>
      )}
    </span>
  )
}
