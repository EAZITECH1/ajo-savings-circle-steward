import React, { useState } from 'react'

export interface TokenLogoProps {
  symbol: string
  className?: string
  size?: number
}

/**
 * Official logos for verified Sui assets:
 * - SUI: Official Sui water droplet from official branding (blue background, white droplet S-curve)
 * - USDC: Official Circle USD Coin logo
 */
export const TokenLogo: React.FC<TokenLogoProps> = ({ symbol, className = 'size-5', size }) => {
  const sym = (symbol || '').toUpperCase().trim()
  const style = size ? { width: size, height: size } : undefined
  const [failedImageSymbol, setFailedImageSymbol] = useState<string | null>(null)

  if (sym === 'SUI') {
    if (failedImageSymbol !== 'SUI') {
      return (
        <img
          src="/tokens/sui.png"
          alt="Sui"
          onError={() => setFailedImageSymbol('SUI')}
          className={`${className} rounded-full object-cover shrink-0`}
          style={style}
        />
      )
    }
    return (
      <span
        role="img"
        aria-label="Sui"
        className={`inline-flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#298DFF] ${className}`}
        style={style}
      >
        <svg
          viewBox="0 0 100 100"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="size-[72%]"
          aria-hidden="true"
        >
          <path
            d="M50 16 C50 16 28 42 28 60 C28 72 37.8 82 50 82 C62.2 82 72 72 72 60 C72 42 50 16 50 16 Z"
            stroke="#FFFFFF"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M50 36 C43 48 41 57 50 66 C56 72 56 76 50 82"
            stroke="#FFFFFF"
            strokeWidth="7"
            strokeLinecap="round"
          />
        </svg>
      </span>
    )
  }

  if (sym === 'USDC') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`${className} shrink-0`}
        style={style}
        aria-label="USD Coin (Circle Official)"
      >
        <circle cx="12" cy="12" r="11" fill="#2775CA" />
        <path
          d="M12.8 7.5c-1.8 0-2.8.9-2.8 2.2 0 1.4.9 1.9 2.5 2.2 1.4.3 1.8.7 1.8 1.4 0 .9-.8 1.5-2 1.5-1.5 0-2.1-.6-2.3-1.6h-1.5c.2 1.7 1.3 2.7 2.8 2.9V18h1.8v-1.9c1.9-.3 2.9-1.4 2.9-2.8 0-1.5-1-2.1-2.6-2.5-1.3-.3-1.7-.7-1.7-1.3 0-.7.7-1.3 1.8-1.3 1.3 0 1.8.6 2 1.4h1.5c-.2-1.5-1.1-2.4-2.7-2.7V6h-1.8v1.5z"
          fill="#FFFFFF"
        />
        <path
          d="M5.5 12a6.5 6.5 0 0 1 6.5-6.5"
          stroke="#FFFFFF"
          strokeWidth="1.25"
          strokeLinecap="round"
          opacity="0.6"
        />
        <path
          d="M18.5 12a6.5 6.5 0 0 1-6.5 6.5"
          stroke="#FFFFFF"
          strokeWidth="1.25"
          strokeLinecap="round"
          opacity="0.6"
        />
      </svg>
    )
  }

  return (
    <div
      className={`rounded-full bg-utility-brand-100 text-brand-primary flex items-center justify-center font-bold text-[10px] ${className}`}
      style={style}
    >
      {sym.slice(0, 3)}
    </div>
  )
}
