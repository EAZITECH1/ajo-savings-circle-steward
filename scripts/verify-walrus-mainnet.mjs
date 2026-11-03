import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadDotEnvIfPresent, requireIntegrationConfig } from '../server/config.mjs'
import {
  checkWalrusMemoryHealth,
  upsertCircleRoster,
  proposeCircleMemory,
  issueConfirmationChallenge,
  confirmAndWriteMemory,
  recallCircleMemories,
  restoreCircleMemoriesFromWalrus,
} from '../server/walrus-memory.mjs'

loadDotEnvIfPresent()

const { serviceConfig } = requireIntegrationConfig('memwal')

const CIRCLE_ID = 'lagos-techies-seed-circle'

const CIRCLE_ROSTER = {
  circleId: CIRCLE_ID,
  circleName: 'Lagos Techies Seed Circle',
  poolAddress: '0x679d547b18cf9f2e77f1d33f932cbf4de5c63dda6a5c5d0e44caf7ae4334cd1b',
  contributionPerMember: 500,
  tokenType: '0x2::sui::SUI',
  cycleLength: 'Monthly',
  currentCycle: 5,
  organizerAddress: '0x679d547b18cf9f2e77f1d33f932cbf4de5c63dda6a5c5d0e44caf7ae4334cd1b',
  members: [
    {
      id: 'm1',
      name: 'Amina Bello',
      address: '0x679d547b18cf9f2e77f1d33f932cbf4de5c63dda6a5c5d0e44caf7ae4334cd1b',
    },
    {
      id: 'm2',
      name: 'Tunde Ojo',
      address: '0xa391d6f24d870aecd74a9c18b0381c946df345c9e2f9724a9b52abce94be1022',
    },
    {
      id: 'm3',
      name: 'Chidi Okonkwo',
      address: '0xf6b75c6fd44e685829e0baa04077c42c09bed658819e921126dc11ce8c3175d4',
    },
    {
      id: 'm4',
      name: 'Zainab Musa',
      address: '0x1111111111111111111111111111111111111111111111111111111111111104',
    },
    {
      id: 'm5',
      name: 'Emeka Nwosu',
      address: '0x1111111111111111111111111111111111111111111111111111111111111105',
    },
    {
      id: 'm6',
      name: 'Folake Adeyemi',
      address: '0x1111111111111111111111111111111111111111111111111111111111111106',
    },
  ],
}

const TEN_MEMORIES_TO_PROPOSE = [
  {
    category: 'Agreements',
    memoryType: 'agreement',
    title: 'Tunde 72-Hour Contractor Grace Window',
    quote: 'Tunde may submit his monthly contribution within 72 hours of cycle open due to contractor payroll clearing dates.',
    suggestedAction: 'Keep chain fact as Late when paid after 24h deadline, but mark policy status as Accepted under recorded grace agreement if within 72h.',
    memberId: 'm2',
    cycle: 4,
  },
  {
    category: 'Member patterns',
    memoryType: 'member_pattern',
    title: 'Emeka Two-Tranche Split Contribution Pattern',
    quote: 'Emeka splits his contribution into two equal installments within 48 hours of cycle open.',
    suggestedAction: 'Aggregate two partial payments from Emeka within the 48-hour partial payment window into one contribution.',
    memberId: 'm5',
    cycle: 2,
  },
  {
    category: 'Member patterns',
    memoryType: 'member_pattern',
    title: 'Chidi Early Cycle Liquidity Anchor',
    quote: 'Chidi consistently transfers his contribution within the first two hours of each cycle opening.',
    suggestedAction: 'Recognize Chidi as a zero-risk early contributor.',
    memberId: 'm3',
    cycle: 1,
  },
  {
    category: 'Reminder preferences',
    memoryType: 'reminder_preference',
    title: 'Folake Direct Notification Preference',
    quote: 'Folake requested direct wallet or private message reminders rather than public group chat tags.',
    suggestedAction: 'Use direct private reminder workflow instead of public channel mentions when Folake is pending.',
    memberId: 'm6',
    cycle: 3,
  },
  {
    category: 'Agreements',
    memoryType: 'agreement',
    title: 'Emergency Medical Rotation Swap Rule',
    quote: 'Members facing verified medical or family emergencies may request a one-cycle payout rotation swap with a consenting member.',
    suggestedAction: 'Allow payout turn swaps when both members confirm the swap in circle memory.',
    cycle: 1,
  },
  {
    category: 'Agreements',
    memoryType: 'agreement',
    title: 'Cycle 6 Turn Swap Between Zainab and Chidi',
    quote: 'Zainab requested to swap her Cycle 6 payout turn with Chidi to cover studio equipment delivery.',
    suggestedAction: 'Record approved rotation swap between Zainab Musa (m4) and Chidi Okonkwo (m3).',
    memberId: 'm4',
    cycle: 5,
  },
  {
    category: 'Reminder preferences',
    memoryType: 'reminder_preference',
    title: 'Tunde Pre-Invoice Reminder Timing',
    quote: 'Tunde prefers a single reminder 24 hours after cycle open once his contractor invoice clears.',
    suggestedAction: 'Hold reminders for Tunde until 24 hours after cycle start.',
    memberId: 'm2',
    cycle: 4,
  },
  {
    category: 'Member patterns',
    memoryType: 'member_pattern',
    title: 'Amina Organizer Day-1 Verification Pattern',
    quote: 'Amina submits her contribution on Day 1 and triggers the initial Sui digest verification check for the circle.',
    suggestedAction: 'Use Amina Day-1 deposit as cycle opening benchmark.',
    memberId: 'm1',
    cycle: 1,
  },
  {
    category: 'Agreements',
    memoryType: 'agreement',
    title: 'Strict Token Type Verification Policy',
    quote: 'Only transfers matching the circle configured Sui coin type to the designated pool address count toward cycle obligations.',
    suggestedAction: 'Classify transfers of any other coin type as WrongToken and exclude from pot total.',
    cycle: 1,
  },
  {
    category: 'Reminder preferences',
    memoryType: 'reminder_preference',
    title: 'Zainab Evening UTC Reminder Window',
    quote: 'Zainab prefers payment status updates between 18:00 and 20:00 UTC after her workday.',
    suggestedAction: 'Schedule Zainab status notifications for 18:00-20:00 UTC.',
    memberId: 'm4',
    cycle: 2,
  },
]

