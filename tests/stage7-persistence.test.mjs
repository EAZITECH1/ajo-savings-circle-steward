import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createServer } from 'node:http'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import {
  initDatabase,
  closeDatabase,
  getDatabase,
  setDatabaseOutageForTesting,
  StorageConflictError,
} from '../server/db.mjs'
import {
  issueWalletAuthChallenge,
  verifyWalletAuthChallenge,
  requireWalletSession,
  WalletAuthError,
} from '../server/wallet-auth.mjs'
import {
  upsertCircleRoster,
  getCircleRoster,
  listCircleRosters,
  verifyCircleMembership,
  proposeCircleMemory,
  getPendingProposals,
  getCircleProposals,
  issueConfirmationChallenge,
  confirmAndWriteMemory,
  isQuarantinedSyntheticRecord,
  QUARANTINED_SYNTHETIC_BLOB_IDS,
} from '../server/walrus-memory.mjs'
import {
  verifyMemberContributionOnSui,
  getServerVerifiedContribution,
  getPersistedSubmittedTransaction,
  getSubmittedDigests,
} from '../server/sui-verifier.mjs'
import authRoutes from '../server/routes/auth.mjs'
import memoryRoutes from '../server/routes/memory.mjs'

const TEST_TATUM_ENV = {
  TATUM_API_KEY: 'tatum_test_key_valid_length_1234',
  TATUM_API_BASE: 'https://api.tatum.io',
  SUI_NETWORK: 'testnet',
  SUI_TOKEN_TYPE: '0x2::sui::SUI',
  SUI_TOKEN_DECIMALS: '9',
  RATE_LIMIT_RPS: '100',
  RATE_LIMIT_MAX_RETRIES: '1',
  RATE_LIMIT_BACKOFF_MS: '50',
}

const DIGEST_MEMBER_1 = '8aB3cD5eF7gH9jK2mN4pQ6rS8tU1vW3xY5zA7bC9dE2f'

