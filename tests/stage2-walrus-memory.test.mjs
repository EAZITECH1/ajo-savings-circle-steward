import test from 'node:test'
import assert from 'node:assert/strict'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1'
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1'
import {
  resolveCircleNamespace,
  upsertCircleRoster,
  persistCircleConfigToWalrus,
  verifyCircleMembership,
  proposeCircleMemory,
  rejectCircleProposal,
  issueConfirmationChallenge,
  confirmAndWriteMemory,
  persistHistoricalLatenessToWalrus,
  persistSplitCompletionToWalrus,
  persistReminderConversionToWalrus,
  getSessionConfirmedCircleMemories,
  computeProposalHash,
  serializeMemoryForWalrus,
  parseRecalledMemory,
  isQuarantinedSyntheticRecord,
  QUARANTINED_SYNTHETIC_BLOB_IDS,
} from '../server/walrus-memory.mjs'
import {
  issueWalletAuthChallenge,
  verifyWalletAuthChallenge,
  verifySuiAddressSignature,
  requireWalletSession,
  WalletAuthError,
} from '../server/wallet-auth.mjs'
import { evaluateContributionPolicy } from '../server/payment-policy.mjs'

test('Walrus Memory: resolves stable circle namespace from circleId', () => {
  const ns1 = resolveCircleNamespace('Abuja Builders Circle', {
    MEMWAL_KEY: 'a'.repeat(64),
    MEMWAL_ACCOUNT_ID: '0x1234',
    MEMWAL_SERVER_URL: 'https://relayer.memory.walrus.xyz',
    MEMWAL_NAMESPACE_PREFIX: 'ajo-circle',
  })
  assert.equal(ns1, 'ajo-circle:abuja-builders-circle')
})

test('Quarantine: blocks synthetic lagos-techies-seed-circle and all 10 synthetic blob IDs from runtime use', () => {
  assert.equal(QUARANTINED_SYNTHETIC_BLOB_IDS.size, 10)
  assert.equal(isQuarantinedSyntheticRecord('lagos-techies-seed-circle'), true)
  assert.equal(
    isQuarantinedSyntheticRecord({
      walrusBlobId: '_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc',
    }),
    true
  )

  assert.throws(
    () =>
      upsertCircleRoster({
        circleId: 'lagos-techies-seed-circle',
        circleName: 'Quarantined Sample Circle',
        poolAddress: '0x1111',
        contributionPerMember: 500,
        tokenType: '0x2::sui::SUI',
        members: [{ id: 'm1', name: 'Member One', address: '0x0001' }],
      }),
    (err) => err instanceof WalletAuthError && err.statusCode === 403
  )

  // Verify quarantined blob cannot excuse a late payment in policy evaluation
  const policyRes = evaluateContributionPolicy(
    {
      status: 'Late',
      code: 'late',
      txDigest: '7Dqpcnkodzc1MX2nrAoVdz9AwUC9KFy2p3ATVppHxx7m',
      amountReceived: 1,
      timestamp: '2026-09-02T10:00:00Z',
    },
    {
      withMemory: true,
      windowEnd: '2026-09-01T23:59:59Z',
      graceWindowHours: 72,
      memberId: 'm2',
      memberName: 'Member Two',
      memories: [
        {
          id: 'quarantined-1',
          walrusBlobId: '_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc',
          category: 'Agreements',
          title: 'Grace Rule',
          quote: '72 hour grace period',
          memberId: 'm2',
        },
      ],
    }
  )
  assert.equal(policyRes.chainStatus, 'Late')
  assert.equal(policyRes.policyStatus, 'Unexcused late payment')
  assert.equal(policyRes.countsTowardPot, false)
})

