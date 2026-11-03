import test from 'node:test'
import assert from 'node:assert/strict'
import { ConfigValidationError } from '../server/config.mjs'
import {
  getStewardStatus,
  runStewardChat,
  runPayoutRecommendation,
  extractJsonObject,
} from '../server/steward-llm.mjs'

const LLM_ENV = {
  LLM_API_KEY: 'llm_test_key_1234567890',
  LLM_BASE_URL: 'https://api.openai.com/v1',
  LLM_MODEL: 'gpt-4o-mini',
}

test('Steward LLM: fails fast with ConfigValidationError when LLM credentials are missing (no canned fallback)', async () => {
  const status = getStewardStatus({})
  assert.equal(status.available, false)

  await assert.rejects(
    () =>
      runStewardChat(
        {
          message: 'Can Tunde pay late this month?',
          currentCycle: 5,
          withMemory: true,
        },
        { env: {} }
      ),
    (err) => err instanceof ConfigValidationError && err.service === 'llm'
  )
})

test('Steward LLM: withMemory vs withoutMemory uses the same real path and filters citations strictly', async () => {
  const realMemories = [
    {
      id: 'e18a766a-2a7c-4c20-961d-a32c9aa7d31e',
      walrusBlobId: '_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc',
      category: 'Agreements',
      title: 'Tunde 72-Hour Contractor Grace Window',
      quote: 'Tunde may submit his monthly contribution within 72 hours of cycle open.',
      context: 'Keep chain fact as Late, but mark policy status as Accepted under grace if within 72h.',
      cycle: 4,
      memberId: 'm2',
      confirmedBy: 'Signed by Amina Bello',
    },
  ]

  const members = [
    { id: 'm1', name: 'Amina Bello', address: '0x0001', avatarColor: '' },
    { id: 'm2', name: 'Tunde Ojo', address: '0x0002', avatarColor: '' },
  ]

  const verifications = {
    m2_5: {
      status: 'Late',
      txDigest: '9fK3mP7qR2vW5xY8zB4nC6dF8gH1jL3kM5pQ7rS9tU2v',
      amountReceived: 500,
      timestamp: '2026-09-03T10:00:00Z',
    },
  }

  let capturedPrompts = []
  const fakeFetch = async (_url, init) => {
    const reqBody = JSON.parse(init.body)
    capturedPrompts.push(reqBody)
    const userPayload = JSON.parse(reqBody.messages[1].content)
    const hasMemories = userPayload.RECALLED_MEMORIES.length > 0

    const responseObj = hasMemories
      ? {
          reply:
            'Tunde paid on-chain with status Late (tx 9fK3mP7qR2vW5xY8zB4nC6dF8gH1jL3kM5pQ7rS9tU2v), which is accepted under the recorded 72-hour grace agreement (blob _jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc).',
          citedMemoryIds: ['e18a766a-2a7c-4c20-961d-a32c9aa7d31e', 'fake-invented-id'],
          citedBlobIds: ['_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc'],
          citedTxDigests: ['9fK3mP7qR2vW5xY8zB4nC6dF8gH1jL3kM5pQ7rS9tU2v', '0xfake_digest'],
          riskAssessment: {
            memberId: 'm2',
            riskLevel: 'Low Risk',
            note: 'Chain status is Late; policy outcome is Accepted under recorded grace agreement.',
          },
        }
      : {
          reply:
            'With memory disabled, Tunde payment (tx 9fK3mP7qR2vW5xY8zB4nC6dF8gH1jL3kM5pQ7rS9tU2v) is Late on-chain and flagged as an unexcused late payment under strict timestamp rules.',
          citedMemoryIds: ['e18a766a-2a7c-4c20-961d-a32c9aa7d31e'], // Even if LLM tries to cite when recall is disabled, server drops it
          citedBlobIds: [],
          citedTxDigests: ['9fK3mP7qR2vW5xY8zB4nC6dF8gH1jL3kM5pQ7rS9tU2v'],
          riskAssessment: {
            memberId: 'm2',
            riskLevel: 'High Risk',
            note: 'Unexcused late payment under strict cycle deadline.',
          },
        }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: JSON.stringify(responseObj) } }],
        }
      },
    }
  }

  // 1. With memory enabled
  const outWithMem = await runStewardChat(
    {
      circleId: 'lagos-techies-seed-circle',
      message: 'Can Tunde pay late this month?',
      currentCycle: 5,
      withMemory: true,
      members,
      verifications,
      windowEnd: '2026-09-01T23:59:59Z',
      memories: realMemories,
    },
    { env: LLM_ENV, fetchFn: fakeFetch, skipLiveWalrusRecall: true }
  )

  assert.equal(outWithMem.citedMemories.length, 1)
  assert.equal(outWithMem.citedMemories[0].walrusBlobId, '_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc')
  assert.deepEqual(outWithMem.citedTxDigests, ['9fK3mP7qR2vW5xY8zB4nC6dF8gH1jL3kM5pQ7rS9tU2v'])

  // 2. Without memory enabled (same function, recall disabled)
  const outWithoutMem = await runStewardChat(
    {
      circleId: 'lagos-techies-seed-circle',
      message: 'Can Tunde pay late this month?',
      currentCycle: 5,
      withMemory: false,
      members,
      verifications,
      windowEnd: '2026-09-01T23:59:59Z',
      memories: realMemories,
    },
    { env: LLM_ENV, fetchFn: fakeFetch, skipLiveWalrusRecall: true }
  )

  const secondPromptPayload = JSON.parse(capturedPrompts[1].messages[1].content)
  assert.equal(secondPromptPayload.RECALLED_MEMORIES.length, 0)
  assert.equal(outWithoutMem.citedMemories.length, 0)
  assert.deepEqual(outWithoutMem.citedTxDigests, ['9fK3mP7qR2vW5xY8zB4nC6dF8gH1jL3kM5pQ7rS9tU2v'])
})

