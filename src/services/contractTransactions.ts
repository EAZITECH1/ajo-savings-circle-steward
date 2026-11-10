// Sui Move Transaction Builders for Ajo Savings Circle
// Interacts with the deployed ajo::circle Move package via official @mysten/sui/transactions

import { Transaction } from '@mysten/sui/transactions'

export const SUI_CLOCK_OBJECT_ID = '0x0000000000000000000000000000000000000000000000000000000000000006'

/**
 * Normalizes a Sui hex address or object ID to 0x + 64 hex digits.
 */
export function normalizeSuiObjectId(id: string): string {
  const clean = id.trim().toLowerCase().replace(/^0x/, '')
  return '0x' + clean.padStart(64, '0')
}

export interface CreateCircleParams {
  packageId: string
  name: string
  contributionAmountBase: bigint | string | number
  cycleDurationMs: bigint | string | number
  members: string[]
  payoutOrder: string[]
  coinType?: string
}

export function buildCreateCircleTx(params: CreateCircleParams): Transaction {
  const tx = new Transaction()
  const pkg = normalizeSuiObjectId(params.packageId)
  const coinType = params.coinType || '0x2::sui::SUI'

  const amountBigInt = BigInt(params.contributionAmountBase)
  const durationBigInt = BigInt(params.cycleDurationMs)
  const normalizedMembers = params.members.map(normalizeSuiObjectId)
  const normalizedPayoutOrder = params.payoutOrder.map(normalizeSuiObjectId)

  tx.moveCall({
    target: `${pkg}::circle::create_circle`,
    arguments: [
      tx.pure.string(params.name),
      tx.pure.u64(amountBigInt),
      tx.pure.u64(durationBigInt),
      tx.pure.vector('address', normalizedMembers),
      tx.pure.vector('address', normalizedPayoutOrder),
    ],
    typeArguments: [coinType],
  })

  return tx
}

export interface AcceptCircleParams {
  packageId: string
  circleObjectId: string
  coinType?: string
}

export function buildAcceptCircleTx(params: AcceptCircleParams): Transaction {
  const tx = new Transaction()
  const pkg = normalizeSuiObjectId(params.packageId)
  const circleId = normalizeSuiObjectId(params.circleObjectId)
  const coinType = params.coinType || '0x2::sui::SUI'

  tx.moveCall({
    target: `${pkg}::circle::accept_circle`,
    arguments: [tx.object(circleId), tx.object(SUI_CLOCK_OBJECT_ID)],
    typeArguments: [coinType],
  })

  return tx
}

export interface ContributeParams {
  packageId: string
  circleObjectId: string
  amountBase: bigint | string | number
  coinType?: string
  primaryCoinObjectId?: string
  coinObjectIds?: string[]
  useAddressBalance?: boolean
}

export interface DirectContributionParams {
  recipientAddress: string
  amountBase: bigint | string | number
  coinType?: string
  primaryCoinObjectId?: string
  coinObjectIds?: string[]
  useAddressBalance?: boolean
}

/**
 * Ask the Sui transaction SDK to source a fungible payment from the sender's
 * address balance when available, falling back to owned Coin<T> objects.
 * This keeps payments compatible with both newer address balances and legacy
 * object-based balances without requiring the app to select coin object IDs.
 */
/**
 * Builds a direct on-chain Sui transfer to a destination pool/vault address.
 * Used when the circle vault is an account/multisig/vault address rather than
 * a Move shared object, or when depositing directly to a configured pool address.
 */
export function buildDirectContributionTx(params: DirectContributionParams): Transaction {
  const tx = new Transaction()
  const recipient = normalizeSuiObjectId(params.recipientAddress)
  const coinType = params.coinType || '0x2::sui::SUI'
  const amountBigInt = BigInt(params.amountBase)

  const isNativeSui = coinType === '0x2::sui::SUI' || coinType.endsWith('::sui::SUI')

  if (isNativeSui) {
    const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountBigInt)])
    tx.transferObjects([paymentCoin], tx.pure.address(recipient))
  } else {
    const coinIds = (params.coinObjectIds && params.coinObjectIds.length > 0)
      ? params.coinObjectIds
      : params.primaryCoinObjectId
      ? [params.primaryCoinObjectId]
      : []

    if (params.useAddressBalance) {
      // Modern Sui Address Balance withdrawal (SIP-39 / 0x2::coin::redeem_funds)
      const withdrawal = tx.withdrawal({
        amount: amountBigInt,
        type: coinType,
      })
      const [paymentCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [coinType],
        arguments: [withdrawal],
      })
      tx.transferObjects([paymentCoin], tx.pure.address(recipient))
    } else if (coinIds.length === 0) {
      throw new Error(`Non-SUI token (${coinType}) transfer requires at least one valid coin object ID`)
    } else {
      const primaryId = normalizeSuiObjectId(coinIds[0])
      const primaryCoin = tx.object(primaryId)

      if (coinIds.length > 1) {
        const otherCoins = coinIds.slice(1).map((id) => tx.object(normalizeSuiObjectId(id)))
        tx.mergeCoins(primaryCoin, otherCoins)
      }

      const [paymentCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountBigInt)])
      tx.transferObjects([paymentCoin], tx.pure.address(recipient))
    }
  }

  return tx
}

