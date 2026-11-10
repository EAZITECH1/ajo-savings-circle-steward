import test from 'node:test'
import assert from 'node:assert/strict'
import {
  toBaseUnits,
  toDisplayUnits,
  formatTokenAmount,
  findTokenByCoinType,
  findTokenBySymbol,
  getTokensForNetwork,
} from '../src/services/tokens.ts'
import {
  normalizeSuiObjectId,
  buildCreateCircleTx,
  buildAcceptCircleTx,
  buildContributeTx,
  buildClaimCycleTx,
  buildClaimRefundTx,
  SUI_CLOCK_OBJECT_ID,
} from '../src/services/contractTransactions.ts'
import { fetchOnchainCircleState } from '../server/ajo-reader.mjs'
import { runGroupReport } from '../server/steward-llm.mjs'
import { upsertCircleRoster } from '../server/walrus-memory.mjs'

const MOCK_PKG_ID = '0x' + 'a'.repeat(64)
const MOCK_CIRCLE_ID = '0x' + 'b'.repeat(64)
const MOCK_ALICE = '0x' + '1'.repeat(64)
const MOCK_BOB = '0x' + '2'.repeat(64)

test('Token configuration: authoritative coin types, decimals, and conversions', () => {
  const testnetTokens = getTokensForNetwork('testnet')
  assert.equal(testnetTokens.length, 2, 'Testnet supports verified tokens (SUI, USDC); WAL is removed')

  const sui = findTokenBySymbol('SUI', 'testnet')
  assert.ok(sui)
  assert.equal(sui.coinType, '0x2::sui::SUI')
  assert.equal(sui.decimals, 9)
  assert.equal(sui.verified, true)
  assert.equal(sui.enabled, true)

  const usdc = findTokenBySymbol('USDC', 'testnet')
  assert.ok(usdc)
  assert.equal(usdc.coinType, '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC')
  assert.equal(usdc.decimals, 6)
  assert.equal(usdc.verified, true)

  const wal = findTokenBySymbol('WAL', 'testnet')
  assert.equal(wal, null, 'WAL must not be present in supported testnet tokens')

  // Math conversions: SUI (9 decimals)
  assert.equal(toBaseUnits(1, 9), 1000000000n)
  assert.equal(toBaseUnits('2.5', 9), 2500000000n)
  assert.equal(toDisplayUnits(2500000000n, 9), 2.5)
  assert.equal(formatTokenAmount(2500000000n, 9, 'SUI'), '2.5 SUI')

  // Math conversions: USDC (6 decimals)
  assert.equal(toBaseUnits(50, 6), 50000000n)
  assert.equal(toDisplayUnits(50000000n, 6), 50)
  assert.equal(formatTokenAmount(50000000n, 6, 'USDC'), '50 USDC')

  // Rejection of unknown token
  assert.equal(findTokenBySymbol('FAKE', 'testnet'), null)
})

