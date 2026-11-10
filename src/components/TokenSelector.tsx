import React from 'react'
import { CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react'
import { TokenConfig, getTokensForNetwork } from '../services/tokens'
import { TokenLogo } from './TokenLogo'

export interface TokenSelectorProps {
  selectedCoinType: string
  onSelectToken: (token: TokenConfig) => void
  network?: string
}

export const TokenSelector: React.FC<TokenSelectorProps> = ({
  selectedCoinType,
  onSelectToken,
  network = 'testnet',
}) => {
  const tokens = getTokensForNetwork(network)
  const normSelected = (selectedCoinType || '').toLowerCase().trim()

  const selectedToken =
    tokens.find((t) => t.coinType.toLowerCase() === normSelected) ||
    tokens.find((t) => t.enabled) ||
    tokens[0]

  return (
    <div className="space-y-sm">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-secondary">
          Contribution Token
        </label>
        <span className="text-xs text-tertiary">
          Network: <strong className="text-primary font-mono">{network.toUpperCase()}</strong>
        </span>
      </div>

      {/* Token Options Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
        {tokens.map((token) => {
          const isSelected =
            normSelected === token.coinType.toLowerCase() ||
            (!normSelected && token.symbol === 'SUI')
          const isDisabled = !token.enabled

          return (
            <button
              key={token.symbol}
              type="button"
              disabled={isDisabled}
              onClick={() => {
                if (!isDisabled) {
                  onSelectToken(token)
                }
              }}
              className={`p-md rounded-xl border text-left transition-all relative flex flex-col justify-between gap-sm ${
                isDisabled
                  ? 'border-secondary bg-secondary/40 opacity-50 cursor-not-allowed'
                  : isSelected
                  ? 'border-brand-solid bg-utility-brand-50/50 shadow-xs ring-1 ring-brand-solid'
                  : 'border-secondary bg-primary hover:border-primary hover:bg-secondary/30'
              }`}
            >
              <div className="flex items-start justify-between w-full">
                <div className="flex items-center gap-sm">
                  <TokenLogo symbol={token.symbol} className="size-7 shrink-0" />
                  <div>
                    <div className="flex items-center gap-xs">
                      <span className="font-bold text-sm text-primary">{token.symbol}</span>
                      {token.verified && (
                        <CheckCircle2 className="size-3 text-fg-brand-primary shrink-0" />
                      )}
                    </div>
                    <p className="text-[11px] text-tertiary leading-tight line-clamp-1">{token.name}</p>
                  </div>
                </div>

                {isSelected && (
                  <span className="w-2 h-2 rounded-full bg-brand-solid shrink-0 mt-1" />
                )}
              </div>

              <div className="flex items-center justify-between text-[11px] text-tertiary pt-xs border-t border-secondary/60 w-full">
                <span>Decimals: <strong className="text-secondary font-mono">{token.decimals}</strong></span>
                <span className="font-mono text-[10px] text-tertiary">
                  {isDisabled ? 'Unavailable' : 'Verified'}
                </span>
              </div>

              {isDisabled && token.disabledReason && (
                <div className="mt-xs text-[10px] text-error-primary flex items-start gap-xxs leading-tight">
                  <AlertCircle className="size-3 shrink-0 mt-0.5" />
                  <span>{token.disabledReason}</span>
                </div>
              )}
            </button>
          )
        })}
      </div>

      {/* Selected Token Technical Verified Move Specification */}
      {selectedToken && (
        <div className="rounded-lg bg-secondary/60 p-md border border-secondary text-xs space-y-xs">
          <div className="flex items-start justify-between gap-sm">
            <span className="text-tertiary shrink-0">Verified Move Coin Type:</span>
            <span className="font-mono text-[11px] text-primary break-all text-right font-medium">
              {selectedToken.coinType || (
                <span className="text-error-primary italic">Not deployed on this network</span>
              )}
            </span>
          </div>
          <div className="flex items-center justify-between pt-xxs border-t border-secondary/40 text-[11px]">
            <span className="text-tertiary">Standard Decimals:</span>
            <span className="font-semibold text-primary tabular-nums">
              {selectedToken.decimals} base units per 1.0 {selectedToken.symbol}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
