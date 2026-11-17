import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidSuiDigest,
  parseSuiGraphqlTransaction,
  verifyMemberContributionOnSui,
  clearSubmittedDigests,
} from '../server/sui-verifier.mjs'

const TEST_ENV = {
  TATUM_API_KEY: 'tatum_test_key_valid_length_1234',
  TATUM_API_BASE: 'https://api.tatum.io',
  SUI_NETWORK: 'testnet',
  SUI_TOKEN_TYPE: '0x2::sui::SUI',
  SUI_TOKEN_DECIMALS: '9',
  RATE_LIMIT_RPS: '100',
  RATE_LIMIT_MAX_RETRIES: '1',
  RATE_LIMIT_BACKOFF_MS: '50',
}

const VALID_DIGEST_1 = '9fK3mP7qR2vW5xY8zB4nC6dF8gH1jL3kM5pQ7rS9tU2v'
const VALID_DIGEST_2 = '4bN7pQ9rS2tU5vW8xY1zC3dF6gH8jK2mL4nP6qR8sT1u'

function makeRpcResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

test('Sui digest validation: accepts Base58 32-byte digests and rejects 0x hex or short strings', () => {
  assert.equal(isValidSuiDigest(VALID_DIGEST_1), true)
  assert.equal(isValidSuiDigest('0x66ff11ab223390fe'), false)
  assert.equal(isValidSuiDigest('short'), false)
  assert.equal(isValidSuiDigest(''), false)
})

test('parseSuiGraphqlTransaction: extracts balanceChanges and rejects incomplete responses', () => {
  const incomplete = parseSuiGraphqlTransaction(
    VALID_DIGEST_1,
    {
      sender: { address: '0x1111' },
      effects: { status: 'SUCCESS' },
      // missing effects.balanceChanges.nodes and effects.timestamp
    },
    '0x2222',
    9
  )
  assert.equal(incomplete.lookupStatus, 'incomplete_fields')
  assert.ok(incomplete.lookupError.includes('effects.balanceChanges.nodes'))

  const validBlock = parseSuiGraphqlTransaction(
    VALID_DIGEST_1,
    {
      digest: VALID_DIGEST_1,
      sender: { address: '0x0002' },
      effects: {
        status: 'SUCCESS',
        timestamp: '2026-09-01T12:00:00Z',
        balanceChanges: {
          nodes: [
            {
              owner: { address: '0x0002' },
              coinType: { repr: '0x2::sui::SUI' },
              amount: '-500000000000',
            },
            {
              owner: { address: '0x0001' },
              coinType: { repr: '0x2::sui::SUI' },
              amount: '500000000000',
            },
          ],
        },
      },
    },
    '0x0001',
    9
  )
  assert.equal(validBlock.lookupStatus, 'found')
  assert.equal(validBlock.transfers.length, 1)
  assert.equal(validBlock.transfers[0].amount, 500)
  assert.equal(validBlock.transfers[0].recipient, '0x0001')
})

