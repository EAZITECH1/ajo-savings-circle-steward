import test from 'node:test'
import assert from 'node:assert/strict'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import {
  upsertCircleRoster,
  getCircleRoster,
  clearCircleRuntimeState,
  proposeCircleMemory,
  issueConfirmationChallenge,
  confirmAndWriteMemory,
  persistCircleConfigToWalrus,
  persistTxDigestAssociationToWalrus,
  restoreCircleFromWalrus,
  serializeCircleConfigForWalrus,
  QUARANTINED_SYNTHETIC_BLOB_IDS,
} from '../server/walrus-memory.mjs'
import {
  getSubmittedDigests,
  getServerVerifiedContribution,
} from '../server/sui-verifier.mjs'
import { WalletAuthError } from '../server/wallet-auth.mjs'

const TEST_ENV = {
  TATUM_API_KEY: 'tatum_test_key_valid_length_1234',
  TATUM_API_BASE: 'https://api.tatum.io',
  SUI_NETWORK: 'testnet',
  SUI_TOKEN_TYPE: '0x2::sui::SUI',
  SUI_TOKEN_DECIMALS: '9',
  MEMWAL_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  MEMWAL_ACCOUNT_ID: '0x111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000',
  MEMWAL_SERVER_URL: 'https://relayer.memory.walrus.xyz',
  MEMWAL_NAMESPACE_PREFIX: 'ajo-circle',
  RATE_LIMIT_RPS: '100',
}

const VALID_DIGEST_A = '9fK3mP7qR2vW5xY8zB4nC6dF8gH1jL3kM5pQ7rS9tU2v'
const VALID_DIGEST_B = '4bN7pQ9rS2tU5vW8xY1zC3dF6gH8jK2mL4nP6qR8sT1u'

/**
 * Isolated in-memory mock of the @mysten-incubation/memwal SDK client.
 * Never makes network calls or touches Walrus Mainnet.
 */
function createMockMemWalStore() {
  const blobs = [] // { blob_id, namespace, text, created_at }
  let seq = 1

  return {
    blobs,
    addRawBlob({ blobId, namespace, text, createdAt = new Date().toISOString() }) {
      blobs.push({
        blob_id: blobId || `mock_walrus_blob_${seq++}`,
        namespace,
        text,
        created_at: createdAt,
      })
    },
    createClient(options = {}) {
      return {
        async rememberAndWait(text, namespace) {
          const blobId = `mock_walrus_blob_${seq++}`
          const createdAt = new Date().toISOString()
          blobs.push({
            blob_id: blobId,
            namespace,
            text,
            created_at: createdAt,
          })
          return {
            id: `job_${seq}`,
            job_id: `job_${seq}`,
            blob_id: blobId,
            namespace,
            owner: '0xowner',
          }
        },
        async restore(namespace) {
          if (options.throwOnRestore) {
            throw new Error(options.throwOnRestore)
          }
          const inNs = blobs.filter((b) => b.namespace === namespace)
          return {
            restored: inNs.length,
            skipped: 0,
            failed: options.restoreFailedCount || 0,
            total: inNs.length,
            namespace,
            owner: '0xowner',
            truncated: Boolean(options.restoreTruncated),
          }
        },
        async listMemories({ namespace }) {
          const inNs = blobs.filter((b) => !namespace || b.namespace === namespace)
          const extra = (options.extraInventoryBlobIds || []).map((bid) => ({
            memory_id: `mem_${bid}`,
            namespace_id: namespace,
            blob_id: bid,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            size: 256,
            status: 'active',
          }))
          return {
            memories: [
              ...inNs.map((b, idx) => ({
                memory_id: `mem_${idx + 1}`,
                namespace_id: b.namespace,
                blob_id: b.blob_id,
                created_at: b.created_at,
                updated_at: b.created_at,
                size: b.text.length,
                status: 'active',
              })),
              ...extra,
            ],
            next_cursor: null,
            has_more: false,
            snapshot_version: 1,
            deleted: [],
            must_resync: false,
          }
        },
        async recall({ namespace }) {
          const omitSet = new Set(options.omitFromRecallBlobIds || [])
          const inNs = blobs.filter(
            (b) => b.namespace === namespace && !omitSet.has(b.blob_id)
          )
          return {
            results: inNs.map((b, idx) => ({
              blob_id: b.blob_id,
              text: b.text,
              distance: 0.05 + idx * 0.01,
              created_at: b.created_at,
            })),
            total: inNs.length,
            dropped_count: options.droppedCount || 0,
          }
        },
        destroy() {},
      }
    },
  }
}