test('Sui wallet signature binding: accepts matching wallet signature, rejects unrelated keypair signature, and enforces one-time challenge nonces', async () => {
  const kpMember1 = new Ed25519Keypair()
  const kpMember2 = new Ed25519Keypair()
  const kpAttacker = new Ed25519Keypair()

  const addr1 = kpMember1.getPublicKey().toSuiAddress()
  const addr2 = kpMember2.getPublicKey().toSuiAddress()
  const addrAttacker = kpAttacker.getPublicKey().toSuiAddress()

  // 1. Wallet login challenge signed by matching keypair succeeds
  const loginChallenge = issueWalletAuthChallenge({ address: addr1 })
  const signedLogin = await kpMember1.signPersonalMessage(
    new TextEncoder().encode(loginChallenge.message)
  )
  const session = await verifyWalletAuthChallenge({
    challengeId: loginChallenge.challengeId,
    address: addr1,
    signature: signedLogin.signature,
  })
  assert.ok(session.token)
  assert.equal(session.walletAddress, addr1)

  // 2. Replaying the same login challengeId fails (one-time use)
  await assert.rejects(
    () =>
      verifyWalletAuthChallenge({
        challengeId: loginChallenge.challengeId,
        address: addr1,
        signature: signedLogin.signature,
      }),
    (err) => err instanceof WalletAuthError && err.statusCode === 401
  )

  // 3. Valid signature from an unrelated keypair (kpAttacker claiming to be addr1) is REJECTED
  const loginChallenge2 = issueWalletAuthChallenge({ address: addr1 })
  const attackerSig = await kpAttacker.signPersonalMessage(
    new TextEncoder().encode(loginChallenge2.message)
  )
  await assert.rejects(
    () =>
      verifyWalletAuthChallenge({
        challengeId: loginChallenge2.challengeId,
        address: addr1,
        signature: attackerSig.signature,
      }),
    (err) => err instanceof WalletAuthError && err.statusCode === 403
  )

  // Raw Ed25519 publicKeyHex from kpAttacker claiming addr1 is also rejected with 403
  const rawAttackerPubHex = Buffer.from(kpAttacker.getPublicKey().toRawBytes()).toString('hex')
  await assert.rejects(
    () =>
      verifySuiAddressSignature({
        message: 'Test message',
        expectedAddress: addr1,
        signature: '00'.repeat(64),
        publicKeyHex: rawAttackerPubHex,
      }),
    (err) =>
      err instanceof WalletAuthError &&
      err.statusCode === 403 &&
      err.message.includes('Signing key address mismatch')
  )

  // 4. Register circle with authenticated wallet addr1
  upsertCircleRoster(
    {
      circleId: 'test-circle-auth',
      circleName: 'Test Circle Auth',
      poolAddress: '0xaaaa',
      contributionPerMember: 1,
      tokenType: '0x2::sui::SUI',
      cycleLength: 'Monthly',
      members: [
        { id: 'm1', name: 'Member One', address: addr1 },
        { id: 'm2', name: 'Member Two', address: addr2 },
      ],
    },
    { authenticatedWalletAddress: addr1 }
  )

  // Non-member wallet cannot update existing circle roster
  assert.throws(
    () =>
      upsertCircleRoster(
        {
          circleId: 'test-circle-auth',
          circleName: 'Hijacked Circle',
          poolAddress: addrAttacker,
          contributionPerMember: 1,
          tokenType: '0x2::sui::SUI',
          members: [{ id: 'm1', name: 'Attacker', address: addrAttacker }],
        },
        { authenticatedWalletAddress: addrAttacker }
      ),
    (err) => err instanceof WalletAuthError && err.statusCode === 403
  )

  // 5. Proposal-bound confirmation challenge: binds proposalId + proposalHash + memberAddress + one-time nonce
  const prop = proposeCircleMemory({
    circleId: 'test-circle-auth',
    category: 'Agreements',
    title: '72-Hour Grace Rule',
    quote: 'Member Two may submit contribution within 72 hours of cycle deadline.',
    suggestedAction: 'Apply 72-hour grace policy.',
    memberId: 'm2',
    cycle: 2,
  })
  assert.equal(prop.proposalHash, computeProposalHash(prop))

  const confChallenge = issueConfirmationChallenge({
    circleId: 'test-circle-auth',
    proposalId: prop.id,
    memberId: 'm2',
    memberAddress: addr2,
  })
  assert.equal(confChallenge.proposalHash, prop.proposalHash)
  assert.ok(confChallenge.message.includes(`ProposalHash: ${prop.proposalHash}`))

  // 5a. Signing confirmation challenge with unrelated keypair (kpAttacker) is rejected and consumes the nonce!
  const badPropSig = await kpAttacker.signPersonalMessage(
    new TextEncoder().encode(confChallenge.message)
  )
  await assert.rejects(
    () =>
      confirmAndWriteMemory({
        circleId: 'test-circle-auth',
        proposalId: prop.id,
        memberId: 'm2',
        memberAddress: addr2,
        challengeNonce: confChallenge.nonce,
        signature: badPropSig.signature,
      }),
    (err) => err instanceof WalletAuthError && err.statusCode === 403
  )

  // 5b. Re-using the consumed challengeNonce even with kpMember2's real signature fails (strict one-time use)
  const validPropSigConsumed = await kpMember2.signPersonalMessage(
    new TextEncoder().encode(confChallenge.message)
  )
  await assert.rejects(
    () =>
      confirmAndWriteMemory({
        circleId: 'test-circle-auth',
        proposalId: prop.id,
        memberId: 'm2',
        memberAddress: addr2,
        challengeNonce: confChallenge.nonce,
        signature: validPropSigConsumed.signature,
      }),
    (err) =>
      err instanceof WalletAuthError &&
      err.statusCode === 401 &&
      err.message.includes('already-consumed')
  )

  // 5c. Issue a fresh challenge and tamper with inline proposal content -> rejected with proposalHash mismatch
  const confChallenge2 = issueConfirmationChallenge({
    circleId: 'test-circle-auth',
    proposalId: prop.id,
    memberId: 'm2',
    memberAddress: addr2,
  })
  const validPropSig2 = await kpMember2.signPersonalMessage(
    new TextEncoder().encode(confChallenge2.message)
  )
  await assert.rejects(
    () =>
      confirmAndWriteMemory({
        circleId: 'test-circle-auth',
        proposalId: prop.id,
        proposal: {
          ...prop,
          quote: 'Tampered quote after challenge was issued',
        },
        memberId: 'm2',
        memberAddress: addr2,
        challengeNonce: confChallenge2.nonce,
        signature: validPropSig2.signature,
      }),
    (err) =>
      err instanceof WalletAuthError &&
      err.statusCode === 403 &&
      err.message.includes('proposalHash')
  )

  // 5d. Non-organizer member (m2) cannot submit an organizer_entered record without a signature
  await assert.rejects(
    () =>
      confirmAndWriteMemory({
        circleId: 'test-circle-auth',
        proposalId: prop.id,
        memberId: 'm2',
        memberAddress: addr2,
        confirmationMode: 'organizer_entered',
      }),
    (err) =>
      err instanceof WalletAuthError &&
      err.statusCode === 403 &&
      err.message.includes('Only the circle organizer')
  )

  // 6. requireWalletSession rejects missing/invalid bearer token and accepts valid session token
  assert.throws(
    () => requireWalletSession({ headers: {} }),
    (err) => err instanceof WalletAuthError && err.statusCode === 401
  )
  const verifiedReqSession = requireWalletSession({
    headers: { authorization: `Bearer ${session.token}` },
  })
  assert.equal(verifiedReqSession.walletAddress, addr1)
})