export function buildContributeTx(params: ContributeParams): Transaction {
  const tx = new Transaction()
  const pkg = normalizeSuiObjectId(params.packageId)
  const circleId = normalizeSuiObjectId(params.circleObjectId)
  const coinType = params.coinType || '0x2::sui::SUI'
  const amountBigInt = BigInt(params.amountBase)

  const isNativeSui = coinType === '0x2::sui::SUI' || coinType.endsWith('::sui::SUI')

  let paymentCoin
  if (isNativeSui) {
    ;[paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountBigInt)])
  } else {
    const coinIds = (params.coinObjectIds && params.coinObjectIds.length > 0)
      ? params.coinObjectIds
      : params.primaryCoinObjectId
      ? [params.primaryCoinObjectId]
      : []

    if (params.useAddressBalance) {
      // Modern Sui Address Balance withdrawal (SIP-39 / 0x2::coin::redeem_funds)
      const withdrawal = tx.withdrawal({
        amount: amountBigInt,
        type: coinType,
      })
      ;[paymentCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [coinType],
        arguments: [withdrawal],
      })
    } else if (coinIds.length === 0) {
      throw new Error(`Non-SUI token (${coinType}) contribution requires at least one valid coin object ID`)
    } else {
      const primaryId = normalizeSuiObjectId(coinIds[0])
      const primaryCoin = tx.object(primaryId)

      if (coinIds.length > 1) {
        const otherCoins = coinIds.slice(1).map((id) => tx.object(normalizeSuiObjectId(id)))
        tx.mergeCoins(primaryCoin, otherCoins)
      }

      ;[paymentCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountBigInt)])
    }
  }

  tx.moveCall({
    target: `${pkg}::circle::contribute`,
    arguments: [tx.object(circleId), paymentCoin, tx.object(SUI_CLOCK_OBJECT_ID)],
    typeArguments: [coinType],
  })

  return tx
}

export interface ClaimCycleParams {
  packageId: string
  circleObjectId: string
  coinType?: string
}

export function buildClaimCycleTx(params: ClaimCycleParams): Transaction {
  const tx = new Transaction()
  const pkg = normalizeSuiObjectId(params.packageId)
  const circleId = normalizeSuiObjectId(params.circleObjectId)
  const coinType = params.coinType || '0x2::sui::SUI'

  tx.moveCall({
    target: `${pkg}::circle::claim_cycle`,
    arguments: [tx.object(circleId), tx.object(SUI_CLOCK_OBJECT_ID)],
    typeArguments: [coinType],
  })

  return tx
}

export interface ClaimRefundParams {
  packageId: string
  circleObjectId: string
  coinType?: string
}

export function buildClaimRefundTx(params: ClaimRefundParams): Transaction {
  const tx = new Transaction()
  const pkg = normalizeSuiObjectId(params.packageId)
  const circleId = normalizeSuiObjectId(params.circleObjectId)
  const coinType = params.coinType || '0x2::sui::SUI'

  tx.moveCall({
    target: `${pkg}::circle::claim_refund`,
    arguments: [tx.object(circleId), tx.object(SUI_CLOCK_OBJECT_ID)],
    typeArguments: [coinType],
  })

  return tx
}

export interface PublishPackageParams {
  modules: string[] | number[][]
  dependencies: string[]
  senderAddress: string
}

export function buildPublishPackageTx(params: PublishPackageParams): Transaction {
  const tx = new Transaction()
  tx.setGasBudget(100_000_000n)
  
  // Normalize modules to base64 strings so every Sui wallet extension deserializes the bytecode properly
  const normalizedModules: string[] = params.modules.map((m) => {
    if (typeof m === 'string') return m
    const uint8 = new Uint8Array(m)
    let binary = ''
    for (let i = 0; i < uint8.byteLength; i++) {
      binary += String.fromCharCode(uint8[i])
    }
    return btoa(binary)
  })

  const [upgradeCap] = tx.publish({
    modules: normalizedModules,
    dependencies: params.dependencies,
  })
  tx.transferObjects([upgradeCap], tx.pure.address(params.senderAddress))
  return tx
}