test('Move Transaction Builders: constructs valid MoveCall transactions for all circle lifecycle steps', () => {
  // 1. Create Circle
  const createTx = buildCreateCircleTx({
    packageId: MOCK_PKG_ID,
    name: 'Test Circle',
    contributionAmountBase: 1000000000n,
    cycleDurationMs: 604800000n,
    members: [MOCK_ALICE, MOCK_BOB],
    payoutOrder: [MOCK_ALICE, MOCK_BOB],
    coinType: '0x2::sui::SUI',
  })
  const createData = createTx.getData()
  assert.equal(createData.commands.length, 1)
  assert.equal(createData.commands[0].$kind, 'MoveCall')
  assert.equal(createData.commands[0].MoveCall.function, 'create_circle')
  assert.equal(createData.commands[0].MoveCall.typeArguments[0], '0x2::sui::SUI')

  // 2. Accept Circle
  const acceptTx = buildAcceptCircleTx({
    packageId: MOCK_PKG_ID,
    circleObjectId: MOCK_CIRCLE_ID,
    coinType: '0x2::sui::SUI',
  })
  const acceptData = acceptTx.getData()
  assert.equal(acceptData.commands.length, 1)
  assert.equal(acceptData.commands[0].MoveCall.function, 'accept_circle')

  // 3. Contribute (Native SUI split from gas)
  const contributeSuiTx = buildContributeTx({
    packageId: MOCK_PKG_ID,
    circleObjectId: MOCK_CIRCLE_ID,
    amountBase: 1000000000n,
    coinType: '0x2::sui::SUI',
  })
  const contributeSuiData = contributeSuiTx.getData()
  assert.equal(contributeSuiData.commands.length, 2, 'SplitCoins + MoveCall')
  assert.equal(contributeSuiData.commands[0].$kind, 'SplitCoins')
  assert.equal(contributeSuiData.commands[1].MoveCall.function, 'contribute')

  // 4. Contribute (Non-native USDC split from coin object)
  const mockCoinObj = '0x' + 'c'.repeat(64)
  const contributeUsdcTx = buildContributeTx({
    packageId: MOCK_PKG_ID,
    circleObjectId: MOCK_CIRCLE_ID,
    amountBase: 50000000n,
    coinType: '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
    primaryCoinObjectId: mockCoinObj,
  })
  const contributeUsdcData = contributeUsdcTx.getData()
  assert.equal(contributeUsdcData.commands.length, 2)
  assert.equal(contributeUsdcData.commands[0].$kind, 'SplitCoins')
  assert.equal(contributeUsdcData.commands[1].MoveCall.typeArguments[0].includes('usdc::USDC'), true)

  // 5. Claim Cycle
  const claimTx = buildClaimCycleTx({
    packageId: MOCK_PKG_ID,
    circleObjectId: MOCK_CIRCLE_ID,
    coinType: '0x2::sui::SUI',
  })
  const claimData = claimTx.getData()
  assert.equal(claimData.commands.length, 1)
  assert.equal(claimData.commands[0].MoveCall.function, 'claim_cycle')

  // 6. Claim Refund
  const refundTx = buildClaimRefundTx({
    packageId: MOCK_PKG_ID,
    circleObjectId: MOCK_CIRCLE_ID,
    coinType: '0x2::sui::SUI',
  })
  const refundData = refundTx.getData()
  assert.equal(refundData.commands.length, 1)
  assert.equal(refundData.commands[0].MoveCall.function, 'claim_refund')
})

test('Steward Group Report: generates un-gated report with member breakdown and Walrus context', async () => {
  const circleId = 'report-test-circle-01'
  upsertCircleRoster({
    circleId,
    circleName: 'Report Testing Circle',
    poolAddress: MOCK_CIRCLE_ID,
    tokenType: '0x2::sui::SUI',
    contributionPerMember: 1,
    cycleLength: 'Weekly',
    currentCycle: 1,
    organizerAddress: MOCK_ALICE,
    members: [
      { id: 'm1', name: 'Alice', address: MOCK_ALICE },
      { id: 'm2', name: 'Bob', address: MOCK_BOB },
    ],
  })

  const report = await runGroupReport({
    circleId,
    withMemory: false,
  })

  assert.equal(report.circleId, circleId)
  assert.equal(report.circleName, 'Report Testing Circle')
  assert.equal(report.currentCycle, 1)
  assert.equal(report.totalExpectedContributions, 2)
  assert.ok(report.reportMarkdown.includes('# Ajo Group Steward Report: Report Testing Circle'))
  assert.ok(report.reportMarkdown.includes('Member Contribution Status'))
})