test('Multi-scheme Sui wallet signature verification: verifies real Ed25519, Secp256k1, and Secp256r1/Passkey/zkLogin wallet signatures', async () => {
  const schemes = [
    { name: 'Ed25519', kp: new Ed25519Keypair() },
    { name: 'Secp256k1', kp: new Secp256k1Keypair() },
    { name: 'Secp256r1', kp: new Secp256r1Keypair() },
  ]

  for (const { name, kp } of schemes) {
    const address = kp.getPublicKey().toSuiAddress()
    const challenge = issueWalletAuthChallenge({ address })
    const signed = await kp.signPersonalMessage(new TextEncoder().encode(challenge.message))
    
    // Verify server-side
    const session = await verifyWalletAuthChallenge({
      challengeId: challenge.challengeId,
      address,
      signature: signed.signature,
    })
    assert.ok(session.token, `${name} session should have token`)
    assert.equal(session.walletAddress, address, `${name} address must match`)

    // Verify direct verification helper
    const directRes = await verifySuiAddressSignature({
      message: challenge.message,
      expectedAddress: address,
      signature: signed.signature,
    })
    assert.equal(directRes.verified, true, `${name} direct verification must succeed`)
    assert.equal(directRes.address, address, `${name} verified address must match`)
  }
})

test('Walrus Memory: serializes and parses recalled memory with real blob_id and metadata intact', () => {
  const original = {
    id: 'mem-test-101',
    circleId: 'abuja-builders-circle',
    memoryType: 'agreement',
    category: 'Agreements',
    title: '72h Grace Period',
    quote: 'Approved 72h grace period for Member Two due to contractor invoice schedule.',
    context: 'Allow 72h grace before marking late violation.',
    date: 'Nov 3, 2026',
    cycle: 4,
    confirmedBy: 'Organizer-entered record by Member One (0x0001) — organizer entry only, not member-signed consensus',
    confirmedByList: [
      'Organizer-entered record by Member One (0x0001) — organizer entry only, not member-signed consensus',
    ],
    confirmationType: 'organizer_entered',
    memberId: 'm2',
    memberIds: ['m2'],
  }

  const serialized = serializeMemoryForWalrus(original)
  assert.ok(serialized.includes('[Circle: abuja-builders-circle]'))
  assert.ok(serialized.includes('[AJO_MEMORY_META]'))

  const parsed = parseRecalledMemory(
    {
      blob_id: 'real_walrus_blob_xyz987',
      text: serialized,
      distance: 0.14,
      created_at: '2026-11-03T13:30:00Z',
    },
    'abuja-builders-circle'
  )

  assert.equal(parsed.walrusBlobId, 'real_walrus_blob_xyz987')
  assert.equal(parsed.title, original.title)
  assert.equal(parsed.quote, original.quote)
  assert.equal(parsed.category, 'Agreements')
  assert.equal(parsed.memoryType, 'agreement')
  assert.equal(parsed.cycle, 4)
  assert.equal(parsed.memberId, 'm2')
  assert.equal(parsed.confirmationType, 'organizer_entered')
})

