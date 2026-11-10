import test from 'node:test'
import assert from 'node:assert/strict'
import {
  recordSubmittedDigest,
  getSubmittedDigests,
  verifyMemberContributionOnSui,
  getServerVerifiedContribution,
  lookupSuiTransactionViaTatum,
} from '../server/sui-verifier.mjs'
import { loadConfig } from '../server/config.mjs'

const CONFIRMED_VAULT = '0xb45b010966bb108875fd0df9c85ef961dc92790b67ae7112e7146cd8e4549159'
const CONFIRMED_SENDER = '0x679d547b18cf9f2e77f1d33f932cbf4de5c63dda6a5c5d0e44caf7ae4334cd1b'
const CONFIRMED_DIGEST = 'DtYXEU4zrMFTPdpAuB9VDqUfchJAvJgHDHqivwADKuz7'

test('Contribution Verification & Retry: submitted digest tracking is idempotent and prevents cross-member conflict', () => {
  const circleId = 'test-circle-stage11'
  const cycle = 1
  const memberA = '0x1111111111111111111111111111111111111111111111111111111111111111'
  const digest1 = '5abc1111111111111111111111111111111111111111'

  // Recording first time returns array with the digest
  const list1 = recordSubmittedDigest(circleId, cycle, memberA, digest1, {
    poolAddress: CONFIRMED_VAULT,
    memberId: 'm1',
  })
  assert.ok(list1.includes(digest1))

  // Recording second time is idempotent and does not duplicate
  const list2 = recordSubmittedDigest(circleId, cycle, memberA, digest1, {
    poolAddress: CONFIRMED_VAULT,
    memberId: 'm1',
  })
  assert.equal(list2.filter((d) => d === digest1).length, 1)

  // Querying submitted digests returns recorded digest
  const retrieved = getSubmittedDigests(circleId, cycle, memberA)
  assert.ok(retrieved.includes(digest1))
})

test('Contribution Verification & Retry: live Tatum lookup confirms DtYXEU4zrMFTPdpAuB9VDqUfchJAvJgHDHqivwADKuz7 transfer to vault', async (t) => {
  const cfg = loadConfig()
  if (!cfg.integrations.tatum.configured) {
    t.skip('Tatum is unconfigured in test environment; skipping live testnet lookup')
    return
  }

  // 1. Direct Tatum lookup via Tatum GraphQL/RPC Gateway
  const lookup = await lookupSuiTransactionViaTatum(CONFIRMED_DIGEST, CONFIRMED_VAULT)
  assert.equal(lookup.lookupStatus, 'found')
  assert.ok(lookup.transfers.length > 0)

  const transfer = lookup.transfers[0]
  assert.equal(transfer.txDigest, CONFIRMED_DIGEST)
  assert.equal(transfer.sender.toLowerCase(), CONFIRMED_SENDER.toLowerCase())
  assert.equal(transfer.recipient.toLowerCase(), CONFIRMED_VAULT.toLowerCase())
  assert.equal(transfer.amount, 1)
  assert.equal(transfer.executionSuccess, true)

  // 2. Full server verification against circle rules
  const verified = await verifyMemberContributionOnSui({
    circleId: 'ajo-1-daily',
    poolAddress: CONFIRMED_VAULT,
    memberAddress: CONFIRMED_SENDER,
    memberId: 'm2',
    memberName: 'Daniel',
    token: '0x2::sui::SUI',
    expectedAmount: 1,
    cycle: 1,
    txDigest: CONFIRMED_DIGEST,
    windowStart: '2026-11-07T17:50:00.000Z',
    windowEnd: '2026-11-08T17:50:00.000Z',
  })

  assert.equal(verified.status, 'Verified')
  assert.equal(verified.code, 'verified')
  assert.equal(verified.amountReceived, 1)
  assert.equal(verified.policy?.countsTowardPot, true)
  assert.equal(verified.policy?.policyVerdict, 'good_standing')

  // 3. Confirm server-verified contributions store records the result
  const stored = getServerVerifiedContribution('ajo-1-daily', 1, CONFIRMED_SENDER)
  assert.ok(stored)
  assert.equal(stored.status, 'Verified')
  assert.equal(stored.amountReceived, 1)
})
