// Verified Token Configuration for Sui Networks
// Official, authoritative coin types and decimals. Never guess or identify by display name alone.

export interface TokenConfig {
  symbol: 'SUI' | 'USDC'
  name: string
  coinType: string
  decimals: number
  verified: boolean
  enabled: boolean
  disabledReason?: string
  explorerUrl?: string
}

export const SUPPORTED_TOKENS: Record<string, Record<string, TokenConfig>> = {
  testnet: {
    SUI: {
      symbol: 'SUI',
      name: 'Sui Native Coin',
      coinType: '0x2::sui::SUI',
      decimals: 9,
      verified: true,
      enabled: true,
    },
    USDC: {
      symbol: 'USDC',
      name: 'USD Coin (Circle Official)',
      coinType: '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
      decimals: 6,
      verified: true,
      enabled: true,
    },
  },
  mainnet: {
    SUI: {
      symbol: 'SUI',
      name: 'Sui Native Coin',
      coinType: '0x2::sui::SUI',
      decimals: 9,
      verified: true,
      enabled: true,
    },
    USDC: {
      symbol: 'USDC',
      name: 'Native USD Coin (Circle)',
      coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
      decimals: 6,
      verified: true,
      enabled: true,
    },
  },
}

export function getTokensForNetwork(network: string = 'testnet'): TokenConfig[] {
  const net = network.toLowerCase().includes('main') ? 'mainnet' : 'testnet'
  const registry = SUPPORTED_TOKENS[net] || SUPPORTED_TOKENS.testnet
  return Object.values(registry)
}

export function findTokenByCoinType(coinType: string, network: string = 'testnet'): TokenConfig | null {
  const tokens = getTokensForNetwork(network)
  const norm = coinType.toLowerCase().trim()
  return (
    tokens.find((t) => t.coinType.toLowerCase() === norm) ||
    tokens.find((t) => norm.endsWith(`::${t.symbol.toLowerCase()}::${t.symbol}`)) ||
    null
  )
}

export function findTokenBySymbol(symbol: string, network: string = 'testnet'): TokenConfig | null {
  const tokens = getTokensForNetwork(network)
  return tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase()) || null
}

/**
 * Detect whether a coin type or symbol represents WAL or an unsupported legacy token.
 * This preserves existing saved circle details without converting or rewriting them.
 */
export function checkTokenSupport(coinTypeOrSymbol: string, network: string = 'testnet'): {
  isSupported: boolean
  isLegacyWal: boolean
  symbol: string
  decimals: number
  warning?: string
} {
  const s = (coinTypeOrSymbol || '').trim()
  const lower = s.toLowerCase()
  const isLegacyWal = lower.includes('wal') || lower.endsWith('::wal::wal')
  if (isLegacyWal) {
    return {
      isSupported: false,
      isLegacyWal: true,
      symbol: 'WAL',
      decimals: 9,
      warning:
        'WAL is no longer supported as a contribution token in Ajo Steward. This circle can no longer accept new WAL contributions.',
    }
  }

  const found = findTokenByCoinType(s, network) || findTokenBySymbol(s, network)
  if (found && found.enabled) {
    return {
      isSupported: true,
      isLegacyWal: false,
      symbol: found.symbol,
      decimals: found.decimals,
    }
  }

  return {
    isSupported: false,
    isLegacyWal: false,
    symbol: s.split('::').pop() || s || 'UNKNOWN',
    decimals: lower.includes('usdc') ? 6 : 9,
    warning: `The token ${s} is not currently supported for new contributions.`,
  }
}

/**
 * Convert human-readable token amount (e.g. 1.5) to on-chain base units (e.g. 1500000000n).
 */
export function toBaseUnits(amount: number | string, decimals: number): bigint {
  const str = typeof amount === 'number' ? amount.toString() : amount.trim()
  if (!str || isNaN(Number(str))) return 0n
  const [whole, fraction = ''] = str.split('.')
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals)
  const combined = `${whole || '0'}${paddedFraction}`
  return BigInt(combined.replace(/^0+(?=\d)/, '') || '0')
}

/**
 * Convert on-chain base units to human-readable number for display.
 */
export function toDisplayUnits(baseUnits: bigint | string | number, decimals: number): number {
  const bi = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits || '0')
  const divisor = 10n ** BigInt(decimals)
  const whole = bi / divisor
  const fraction = bi % divisor
  const fractionStr = fraction.toString().padStart(decimals, '0')
  return parseFloat(`${whole}.${fractionStr}`)
}

/**
 * Format a token amount for clean UI display with its symbol.
 */
export function formatTokenAmount(
  baseUnits: bigint | string | number,
  decimals: number,
  symbol?: string
): string {
  const val = toDisplayUnits(baseUnits, decimals)
  const formatted = val.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals > 4 ? 4 : decimals,
  })
  return symbol ? `${formatted} ${symbol}` : formatted
}
