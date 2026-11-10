// Sui Coin Object and Balance Fetcher for Ajo Savings Circle
// Interacts with Sui fullnodes via official @mysten/sui/grpc SuiGrpcClient

import { SuiGrpcClient } from '@mysten/sui/grpc'
import { toDisplayUnits } from './tokens.ts'

const GRPC_URLS: Record<string, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
}

export interface WalletCoinInfo {
  objectId: string
  balance: string
  version?: string
  digest?: string
}

export interface BalanceCheckResult {
  hasSufficientBalance: boolean
  heldBase: bigint
  requiredBase: bigint
  heldDisplay: string
  requiredDisplay: string
  selectedCoinObjectIds: string[]
  useAddressBalance?: boolean
  reason?: 'insufficient_balance' | 'no_coins_found' | 'insufficient_gas' | null
  errorMessage?: string | null
}

/**
 * Creates a SuiGrpcClient for the target network.
 */
export function getSuiClient(network: string = 'testnet'): SuiGrpcClient {
  const norm = network.toLowerCase()
  return new SuiGrpcClient({
    network: norm,
    baseUrl: GRPC_URLS[norm] || GRPC_URLS.testnet,
  })
}

/**
 * Fetches all coin objects and authoritative total balance for a specific coinType owned by ownerAddress.
 * Supports modern Sui Address Balances (faucets/direct deposits) as well as discrete Coin objects.
 */
export async function fetchWalletCoins(
  network: string,
  ownerAddress: string,
  coinType: string
): Promise<{ coins: WalletCoinInfo[]; totalBalance: bigint }> {
  if (!ownerAddress || !ownerAddress.startsWith('0x')) {
    return { coins: [], totalBalance: 0n }
  }

  const client = getSuiClient(network)
  const cleanOwner = ownerAddress.trim().toLowerCase()
  const cleanCoinType = coinType.trim()

  let totalBalance = 0n

  // 1. Fetch authoritative balance via getBalance (reflects addressBalance + coinBalance)
  try {
    const balRes = await client.getBalance({
      owner: cleanOwner,
      coinType: cleanCoinType,
    })
    if (balRes?.balance?.balance) {
      totalBalance = BigInt(balRes.balance.balance)
    }
  } catch (err: any) {
    console.warn(`[suiCoins] Failed to getBalance for ${cleanCoinType}:`, err.message)
  }

  // 2. Fetch discrete coin objects via listCoins (used for non-SUI coin merging/splitting if present)
  let coins: WalletCoinInfo[] = []
  try {
    const res = await client.listCoins({
      owner: cleanOwner,
      coinType: cleanCoinType,
    })

    coins = (res.objects || [])
      .map((o: any) => ({
        objectId: o.objectId,
        balance: o.balance || '0',
        version: o.version,
        digest: o.digest,
      }))
      .filter((c: WalletCoinInfo) => {
        try {
          return BigInt(c.balance) > 0n
        } catch {
          return false
        }
      })

    // Fallback: If getBalance was unavailable or 0 but listCoins returned coins, sum them
    if (totalBalance === 0n && coins.length > 0) {
      totalBalance = coins.reduce((acc, c) => acc + BigInt(c.balance), 0n)
    }
  } catch (err: any) {
    console.warn(`[suiCoins] Failed to list coins for ${cleanCoinType}:`, err.message)
  }

  return { coins, totalBalance }
}

/**
 * Verifies if the wallet holds sufficient balance and gas before requesting signature.
 * For non-SUI tokens, selects coin objects sufficient to satisfy requiredAmountBase.
 */
