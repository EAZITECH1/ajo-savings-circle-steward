import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadConfig,
  requireIntegrationConfig,
  configuredSecretValues,
  ConfigValidationError,
  TUNABLE_DEFAULTS,
} from '../server/config.mjs'
import {
  classifyChainContribution,
  evaluateContributionPolicy,
  normalizeSuiAddress,
  normalizeCoinType,
} from '../server/payment-policy.mjs'

test('Config validation: empty env applies documented tunable defaults and marks integrations unconfigured', () => {
  const cfg = loadConfig({})
  assert.equal(cfg.tunables.port, TUNABLE_DEFAULTS.PORT)
  assert.equal(cfg.tunables.graceWindowHours, TUNABLE_DEFAULTS.GRACE_WINDOW_HOURS)
  assert.equal(cfg.tunables.partialPaymentWindowHours, TUNABLE_DEFAULTS.PARTIAL_PAYMENT_WINDOW_HOURS)
  assert.equal(cfg.tunables.pollingIntervalMs, TUNABLE_DEFAULTS.POLLING_INTERVAL_MS)
  assert.equal(cfg.tunables.rateLimitRps, TUNABLE_DEFAULTS.RATE_LIMIT_RPS)
  assert.equal(cfg.tunables.rateLimitMaxRetries, TUNABLE_DEFAULTS.RATE_LIMIT_MAX_RETRIES)
  assert.equal(cfg.tunables.rateLimitBackoffMs, TUNABLE_DEFAULTS.RATE_LIMIT_BACKOFF_MS)
  assert.equal(cfg.tunables.recallLimit, TUNABLE_DEFAULTS.RECALL_LIMIT)
  assert.equal(cfg.tunables.requestTimeoutMs, TUNABLE_DEFAULTS.REQUEST_TIMEOUT_MS)

  assert.equal(cfg.integrations.tatum.configured, false)
  assert.equal(cfg.integrations.tatum.status, 'unconfigured')
  assert.equal(cfg.integrations.memwal.configured, false)
  assert.equal(cfg.integrations.memwal.status, 'unconfigured')
  assert.equal(cfg.integrations.llm.configured, false)
  assert.equal(cfg.integrations.llm.status, 'unconfigured')
})

test('Config validation: malformed tunable throws ConfigValidationError', () => {
  assert.throws(
    () => loadConfig({ GRACE_WINDOW_HOURS: '-10' }),
    (err) => err instanceof ConfigValidationError && err.service === 'tunables'
  )
  assert.throws(
    () => loadConfig({ PORT: 'not-a-port' }),
    (err) => err instanceof ConfigValidationError && err.service === 'tunables'
  )
})

test('Config validation: partial or invalid service config is flagged and requireIntegrationConfig throws', () => {
  const partialEnv = {
    MEMWAL_KEY: 'a'.repeat(64),
  }
  const cfg = loadConfig(partialEnv)
  assert.equal(cfg.integrations.memwal.configured, false)
  assert.equal(cfg.integrations.memwal.status, 'incomplete')
  assert.deepEqual(cfg.integrations.memwal.missingVars, ['MEMWAL_ACCOUNT_ID', 'MEMWAL_SERVER_URL'])

  assert.throws(
    () => requireIntegrationConfig('memwal', partialEnv),
    (err) => err instanceof ConfigValidationError && err.service === 'memwal'
  )

  const invalidNetworkEnv = {
    TATUM_API_KEY: 'tatum_test_key_12345',
    TATUM_API_BASE: 'https://api.tatum.io',
    SUI_NETWORK: 'devnet',
  }
  const cfg2 = loadConfig(invalidNetworkEnv)
  assert.equal(cfg2.integrations.tatum.configured, false)
  assert.equal(cfg2.integrations.tatum.status, 'invalid')
})

test('Config validation: valid service configs parse cleanly and configuredSecretValues returns all secrets', () => {
  const env = {
    TATUM_API_KEY: 'tatum_secret_key_abcdef',
    TATUM_API_BASE: 'https://api.tatum.io/',
    SUI_NETWORK: 'testnet',
    SUI_TOKEN_TYPE: '0x2::sui::SUI',
    SUI_TOKEN_DECIMALS: '9',
    MEMWAL_KEY: 'b'.repeat(64),
    MEMWAL_ACCOUNT_ID: '0xf6b75c6fd44e685829e0baa04077c42c09bed658819e921126dc11ce8c3175d4',
    MEMWAL_SERVER_URL: 'https://relayer.memory.walrus.xyz/',
    LLM_API_KEY: 'llm_secret_key_123456',
    LLM_BASE_URL: 'https://api.openai.com/v1/',
    LLM_MODEL: 'gpt-4o-mini',
  }
  const cfg = loadConfig(env)
  assert.equal(cfg.integrations.tatum.configured, true)
  assert.equal(cfg.integrations.tatum.config.TATUM_API_BASE, 'https://api.tatum.io')
  assert.equal(cfg.integrations.memwal.configured, true)
  assert.equal(cfg.integrations.memwal.config.MEMWAL_SERVER_URL, 'https://relayer.memory.walrus.xyz')
  assert.equal(cfg.integrations.llm.configured, true)

  const secrets = configuredSecretValues(env)
  assert.equal(secrets.length, 3)
  assert.ok(secrets.includes('tatum_secret_key_abcdef'))
  assert.ok(secrets.includes('b'.repeat(64)))
  assert.ok(secrets.includes('llm_secret_key_123456'))
})

