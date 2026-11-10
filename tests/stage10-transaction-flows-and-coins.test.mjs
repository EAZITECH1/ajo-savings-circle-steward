import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDirectContributionTx,
  buildContributeTx,
  normalizeSuiObjectId,
} from '../src/services/contractTransactions.ts'
import { toBaseUnits, toDisplayUnits, findTokenBySymbol } from '../src/services/tokens.ts'
import { verifyWalletBalance } from '../src/services/suiCoins.ts'

const TEST_RECIPIENT = '0x679d547b18cf9f2e77f1d33f932cbf4de5c63dda6a5c5d0e44caf7ae4334cd1b'
const USDC_COIN_TYPE = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC'
const COIN_1 = '0x1111111111111111111111111111111111111111111111111111111111111111'
const COIN_2 = '0x2222222222222222222222222222222222222222222222222222222222222222'

test('Transaction Flows: SUI direct contribution splits from gas and transfers to vault', () => {
  const amountBase = toBaseUnits(1.5, 9) // 1,500,000,000
  const tx = buildDirectContributionTx({
    recipientAddress: TEST_RECIPIENT,
    amountBase,
    coinType: '0x2::sui::SUI',
  })

  const commands = tx.getData().commands
  assert.equal(commands.length, 2)
  assert.equal(commands[0].$kind, 'SplitCoins')
  assert.equal(commands[0].SplitCoins.coin.$kind, 'GasCoin')
  assert.equal(commands[1].$kind, 'TransferObjects')
  assert.equal(commands[1].TransferObjects.objects[0].$kind, 'NestedResult')
})

test('Transaction Flows: Non-SUI token with single coin object splits and transfers', () => {
  const amountBase = toBaseUnits(10, 6) // 10,000,000 base units for USDC
  const tx = buildDirectContributionTx({
    recipientAddress: TEST_RECIPIENT,
    amountBase,
    coinType: USDC_COIN_TYPE,
    coinObjectIds: [COIN_1],
  })

  const commands = tx.getData().commands
  assert.equal(commands.length, 2)
  assert.equal(commands[0].$kind, 'SplitCoins')
  assert.notEqual(commands[0].SplitCoins.coin.$kind, 'GasCoin')
  assert.equal(commands[1].$kind, 'TransferObjects')
})

test('Transaction Flows: Non-SUI token with multiple coin objects merges before splitting', () => {
  const amountBase = toBaseUnits(50, 6)
  const tx = buildDirectContributionTx({
    recipientAddress: TEST_RECIPIENT,
    amountBase,
    coinType: USDC_COIN_TYPE,
    coinObjectIds: [COIN_1, COIN_2],
  })

  const commands = tx.getData().commands
  assert.equal(commands.length, 3)
  assert.equal(commands[0].$kind, 'MergeCoins')
  assert.equal(commands[1].$kind, 'SplitCoins')
  assert.equal(commands[2].$kind, 'TransferObjects')
})

test('Transaction Flows: Non-SUI token with missing coin objects throws clear error', () => {
  assert.throws(
    () => {
      buildDirectContributionTx({
        recipientAddress: TEST_RECIPIENT,
        amountBase: 1000000n,
        coinType: USDC_COIN_TYPE,
        coinObjectIds: [],
      })
    },
    {
      message: /Non-SUI token .* transfer requires at least one valid coin object ID/,
    }
  )
})

test('Transaction Flows: Non-SUI token with Address Balance uses withdrawal and redeem_funds', () => {
  const tx = buildDirectContributionTx({
    recipientAddress: TEST_RECIPIENT,
    amountBase: 500000n,
    coinType: USDC_COIN_TYPE,
    coinObjectIds: [],
    useAddressBalance: true,
  })

  const commands = tx.getData().commands
  assert.equal(commands.length, 2)
  assert.equal(commands[0].$kind, 'MoveCall')
  assert.equal(commands[0].MoveCall.module, 'coin')
  assert.equal(commands[0].MoveCall.function, 'redeem_funds')
  assert.equal(commands[1].$kind, 'TransferObjects')
})

test('Transaction Flows: Decimal conversions for SUI and USDC match verified base units', () => {
  const suiToken = findTokenBySymbol('SUI', 'testnet')
  const usdcToken = findTokenBySymbol('USDC', 'testnet')
  const walToken = findTokenBySymbol('WAL', 'testnet')

  assert.equal(suiToken.decimals, 9)
  assert.equal(usdcToken.decimals, 6)
  assert.equal(walToken, null, 'WAL is no longer a supported contribution token')

  // 1 SUI = 1,000,000,000 base units
  assert.equal(toBaseUnits(1, 9), 1000000000n)
  assert.equal(toDisplayUnits(1000000000n, 9), 1)

  // 1 USDC = 1,000,000 base units
  assert.equal(toBaseUnits(1, 6), 1000000n)
  assert.equal(toDisplayUnits(1000000n, 6), 1)

  // 25.5 USDC = 25,500,000 base units
  assert.equal(toBaseUnits(25.5, 6), 25500000n)
  assert.equal(toDisplayUnits(25500000n, 6), 25.5)
})

test('Transaction Flows: Sui Address Balance verification supports native SUI without discrete coin objects', async () => {
  const result = await verifyWalletBalance({
    network: 'testnet',
    ownerAddress: TEST_RECIPIENT,
    coinType: '0x2::sui::SUI',
    requiredAmountBase: 500000000n, // 0.5 SUI
    decimals: 9,
    symbol: 'SUI',
  })

  // Testnet address TEST_RECIPIENT holds > 0.9 SUI in Address Balance
  assert.equal(result.hasSufficientBalance, true)
  assert.ok(result.heldBase >= 500000000n)
  assert.ok(result.heldDisplay.includes('SUI'))
})
