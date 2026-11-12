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
  parseGraceAgreementMeta,
  detectPayoutSwapAgreement,
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

test('Policy evaluation: parses custom grace window durations (10 minutes / 10 miniutes) and enforces cycle scope', () => {
  const grace10m = {
    id: 'mem-grace-10m',
    walrusBlobId: 'blob_10m_grace_cycle2',
    category: 'Agreements',
    title: '10 Miniutes Grace Window For Cycle 2 Payment',
    quote: 'Vanessa (m1) is granted a 10 minutes grace window for Cycle 2 payment.',
    memberId: 'm1',
    cycle: 2,
  }

  const parsed = parseGraceAgreementMeta(grace10m, 72)
  assert.equal(parsed.durationMs, 10 * 60 * 1000)
  assert.equal(parsed.durationLabel, '10m')
  assert.equal(parsed.explicitCycle, 2)
  assert.equal(parsed.isCustomDuration, true)

  const windowEnd = '2026-09-01T12:00:00Z'

  // 1. Arrived 6 minutes after deadline in Cycle 2 -> Honored (within 10m grace window)
  const late6m = {
    status: 'Late',
    code: 'late',
    txDigest: 'DgLate6Min',
    amountReceived: 500,
    timestamp: '2026-09-01T12:06:00Z',
  }
  const honoredEval = evaluateContributionPolicy(late6m, {
    withMemory: true,
    windowEnd,
    graceWindowHours: 72,
    memories: [grace10m],
    memberId: 'm1',
    memberName: 'Vanessa',
    cycle: 2,
  })
  assert.equal(honoredEval.chainStatus, 'Late')
  assert.equal(honoredEval.policyStatus, 'Accepted under recorded grace agreement')
  assert.equal(honoredEval.countsTowardPot, true)
  assert.equal(honoredEval.graceEvaluation?.honored, true)
  assert.equal(honoredEval.graceEvaluation?.durationLabel, '10m')
  assert.equal(honoredEval.citedMemory?.walrusBlobId, 'blob_10m_grace_cycle2')

  // 2. Arrived 25 minutes after deadline in Cycle 2 -> Exceeded 10m grace window (even though default is 72h!)
  const late25m = {
    status: 'Late',
    code: 'late',
    txDigest: 'DgLate25Min',
    amountReceived: 500,
    timestamp: '2026-09-01T12:25:00Z',
  }
  const exceededEval = evaluateContributionPolicy(late25m, {
    withMemory: true,
    windowEnd,
    graceWindowHours: 72,
    memories: [grace10m],
    memberId: 'm1',
    memberName: 'Vanessa',
    cycle: 2,
  })
  assert.equal(exceededEval.chainStatus, 'Late')
  assert.equal(exceededEval.policyStatus, 'Late (Exceeded grace window)')
  assert.equal(exceededEval.countsTowardPot, false)
  assert.equal(exceededEval.graceEvaluation?.honored, false)
  assert.ok(exceededEval.policyReason.includes('10m grace window'))

  // 3. Cycle 2 agreement does NOT excuse a late payment in Cycle 3
  const cycle3Eval = evaluateContributionPolicy(late6m, {
    withMemory: true,
    windowEnd,
    graceWindowHours: 72,
    memories: [grace10m],
    memberId: 'm1',
    memberName: 'Vanessa',
    cycle: 3,
  })
  assert.equal(cycle3Eval.policyStatus, 'Unexcused late payment')
  assert.equal(cycle3Eval.countsTowardPot, false)
})

test('Policy evaluation: cross-cycle timeliness trajectory compares prior historical_behavior blob with current payment', () => {
  const priorCycleLatenessBlob = {
    id: 'hist-lateness-c1-m1',
    walrusBlobId: 'blob_cycle1_lateness_m1',
    category: 'Member patterns',
    memoryType: 'historical_behavior',
    label: 'historical contribution behavior',
    title: 'Historical Contribution Behavior: Grace Agreement Honored by Vanessa in Cycle 1',
    quote: 'Member Vanessa (m1) completed cycle 1 contribution 4m late within 10m grace window.',
    memberId: 'm1',
    cycle: 1,
  }

  // 1. In Cycle 2, Vanessa pays ON TIME -> Policy notes recovery and cites the Cycle 1 Walrus blob
  const onTimeCycle2 = {
    status: 'Verified',
    code: 'verified',
    txDigest: 'DgOnTimeCycle2',
    amountReceived: 500,
    timestamp: '2026-09-02T11:50:00Z',
  }
  const recoveredEval = evaluateContributionPolicy(onTimeCycle2, {
    withMemory: true,
    windowEnd: '2026-09-02T12:00:00Z',
    memories: [priorCycleLatenessBlob],
    memberId: 'm1',
    memberName: 'Vanessa',
    cycle: 2,
  })
  assert.equal(recoveredEval.chainStatus, 'Verified')
  assert.equal(recoveredEval.policyStatus, 'Accepted on time (Recovered after prior late cycle)')
  assert.equal(recoveredEval.countsTowardPot, true)
  assert.equal(recoveredEval.timelinessTrajectory, 'recovered_on_time')
  assert.equal(recoveredEval.citedMemory?.walrusBlobId, 'blob_cycle1_lateness_m1')

  // 2. In Cycle 2, if Vanessa is late again without a Cycle 2 grace agreement -> Repeat late cycle
  const lateCycle2 = {
    status: 'Late',
    code: 'late',
    txDigest: 'DgRepeatLateCycle2',
    amountReceived: 500,
    timestamp: '2026-09-02T14:00:00Z',
  }
  const repeatLateEval = evaluateContributionPolicy(lateCycle2, {
    withMemory: true,
    windowEnd: '2026-09-02T12:00:00Z',
    memories: [priorCycleLatenessBlob],
    memberId: 'm1',
    memberName: 'Vanessa',
    cycle: 2,
  })
  assert.equal(repeatLateEval.chainStatus, 'Late')
  assert.equal(repeatLateEval.policyStatus, 'Unexcused late payment (Repeat late cycle)')
  assert.equal(repeatLateEval.countsTowardPot, false)
  assert.equal(repeatLateEval.timelinessTrajectory, 'repeat_late_unexcused')
  assert.equal(repeatLateEval.citedMemory?.walrusBlobId, 'blob_cycle1_lateness_m1')
})