test('Payment classification: unavailable, malformed, not_found, and incomplete_fields return Unverified (never Pending)', () => {
  const baseExpected = {
    poolAddress: '0x1111',
    memberAddress: '0x2222',
    token: '0x2::sui::SUI',
    expectedAmount: 500,
    windowStart: '2026-09-01T00:00:00Z',
    windowEnd: '2026-09-01T23:59:59Z',
  }

  for (const status of ['unavailable', 'malformed_digest', 'not_found', 'incomplete_fields']) {
    const res = classifyChainContribution({
      lookupStatus: status,
      lookupError: `Simulated ${status}`,
      expected: baseExpected,
    })
    assert.equal(res.status, 'Unverified')
    assert.equal(res.code, 'unverified')
  }

  const pendingRes = classifyChainContribution({
    lookupStatus: 'no_digest_submitted',
    expected: baseExpected,
  })
  assert.equal(pendingRes.status, 'Pending')
  assert.equal(pendingRes.code, 'pending')
})

test('Payment classification: on-time, late, partial, wrong_token, wrong_amount, and split-payment aggregation', () => {
  const expected = {
    poolAddress: '0x000000000000000000000000000000000000000000000000000000000000aaaa',
    memberAddress: '0x000000000000000000000000000000000000000000000000000000000000bbbb',
    token: '0x2::sui::SUI',
    expectedAmount: 500,
    windowStart: '2026-09-01T00:00:00Z',
    windowEnd: '2026-09-01T23:59:59Z',
  }

  // 1. On-time payment (also testing short vs full-padded 0x2::sui::SUI coin type normalization)
  const onTime = classifyChainContribution({
    lookupStatus: 'found',
    expected,
    transfers: [
      {
        txDigest: 'DgOnTime111',
        sender: '0xbbbb',
        recipient: '0xaaaa',
        tokenType: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
        amount: 500,
        timestampMs: Date.parse('2026-09-01T10:00:00Z'),
      },
    ],
  })
  assert.equal(onTime.status, 'Verified')
  assert.equal(onTime.code, 'verified')
  assert.equal(onTime.amountReceived, 500)

  // 2. Late payment (arrived 2 days after windowEnd) -> remains Late as a chain fact
  const late = classifyChainContribution({
    lookupStatus: 'found',
    expected,
    transfers: [
      {
        txDigest: 'DgLate222',
        sender: '0xbbbb',
        recipient: '0xaaaa',
        tokenType: '0x2::sui::SUI',
        amount: 500,
        timestampMs: Date.parse('2026-09-03T12:00:00Z'),
      },
    ],
  })
  assert.equal(late.status, 'Late')
  assert.equal(late.code, 'late')
  assert.equal(late.amountReceived, 500)

  // 3. Single partial payment (250 of 500)
  const partial = classifyChainContribution({
    lookupStatus: 'found',
    expected,
    transfers: [
      {
        txDigest: 'DgPart1',
        sender: '0xbbbb',
        recipient: '0xaaaa',
        tokenType: '0x2::sui::SUI',
        amount: 250,
        timestampMs: Date.parse('2026-09-01T08:00:00Z'),
      },
    ],
  })
  assert.equal(partial.status, 'Partial')
  assert.equal(partial.code, 'partial')
  assert.equal(partial.amountReceived, 250)

  // 4. Two partial payments inside the 48h window completing before windowEnd -> Verified
  const splitVerified = classifyChainContribution({
    lookupStatus: 'found',
    expected,
    partialPaymentWindowHours: 48,
    transfers: [
      {
        txDigest: 'DgSplit1',
        sender: '0xbbbb',
        recipient: '0xaaaa',
        tokenType: '0x2::sui::SUI',
        amount: 250,
        timestampMs: Date.parse('2026-09-01T06:00:00Z'),
      },
      {
        txDigest: 'DgSplit2',
        sender: '0xbbbb',
        recipient: '0xaaaa',
        tokenType: '0x2::sui::SUI',
        amount: 250,
        timestampMs: Date.parse('2026-09-01T20:00:00Z'),
      },
    ],
  })
  assert.equal(splitVerified.status, 'Verified')
  assert.equal(splitVerified.amountReceived, 500)
  assert.deepEqual(splitVerified.txDigests, ['DgSplit1', 'DgSplit2'])

  // 5. Two partial payments separated by 60h (> 48h partialPaymentWindowHours) -> stays Partial
  const splitExceededWindow = classifyChainContribution({
    lookupStatus: 'found',
    expected: {
      ...expected,
      windowEnd: '2026-09-05T23:59:59Z',
    },
    partialPaymentWindowHours: 48,
    transfers: [
      {
        txDigest: 'DgSlowSplit1',
        sender: '0xbbbb',
        recipient: '0xaaaa',
        tokenType: '0x2::sui::SUI',
        amount: 250,
        timestampMs: Date.parse('2026-09-01T06:00:00Z'),
      },
      {
        txDigest: 'DgSlowSplit2',
        sender: '0xbbbb',
        recipient: '0xaaaa',
        tokenType: '0x2::sui::SUI',
        amount: 250,
        timestampMs: Date.parse('2026-09-03T18:00:00Z'), // 60 hours later
      },
    ],
  })
  assert.equal(splitExceededWindow.status, 'Partial')

  // 6. Wrong token
  const wrongToken = classifyChainContribution({
    lookupStatus: 'found',
    expected,
    transfers: [
      {
        txDigest: 'DgWrongTok',
        sender: '0xbbbb',
        recipient: '0xaaaa',
        tokenType: '0xdeadbeef::fake::COIN',
        amount: 500,
        timestampMs: Date.parse('2026-09-01T10:00:00Z'),
      },
    ],
  })
  assert.equal(wrongToken.status, 'WrongToken')
  assert.equal(wrongToken.code, 'wrong_token')

  // 7. Wrong amount (overpayment)
  const wrongAmount = classifyChainContribution({
    lookupStatus: 'found',
    expected,
    transfers: [
      {
        txDigest: 'DgOverpay',
        sender: '0xbbbb',
        recipient: '0xaaaa',
        tokenType: '0x2::sui::SUI',
        amount: 750,
        timestampMs: Date.parse('2026-09-01T10:00:00Z'),
      },
    ],
  })
  assert.equal(wrongAmount.status, 'WrongAmount')
  assert.equal(wrongAmount.code, 'wrong_amount')
})

