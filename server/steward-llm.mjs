import crypto from 'node:crypto'
import { z } from 'zod'
import { loadConfig, requireIntegrationConfig } from './config.mjs'
import { recallCircleMemories, proposeCircleMemory } from './walrus-memory.mjs'
import { evaluateContributionPolicy } from './payment-policy.mjs'

export const StewardChatLlmSchema = z.object({
  reply: z.string().trim().min(1),
  citedMemoryIds: z.array(z.string()).default([]),
  citedBlobIds: z.array(z.string()).default([]),
  citedTxDigests: z.array(z.string()).default([]),
  proposedMemory: z
    .object({
      category: z.enum(['Agreements', 'Member patterns', 'Reminder preferences']),
      title: z.string().trim().min(1),
      quote: z.string().trim().min(1),
      suggestedAction: z.string().trim().min(1),
      memberId: z.string().optional(),
    })
    .nullable()
    .optional(),
  riskAssessment: z
    .object({
      memberId: z.string().trim().min(1),
      riskLevel: z.enum(['Zero Risk', 'Low Risk', 'Moderate Risk', 'High Risk']),
      note: z.string().trim().min(1),
    })
    .nullable()
    .optional(),
})

export const PayoutRecommendationLlmSchema = z.object({
  nextRecipientId: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  memberRisks: z.array(
    z.object({
      memberId: z.string().trim().min(1),
      riskLevel: z.enum(['Zero Risk', 'Low Risk', 'Moderate Risk', 'High Risk']),
      reasoning: z.string().trim().min(1),
      action: z.string().trim().min(1),
      citedBlobId: z.string().nullable().optional(),
    })
  ),
})

/**
 * Extract JSON object from an LLM completion string (strips optional markdown code fences).
 */
export function extractJsonObject(rawContent) {
  if (typeof rawContent !== 'string') {
    throw new Error('LLM response content is not a string')
  }
  const trimmed = rawContent.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('LLM response did not contain a valid JSON object')
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1))
}

/**
 * Call the configured OpenAI-compatible chat completions endpoint.
 */
export async function callConfiguredLlm(messages, options = {}) {
  const env = options.env || process.env
  const fetchFn = options.fetchFn || fetch
  const { serviceConfig, tunables } = requireIntegrationConfig('llm', env)

  const endpoint = `${serviceConfig.LLM_BASE_URL}/chat/completions`
  const res = await fetchFn(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(tunables.requestTimeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceConfig.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: serviceConfig.LLM_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages,
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`LLM API returned HTTP ${res.status}: ${errText.slice(0, 200)}`)
  }

  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('LLM API response did not include choices[0].message.content')
  }
  return extractJsonObject(content)
}

/**
 * Check LLM Steward availability without making fabricated claims.
 */
export function getStewardStatus(env = process.env) {
  const cfg = loadConfig(env)
  return {
    available: cfg.integrations.llm.configured,
    status: cfg.integrations.llm.status,
    model: cfg.integrations.llm.config?.LLM_MODEL || null,
    missingVars: cfg.integrations.llm.missingVars,
    issues: cfg.integrations.llm.issues,
  }
}

/**
 * Process a Steward chat message using the single real code path:
 * - When `withMemory === true`: recalls relevant memories from Walrus Memory for `circleId`.
 * - When `withMemory === false`: disables recall (`recalledMemories = []`) and uses the exact same prompt & LLM pipeline.
 * - Filters all cited memory IDs / blob IDs and transaction digests against real recalled memories and verified transactions.
 */
