import test from 'node:test'
import assert from 'node:assert/strict'
import { loadDotEnvIfPresent, loadConfig } from '../server/config.mjs'
import {
  checkWalrusMemoryHealth,
  recallCircleMemories,
  upsertCircleRoster,
  isQuarantinedSyntheticRecord,
} from '../server/walrus-memory.mjs'
import { WalletAuthError } from '../server/wallet-auth.mjs'
import {
  checkTatumSuiStatus,
  lookupSuiTransactionViaTatum,
  verifyMemberContributionOnSui,
  clearSubmittedDigests,
} from '../server/sui-verifier.mjs'
import { runStewardChat } from '../server/steward-llm.mjs'

loadDotEnvIfPresent()

const liveConfig = loadConfig()

// Real public Sui Testnet transfer transaction:
// Transfers 1 SUI (1_000_000_000 MIST, 0x2::sui::SUI) from SENDER to RECIPIENT at 2026-11-03T13:30:37.833Z
const PUBLIC_TESTNET_TX_DIGEST = '7Dqpcnkodzc1MX2nrAoVdz9AwUC9KFy2p3ATVppHxx7m'
const PUBLIC_TESTNET_SENDER =
  '0x059e21c19f9a8233f4fcbc11fba713c022dcf9d3632961b7ac7836a9ffa8d94f'
const PUBLIC_TESTNET_RECIPIENT =
  '0x978095921852e2fe53ea7fae4f69f2c7285e365d07450cace661c3553c3c4b33'
const PUBLIC_TESTNET_TIMESTAMP = '2026-11-03T13:30:37.833Z'

test(
  'Live Integration — Walrus Memory Mainnet read-only health and quarantine enforcement',
  {
    skip: !liveConfig.integrations.memwal.configured
      ? `SKIPPED: Walrus Memory credentials absent (${liveConfig.integrations.memwal.issues.join('; ')})`
      : false,
  },
  async () => {
    const health = await checkWalrusMemoryHealth()
    assert.equal(health.connected, true)
    assert.equal(health.configured, true)

    // Runtime recall on the quarantined synthetic circle MUST be blocked (403)
    await assert.rejects(
      () => recallCircleMemories('lagos-techies-seed-circle', 'grace period', { limit: 5 }),
      (err) => err instanceof WalletAuthError && err.statusCode === 403
    )

    // Read-only audit inventory (`includeQuarantinedForAudit: true`) can inspect the records without writing/deleting
    const auditRecall = await recallCircleMemories(
      'lagos-techies-seed-circle',
      'grace period contractor invoice',
      { limit: 5, includeQuarantinedForAudit: true }
    )
    assert.ok(Array.isArray(auditRecall.records))
    assert.ok(auditRecall.records.length > 0)
    for (const r of auditRecall.records) {
      assert.equal(isQuarantinedSyntheticRecord(r), true)
    }
  }
)