test('Loop 3: Multi-tranche split completion is flagged and cites prior split pattern memory', () => {
  const splitVerified = {
    status: 'Verified',
    code: 'verified',
    txDigest: 'DgSplit2',
    txDigests: ['DgSplit1', 'DgSplit2'],
    amountReceived: 500,
    timestamp: '2026-09-01T20:00:00Z',
  }
  const splitMemory = {
    id: 'mem_split_c1',
    walrusBlobId: 'blob_split_pattern_m2',
    category: 'Member patterns',
    memoryType: 'historical_behavior',
    label: 'split contribution pattern',
    title: 'Split Contribution Pattern: Daniel Completed Cycle 1 in 2 Tranches',
    quote: 'Daniel completed Cycle 1 in 2 tranches.',
    memberId: 'm2',
    memberIds: ['m2'],
    cycle: 1,
  }

  const evalRes = evaluateContributionPolicy(splitVerified, {
    withMemory: true,
    memories: [splitMemory],
    memberId: 'm2',
    memberName: 'Daniel',
    cycle: 2,
  })
  assert.equal(evalRes.chainStatus, 'Verified')
  assert.equal(evalRes.policyStatus, 'Accepted on time (Split tranches completed under recorded pattern)')
  assert.equal(evalRes.countsTowardPot, true)
  assert.equal(evalRes.splitCompletion?.trancheCount, 2)
  assert.equal(evalRes.splitCompletion?.matchedPatternBlobId, 'blob_split_pattern_m2')
  assert.equal(evalRes.citedMemory?.walrusBlobId, 'blob_split_pattern_m2')
})

test('Loop 4: Opted-in reminder preference and prior conversion outcome enrich Pending and Verified evaluations', () => {
  const prefMem = {
    id: 'mem_rem_pref_m3',
    walrusBlobId: 'blob_rem_pref_m3',
    category: 'Reminder preferences',
    memoryType: 'reminder_preference',
    label: 'reminder preference',
    title: 'Evening 6pm WAT reminder opt-in',
    quote: 'Sarah prefers evening 6pm WAT reminders 24h before deadline.',
    memberId: 'm3',
    memberIds: ['m3'],
  }
  const outcomeMem = {
    id: 'mem_rem_outcome_m3',
    walrusBlobId: 'blob_rem_outcome_m3',
    category: 'Reminder preferences',
    memoryType: 'reminder_preference',
    label: 'reminder conversion outcome',
    title: 'Reminder Conversion Outcome: Sarah Completed Cycle 1',
    quote: 'Sarah completed Cycle 1 after evening reminder.',
    memberId: 'm3',
    memberIds: ['m3'],
    cycle: 1,
  }

  const pendingEval = evaluateContributionPolicy(
    { status: 'Pending', code: 'pending', amountReceived: 0 },
    {
      withMemory: true,
      memories: [prefMem, outcomeMem],
      memberId: 'm3',
      memberName: 'Sarah',
      cycle: 2,
    }
  )
  assert.equal(pendingEval.reminderPreference?.walrusBlobId, 'blob_rem_pref_m3')
  assert.equal(pendingEval.citedMemory?.walrusBlobId, 'blob_rem_pref_m3')
  assert.match(pendingEval.policyReason, /Follow recorded reminder preference/i)
  assert.match(pendingEval.policyReason, /Prior on-time settlement/i)

  const verifiedEval = evaluateContributionPolicy(
    { status: 'Verified', code: 'verified', txDigest: 'DgSarahC2', amountReceived: 500 },
    {
      withMemory: true,
      memories: [prefMem],
      memberId: 'm3',
      memberName: 'Sarah',
      cycle: 2,
    }
  )
  assert.equal(verifiedEval.reminderPreference?.walrusBlobId, 'blob_rem_pref_m3')
})

test('Loop 5: detectPayoutSwapAgreement detects payout-order swap agreement as advisory guardrail only', () => {
  const swapMem = {
    id: 'mem_swap_c2',
    walrusBlobId: 'blob_swap_agreement_c2',
    category: 'Agreements',
    memoryType: 'agreement',
    title: 'Cycle 2 Payout Order Swap Agreement between Daniel and Sarah',
    quote: 'Daniel and Sarah agreed to swap payout order for Cycle 2.',
    cycle: 2,
    memberId: 'm2',
  }

  const advisory = detectPayoutSwapAgreement([swapMem], {
    cycle: 2,
    scheduledRecipientName: 'Daniel',
  })
  assert.equal(advisory?.detected, true)
  assert.equal(advisory?.walrusBlobId, 'blob_swap_agreement_c2')
  assert.match(advisory?.advisoryNote || '', /Move contract.*enforces the immutable payout_order/i)

  assert.equal(detectPayoutSwapAgreement([], { cycle: 2, scheduledRecipientName: 'Daniel' }), null)
})