async function main() {
  console.log('1. Checking Walrus Memory Mainnet relayer health...')
  const health = await checkWalrusMemoryHealth()
  console.log('Health:', JSON.stringify(health, null, 2))
  if (!health.connected) {
    throw new Error(`Walrus Memory relayer is not connected: ${health.error || JSON.stringify(health.issues)}`)
  }

  console.log('\n2. Registering circle roster on server...')
  const circle = upsertCircleRoster(CIRCLE_ROSTER)
  console.log(`Registered circle "${circle.circleName}" (${circle.circleId}) with ${circle.members.length} members.`)

  // Generate an Ed25519 keypair to test cryptographic challenge signing on the first 5 writes,
  // and organizer-entered confirmation on the next 5 writes.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' })
  const publicKeyHex = spkiDer.subarray(spkiDer.length - 32).toString('hex')

  const completedWrites = []

  console.log(`\n3. Executing ${TEN_MEMORIES_TO_PROPOSE.length} real propose -> confirm -> rememberAndWait writes to Walrus Mainnet...`)
  for (let i = 0; i < TEN_MEMORIES_TO_PROPOSE.length; i++) {
    const item = TEN_MEMORIES_TO_PROPOSE[i]
    const proposal = proposeCircleMemory({
      circleId: CIRCLE_ID,
      ...item,
    })

    let confirmPayload = {
      circleId: CIRCLE_ID,
      proposalId: proposal.id,
      memberId: 'm1',
    }

    if (i < 5) {
      const challenge = issueConfirmationChallenge({
        circleId: CIRCLE_ID,
        proposalId: proposal.id,
        memberId: 'm1',
      })
      const sig = crypto.sign(null, Buffer.from(challenge.message, 'utf8'), privateKey).toString('hex')
      confirmPayload = {
        ...confirmPayload,
        challengeNonce: challenge.nonce,
        signature: sig,
        publicKeyHex,
      }
    }

    const startedAt = Date.now()
    const saved = await confirmAndWriteMemory(confirmPayload)
    const elapsedMs = Date.now() - startedAt

    console.log(
      `  [${i + 1}/${TEN_MEMORIES_TO_PROPOSE.length}] Saved on Walrus Mainnet (${elapsedMs}ms): blob_id=${saved.walrusBlobId} job_id=${saved.jobId} title="${saved.title}"`
    )
    completedWrites.push({
      index: i + 1,
      id: saved.id,
      jobId: saved.jobId,
      walrusBlobId: saved.walrusBlobId,
      namespace: saved.namespace,
      owner: saved.owner,
      category: saved.category,
      memoryType: saved.memoryType,
      title: saved.title,
      cycle: saved.cycle,
      memberId: saved.memberId,
      confirmationType: saved.confirmationType,
      confirmedBy: saved.confirmedBy,
      elapsedMs,
      createdAt: saved.createdAt,
    })
  }

  console.log('\n4. Testing real semantic recall from Walrus Mainnet...')
  const tundeRecall = await recallCircleMemories(CIRCLE_ID, 'Can Tunde pay late this month grace period?', {
    limit: 5,
  })
  console.log(
    `Recalled ${tundeRecall.records.length} memories for Tunde query. Top match: "${tundeRecall.records[0]?.title}" (blob=${tundeRecall.records[0]?.walrusBlobId}, distance=${tundeRecall.records[0]?.distance})`
  )

  console.log('\n5. Testing restoreCircleMemoriesFromWalrus...')
  const restoreOutcome = await restoreCircleMemoriesFromWalrus(CIRCLE_ID, 15)
  console.log('Restore result:', JSON.stringify(restoreOutcome.restoreResult, null, 2))

  const evidencePath = path.resolve(process.cwd(), 'docs', 'walrus-mainnet-writes.json')
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
  const evidenceDoc = {
    verifiedAt: new Date().toISOString(),
    relayerUrl: serviceConfig.MEMWAL_SERVER_URL,
    accountId: serviceConfig.MEMWAL_ACCOUNT_ID,
    circleId: CIRCLE_ID,
    namespace: completedWrites[0]?.namespace,
    totalCompletedMainnetWrites: completedWrites.length,
    writes: completedWrites,
    sampleRecallVerification: {
      query: tundeRecall.query,
      returnedCount: tundeRecall.records.length,
      topHits: tundeRecall.records.slice(0, 3).map((r) => ({
        title: r.title,
        walrusBlobId: r.walrusBlobId,
        distance: r.distance,
        category: r.category,
      })),
    },
    restoreVerification: restoreOutcome.restoreResult,
  }
  fs.writeFileSync(evidencePath, JSON.stringify(evidenceDoc, null, 2) + '\n', 'utf8')
  console.log(`\nSaved verifiable Mainnet write evidence to ${evidencePath}`)
}

main().catch((err) => {
  console.error('Walrus Mainnet verification failed:', err)
  process.exit(1)
})