test(
  'Live Integration — Tatum Sui Testnet end-to-end contribution verification (sender, recipient, coinType, amount, status, timestamp)',
  {
    skip: !liveConfig.integrations.tatum.configured
      ? `SKIPPED: Tatum Sui credentials absent (${liveConfig.integrations.tatum.issues.join('; ')})`
      : false,
  },
  async () => {
    const status = await checkTatumSuiStatus()
    assert.equal(status.connected, true, `Tatum Sui Gateway failed: ${status.error || 'unknown error'}`)
    assert.ok(status.chainId)

    // 1. Raw transaction lookup via Tatum Sui GraphQL Gateway
    const lookup = await lookupSuiTransactionViaTatum(
      PUBLIC_TESTNET_TX_DIGEST,
      PUBLIC_TESTNET_RECIPIENT
    )
    assert.equal(
      lookup.lookupStatus,
      'found',
      `Expected found, got ${lookup.lookupStatus}: ${lookup.lookupError}`
    )
    assert.ok(Array.isArray(lookup.transfers) && lookup.transfers.length > 0)

    const matchingTransfer = lookup.transfers.find(
      (t) =>
        t.sender === PUBLIC_TESTNET_SENDER &&
        t.recipient === PUBLIC_TESTNET_RECIPIENT &&
        t.amount === 1
    )
    assert.ok(matchingTransfer, 'Expected positive 1 SUI transfer from sender to recipient')
    assert.equal(matchingTransfer.executionSuccess, true)
    assert.equal(new Date(matchingTransfer.timestampMs).toISOString(), PUBLIC_TESTNET_TIMESTAMP)

    // 2. End-to-end contribution verification: On-time window -> Chain status Verified, Policy Accepted on time
    clearSubmittedDigests('live-testnet-circle', 1, PUBLIC_TESTNET_SENDER)
    const onTimeVerified = await verifyMemberContributionOnSui({
      circleId: 'live-testnet-circle',
      poolAddress: PUBLIC_TESTNET_RECIPIENT,
      memberAddress: PUBLIC_TESTNET_SENDER,
      memberId: 'm1',
      memberName: 'Testnet Contributor',
      token: '0x2::sui::SUI',
      expectedAmount: 1,
      windowStart: '2026-11-03T00:00:00.000Z',
      windowEnd: '2026-11-03T23:59:59.000Z',
      cycle: 1,
      txDigest: PUBLIC_TESTNET_TX_DIGEST,
      withMemory: false,
    })
    assert.equal(onTimeVerified.status, 'Verified')
    assert.equal(onTimeVerified.code, 'verified')
    assert.equal(onTimeVerified.amountReceived, 1)
    assert.equal(onTimeVerified.timestamp, PUBLIC_TESTNET_TIMESTAMP)
    assert.equal(onTimeVerified.policy.chainStatus, 'Verified')
    assert.equal(onTimeVerified.policy.policyStatus, 'Accepted on time')
    assert.equal(onTimeVerified.policy.countsTowardPot, true)

    // 3. End-to-end contribution verification: Deadline before tx timestamp -> Chain status Late
    clearSubmittedDigests('live-testnet-circle', 2, PUBLIC_TESTNET_SENDER)
    const lateVerified = await verifyMemberContributionOnSui({
      circleId: 'live-testnet-circle',
      poolAddress: PUBLIC_TESTNET_RECIPIENT,
      memberAddress: PUBLIC_TESTNET_SENDER,
      memberId: 'm1',
      memberName: 'Testnet Contributor',
      token: '0x2::sui::SUI',
      expectedAmount: 1,
      windowStart: '2026-11-01T00:00:00.000Z',
      windowEnd: '2026-11-02T23:59:59.000Z', // 13.5h before tx timestamp
      cycle: 2,
      txDigest: PUBLIC_TESTNET_TX_DIGEST,
      withMemory: false,
    })
    assert.equal(lateVerified.status, 'Late')
    assert.equal(lateVerified.code, 'late')
    assert.equal(lateVerified.amountReceived, 1)
    assert.equal(lateVerified.policy.chainStatus, 'Late')
    assert.equal(lateVerified.policy.policyStatus, 'Unexcused late payment')
    assert.equal(lateVerified.policy.countsTowardPot, false)
  }
)

test(
  'Live Integration — LLM Steward chat with server-verified Sui Testnet contribution',
  {
    skip: !liveConfig.integrations.llm.configured
      ? `SKIPPED: LLM credentials absent (${liveConfig.integrations.llm.issues.join('; ')})`
      : false,
  },
  async () => {
    upsertCircleRoster({
      circleId: 'live-testnet-circle',
      circleName: 'Live Testnet Circle',
      poolAddress: PUBLIC_TESTNET_RECIPIENT,
      contributionPerMember: 1,
      tokenType: '0x2::sui::SUI',
      cycleLength: 'Monthly',
      currentCycle: 1,
      members: [
        {
          id: 'm1',
          name: 'Testnet Contributor',
          address: PUBLIC_TESTNET_SENDER,
          avatarColor: '',
        },
      ],
    })

    const output = await runStewardChat({
      circleId: 'live-testnet-circle',
      circleName: 'Live Testnet Circle',
      message: 'Has Testnet Contributor paid for Cycle 1? Cite the transaction digest.',
      currentCycle: 1,
      withMemory: false,
      windowStart: '2026-11-03T00:00:00.000Z',
      windowEnd: '2026-11-03T23:59:59.000Z',
    })
    assert.ok(output.reply.length > 0)
    assert.ok(Array.isArray(output.citedMemories))
    assert.equal(output.citedMemories.length, 0)
  }
)
