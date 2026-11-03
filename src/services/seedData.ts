import { MemoryRecord } from './types'

export const SEED_MEMORIES: MemoryRecord[] = [
  {
    id: 'mem-1',
    category: 'Agreements',
    title: 'Tunde 3-Day Grace Period',
    quote: 'Group approved 3-day grace for Tunde due to monthly contractor payroll dates (5 of 6 agreed, cycle 4).',
    date: 'Aug 14, 2026',
    cycle: 4,
    confirmedBy: 'Circle Consensus (5/6 votes)',
    walrusBlobId: 'walrus_blob_9x8f02a99e71b2k37q',
    context: 'Prevents Tunde from being flagged as delinquent as long as payment occurs within 72h of cycle open.',
    memberId: 'm2'
  },
  {
    id: 'mem-2',
    category: 'Member patterns',
    title: 'Emeka Split Payment Habit',
    quote: 'Emeka splits every contribution into two equal tranches of 250 USDC within 48 hours without fail.',
    date: 'Jun 02, 2026',
    cycle: 2,
    confirmedBy: 'Steward Observed & Verified',
    walrusBlobId: 'walrus_blob_4m19a820c741p902',
    context: 'Do not trigger urgent overdue alerts for Emeka until 48 hours post initial tranche.',
    memberId: 'm5'
  },
  {
    id: 'mem-3',
    category: 'Member patterns',
    title: 'Chidi Day-1 Early Bird',
    quote: 'Chidi always pays in the first 2 hours of cycle opening. Reliable liquidity source.',
    date: 'May 01, 2026',
    cycle: 1,
    confirmedBy: 'Steward Observed',
    walrusBlobId: 'walrus_blob_88x2c199bb601bc',
    context: 'Can be relied upon for early balance confirmation.',
    memberId: 'm3'
  },
  {
    id: 'mem-4',
    category: 'Reminder preferences',
    title: 'Folake Silent Channel Rule',
    quote: 'Folake ignores Discord / group ping reminders; prefers onchain notification or quiet email.',
    date: 'Jul 10, 2026',
    cycle: 3,
    confirmedBy: 'Folake Adeyemi (Self-declared)',
    walrusBlobId: 'walrus_blob_33v71a44cc2199xa',
    context: 'Suppress group chat tags for Folake to avoid reminder fatigue.',
    memberId: 'm6'
  },
  {
    id: 'mem-5',
    category: 'Agreements',
    title: 'Emergency Medical Payout Priority',
    quote: 'Circle agreed that medical or bereavement needs can swap recipient turn if backed by 4 member votes.',
    date: 'May 12, 2026',
    cycle: 1,
    confirmedBy: 'Circle Consensus (6/6 votes)',
    walrusBlobId: 'walrus_blob_66z44p12089188tt',
    context: 'Governance rule preserved for emergency payout re-ordering.',
  }
]