test('Durable SQLite persistence across restarts: circles, memberships, proposals, hashed sessions, nonces, and verified transactions survive restart', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ajo-steward-persist-'))
  const dbFilePath = path.join(tmpDir, 'durable-restart.sqlite')

  try {
    initDatabase(dbFilePath)

    const kpMember1 = new Ed25519Keypair()
    const kpMember2 = new Ed25519Keypair()
    const kpOutsider = new Ed25519Keypair()

    const addr1 = kpMember1.getPublicKey().toSuiAddress()
    const addr2 = kpMember2.getPublicKey().toSuiAddress()
    const addrOutsider = kpOutsider.getPublicKey().toSuiAddress()
    const poolAddr = '0x978095921852e2fe53ea7fae4f69f2c7285e365d07450cace661c3553c3c4b33'

    // 1. Authenticate Member 1 and Member 2
    const ch1 = issueWalletAuthChallenge({ address: addr1 })
    const sig1 = await kpMember1.signPersonalMessage(new TextEncoder().encode(ch1.message))
    const session1 = await verifyWalletAuthChallenge({
      challengeId: ch1.challengeId,
      address: addr1,
      signature: sig1.signature,
    })

    const ch2 = issueWalletAuthChallenge({ address: addr2 })
    const sig2 = await kpMember2.signPersonalMessage(new TextEncoder().encode(ch2.message))
    const session2 = await verifyWalletAuthChallenge({
      challengeId: ch2.challengeId,
      address: addr2,
      signature: sig2.signature,
    })

    // Verify raw bearer token and raw signature are NEVER stored in SQLite
    const rawSessionRows = getDatabase().prepare('SELECT * FROM wallet_sessions').all()
    assert.equal(rawSessionRows.length, 2)
    for (const row of rawSessionRows) {
      assert.equal(row.token, undefined)
      assert.NotEqual?.(row.token_hash, session1.token)
      assert.notEqual(row.token_hash, session1.token)
      assert.notEqual(row.token_hash, session2.token)
      assert.equal(row.token_hash.length, 64) // SHA-256 hex
    }

    // 2. Register circle with Member 1 & Member 2
    upsertCircleRoster(
      {
        circleId: 'durable-circle-1',
        circleName: 'Durable Circle One',
        poolAddress: poolAddr,
        contributionPerMember: 250,
        tokenType: '0x2::sui::SUI',
        cycleLength: 'Monthly',
        currentCycle: 3,
        members: [
          { id: 'm1', name: 'Adaeze Obi', address: addr1 },
          { id: 'm2', name: 'Chinedu Eze', address: addr2 },
        ],
      },
      { authenticatedWalletAddress: addr1 }
    )

    // 3. Stage two proposals; confirm Proposal 1 with Member 2's wallet signature
    const propConfirmed = proposeCircleMemory({
      circleId: 'durable-circle-1',
      category: 'Agreements',
      title: '48-Hour Grace Agreement',
      quote: 'Members with delayed bank transfers have a 48h grace window.',
      suggestedAction: 'Allow 48h grace window for verified late transfers.',
      memberId: 'm2',
      cycle: 3,
      proposedBy: `Adaeze Obi (${addr1})`,
    })

    const propPending = proposeCircleMemory({
      circleId: 'durable-circle-1',
      category: 'Reminder preferences',
      title: 'Evening Reminder Preference',
      quote: 'Send cycle reminders after 18:00 WAT.',
      suggestedAction: 'Schedule reminders for 18:00 WAT.',
      memberId: 'm1',
      cycle: 3,
      proposedBy: `Adaeze Obi (${addr1})`,
    })

    const confChallenge = issueConfirmationChallenge({
      circleId: 'durable-circle-1',
      proposalId: propConfirmed.id,
      memberId: 'm2',
      memberAddress: addr2,
    })
    const propSig = await kpMember2.signPersonalMessage(
      new TextEncoder().encode(confChallenge.message)
    )

    // Use isolated mock MemWal client so unit test never writes synthetic data to Walrus Mainnet
    const isolatedMemWalClient = {
      async rememberAndWait() {
        return {
          id: 'isolated-mem-id-1',
          job_id: 'isolated-job-1',
          blob_id: 'isolated_test_blob_id_durable_001',
          namespace: 'ajo-circle:durable-circle-1',
          owner: '0x1234',
        }
      },
      destroy() {},
    }

    const savedMem = await confirmAndWriteMemory({
      circleId: 'durable-circle-1',
      proposalId: propConfirmed.id,
      memberId: 'm2',
      memberAddress: addr2,
      challengeNonce: confChallenge.nonce,
      signature: propSig.signature,
      memwalClientOverride: isolatedMemWalClient,
    })
    assert.equal(savedMem.walrusBlobId, 'isolated_test_blob_id_durable_001')

    // 4. Verify a Sui transaction for Member 1 via Tatum RPC fixture
    const txTimestampMs = Date.parse('2026-10-01T12:00:00.000Z')
    const rpcCaller = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          jsonrpc: '2.0',
          id: 1,
          result: {
            digest: DIGEST_MEMBER_1,
            timestampMs: String(txTimestampMs),
            transaction: { data: { sender: addr1 } },
            effects: { status: { status: 'success' } },
            balanceChanges: [
              {
                owner: { AddressOwner: poolAddr },
                coinType: '0x2::sui::SUI',
                amount: '250000000000', // 250 SUI (9 decimals)
              },
            ],
          },
        }
      },
    })

    const verifiedContribution = await verifyMemberContributionOnSui(
      {
        circleId: 'durable-circle-1',
        poolAddress: poolAddr,
        memberAddress: addr1,
        memberId: 'm1',
        memberName: 'Adaeze Obi',
        token: '0x2::sui::SUI',
        expectedAmount: 250,
        windowStart: '2026-10-01T00:00:00.000Z',
        windowEnd: '2026-10-01T23:59:59.000Z',
        cycle: 3,
        txDigest: DIGEST_MEMBER_1,
        withMemory: false,
      },
      { env: TEST_TATUM_ENV, fetchRpc: rpcCaller }
    )
    assert.equal(verifiedContribution.status, 'Verified')

    // 5. Simulate server restart: close SQLite connection and reopen from disk
    closeDatabase()
    initDatabase(dbFilePath)

    // 6. Verify wallet sessions and authorization after restart
    const reloadedSession1 = requireWalletSession({
      headers: { authorization: `Bearer ${session1.token}` },
    })
    assert.equal(reloadedSession1.walletAddress, addr1)

    const reloadedSession2 = requireWalletSession({
      headers: { authorization: `Bearer ${session2.token}` },
    })
    assert.equal(reloadedSession2.walletAddress, addr2)

    // Consumed login challenge and confirmation challenge nonces remain consumed after restart
    await assert.rejects(
      () =>
        verifyWalletAuthChallenge({
          challengeId: ch1.challengeId,
          address: addr1,
          signature: sig1.signature,
        }),
      (err) => err instanceof WalletAuthError && err.statusCode === 401
    )

    await assert.rejects(
      () =>
        confirmAndWriteMemory({
          circleId: 'durable-circle-1',
          proposalId: propConfirmed.id,
          memberId: 'm2',
          memberAddress: addr2,
          challengeNonce: confChallenge.nonce,
          signature: propSig.signature,
          memwalClientOverride: isolatedMemWalClient,
        }),
      (err) =>
        err instanceof WalletAuthError &&
        err.statusCode === 401 &&
        err.message.includes('already-consumed')
    )

    // 7. Verify circle roster and membership authorization after restart
    const reloadedCircle = getCircleRoster('durable-circle-1')
    assert.ok(reloadedCircle)
    assert.equal(reloadedCircle.circleName, 'Durable Circle One')
    assert.equal(reloadedCircle.members.length, 2)
    assert.equal(reloadedCircle.members[0].address, addr1)
    assert.equal(reloadedCircle.members[1].address, addr2)

    const member1Circles = listCircleRosters({ memberAddress: addr1 })
    assert.equal(member1Circles.length, 1)
    const outsiderCircles = listCircleRosters({ memberAddress: addrOutsider })
    assert.equal(outsiderCircles.length, 0)

    assert.throws(
      () => verifyCircleMembership('durable-circle-1', { memberAddress: addrOutsider }),
      (err) => err instanceof WalletAuthError && err.statusCode === 403
    )

    // 8. Verify proposals (1 confirmed, 1 pending) after restart
    const pendingAfterRestart = getPendingProposals('durable-circle-1')
    assert.equal(pendingAfterRestart.length, 1)
    assert.equal(pendingAfterRestart[0].id, propPending.id)

    const confirmedAfterRestart = getCircleProposals('durable-circle-1', { status: 'confirmed' })
    assert.equal(confirmedAfterRestart.length, 1)
    assert.equal(confirmedAfterRestart[0].id, propConfirmed.id)
    assert.equal(confirmedAfterRestart[0].walrusBlobId, 'isolated_test_blob_id_durable_001')
    assert.equal(confirmedAfterRestart[0].confirmationType, 'wallet_signature_verified')

    // 9. Verify persisted transaction verification and authoritative chain evidence after restart
    const submittedDigests = getSubmittedDigests('durable-circle-1', 3, addr1)
    assert.deepEqual(submittedDigests, [DIGEST_MEMBER_1])

    const persistedTx = getPersistedSubmittedTransaction(DIGEST_MEMBER_1, 'testnet')
    assert.ok(persistedTx)
    assert.equal(persistedTx.network, 'testnet')
    assert.equal(persistedTx.txDigest, DIGEST_MEMBER_1)
    assert.equal(persistedTx.observedSender, addr1)
    assert.equal(persistedTx.observedRecipient, poolAddr)
    assert.equal(persistedTx.tokenType, '0x2::sui::SUI')
    assert.equal(persistedTx.amount, 250)
    assert.equal(persistedTx.executionStatus, 'success')
    assert.equal(persistedTx.txTimestampMs, txTimestampMs)
    assert.ok(persistedTx.verifiedAtIso)

    const persistedVerification = getServerVerifiedContribution('durable-circle-1', 3, addr1)
    assert.ok(persistedVerification)
    assert.equal(persistedVerification.status, 'Verified')
    assert.equal(persistedVerification.network, 'testnet')
    assert.equal(persistedVerification.txDigest, DIGEST_MEMBER_1)
    assert.equal(persistedVerification.observedSender, addr1)
    assert.equal(persistedVerification.observedRecipient, poolAddr)
    assert.equal(persistedVerification.tokenReceived, '0x2::sui::SUI')
    assert.equal(persistedVerification.amountReceived, 250)
    assert.equal(persistedVerification.executionStatus, 'success')
    assert.equal(persistedVerification.timestamp, '2026-10-01T12:00:00.000Z')
    assert.ok(persistedVerification.verifiedAtServerIso)

    // 10. Verify quarantine survives restart in both code and SQLite `quarantined_records`
    assert.equal(isQuarantinedSyntheticRecord('lagos-techies-seed-circle'), true)
    assert.throws(
      () =>
        upsertCircleRoster({
          circleId: 'lagos-techies-seed-circle',
          circleName: 'Synthetic Circle',
          poolAddress: poolAddr,
          contributionPerMember: 100,
          tokenType: '0x2::sui::SUI',
          members: [{ id: 'm1', name: 'Member', address: addr1 }],
        }),
      (err) => err instanceof WalletAuthError && err.statusCode === 403
    )
    const quarantinedRows = getDatabase()
      .prepare("SELECT COUNT(*) AS cnt FROM quarantined_records WHERE record_kind = 'walrus_blob'")
      .get()
    assert.equal(Number(quarantinedRows.cnt), QUARANTINED_SYNTHETIC_BLOB_IDS.size)
  } finally {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
    initDatabase() // Restore default test DB
  }
})