test('Walrus Memory: persistHistoricalLatenessToWalrus records grace resolution outcome and populates sessionConfirmedCache', async () => {
  const kp1 = new Ed25519Keypair()
  const addr1 = kp1.getPublicKey().toSuiAddress()
  const circleId = 'test-circle-lateness-outcome'
  const testEnv = {
    MEMWAL_KEY: 'a'.repeat(64),
    MEMWAL_ACCOUNT_ID: '0x1234',
    MEMWAL_SERVER_URL: 'https://relayer.memory.walrus.xyz',
    MEMWAL_NAMESPACE_PREFIX: 'ajo-circle',
  }

  upsertCircleRoster(
    {
      circleId,
      circleName: 'Lateness Outcome Test Circle',
      poolAddress: '0xbbbb',
      contributionPerMember: 1,
      tokenType: '0x2::sui::SUI',
      cycleLength: 'Daily',
      members: [{ id: 'm1', name: 'Vanessa', address: addr1 }],
    },
    { authenticatedWalletAddress: addr1 }
  )

  const mockMemwalClient = {
    async rememberAndWait(_text, namespace) {
      return {
        id: 'job_lateness_1',
        job_id: 'job_lateness_1',
        blob_id: 'mock_blob_grace_honored_c2',
        namespace,
        owner: '0xowner',
      }
    },
    destroy() {},
  }

  const saved = await persistHistoricalLatenessToWalrus(
    {
      circleId,
      cycle: 2,
      memberAddress: addr1,
      memberId: 'm1',
      requiredAmount: 1,
      amountPaidByDeadline: 0,
      amountRemainingOutstanding: 0,
      deadlineTimestamp: '2026-09-01T12:00:00Z',
      latePaymentDigest: '9fK3mP7qR2vW5xY8zB4nC6dF8gH1jL3kM5pQ7rS9tU2v',
      latePaymentTimestamp: '2026-09-01T12:04:00Z',
      elapsedMs: 4 * 60 * 1000,
      elapsedDisplay: '4m late',
      policyEvaluation: {
        graceEvaluation: {
          honored: true,
          durationMs: 10 * 60 * 1000,
          durationLabel: '10m',
          explicitCycle: 2,
          graceBlobId: 'blob_rule_10m_c2',
          graceTitle: '10 Miniutes Grace Window For Cycle 2 Payment',
        },
      },
      memwalClientOverride: mockMemwalClient,
    },
    testEnv
  )

  assert.equal(saved.walrusBlobId, 'mock_blob_grace_honored_c2')

  const splitSaved = await persistSplitCompletionToWalrus(
    {
      circleId,
      cycle: 2,
      memberAddress: addr1,
      memberId: 'm1',
      requiredAmount: 1,
      txDigests: ['DgSplitA1', 'DgSplitA2'],
      memwalClientOverride: {
        async rememberAndWait(_text, namespace) {
          return { blob_id: 'mock_blob_split_c2', namespace }
        },
        destroy() {},
      },
    },
    testEnv
  )
  assert.equal(splitSaved.walrusBlobId, 'mock_blob_split_c2')
  assert.equal(splitSaved.label, 'split contribution pattern')

  const remSaved = await persistReminderConversionToWalrus(
    {
      circleId,
      cycle: 2,
      memberAddress: addr1,
      memberId: 'm1',
      txDigest: 'DgRemConvC2',
      reminderPreferenceBlobId: 'blob_rem_pref_1',
      reminderPreferenceTitle: '6pm WAT reminder',
      memwalClientOverride: {
        async rememberAndWait(_text, namespace) {
          return { blob_id: 'mock_blob_rem_outcome_c2', namespace }
        },
        destroy() {},
      },
    },
    testEnv
  )
  assert.equal(remSaved.walrusBlobId, 'mock_blob_rem_outcome_c2')
  assert.equal(remSaved.label, 'reminder conversion outcome')

  const cached = getSessionConfirmedCircleMemories(circleId, testEnv)
  const cachedBlobs = cached.map((m) => m.walrusBlobId)
  assert.ok(cachedBlobs.includes('mock_blob_grace_honored_c2'))
  assert.ok(cachedBlobs.includes('mock_blob_split_c2'))
  assert.ok(cachedBlobs.includes('mock_blob_rem_outcome_c2'))
  assert.ok(saved.title.includes('Grace Agreement Honored by Vanessa in Cycle 2'))
  assert.ok(saved.quote.includes('10m grace window'))
  assert.ok(saved.quote.includes('blob_rule_10m_c2'))

  const sessionRecords = getSessionConfirmedCircleMemories(circleId, testEnv)
  assert.ok(sessionRecords.some((r) => r.walrusBlobId === 'mock_blob_grace_honored_c2'))
})