export async function runStewardChat(input, options = {}) {
  const env = options.env || process.env
  const cfg = loadConfig(env)
  const {
    circleId,
    circleName = 'Savings Circle',
    message,
    currentCycle = 1,
    withMemory = true,
    members = [],
    verifications = {},
    windowEnd,
    memories: clientMemories = [],
  } = input

  if (!message || !String(message).trim()) {
    throw new Error('Chat message is required')
  }

  // Require LLM configuration (throws ConfigValidationError if missing)
  requireIntegrationConfig('llm', env)

  // Step 1: Recall memories only when `withMemory === true`
  let activeMemories = []
  if (withMemory) {
    if (circleId && cfg.integrations.memwal.configured && !options.skipLiveWalrusRecall) {
      try {
        const recallRes = await recallCircleMemories(
          circleId,
          message,
          { limit: cfg.tunables.recallLimit },
          env
        )
        activeMemories = recallRes.records
      } catch {
        activeMemories = clientMemories.filter((m) => Boolean(m.walrusBlobId))
      }
    } else {
      activeMemories = clientMemories.filter((m) => Boolean(m.walrusBlobId))
    }
  }

  // Step 2: Build verified on-chain evidence + policy table for the current cycle
  const memberEvidence = members.map((m) => {
    const recKey = `${m.id}_${currentCycle}`
    const raw = verifications[recKey] || verifications[m.id] || {
      status: 'Pending',
      amountReceived: 0,
      rawNotes: 'No transaction verified for this cycle yet.',
    }
    const policy =
      raw.policy ||
      evaluateContributionPolicy(raw, {
        withMemory,
        windowEnd: windowEnd || new Date().toISOString(),
        graceWindowHours: cfg.tunables.graceWindowHours,
        memories: activeMemories,
        memberId: m.id,
        memberName: m.name,
      })
    return {
      memberId: m.id,
      name: m.name,
      address: m.address,
      chainStatus: raw.status,
      txDigest: raw.txDigest || null,
      txDigests: raw.txDigests || (raw.txDigest ? [raw.txDigest] : []),
      amountReceived: raw.amountReceived ?? 0,
      timestamp: raw.timestamp || null,
      policyStatus: policy.policyStatus,
      countsTowardPot: policy.countsTowardPot,
      policyReason: policy.policyReason,
      citedMemoryBlobId: policy.citedMemory?.walrusBlobId || null,
    }
  })

  const systemPrompt = [
    'You are the Ajo Circle Steward, a non-custodial advisory agent for a rotating savings circle on Sui.',
    `Mode: ${withMemory ? 'WITH_MEMORY (Walrus group memories enabled)' : 'WITHOUT_MEMORY (strict on-chain timestamp evaluation only; memory recall disabled)'}.`,
    'CRITICAL RULES:',
    '1. Separate chain facts from group policy: a payment that arrived after windowEnd is ALWAYS "Late" as a chain fact, even if excused under a recorded grace agreement.',
    '2. Every claim about a member MUST cite either a recalled Walrus memory (by id/walrusBlobId from RECALLED_MEMORIES) or a verified transaction digest (from MEMBER_EVIDENCE), or explicitly state that the member has no verified transaction yet (Pending/Unverified).',
    '3. Never invent blob IDs, transaction digests, vote counts, or balances.',
    '4. If the user message proposes a new circle rule, exception, turn swap, or reminder preference, populate `proposedMemory` so a member can confirm it before writing to Walrus.',
    'Respond ONLY with a valid JSON object matching this schema:',
    JSON.stringify({
      reply: 'string (concise, accurate response citing blob IDs or tx digests)',
      citedMemoryIds: ['array of memory `id` strings from RECALLED_MEMORIES that affected your answer'],
      citedBlobIds: ['array of `walrusBlobId` strings from RECALLED_MEMORIES that affected your answer'],
      citedTxDigests: ['array of verified `txDigest` strings from MEMBER_EVIDENCE that affected your answer'],
      proposedMemory: {
        category: 'Agreements | Member patterns | Reminder preferences',
        title: 'string',
        quote: 'string',
        suggestedAction: 'string',
        memberId: 'optional memberId string',
      },
      riskAssessment: {
        memberId: 'memberId string',
        riskLevel: 'Zero Risk | Low Risk | Moderate Risk | High Risk',
        note: 'string',
      },
    }),
  ].join('\n')

  const userPayload = JSON.stringify(
    {
      circleName,
      currentCycle,
      withMemory,
      userMessage: message,
      RECALLED_MEMORIES: activeMemories.map((m) => ({
        id: m.id,
        walrusBlobId: m.walrusBlobId,
        category: m.category,
        title: m.title,
        quote: m.quote,
        context: m.context,
        cycle: m.cycle,
        memberId: m.memberId,
        confirmedBy: m.confirmedBy,
      })),
      MEMBER_EVIDENCE: memberEvidence,
    },
    null,
    2
  )

  const rawJson = await callConfiguredLlm(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPayload },
    ],
    options
  )

  const validated = StewardChatLlmSchema.parse(rawJson)

  // Strictly filter citedMemories to only real recalled memories when withMemory === true
  const citedMemories = withMemory
    ? activeMemories.filter(
        (m) =>
          validated.citedMemoryIds.includes(m.id) ||
          validated.citedBlobIds.includes(m.walrusBlobId)
      )
    : []

  // Strictly filter citedTxDigests to only real verified txDigests from memberEvidence
  const knownDigests = new Set(
    memberEvidence.flatMap((e) => e.txDigests).filter(Boolean)
  )
  const citedTxDigests = validated.citedTxDigests.filter((d) => knownDigests.has(d))

  let proposedMemory = undefined
  if (validated.proposedMemory) {
    if (circleId) {
      try {
        proposedMemory = proposeCircleMemory({
          circleId,
          ...validated.proposedMemory,
          cycle: currentCycle,
        })
      } catch {
        proposedMemory = {
          id: `prop-${crypto.randomUUID()}`,
          circleId,
          ...validated.proposedMemory,
          cycle: currentCycle,
        }
      }
    } else {
      proposedMemory = {
        id: `prop-${crypto.randomUUID()}`,
        ...validated.proposedMemory,
        cycle: currentCycle,
      }
    }
  }

  return {
    reply: validated.reply,
    proposedMemory,
    citedMemories,
    citedTxDigests,
    riskAssessment: validated.riskAssessment || undefined,
  }
}