test('Steward LLM: runPayoutRecommendation validates schema and filters citedBlob against real memories', async () => {
  const members = [
    { id: 'm1', name: 'Amina Bello', address: '0x0001', avatarColor: '' },
    { id: 'm2', name: 'Tunde Ojo', address: '0x0002', avatarColor: '' },
  ]
  const realMemories = [
    {
      id: 'mem-1',
      walrusBlobId: '_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc',
      category: 'Agreements',
      title: 'Tunde 72-Hour Contractor Grace Window',
      quote: 'Approved 72h grace.',
      memberId: 'm2',
    },
  ]

  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                nextRecipientId: 'm1',
                rationale: 'Amina is scheduled for Cycle 1.',
                memberRisks: [
                  {
                    memberId: 'm1',
                    riskLevel: 'Zero Risk',
                    reasoning: 'Chain: Verified · Policy: Accepted on time',
                    action: 'No action needed',
                    citedBlobId: 'fake_unverified_blob',
                  },
                  {
                    memberId: 'm2',
                    riskLevel: 'Low Risk',
                    reasoning: 'Chain: Late · Policy: Accepted under recorded grace agreement',
                    action: 'Grace rule applied',
                    citedBlobId: '_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc',
                  },
                ],
              }),
            },
          },
        ],
      }
    },
  })

  const rec = await runPayoutRecommendation(
    {
      circleId: 'lagos-techies-seed-circle',
      cycle: 1,
      members,
      verifications: {},
      memories: realMemories,
      withMemory: true,
    },
    { env: LLM_ENV, fetchFn: fakeFetch, skipLiveWalrusRecall: true }
  )

  assert.equal(rec.nextRecipient.id, 'm1')
  assert.equal(rec.memberRisks[0].citedBlob, undefined) // Fake blob dropped!
  assert.equal(rec.memberRisks[1].citedBlob, '_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc')
})

test('extractJsonObject parses raw JSON and fenced markdown JSON', () => {
  const parsed = extractJsonObject('```json\n{"reply":"hello"}\n```')
  assert.equal(parsed.reply, 'hello')
})