export async function verifyWalletBalance(params: {
  network: string
  ownerAddress: string
  coinType: string
  requiredAmountBase: bigint
  decimals: number
  symbol: string
}): Promise<BalanceCheckResult> {
  const { network, ownerAddress, coinType, requiredAmountBase, decimals, symbol } = params
  const isNativeSui = coinType === '0x2::sui::SUI' || coinType.endsWith('::sui::SUI')

  const requiredDisplay = `${toDisplayUnits(requiredAmountBase, decimals)} ${symbol}`

  // Fetch target token coins
  const { coins, totalBalance } = await fetchWalletCoins(network, ownerAddress, coinType)
  const heldDisplay = `${toDisplayUnits(totalBalance, decimals)} ${symbol}`

  // Check gas SUI balance if this is a non-SUI token
  if (!isNativeSui) {
    const { totalBalance: suiGasBalance } = await fetchWalletCoins(network, ownerAddress, '0x2::sui::SUI')
    const minGasRequired = 5_000_000n // 0.005 SUI reserve for transaction gas
    if (suiGasBalance < minGasRequired) {
      return {
        hasSufficientBalance: false,
        heldBase: totalBalance,
        requiredBase: requiredAmountBase,
        heldDisplay,
        requiredDisplay,
        selectedCoinObjectIds: [],
        reason: 'insufficient_gas',
        errorMessage: `Insufficient SUI for network gas fees. You need at least 0.005 SUI in your wallet to sign a ${symbol} transfer.`,
      }
    }
  }

  // Check token balance
  if (totalBalance < requiredAmountBase) {
    if (totalBalance === 0n) {
      return {
        hasSufficientBalance: false,
        heldBase: 0n,
        requiredBase: requiredAmountBase,
        heldDisplay: `0 ${symbol}`,
        requiredDisplay,
        selectedCoinObjectIds: [],
        reason: 'no_coins_found',
        errorMessage: `No ${symbol} balance found in your wallet. You must acquire ${symbol} on Sui ${network} to make this contribution.`,
      }
    }

    return {
      hasSufficientBalance: false,
      heldBase: totalBalance,
      requiredBase: requiredAmountBase,
      heldDisplay,
      requiredDisplay,
      selectedCoinObjectIds: [],
      reason: 'insufficient_balance',
      errorMessage: `Insufficient ${symbol} balance: Wallet holds ${heldDisplay}, but this contribution requires ${requiredDisplay}.`,
    }
  }

  // If native SUI, coins are split directly from tx.gas (which seamlessly uses address balance)
  // Ensure the user has enough SUI left over for gas fees
  if (isNativeSui) {
    const minSuiGasReserve = 5_000_000n // 0.005 SUI reserved for transaction gas
    if (totalBalance < requiredAmountBase + minSuiGasReserve) {
      return {
        hasSufficientBalance: false,
        heldBase: totalBalance,
        requiredBase: requiredAmountBase,
        heldDisplay,
        requiredDisplay,
        selectedCoinObjectIds: coins.map((c) => c.objectId),
        reason: 'insufficient_gas',
        errorMessage: `Insufficient SUI for gas: You hold ${heldDisplay}, but this contribution requires ${requiredDisplay} plus at least 0.005 SUI reserved for network transaction gas.`,
      }
    }

    return {
      hasSufficientBalance: true,
      heldBase: totalBalance,
      requiredBase: requiredAmountBase,
      heldDisplay,
      requiredDisplay,
      selectedCoinObjectIds: coins.map((c) => c.objectId),
    }
  }

  // For non-SUI tokens, pick minimal coin objects that sum to >= requiredAmountBase
  const sorted = [...coins].sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))
  const selected: string[] = []
  let accumulated = 0n

  for (const coin of sorted) {
    selected.push(coin.objectId)
    accumulated += BigInt(coin.balance)
    if (accumulated >= requiredAmountBase) {
      break
    }
  }

  // If discrete coin objects alone can satisfy requiredAmountBase, use discrete coin objects.
  // Otherwise, use modern Sui Address Balance withdrawal (SIP-39 / 0x2::coin::redeem_funds).
  const useAddressBalance = accumulated < requiredAmountBase
  const selectedCoinObjectIds = useAddressBalance ? [] : selected

  return {
    hasSufficientBalance: true,
    heldBase: totalBalance,
    requiredBase: requiredAmountBase,
    heldDisplay,
    requiredDisplay,
    selectedCoinObjectIds,
    useAddressBalance,
  }
}
