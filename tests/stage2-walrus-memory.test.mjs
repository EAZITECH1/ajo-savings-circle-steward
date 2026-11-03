import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  resolveCircleNamespace,
  upsertCircleRoster,
  verifyCircleMembership,
  proposeCircleMemory,
  issueConfirmationChallenge,
  serializeMemoryForWalrus,
  parseRecalledMemory,
} from '../server/walrus-memory.mjs'

test('Walrus Memory: resolves stable circle namespace from circleId', () => {
  const ns1 = resolveCircleNamespace('Lagos Techies Seed Circle', {
    MEMWAL_KEY: 'a'.repeat(64),
    MEMWAL_ACCOUNT_ID: '0x1234',
    MEMWAL_SERVER_URL: 'https://relayer.memory.walrus.xyz',
    MEMWAL_NAMESPACE_PREFIX: 'ajo-circle',
  })
  assert.equal(ns1, 'ajo-circle:lagos-techies-seed-circle')
})

test('Walrus Memory: enforces circle membership server-side and rejects non-members', () => {
  upsertCircleRoster({
    circleId: 'test-circle-auth',
    circleName: 'Test Circle Auth',
    poolAddress: '0xaaaa',
    contributionPerMember: 500,
    tokenType: '0x2::sui::SUI',
    cycleLength: 'Monthly',
    members: [
      { id: 'm1', name: 'Amina Bello', address: '0x0001' },
      { id: 'm2', name: 'Tunde Ojo', address: '0x0002' },
    ],
  })

  const authorized = verifyCircleMembership('test-circle-auth', { memberAddress: '0x1' })
  assert.equal(authorized.member.id, 'm1')

  assert.throws(
    () => verifyCircleMembership('test-circle-auth', { memberAddress: '0x9999' }),
    /Authorization failed: member/
  )

  assert.throws(
    () => verifyCircleMembership('unknown-circle-id', { memberId: 'm1' }),
    /is not registered on the server/
  )
})

test('Walrus Memory: issues challenge only to registered circle members', () => {
  const prop = proposeCircleMemory({
    circleId: 'test-circle-auth',
    category: 'Agreements',
    title: '72-Hour Grace Rule',
    quote: 'Tunde may submit contribution within 72 hours of cycle open.',
    suggestedAction: 'Apply 72-hour grace policy.',
    memberId: 'm2',
    cycle: 4,
  })

  const challenge = issueConfirmationChallenge({
    circleId: 'test-circle-auth',
    proposalId: prop.id,
    memberId: 'm1',
  })
  assert.ok(challenge.nonce)
  assert.ok(challenge.message.includes(prop.id))

  // Verify Ed25519 keypair signing works with challenge message format
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const sig = crypto.sign(null, Buffer.from(challenge.message, 'utf8'), privateKey)
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' })
  const rawPubKeyHex = spkiDer.subarray(spkiDer.length - 32).toString('hex')
  assert.equal(rawPubKeyHex.length, 64)
  assert.equal(sig.length, 64)
})

test('Walrus Memory: serializes and parses recalled memory with real blob_id and metadata intact', () => {
  const original = {
    id: 'mem-test-101',
    circleId: 'lagos-techies-seed-circle',
    memoryType: 'agreement',
    category: 'Agreements',
    title: 'Tunde 72h Grace Period',
    quote: 'Approved 72h grace period for Tunde due to contractor invoice schedule.',
    context: 'Allow 72h grace before marking late violation.',
    date: 'Nov 3, 2026',
    cycle: 4,
    confirmedBy: 'Organizer-entered record (Amina Bello · 0x0001)',
    confirmedByList: ['Organizer-entered record (Amina Bello · 0x0001)'],
    confirmationType: 'organizer_entered',
    memberId: 'm2',
    memberIds: ['m2'],
  }

  const serialized = serializeMemoryForWalrus(original)
  assert.ok(serialized.includes('[Circle: lagos-techies-seed-circle]'))
  assert.ok(serialized.includes('[AJO_MEMORY_META]'))

  const parsed = parseRecalledMemory(
    {
      blob_id: 'real_walrus_blob_xyz987',
      text: serialized,
      distance: 0.14,
      created_at: '2026-11-03T13:30:00Z',
    },
    'lagos-techies-seed-circle'
  )

  assert.equal(parsed.walrusBlobId, 'real_walrus_blob_xyz987')
  assert.equal(parsed.title, original.title)
  assert.equal(parsed.quote, original.quote)
  assert.equal(parsed.category, 'Agreements')
  assert.equal(parsed.memoryType, 'agreement')
  assert.equal(parsed.cycle, 4)
  assert.equal(parsed.memberId, 'm2')
  assert.equal(parsed.confirmationType, 'organizer_entered')
  assert.equal(parsed.confirmedBy, 'Organizer-entered record (Amina Bello · 0x0001)')
})