/**
 * Generate a cycle payout recommendation using the configured LLM and real policy evaluations.
 */
export async function runPayoutRecommendation(input, options = {}) {
  const env = options.env || process.env
  const cfg = loadConfig(env)
  const {
    circleId,
    cycle = 1,
    members = [],
    verifications = {},
    memories: clientMemories = [],
    withMemory = true,
    windowEnd,
  } = input

  if (!Array.isArray(members) || members.length === 0) {
    throw new Error('Cannot generate payout recommendation for an empty member roster.')
  }

  requireIntegrationConfig('llm', env)

  let activeMemories = []
  if (withMemory) {
    if (circleId && cfg.integrations.memwal.configured && !options.skipLiveWalrusRecall) {
      try {
        const recallRes = await recallCircleMemories(
          circleId,
          `cycle ${cycle} payout rotation swap grace period split payment risk`,
          { limit: cfg.tunables.recallLimit },
          env
        )
        activeMemories = recallRes.records
      } catch {
        activeMemories = clientMemories.filter((m) => Boolean(m.walrusBlobId))
      }
    } else {
      activeMemories = clientMemories.filter((m) => Boolean(m.walrusBlobId))
    }
  }

  const scheduledIndex = (cycle - 1) % members.length
  const scheduledRecipient = members[scheduledIndex] || members[0]

  const memberEvaluations = members.map((m) => {
    const recKey = `${m.id}_${cycle}`
    const raw = verifications[recKey] || verifications[m.id] || {
      status: 'Pending',
      amountReceived: 0,
    }
    const policy =
      raw.policy ||
      evaluateContributionPolicy(raw, {
        withMemory,
        windowEnd: windowEnd || new Date().toISOString(),
        graceWindowHours: cfg.tunables.graceWindowHours,
        memories: activeMemories,
        memberId: m.id,
        memberName: m.name,
      })
    return {
      member: m,
      chainStatus: raw.status,
      txDigest: raw.txDigest || null,
      amountReceived: raw.amountReceived ?? 0,
      policyStatus: policy.policyStatus,
      countsTowardPot: policy.countsTowardPot,
      policyReason: policy.policyReason,
      citedBlobId: policy.citedMemory?.walrusBlobId || null,
    }
  })

  const systemPrompt = [
    'You are the Ajo Circle Steward generating a payout & risk recommendation for the current cycle.',
    `Mode: ${withMemory ? 'WITH_MEMORY' : 'WITHOUT_MEMORY (recall disabled)'}.`,
    'Keep chain facts (Verified, Late, Partial, Pending, Unverified) separate from group policy outcomes.',
    'Respond ONLY with a valid JSON object matching this schema:',
    JSON.stringify({
      nextRecipientId: 'memberId string',
      rationale: 'string explaining the recommendation based on verified chain balances and (if WITH_MEMORY) cited memories',
      memberRisks: [
        {
          memberId: 'memberId string',
          riskLevel: 'Zero Risk | Low Risk | Moderate Risk | High Risk',
          reasoning: 'string stating both chain fact and policy status',
          action: 'string concise recommended next step',
          citedBlobId: 'optional walrusBlobId string from RECALLED_MEMORIES or null',
        },
      ],
    }),
  ].join('\n')

  const rawJson = await callConfiguredLlm(
    [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          cycle,
          withMemory,
          scheduledRecipientId: scheduledRecipient.id,
          scheduledRecipientName: scheduledRecipient.name,
          RECALLED_MEMORIES: activeMemories.map((m) => ({
            id: m.id,
            walrusBlobId: m.walrusBlobId,
            category: m.category,
            title: m.title,
            quote: m.quote,
            memberId: m.memberId,
          })),
          MEMBER_EVALUATIONS: memberEvaluations.map((e) => ({
            memberId: e.member.id,
            name: e.member.name,
            chainStatus: e.chainStatus,
            txDigest: e.txDigest,
            amountReceived: e.amountReceived,
            policyStatus: e.policyStatus,
            policyReason: e.policyReason,
            citedBlobId: e.citedBlobId,
          })),
        }),
      },
    ],
    options
  )

  const validated = PayoutRecommendationLlmSchema.parse(rawJson)
  const validBlobs = new Set(activeMemories.map((m) => m.walrusBlobId).filter(Boolean))
  const nextRecipient =
    members.find((m) => m.id === validated.nextRecipientId) || scheduledRecipient

  const memberRisks = members.map((m) => {
    const llmRisk = validated.memberRisks.find((r) => r.memberId === m.id)
    const evalItem = memberEvaluations.find((e) => e.member.id === m.id)
    const riskLevel = llmRisk?.riskLevel || 'Moderate Risk'
    const badgeClass =
      riskLevel === 'Zero Risk' || riskLevel === 'Low Risk'
        ? 'bg-utility-success-50 text-utility-success-700 border-utility-success-200'
        : riskLevel === 'Moderate Risk'
        ? 'bg-utility-warning-50 text-utility-warning-700 border-utility-warning-200'
        : 'bg-utility-error-50 text-error-primary border-error-subtle'

    const candidateBlob = llmRisk?.citedBlobId || evalItem?.citedBlobId || undefined
    return {
      member: m,
      riskLevel,
      badgeClass,
      reasoning:
        llmRisk?.reasoning ||
        `Chain: ${evalItem?.chainStatus || 'Unverified'} · Policy: ${evalItem?.policyStatus || 'Unverified'}`,
      action: llmRisk?.action || 'Verify contribution digest',
      citedBlob: withMemory && candidateBlob && validBlobs.has(candidateBlob) ? candidateBlob : undefined,
    }
  })

  return {
    nextRecipient,
    rationale: validated.rationale,
    memberRisks,
  }
}