test('Constraints & Conflicts: rejects duplicate memberships and conflicting transaction digest submissions', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ajo-steward-conflict-'))
  const dbFilePath = path.join(tmpDir, 'conflicts.sqlite')

  try {
    initDatabase(dbFilePath)
    const addr1 = new Ed25519Keypair().getPublicKey().toSuiAddress()
    const addr2 = new Ed25519Keypair().getPublicKey().toSuiAddress()
    const poolAddr = '0x978095921852e2fe53ea7fae4f69f2c7285e365d07450cace661c3553c3c4b33'

    // 1. Duplicate member ID in the same circle is rejected with StorageConflictError (409)
    assert.throws(
      () =>
        upsertCircleRoster({
          circleId: 'conflict-circle',
          circleName: 'Conflict Circle',
          poolAddress: poolAddr,
          contributionPerMember: 100,
          tokenType: '0x2::sui::SUI',
          members: [
            { id: 'm1', name: 'One', address: addr1 },
            { id: 'm1', name: 'Duplicate ID', address: addr2 },
          ],
        }),
      (err) => err instanceof StorageConflictError && err.statusCode === 409
    )

    // 2. Duplicate member wallet address in the same circle is rejected with StorageConflictError (409)
    assert.throws(
      () =>
        upsertCircleRoster({
          circleId: 'conflict-circle',
          circleName: 'Conflict Circle',
          poolAddress: poolAddr,
          contributionPerMember: 100,
          tokenType: '0x2::sui::SUI',
          members: [
            { id: 'm1', name: 'One', address: addr1 },
            { id: 'm2', name: 'Duplicate Address', address: addr1.toUpperCase() },
          ],
        }),
      (err) => err instanceof StorageConflictError && err.statusCode === 409
    )

    // 3. Conflicting transaction digest submission across different members/cycles is rejected as Unverified
    const sharedDigest = '5cD7eF9gH1jK3mN5pQ7rS9tU2vW4xY6zA8bC1dE3fG5h'
    const rpcCaller = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          jsonrpc: '2.0',
          id: 1,
          result: {
            digest: sharedDigest,
            timestampMs: String(Date.parse('2026-10-01T12:00:00.000Z')),
            transaction: { data: { sender: addr1 } },
            effects: { status: { status: 'success' } },
            balanceChanges: [
              {
                owner: { AddressOwner: poolAddr },
                coinType: '0x2::sui::SUI',
                amount: '100000000000',
              },
            ],
          },
        }
      },
    })

    const firstClaim = await verifyMemberContributionOnSui(
      {
        circleId: 'conflict-circle',
        poolAddress: poolAddr,
        memberAddress: addr1,
        memberId: 'm1',
        memberName: 'Member One',
        token: '0x2::sui::SUI',
        expectedAmount: 100,
        windowStart: '2026-10-01T00:00:00.000Z',
        windowEnd: '2026-10-01T23:59:59.000Z',
        cycle: 1,
        txDigest: sharedDigest,
        withMemory: false,
      },
      { env: TEST_TATUM_ENV, fetchRpc: rpcCaller }
    )
    assert.equal(firstClaim.status, 'Verified')

    // Member 2 attempts to submit the exact same txDigest -> rejected as Unverified with conflict=true
    const conflictingClaim = await verifyMemberContributionOnSui(
      {
        circleId: 'conflict-circle',
        poolAddress: poolAddr,
        memberAddress: addr2,
        memberId: 'm2',
        memberName: 'Member Two',
        token: '0x2::sui::SUI',
        expectedAmount: 100,
        windowStart: '2026-10-01T00:00:00.000Z',
        windowEnd: '2026-10-01T23:59:59.000Z',
        cycle: 1,
        txDigest: sharedDigest,
        withMemory: false,
      },
      { env: TEST_TATUM_ENV, fetchRpc: rpcCaller }
    )
    assert.equal(conflictingClaim.status, 'Unverified')
    assert.equal(conflictingClaim.conflict, true)
    assert.ok(conflictingClaim.error.includes('Conflicting transaction submission'))
  } finally {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
    initDatabase()
  }
})