test('Organizer approval & notifications: non-organizer agreement requires organizer signature or rejection and synthesizes overdue reminders', async () => {
  const { listNotificationsForUser, addNotification } = await import('../server/notifications.mjs')
  const kpOrg = new Ed25519Keypair()
  const kpMem = new Ed25519Keypair()
  const orgAddr = kpOrg.getPublicKey().toSuiAddress()
  const memAddr = kpMem.getPublicKey().toSuiAddress()
  const circleId = 'test-circle-org-approval'

  upsertCircleRoster(
    {
      circleId,
      circleName: 'Organizer Approval Circle',
      poolAddress: '0xcccc',
      contributionPerMember: 10,
      tokenType: '0x2::sui::SUI',
      cycleLength: 'Daily',
      currentCycle: 1,
      windowEnd: '2026-01-01T00:00:00Z', // past deadline -> overdue
      members: [
        { id: 'm1', name: 'Organizer', address: orgAddr },
        { id: 'm2', name: 'MemberTwo', address: memAddr },
      ],
    },
    { authenticatedWalletAddress: orgAddr }
  )

  const prop = proposeCircleMemory({
    circleId,
    category: 'Agreements',
    title: '10 Minutes Grace Window for MemberTwo',
    quote: 'MemberTwo requests 10m grace.',
    memberId: 'm2',
    cycle: 1,
    proposedBy: `MemberTwo (${memAddr})`,
    proposedByAddress: memAddr,
    proposedByMemberId: 'm2',
  })

  assert.equal(prop.requiresOrganizerApproval, true)

  // Non-organizer proposer cannot sign their own Agreement proposal when requiresOrganizerApproval is true
  assert.throws(
    () =>
      issueConfirmationChallenge({
        circleId,
        proposalId: prop.id,
        memberId: 'm2',
        memberAddress: memAddr,
      }),
    /requires the circle organizer's wallet/i
  )

  // Organizer CAN issue challenge for it
  const challenge = issueConfirmationChallenge({
    circleId,
    proposalId: prop.id,
    memberId: 'm1',
    memberAddress: orgAddr,
  })
  assert.equal(challenge.proposalId, prop.id)

  // Non-organizer cannot reject; organizer can reject a second proposal
  const prop2 = proposeCircleMemory({
    circleId,
    category: 'Agreements',
    title: 'Second Proposal to Reject',
    quote: 'Requesting swap.',
    memberId: 'm2',
    cycle: 1,
    proposedByAddress: memAddr,
    proposedByMemberId: 'm2',
  })
  assert.throws(
    () =>
      rejectCircleProposal({
        circleId,
        proposalId: prop2.id,
        organizerAddress: memAddr,
        reason: 'Trying as non-organizer',
      }),
    /Only the circle organizer can reject/i
  )

  const rejected = rejectCircleProposal({
    circleId,
    proposalId: prop2.id,
    organizerAddress: orgAddr,
    reason: 'Cycle 1 deadline already passed',
  })
  assert.equal(rejected.proposal.status, 'rejected')
  assert.equal(rejected.proposal.rejectionReason, 'Cycle 1 deadline already passed')

  addNotification({
    circleId,
    circleName: 'Organizer Approval Circle',
    recipientAddresses: [memAddr],
    type: 'proposal_rejected',
    title: 'Agreement Proposal Rejected',
    message: 'Organizer rejected Second Proposal to Reject: Cycle 1 deadline already passed',
    severity: 'error',
  })

  const memNotifs = listNotificationsForUser({ walletAddress: memAddr, circleId })
  assert.ok(memNotifs.some((n) => n.type === 'proposal_rejected'))
  assert.ok(memNotifs.some((n) => n.type === 'contribution_overdue'))
})