test('Policy evaluation: separates chain status (Late) from grace-agreement policy outcome', () => {
  const lateChainFact = {
    status: 'Late',
    code: 'late',
    txDigest: 'DgLateTunde',
    amountReceived: 500,
    timestamp: '2026-09-03T14:15:00Z',
    hoursLate: 38.25,
  }

  const memories = [
    {
      id: 'mem-grace-1',
      category: 'Agreements',
      title: 'Tunde 3-Day Grace Agreement',
      quote: 'Approved 72h grace window for Tunde.',
      memberId: 'm2',
      walrusBlobId: 'real_blob_id_abc',
    },
  ]

  // With memory enabled: chainStatus MUST remain 'Late', while policyStatus is 'Accepted under recorded grace agreement'
  const withMemEval = evaluateContributionPolicy(lateChainFact, {
    withMemory: true,
    windowEnd: '2026-09-01T23:59:59Z',
    graceWindowHours: 72,
    memories,
    memberId: 'm2',
    memberName: 'Tunde Ojo',
  })

  assert.equal(withMemEval.chainStatus, 'Late')
  assert.equal(withMemEval.policyStatus, 'Accepted under recorded grace agreement')
  assert.equal(withMemEval.countsTowardPot, true)
  assert.equal(withMemEval.citedMemory?.id, 'mem-grace-1')

  // With memory disabled: same function returns 'Unexcused late payment' and countsTowardPot = false
  const withoutMemEval = evaluateContributionPolicy(lateChainFact, {
    withMemory: false,
    windowEnd: '2026-09-01T23:59:59Z',
    graceWindowHours: 72,
    memories,
    memberId: 'm2',
    memberName: 'Tunde Ojo',
  })

  assert.equal(withoutMemEval.chainStatus, 'Late')
  assert.equal(withoutMemEval.policyStatus, 'Unexcused late payment')
  assert.equal(withoutMemEval.countsTowardPot, false)
  assert.equal(withoutMemEval.citedMemory, null)
})

test('Address and CoinType normalization', () => {
  assert.equal(
    normalizeSuiAddress('0x2'),
    '0x0000000000000000000000000000000000000000000000000000000000000002'
  )
  assert.equal(
    normalizeCoinType('0x2::sui::SUI'),
    '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'
  )
})