test('Database Outage Handling: never reports a payment as Verified when storage is unavailable and returns 503 on routes', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRoutes)
  app.use('/api/memory', memoryRoutes)
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    const addr1 = new Ed25519Keypair().getPublicKey().toSuiAddress()
    const poolAddr = '0x978095921852e2fe53ea7fae4f69f2c7285e365d07450cace661c3553c3c4b33'
    const validDigest = '3xY5zA7bC9dE2fG4hJ6kM8nP1qR3sT5uV7wX9yZ2aB4c'

    // Simulate database outage
    setDatabaseOutageForTesting(true, 'Simulated SQLite disk I/O outage')

    const rpcCaller = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          jsonrpc: '2.0',
          id: 1,
          result: {
            digest: validDigest,
            timestampMs: String(Date.parse('2026-10-01T12:00:00.000Z')),
            transaction: { data: { sender: addr1 } },
            effects: { status: { status: 'success' } },
            balanceChanges: [
              {
                owner: { AddressOwner: poolAddr },
                coinType: '0x2::sui::SUI',
                amount: '100000000000',
              },
            ],
          },
        }
      },
    })

    // Even when Tatum RPC returns a valid transfer, verification MUST return Unverified if persistence fails
    const outageVerification = await verifyMemberContributionOnSui(
      {
        circleId: 'outage-circle',
        poolAddress: poolAddr,
        memberAddress: addr1,
        memberId: 'm1',
        memberName: 'Outage Tester',
        token: '0x2::sui::SUI',
        expectedAmount: 100,
        windowStart: '2026-10-01T00:00:00.000Z',
        windowEnd: '2026-10-01T23:59:59.000Z',
        cycle: 1,
        txDigest: validDigest,
        withMemory: false,
      },
      { env: TEST_TATUM_ENV, fetchRpc: rpcCaller }
    )
    assert.equal(outageVerification.status, 'Unverified')
    assert.equal(outageVerification.policy.chainStatus, 'Unverified')
    assert.ok(outageVerification.error.includes('Simulated SQLite disk I/O outage'))

    // Routes return HTTP 503 during storage outage
    const chRes = await fetch(`${baseUrl}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr1 }),
    })
    assert.equal(chRes.status, 503)

    // Restore storage availability
    setDatabaseOutageForTesting(false)
    const recoveredRes = await fetch(`${baseUrl}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr1 }),
    })
    assert.equal(recoveredRes.status, 200)
  } finally {
    setDatabaseOutageForTesting(false)
    await new Promise((resolve) => server.close(resolve))
  }
})