test('upsertCircleRoster & persistCircleConfigToWalrus persist circleRules and commit founding Agreements memory', async () => {
  const orgKp = Ed25519Keypair.generate()
  const memKp = Ed25519Keypair.generate()
  const orgAddr = orgKp.getPublicKey().toSuiAddress()
  const memAddr = memKp.getPublicKey().toSuiAddress()
  const circleId = `circle-rules-${Date.now()}`
  const rulesText =
    'Members get a 48-hour grace period.\nSplit payments are allowed before the cycle deadline.'

  const roster = upsertCircleRoster(
    {
      circleId,
      circleName: 'Rules Circle',
      poolAddress: '0x000000000000000000000000000000000000000000000000000000000000cafe',
      contributionPerMember: 10,
      tokenType: '0x2::sui::SUI',
      cycleLength: 'Monthly',
      currentCycle: 1,
      organizerAddress: orgAddr,
      circleRules: rulesText,
      members: [
        { id: 'm1', name: 'Organizer', address: orgAddr },
        { id: 'm2', name: 'Member', address: memAddr },
      ],
    },
    { authenticatedWalletAddress: orgAddr }
  )

  assert.equal(roster.circleRules, rulesText)

  let rememberCalls = 0
  const mockClient = {
    rememberAndWait: async (_text, namespace) => {
      rememberCalls += 1
      return {
        id: `job-${rememberCalls}`,
        blob_id: `blob-rules-${rememberCalls}`,
        namespace,
        owner: orgAddr,
      }
    },
  }

  const persisted = await persistCircleConfigToWalrus(
    {
      circleId,
      memberId: 'm1',
      memberAddress: orgAddr,
      allowUnsignedOrganizerSetup: true,
      memwalClientOverride: mockClient,
    },
    {}
  )

  assert.equal(persisted.walrusBlobId, 'blob-rules-1')
  assert.equal(persisted.foundingRulesBlobId, 'blob-rules-2')
  assert.equal(persisted.circle.circleRules, rulesText)
  assert.equal(rememberCalls, 2)

  const cachedMemories = getSessionConfirmedCircleMemories(circleId)
  const rulesMemory = cachedMemories.find((m) => m.walrusBlobId === 'blob-rules-2')
  assert.ok(rulesMemory, 'Expected founding circle rules to be cached in sessionConfirmedCache')
  assert.equal(rulesMemory.category, 'Agreements')
  assert.equal(rulesMemory.memoryType, 'agreement')
  assert.equal(rulesMemory.title, 'Founding Circle Rules & Guidelines')
  assert.equal(rulesMemory.quote, rulesText)
})