test('verifyMemberContributionOnSui: handles unconfigured Tatum, malformed digest, not_found, late + grace policy, and split payments', async () => {
  const baseParams = {
    circleId: 'test-circle-sui',
    poolAddress: '0x0001',
    memberAddress: '0x0002',
    memberId: 'm2',
    memberName: 'Tunde Ojo',
    token: '0x2::sui::SUI',
    expectedAmount: 500,
    windowStart: '2026-09-01T00:00:00Z',
    windowEnd: '2026-09-01T23:59:59Z',
    cycle: 5,
  }

  // 1. Unconfigured Tatum env -> Unverified
  const unconfRes = await verifyMemberContributionOnSui(baseParams, { env: {} })
  assert.equal(unconfRes.status, 'Unverified')
  assert.equal(unconfRes.policy.chainStatus, 'Unverified')

  // 2. Configured Tatum env, no digest submitted yet -> Pending
  clearSubmittedDigests('test-circle-sui', 5, '0x0002')
  const pendingRes = await verifyMemberContributionOnSui(baseParams, { env: TEST_ENV })
  assert.equal(pendingRes.status, 'Pending')
  assert.equal(pendingRes.policy.chainStatus, 'Pending')

  // 3. Malformed digest -> Unverified
  const malformedRes = await verifyMemberContributionOnSui(
    { ...baseParams, txDigest: '0x66ff11ab223390fe' },
    { env: TEST_ENV }
  )
  assert.equal(malformedRes.status, 'Unverified')

  // 4. Late transaction digest -> Chain fact is Late, policy is Accepted under grace when withMemory=true
  clearSubmittedDigests('test-circle-sui', 5, '0x0002')
  const graceMemories = [
    {
      id: 'mem-grace-member2',
      category: 'Agreements',
      title: 'Member Two 72-Hour Contractor Grace Window',
      quote: 'Member Two may submit his contribution within 72 hours of cycle open.',
      memberId: 'm2',
      walrusBlobId: 'verified_walrus_blob_grace_001',
    },
  ]

  const lateGqlCaller = async (_chain, _query, variables) => {
    assert.equal(variables.digest, VALID_DIGEST_1)
    return makeRpcResponse({
      data: {
        transaction: {
          digest: VALID_DIGEST_1,
          sender: { address: '0x0002' },
          effects: {
            status: 'SUCCESS',
            timestamp: '2026-09-03T10:00:00Z', // ~34h after windowEnd (within 72h grace)
            balanceChanges: {
              nodes: [
                {
                  owner: { address: '0x0001' },
                  coinType: { repr: '0x2::sui::SUI' },
                  amount: '500000000000',
                },
              ],
            },
          },
        },
      },
    })
  }

  const lateWithMem = await verifyMemberContributionOnSui(
    {
      ...baseParams,
      txDigest: VALID_DIGEST_1,
      withMemory: true,
      memories: graceMemories,
    },
    { env: TEST_ENV, fetchGraphql: lateGqlCaller }
  )
  assert.equal(lateWithMem.status, 'Late')
  assert.equal(lateWithMem.policy.chainStatus, 'Late')
  assert.equal(lateWithMem.policy.policyStatus, 'Accepted under recorded grace agreement')
  assert.equal(lateWithMem.policy.countsTowardPot, true)

  const lateWithoutMem = await verifyMemberContributionOnSui(
    {
      ...baseParams,
      txDigest: VALID_DIGEST_1,
      withMemory: false,
      memories: graceMemories,
    },
    { env: TEST_ENV, fetchGraphql: lateGqlCaller }
  )
  assert.equal(lateWithoutMem.status, 'Late')
  assert.equal(lateWithoutMem.policy.chainStatus, 'Late')
  assert.equal(lateWithoutMem.policy.policyStatus, 'Unexcused late payment')
  assert.equal(lateWithoutMem.policy.countsTowardPot, false)

  // 5. Split payments: 2 sequential partial digests for member 0x0005 within 48h -> aggregated to Verified
  clearSubmittedDigests('test-circle-sui', 5, '0x0002')
  clearSubmittedDigests('test-circle-sui', 5, '0x0005')
  const splitGqlCaller = async (_chain, _query, variables) => {
    const requestedDigest = variables.digest
    const ts =
      requestedDigest === VALID_DIGEST_1
        ? '2026-09-01T06:00:00Z'
        : '2026-09-01T18:00:00Z'
    return makeRpcResponse({
      data: {
        transaction: {
          digest: requestedDigest,
          sender: { address: '0x0005' },
          effects: {
            status: 'SUCCESS',
            timestamp: ts,
            balanceChanges: {
              nodes: [
                {
                  owner: { address: '0x0001' },
                  coinType: { repr: '0x2::sui::SUI' },
                  amount: '250000000000', // 250 SUI each
                },
              ],
            },
          },
        },
      },
    })
  }

  const tranche1 = await verifyMemberContributionOnSui(
    {
      ...baseParams,
      memberAddress: '0x0005',
      memberId: 'm5',
      memberName: 'Emeka Nwosu',
      txDigest: VALID_DIGEST_1,
    },
    { env: TEST_ENV, fetchGraphql: splitGqlCaller }
  )
  assert.equal(tranche1.status, 'Partial')
  assert.equal(tranche1.amountReceived, 250)

  const tranche2 = await verifyMemberContributionOnSui(
    {
      ...baseParams,
      memberAddress: '0x0005',
      memberId: 'm5',
      memberName: 'Emeka Nwosu',
      txDigest: VALID_DIGEST_2,
    },
    { env: TEST_ENV, fetchGraphql: splitGqlCaller }
  )
  assert.equal(tranche2.status, 'Verified')
  assert.equal(tranche2.amountReceived, 500)
  assert.deepEqual(tranche2.txDigests, [VALID_DIGEST_1, VALID_DIGEST_2])
})
