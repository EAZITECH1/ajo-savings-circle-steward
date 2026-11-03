import test from 'node:test'
import assert from 'node:assert/strict'
import { loadDotEnvIfPresent, loadConfig } from '../server/config.mjs'
import {
  checkWalrusMemoryHealth,
  recallCircleMemories,
  restoreCircleMemoriesFromWalrus,
} from '../server/walrus-memory.mjs'
import { checkTatumSuiStatus, lookupSuiTransactionViaTatum } from '../server/sui-verifier.mjs'
import { runStewardChat } from '../server/steward-llm.mjs'

loadDotEnvIfPresent()

const liveConfig = loadConfig()

test(
  'Live Integration — Walrus Memory Mainnet health, recall, and restore',
  {
    skip: !liveConfig.integrations.memwal.configured
      ? `SKIPPED: Walrus Memory credentials absent (${liveConfig.integrations.memwal.issues.join('; ')})`
      : false,
  },
  async () => {
    const health = await checkWalrusMemoryHealth()
    assert.equal(health.connected, true)
    assert.equal(health.configured, true)

    const recall = await recallCircleMemories(
      'lagos-techies-seed-circle',
      'Tunde grace period contractor invoice',
      { limit: 5 }
    )
    assert.ok(Array.isArray(recall.records))
    assert.ok(recall.records.length > 0, 'Expected at least 1 recalled memory from Walrus Mainnet')
    assert.ok(recall.records[0].walrusBlobId, 'Recalled memory must carry a real walrusBlobId')

    const restore = await restoreCircleMemoriesFromWalrus('lagos-techies-seed-circle', 10)
    assert.equal(restore.restoreResult.failed, 0)
    assert.equal(restore.restoreResult.namespace, 'ajo-circle:lagos-techies-seed-circle')
    assert.equal(typeof restore.restoreResult.total, 'number')
    assert.ok(restore.records.length > 0, 'Expected recalled memories after restore')
  }
)

test(
  'Live Integration — Tatum Sui RPC connectivity check',
  {
    skip: !liveConfig.integrations.tatum.configured
      ? `SKIPPED: Tatum Sui credentials absent (${liveConfig.integrations.tatum.issues.join('; ')})`
      : false,
  },
  async () => {
    const status = await checkTatumSuiStatus()
    assert.equal(status.connected, true, `Tatum Sui RPC failed: ${status.error || 'unknown error'}`)
    assert.ok(status.chainId)

    const lookup = await lookupSuiTransactionViaTatum(
      '3jseEdb6UizBY9bfPVtR3GVDrbrfbsviThfL8fRSPTUa',
      '0x4483dd1b153465279d4483930b929e6709a5ed7815c1258733106a529ed284f8'
    )
    assert.equal(lookup.lookupStatus, 'found', `Expected found, got ${lookup.lookupStatus}: ${lookup.lookupError}`)
    assert.ok(Array.isArray(lookup.transfers) && lookup.transfers.length > 0)
  }
)

test(
  'Live Integration — LLM Steward chat with recalled Walrus memories',
  {
    skip: !liveConfig.integrations.llm.configured
      ? `SKIPPED: LLM credentials absent (${liveConfig.integrations.llm.issues.join('; ')})`
      : false,
  },
  async () => {
    const output = await runStewardChat({
      circleId: 'lagos-techies-seed-circle',
      circleName: 'Lagos Techies Seed Circle',
      message: 'Can Tunde pay late this month?',
      currentCycle: 5,
      withMemory: true,
      members: [
        { id: 'm1', name: 'Amina Bello', address: '0x0001', avatarColor: '' },
        { id: 'm2', name: 'Tunde Ojo', address: '0x0002', avatarColor: '' },
      ],
      verifications: {},
    })
    assert.ok(output.reply.length > 0)
    assert.ok(Array.isArray(output.citedMemories))
  }
)