test('Walrus Restart Recovery: persists circle_config, member-signed agreement, and tx_digest_association, clears memory, and reconstructs full state with Tatum re-verification', async () => {
  const kpOrganizer = new Ed25519Keypair()
  const kpMember2 = new Ed25519Keypair()
  const kpOutsider = new Ed25519Keypair()
  const addrOrg = kpOrganizer.getPublicKey().toSuiAddress()
  const addrMem2 = kpMember2.getPublicKey().toSuiAddress()
  const addrOutsider = kpOutsider.getPublicKey().toSuiAddress()
  const poolAddr = '0x978095921852e2fe53ea7fae4f69f2c7285e365d07450cace661c3553c3c4b33'
  const circleId = 'recovery-test-circle-alpha'

  clearCircleRuntimeState(circleId, TEST_ENV)
  const mockStore = createMockMemWalStore()

  // 1. Register circle in memory & persist circle_config to mock Walrus
  upsertCircleRoster(
    {
      circleId,
      circleName: 'Alpha Recovery Circle',
      poolAddress: poolAddr,
      contributionPerMember: 500,
      tokenType: '0x2::sui::SUI',
      cycleLength: 'Monthly',
      currentCycle: 2,
      members: [
        { id: 'm1', name: 'Adaeze Organizer', address: addrOrg },
        { id: 'm2', name: 'Chinedu Member', address: addrMem2 },
      ],
      organizerAddress: addrOrg,
    },
    { authenticatedWalletAddress: addrOrg }
  )

  const persistedConfig = await persistCircleConfigToWalrus(
    {
      circleId,
      memberId: 'm1',
      memberAddress: addrOrg,
      memwalClientOverride: mockStore.createClient(),
    },
    TEST_ENV
  )
  assert.ok(persistedConfig.walrusBlobId.startsWith('mock_walrus_blob_'))
  assert.equal(persistedConfig.version, 1)

  // Verify privacy & data minimization: no tokens, nonces, or raw signatures in serialized Walrus payload
  const rawConfigBlobText = mockStore.blobs[0].text
  assert.equal(rawConfigBlobText.includes('bearerToken'), false)
  assert.equal(rawConfigBlobText.includes('sessionToken'), false)
  assert.equal(rawConfigBlobText.includes('privateKey'), false)

  // 2. Propose and member-sign a 72h grace agreement for m2 in cycle 2
  const proposal = proposeCircleMemory({
    circleId,
    category: 'Agreements',
    title: 'Chinedu 72h Travel Grace Window',
    quote: 'Chinedu may submit his cycle 2 contribution within 72 hours of cycle end.',
    suggestedAction: 'Apply 72h grace period to m2 in cycle 2.',
    memberId: 'm2',
    cycle: 2,
  })
  const challenge = issueConfirmationChallenge({
    circleId,
    proposalId: proposal.id,
    memberId: 'm2',
    memberAddress: addrMem2,
  })
  const signedMsg = await kpMember2.signPersonalMessage(
    new TextEncoder().encode(challenge.message)
  )
  const savedAgreement = await confirmAndWriteMemory(
    {
      circleId,
      proposalId: proposal.id,
      memberId: 'm2',
      memberAddress: addrMem2,
      challengeNonce: challenge.nonce,
      signature: signedMsg.signature,
      confirmationMode: 'wallet_signature_verified',
      memwalClientOverride: mockStore.createClient(),
    },
    TEST_ENV
  )
  assert.equal(savedAgreement.confirmationType, 'wallet_signature_verified')
  assert.ok(savedAgreement.confirmedBy.includes('not full group consensus'))

  // 3. Persist a transaction digest association for m2 in cycle 2
  const savedAssoc = await persistTxDigestAssociationToWalrus(
    {
      circleId,
      cycle: 2,
      memberId: 'm2',
      memberAddress: addrMem2,
      txDigest: VALID_DIGEST_A,
      network: 'testnet',
      authenticatedWalletAddress: addrMem2,
      memwalClientOverride: mockStore.createClient(),
    },
    TEST_ENV
  )
  assert.equal(savedAssoc.verifiedOnChain, false)
  assert.equal(savedAssoc.txDigest, VALID_DIGEST_A)

  // 4. Simulate server restart: wipe all in-memory circle, proposal, memory, and digest state
  clearCircleRuntimeState(circleId, TEST_ENV)
  assert.equal(getCircleRoster(circleId), null)
  assert.deepEqual(getSubmittedDigests(circleId, 2, addrMem2), [])
  assert.equal(getServerVerifiedContribution(circleId, 2, addrMem2), null)

  // 5. Outsider wallet attempting to restore this circle is rejected with 403 before state is rebuilt
  await assert.rejects(
    () =>
      restoreCircleFromWalrus(
        circleId,
        {
          authenticatedWalletAddress: addrOutsider,
          memwalClientOverride: mockStore.createClient(),
        },
        TEST_ENV
      ),
    (err) => err instanceof WalletAuthError && err.statusCode === 403
  )
  assert.equal(getCircleRoster(circleId), null)

  // 6. Member 2 restores the circle; mock Tatum RPC returns a late transfer (30h after windowEnd, within 72h grace)
  let tatumRpcCalls = 0
  const mockTatumRpc = async (_chain, body) => {
    tatumRpcCalls++
    assert.equal(body.method, 'sui_getTransactionBlock')
    assert.equal(body.params[0], VALID_DIGEST_A)
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          jsonrpc: '2.0',
          id: 1,
          result: {
            digest: VALID_DIGEST_A,
            timestampMs: String(Date.parse('2026-09-03T06:00:00Z')), // 30h after windowEnd
            transaction: { data: { sender: addrMem2 } },
            effects: { status: { status: 'success' } },
            balanceChanges: [
              {
                owner: { AddressOwner: poolAddr },
                coinType: '0x2::sui::SUI',
                amount: '500000000000',
              },
            ],
          },
        }
      },
    }
  }

  const restoreReport = await restoreCircleFromWalrus(
    circleId,
    {
      authenticatedWalletAddress: addrMem2,
      windowStart: '2026-09-01T00:00:00Z',
      windowEnd: '2026-09-01T23:59:59Z',
      memwalClientOverride: mockStore.createClient(),
      fetchRpc: mockTatumRpc,
    },
    TEST_ENV
  )

  assert.equal(restoreReport.complete, true)
  assert.equal(restoreReport.recoveryStatus, 'complete')
  assert.equal(restoreReport.conflicts.length, 0)
  assert.equal(restoreReport.missingBlobIds.length, 0)
  assert.equal(restoreReport.missingFields.length, 0)
  assert.equal(restoreReport.malformedRecords.length, 0)
  assert.equal(tatumRpcCalls, 1)

  // Verify reconstructed circle configuration & roster in memory
  const rebuiltCircle = getCircleRoster(circleId)
  assert.ok(rebuiltCircle)
  assert.equal(rebuiltCircle.circleName, 'Alpha Recovery Circle')
  assert.equal(rebuiltCircle.contributionPerMember, 500)
  assert.equal(rebuiltCircle.currentCycle, 2)
  assert.equal(rebuiltCircle.members.length, 2)

  // Verify reconstructed agreement & Tatum re-verification with policy evaluation
  assert.equal(restoreReport.records.length, 1)
  assert.equal(restoreReport.records[0].title, 'Chinedu 72h Travel Grace Window')
  assert.equal(restoreReport.tatumReverifications.length, 1)
  assert.equal(restoreReport.tatumReverifications[0].status, 'Late')
  assert.equal(
    restoreReport.tatumReverifications[0].policy.policyStatus,
    'Accepted under recorded grace agreement'
  )
  assert.equal(restoreReport.tatumReverifications[0].policy.countsTowardPot, true)

  // 7. Repeat restore to prove idempotency
  const secondReport = await restoreCircleFromWalrus(
    circleId,
    {
      authenticatedWalletAddress: addrMem2,
      windowStart: '2026-09-01T00:00:00Z',
      windowEnd: '2026-09-01T23:59:59Z',
      memwalClientOverride: mockStore.createClient(),
      fetchRpc: mockTatumRpc,
    },
    TEST_ENV
  )
  assert.equal(secondReport.complete, true)
  assert.equal(secondReport.records.length, 1)
  assert.equal(getCircleRoster(circleId).members.length, 2)
  assert.deepEqual(getSubmittedDigests(circleId, 2, addrMem2), [VALID_DIGEST_A])
})

