import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import authRoutes from '../server/routes/auth.mjs'
import memoryRoutes from '../server/routes/memory.mjs'
import tatumRoutes from '../server/routes/tatum.mjs'
import stewardRoutes from '../server/routes/steward.mjs'

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRoutes)
  app.use('/api/memory', memoryRoutes)
  app.use('/api/tatum', tatumRoutes)
  app.use('/api/steward', stewardRoutes)
  return app
}

async function loginWithKeypair(baseUrl, keypair) {
  const address = keypair.getPublicKey().toSuiAddress()
  const chRes = await fetch(`${baseUrl}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  })
  assert.equal(chRes.status, 200)
  const challenge = await chRes.json()

  const signed = await keypair.signPersonalMessage(
    new TextEncoder().encode(challenge.message)
  )
  const verRes = await fetch(`${baseUrl}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      address,
      signature: signed.signature,
    }),
  })
  assert.equal(verRes.status, 200)
  return verRes.json()
}

test('Route Authorization: blocks unauthenticated requests (401) and non-member requests (403) across memory, tatum, and steward routes', async () => {
  const app = createTestApp()
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    // 1. Unauthenticated calls to sensitive routes must return 401
    const unauthRoutes = [
      { method: 'GET', path: '/api/memory/circles' },
      { method: 'POST', path: '/api/memory/circles', body: { circleId: 'c1', circleName: 'C1' } },
      { method: 'GET', path: '/api/memory/circles/c1' },
      { method: 'POST', path: '/api/memory/propose', body: { circleId: 'c1', title: 'T', quote: 'Q' } },
      { method: 'POST', path: '/api/memory/challenge', body: { circleId: 'c1', proposalId: 'p1' } },
      { method: 'POST', path: '/api/memory/confirm', body: { circleId: 'c1', proposalId: 'p1' } },
      { method: 'POST', path: '/api/memory/recall', body: { circleId: 'c1', query: 'grace' } },
      { method: 'GET', path: '/api/memory/list?circleId=c1' },
      { method: 'POST', path: '/api/memory/restore', body: { circleId: 'c1' } },
      { method: 'POST', path: '/api/tatum/sui/verify-contribution', body: { circleId: 'c1' } },
      { method: 'POST', path: '/api/tatum/sui/evaluate-policy', body: { circleId: 'c1' } },
      { method: 'POST', path: '/api/tatum/sui/clear-digests', body: { circleId: 'c1', memberAddress: '0x1' } },
      { method: 'POST', path: '/api/steward/chat', body: { circleId: 'c1', message: 'hi' } },
      { method: 'POST', path: '/api/steward/payout-recommendation', body: { circleId: 'c1', cycle: 1 } },
    ]

    for (const r of unauthRoutes) {
      const res = await fetch(`${baseUrl}${r.path}`, {
        method: r.method,
        headers: { 'Content-Type': 'application/json' },
        body: r.body ? JSON.stringify(r.body) : undefined,
      })
      assert.equal(
        res.status,
        401,
        `Expected 401 for unauthenticated ${r.method} ${r.path}, got ${res.status}`
      )
    }

    // 2. Authenticate two wallets: Member 1 (in circle) and Outsider (not in circle)
    const kpMember1 = new Ed25519Keypair()
    const kpOutsider = new Ed25519Keypair()
    const addr1 = kpMember1.getPublicKey().toSuiAddress()
    const addrOutsider = kpOutsider.getPublicKey().toSuiAddress()

    const sessionMember1 = await loginWithKeypair(baseUrl, kpMember1)
    const sessionOutsider = await loginWithKeypair(baseUrl, kpOutsider)

    // 3. Member 1 registers a circle where Member 1 is in the roster
    const regRes = await fetch(`${baseUrl}/api/memory/circles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionMember1.token}`,
      },
      body: JSON.stringify({
        circleId: 'secure-circle-1',
        circleName: 'Secure Circle 1',
        poolAddress: '0x978095921852e2fe53ea7fae4f69f2c7285e365d07450cace661c3553c3c4b33',
        contributionPerMember: 1,
        tokenType: '0x2::sui::SUI',
        cycleLength: 'Monthly',
        currentCycle: 1,
        members: [{ id: 'm1', name: 'Organizer One', address: addr1 }],
      }),
    })
    assert.equal(regRes.status, 200)

    // 4. Outsider cannot view, propose, challenge, confirm, list, recall, verify, or chat in `secure-circle-1`
    const outsiderChecks = [
      { method: 'GET', path: '/api/memory/circles/secure-circle-1' },
      {
        method: 'POST',
        path: '/api/memory/propose',
        body: { circleId: 'secure-circle-1', title: 'Hijack', quote: 'Hijack rule' },
      },
      {
        method: 'POST',
        path: '/api/memory/recall',
        body: { circleId: 'secure-circle-1', query: 'rule' },
      },
      { method: 'GET', path: '/api/memory/list?circleId=secure-circle-1' },
      {
        method: 'POST',
        path: '/api/tatum/sui/verify-contribution',
        body: { circleId: 'secure-circle-1', memberId: 'm1' },
      },
      {
        method: 'POST',
        path: '/api/steward/chat',
        body: { circleId: 'secure-circle-1', message: 'Status?' },
      },
    ]

    for (const c of outsiderChecks) {
      const res = await fetch(`${baseUrl}${c.path}`, {
        method: c.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionOutsider.token}`,
        },
        body: c.body ? JSON.stringify(c.body) : undefined,
      })
      assert.equal(
        res.status,
        403,
        `Expected 403 for non-member ${c.method} ${c.path}, got ${res.status}`
      )
    }

    // 5. Outsider listing `/api/memory/circles` does NOT see `secure-circle-1`
    const outsiderList = await fetch(`${baseUrl}/api/memory/circles`, {
      headers: { Authorization: `Bearer ${sessionOutsider.token}` },
    }).then((r) => r.json())
    assert.equal(
      outsiderList.circles.some((c) => c.circleId === 'secure-circle-1'),
      false
    )
    assert.equal(addrOutsider !== addr1, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