test('Historical Lateness & Missed Deadlines: duration formatting, payment classification, and factual memory persistence', async () => {
  const { formatElapsedDuration, classifyChainContribution } = await import('../server/payment-policy.mjs')
  const { persistHistoricalLatenessToWalrus } = await import('../server/walrus-memory.mjs')

  // 1. Duration formatting
  assert.equal(formatElapsedDuration(0), '0 hours late')
  assert.equal(formatElapsedDuration(4 * 3600 * 1000), '4 hours late')
  assert.equal(formatElapsedDuration(24 * 3600 * 1000), '1 day, 0 hours late')
  assert.equal(formatElapsedDuration((2 * 24 + 4) * 3600 * 1000), '2 days, 4 hours late')

  // 2. Partial payment before deadline + late completion after deadline
  const windowEndMs = Date.parse('2026-09-01T23:59:59Z')
  const expected = {
    poolAddress: MOCK_CIRCLE_ID,
    memberAddress: MOCK_BOB,
    token: '0x2::sui::SUI',
    expectedAmount: 1000,
    windowStart: '2026-09-01T00:00:00Z',
    windowEnd: new Date(windowEndMs).toISOString(),
  }

  // Bob pays 400 before deadline
  const onTimeTx = {
    txDigest: 'DgBobOnTime',
    sender: MOCK_BOB,
    recipient: MOCK_CIRCLE_ID,
    tokenType: '0x2::sui::SUI',
    amount: 400,
    timestampMs: windowEndMs - 3600 * 1000, // 1 hour before deadline
  }

  // Bob pays remaining 600 exactly 2 days and 4 hours after deadline
  const lateTx = {
    txDigest: 'DgBobLateCompletion',
    sender: MOCK_BOB,
    recipient: MOCK_CIRCLE_ID,
    tokenType: '0x2::sui::SUI',
    amount: 600,
    timestampMs: windowEndMs + (2 * 24 + 4) * 3600 * 1000,
  }

  const lateResult = classifyChainContribution({
    lookupStatus: 'found',
    expected,
    transfers: [onTimeTx, lateTx],
  })

  assert.equal(lateResult.status, 'Late')
  assert.equal(lateResult.code, 'late')
  assert.equal(lateResult.amountReceived, 1000)
  assert.equal(lateResult.amountPaidByDeadline, 400)
  assert.equal(lateResult.amountPaidAfterDeadline, 600)
  assert.equal(lateResult.amountRemainingOutstanding, 0)
  assert.equal(lateResult.isLateCompletion, true)
  assert.equal(lateResult.elapsedDisplay, '2 days, 4 hours late')
  assert.equal(lateResult.latePaymentDigest, 'DgBobLateCompletion')

  // 3. Member who made partial payment but has NOT completed by deadline
  const missedDeadlineResult = classifyChainContribution({
    lookupStatus: 'found',
    expected,
    isPastDeadline: true,
    transfers: [onTimeTx],
  })

  assert.equal(missedDeadlineResult.status, 'MissedDeadline')
  assert.equal(missedDeadlineResult.code, 'missed_deadline')
  assert.equal(missedDeadlineResult.amountReceived, 400)
  assert.equal(missedDeadlineResult.amountPaidByDeadline, 400)
  assert.equal(missedDeadlineResult.amountRemainingOutstanding, 600)
  assert.equal(missedDeadlineResult.missedDeadline, true)

  // 4. Idempotent Walrus Memory write for historical lateness
  const mockMemwalClient = {
    async rememberAndWait(serialized, namespace, options) {
      assert.ok(serialized.includes('Historical Contribution Behavior'))
      assert.ok(serialized.includes('2 days, 4 hours late'))
      assert.ok(serialized.includes('DgBobLateCompletion'))
      return {
        id: 'mem_late_bob_01',
        blob_id: 'blob_late_bob_real_hash_987654',
        namespace,
      }
    },
    destroy() {},
  }

  const memoryRecord = await persistHistoricalLatenessToWalrus({
    circleId: 'report-test-circle-01',
    cycle: 1,
    memberAddress: MOCK_BOB,
    memberId: 'm2',
    requiredAmount: 1000,
    amountPaidByDeadline: lateResult.amountPaidByDeadline,
    amountRemainingOutstanding: lateResult.amountRemainingOutstanding,
    deadlineTimestamp: lateResult.deadlineTimestamp,
    latePaymentDigest: lateResult.latePaymentDigest,
    latePaymentTimestamp: lateResult.latePaymentTimestamp,
    elapsedMs: lateResult.elapsedMs,
    elapsedDisplay: lateResult.elapsedDisplay,
    memwalClientOverride: mockMemwalClient,
  })

  assert.equal(memoryRecord.recorded, true)
  assert.equal(memoryRecord.durableWalrusConfirmed, true)
  assert.equal(memoryRecord.walrusBlobId, 'blob_late_bob_real_hash_987654')
  assert.equal(memoryRecord.label, 'historical contribution behavior')
  assert.equal(memoryRecord.elapsedDisplay, '2 days, 4 hours late')
})