test('Walrus Restart Recovery: handles version upgrades, duplicates, malformed records, quarantined blobs, and surfaces conflicts without silently picking one', async () => {
  const kpOrg = new Ed25519Keypair()
  const kpMem = new Ed25519Keypair()
  const addrOrg = kpOrg.getPublicKey().toSuiAddress()
  const addrMem = kpMem.getPublicKey().toSuiAddress()
  const poolAddr = '0x978095921852e2fe53ea7fae4f69f2c7285e365d07450cace661c3553c3c4b33'
  const circleId = 'recovery-conflict-circle'
  const namespace = `ajo-circle:${circleId}`

  clearCircleRuntimeState(circleId, TEST_ENV)
  const mockStore = createMockMemWalStore()

  // Build v1 circle_config and linear v2 upgrade
  const baseCircleV1 = {
    circleId,
    circleName: 'Conflict Test Circle v1',
    poolAddress: poolAddr,
    contributionPerMember: 100,
    tokenType: '0x2::sui::SUI',
    cycleLength: 'Weekly',
    currentCycle: 1,
    organizerAddress: addrOrg,
    members: [
      { id: 'm1', name: 'Org', address: addrOrg },
      { id: 'm2', name: 'Mem', address: addrMem },
    ],
  }
  const textV1 = serializeCircleConfigForWalrus(baseCircleV1, {
    version: 1,
    confirmingAddress: addrOrg,
  })
  const v1Meta = JSON.parse(textV1.split('\n[AJO_MEMORY_META]')[1])

  const baseCircleV2 = {
    ...baseCircleV1,
    circleName: 'Conflict Test Circle v2',
    currentCycle: 2,
  }
  const textV2 = serializeCircleConfigForWalrus(baseCircleV2, {
    version: 2,
    previousConfigHash: v1Meta.configHash,
    confirmingAddress: addrOrg,
  })

  // Add v1, duplicate of v1, and linear v2
  mockStore.addRawBlob({ blobId: 'blob_cfg_v1', namespace, text: textV1 })
  mockStore.addRawBlob({ blobId: 'blob_cfg_v1_dup', namespace, text: textV1 })
  mockStore.addRawBlob({ blobId: 'blob_cfg_v2', namespace, text: textV2 })

  // Add one of the 10 quarantined synthetic blob IDs to prove it is skipped
  const [quarantinedBlobId] = Array.from(QUARANTINED_SYNTHETIC_BLOB_IDS)
  mockStore.addRawBlob({
    blobId: quarantinedBlobId,
    namespace,
    text: textV2,
  })

  const cleanLinearReport = await restoreCircleFromWalrus(
    circleId,
    {
      authenticatedWalletAddress: addrOrg,
      memwalClientOverride: mockStore.createClient(),
    },
    TEST_ENV
  )
  assert.equal(cleanLinearReport.complete, true)
  assert.equal(cleanLinearReport.recoveryStatus, 'complete')
  assert.equal(cleanLinearReport.circle.circleName, 'Conflict Test Circle v2')
  assert.equal(cleanLinearReport.circle.currentCycle, 2)
  assert.equal(cleanLinearReport.duplicateRecordsSkipped.length, 1)
  assert.equal(cleanLinearReport.staleRecordsSkipped.length, 1)
  assert.equal(cleanLinearReport.quarantinedRecordsSkipped.length, 1)

  // Now inject a conflicting v2 config with a different contributionPerMember, a conflicting tx_digest_association, and a malformed record
  const conflictingV2 = serializeCircleConfigForWalrus(
    { ...baseCircleV2, contributionPerMember: 999 },
    {
      version: 2,
      previousConfigHash: v1Meta.configHash,
      confirmingAddress: addrOrg,
    }
  )
  mockStore.addRawBlob({ blobId: 'blob_cfg_v2_conflict', namespace, text: conflictingV2 })
  mockStore.addRawBlob({
    blobId: 'blob_malformed_json',
    namespace,
    text: 'Unstructured text without metadata marker',
  })

  clearCircleRuntimeState(circleId, TEST_ENV)
  const conflictReport = await restoreCircleFromWalrus(
    circleId,
    {
      authenticatedWalletAddress: addrOrg,
      memwalClientOverride: mockStore.createClient(),
    },
    TEST_ENV
  )
  assert.equal(conflictReport.complete, false)
  assert.equal(conflictReport.recoveryStatus, 'conflict')
  assert.ok(
    conflictReport.conflicts.some((c) => c.type === 'circle_config_conflict')
  )
  assert.equal(conflictReport.malformedRecords.length, 1)
  // Conflicting circle_config must not be silently applied to circleRegistry
  assert.equal(getCircleRoster(circleId), null)
})

test('Walrus Restart Recovery: detects incomplete recall (missingBlobIds / truncated restore) and fails closed when Tatum or Walrus is unavailable', async () => {
  const kpOrg = new Ed25519Keypair()
  const addrOrg = kpOrg.getPublicKey().toSuiAddress()
  const poolAddr = '0x978095921852e2fe53ea7fae4f69f2c7285e365d07450cace661c3553c3c4b33'
  const circleId = 'recovery-outage-circle'

  clearCircleRuntimeState(circleId, TEST_ENV)
  const mockStore = createMockMemWalStore()

  upsertCircleRoster(
    {
      circleId,
      circleName: 'Outage Test Circle',
      poolAddress: poolAddr,
      contributionPerMember: 250,
      tokenType: '0x2::sui::SUI',
      cycleLength: 'Monthly',
      currentCycle: 1,
      members: [{ id: 'm1', name: 'Org', address: addrOrg }],
      organizerAddress: addrOrg,
    },
    { authenticatedWalletAddress: addrOrg }
  )

  await persistCircleConfigToWalrus(
    {
      circleId,
      memberId: 'm1',
      memberAddress: addrOrg,
      memwalClientOverride: mockStore.createClient(),
    },
    TEST_ENV
  )

  await persistTxDigestAssociationToWalrus(
    {
      circleId,
      cycle: 1,
      memberId: 'm1',
      memberAddress: addrOrg,
      txDigest: VALID_DIGEST_B,
      network: 'testnet',
      authenticatedWalletAddress: addrOrg,
      memwalClientOverride: mockStore.createClient(),
    },
    TEST_ENV
  )

  // 1. Simulate incomplete recall: listMemories reports 'blob_unrecalled_99' that recall() does not return
  clearCircleRuntimeState(circleId, TEST_ENV)
  const incompleteReport = await restoreCircleFromWalrus(
    circleId,
    {
      authenticatedWalletAddress: addrOrg,
      memwalClientOverride: mockStore.createClient({
        extraInventoryBlobIds: ['blob_unrecalled_99'],
      }),
      // Simulate Tatum outage during re-verification
      fetchRpc: async () => {
        throw new Error('Tatum gateway 503 Service Unavailable')
      },
    },
    TEST_ENV
  )

  assert.equal(incompleteReport.complete, false)
  assert.equal(incompleteReport.recoveryStatus, 'incomplete')
  assert.deepEqual(incompleteReport.missingBlobIds, ['blob_unrecalled_99'])
  assert.ok(incompleteReport.recoveryPath.length > 0)

  // Because Tatum threw an outage error, the restored digest association MUST remain Unverified (never Verified)
  assert.equal(incompleteReport.restoredTxAssociations.length, 1)
  assert.equal(incompleteReport.restoredTxAssociations[0].verifiedOnChain, false)
  assert.equal(incompleteReport.tatumReverifications.length, 1)
  assert.equal(incompleteReport.tatumReverifications[0].status, 'Unverified')
  assert.ok(
    incompleteReport.tatumReverifications[0].error.includes('Tatum gateway 503')
  )

  // 2. Simulate Walrus outage during restore -> fails closed
  await assert.rejects(
    () =>
      restoreCircleFromWalrus(
        circleId,
        {
          authenticatedWalletAddress: addrOrg,
          memwalClientOverride: mockStore.createClient({
            throwOnRestore: 'Walrus relayer unreachable (502)',
          }),
        },
        TEST_ENV
      ),
    /Walrus relayer unreachable/
  )
})
