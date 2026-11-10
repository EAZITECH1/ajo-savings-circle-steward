// Stage 9: Schedule, Cadence, and IANA Time Zone Verification
// Tests Daily and Yearly cadence, daylight-saving-aware date calculations,
// wall-clock hour preservation across DST, IANA time zones, and Walrus config persistence.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPPORTED_CYCLE_LENGTHS,
  detectSystemTimeZone,
  localToUtc,
  utcToLocalParts,
  calculateDaylightSavingAwareCycleEnd,
  formatRotationDuration,
} from '../server/schedule.mjs'
import {
  computeCircleConfigHash,
  serializeCircleConfigForWalrus,
  validateWalrusRecordForRestore,
  upsertCircleRoster,
  clearCircleRuntimeState,
} from '../server/walrus-memory.mjs'

test('Schedule: supports all required cycle lengths including Daily and Yearly', () => {
  assert.deepEqual(SUPPORTED_CYCLE_LENGTHS, [
    'Daily',
    'Weekly',
    'Bi-Weekly',
    'Monthly',
    'Yearly',
    '5 Minutes (Demo)',
  ])
})

test('Schedule: rotation duration formatting produces correct pluralized units', () => {
  assert.equal(formatRotationDuration('Daily', 1), '1 day')
  assert.equal(formatRotationDuration('Daily', 5), '5 days')
  assert.equal(formatRotationDuration('Weekly', 1), '1 week')
  assert.equal(formatRotationDuration('Weekly', 4), '4 weeks')
  assert.equal(formatRotationDuration('Bi-Weekly', 3), '6 weeks (3 bi-weekly rotations)')
  assert.equal(formatRotationDuration('Monthly', 1), '1 month')
  assert.equal(formatRotationDuration('Monthly', 12), '12 months')
  assert.equal(formatRotationDuration('Yearly', 1), '1 year')
  assert.equal(formatRotationDuration('Yearly', 3), '3 years')
  assert.equal(formatRotationDuration('5 Minutes (Demo)', 2), '10 minutes (2 5-minute cycles)')
})

test('Schedule: detects valid system IANA time zone or defaults to UTC', () => {
  const tz = detectSystemTimeZone()
  assert.ok(typeof tz === 'string' && tz.length > 0)
  // Verify it works in Intl
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz })
  assert.ok(dtf)
})

test('Schedule: daylight-saving-aware Monthly calculation preserves local wall-clock hour across US DST transition', () => {
  // US DST begins on the 2nd Sunday in March (March 8, 2026).
  // March 1, 2026 at 10:00 AM NY is EST (UTC-5) -> 15:00 UTC.
  // April 1, 2026 at 10:00 AM NY is EDT (UTC-4) -> 14:00 UTC.
  const tz = 'America/New_York'
  const startUtc = localToUtc(2026, 3, 1, 10, 0, tz).toISOString()
  assert.equal(startUtc, '2026-03-01T15:00:00.000Z')

  const deadlineUtc = calculateDaylightSavingAwareCycleEnd(startUtc, 'Monthly', tz)
  assert.equal(deadlineUtc, '2026-04-01T14:00:00.000Z')

  // The local wall clock must strictly retain 10:00 AM!
  const localDeadline = utcToLocalParts(deadlineUtc, tz)
  assert.equal(localDeadline.year, 2026)
  assert.equal(localDeadline.month, 4)
  assert.equal(localDeadline.day, 1)
  assert.equal(localDeadline.hour, 10)
  assert.equal(localDeadline.minute, 0)
  assert.equal(localDeadline.isoTime, '10:00')
})

test('Schedule: daylight-saving-aware Daily calculation preserves local wall-clock hour', () => {
  const tz = 'Europe/London'
  const startUtc = localToUtc(2026, 6, 15, 9, 30, tz).toISOString()
  const deadlineUtc = calculateDaylightSavingAwareCycleEnd(startUtc, 'Daily', tz)

  const localDeadline = utcToLocalParts(deadlineUtc, tz)
  assert.equal(localDeadline.year, 2026)
  assert.equal(localDeadline.month, 6)
  assert.equal(localDeadline.day, 16)
  assert.equal(localDeadline.hour, 9)
  assert.equal(localDeadline.minute, 30)
})

test('Schedule: daylight-saving-aware Yearly calculation preserves wall-clock hour and handles leap years', () => {
  const tz = 'Africa/Lagos'
  // Start on 2026-11-01 at 09:00 AM Lagos time
  const startUtc = localToUtc(2026, 11, 1, 9, 0, tz).toISOString()
  const deadlineUtc = calculateDaylightSavingAwareCycleEnd(startUtc, 'Yearly', tz)

  const localDeadline = utcToLocalParts(deadlineUtc, tz)
  assert.equal(localDeadline.year, 2027)
  assert.equal(localDeadline.month, 11)
  assert.equal(localDeadline.day, 1)
  assert.equal(localDeadline.hour, 9)
  assert.equal(localDeadline.minute, 0)

  // Leap year leap day test: 2028 is a leap year (Feb 29 exists); 2029 is not (clips to Feb 28).
  const leapStart = localToUtc(2028, 2, 29, 14, 0, 'Europe/London').toISOString()
  const leapEnd = calculateDaylightSavingAwareCycleEnd(leapStart, 'Yearly', 'Europe/London')
  const localLeapEnd = utcToLocalParts(leapEnd, 'Europe/London')
  assert.equal(localLeapEnd.year, 2029)
  assert.equal(localLeapEnd.month, 2)
  assert.equal(localLeapEnd.day, 28)
  assert.equal(localLeapEnd.hour, 14)
})

test('Schedule: 5 Minutes (Demo) calculation sets deadline exactly 5 minutes ahead', () => {
  const start = '2026-11-08T10:00:00.000Z'
  const deadline = calculateDaylightSavingAwareCycleEnd(start, '5 Minutes (Demo)', 'Africa/Lagos')
  assert.equal(deadline, '2026-11-08T10:05:00.000Z')
})

test('Schedule: circle_config with timeZone, windowStart, and windowEnd serializes, hashes, and restores idempotently', () => {
  const circleId = 'lagos-cadence-circle-2026'
  clearCircleRuntimeState(circleId)

  const circleData = {
    circleId,
    circleName: 'Lagos Daily Cadence Savings',
    poolAddress: '0x00000000000000000000000000000000000000000000000000000000000000aa',
    contributionPerMember: 50,
    tokenType: '0x2::sui::SUI',
    cycleLength: 'Daily',
    currentCycle: 1,
    timeZone: 'Africa/Lagos',
    windowStart: '2026-11-01T08:00:00.000Z',
    windowEnd: '2026-11-02T08:00:00.000Z',
    organizerAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
    members: [
      {
        id: 'm1',
        name: 'Amina',
        address: '0x0000000000000000000000000000000000000000000000000000000000000001',
      },
      {
        id: 'm2',
        name: 'Chidi',
        address: '0x0000000000000000000000000000000000000000000000000000000000000002',
      },
    ],
  }

  // 1. In-memory upsert retains timeZone and schedule
  const registered = upsertCircleRoster(circleData)
  assert.equal(registered.cycleLength, 'Daily')
  assert.equal(registered.timeZone, 'Africa/Lagos')
  assert.equal(registered.windowStart, '2026-11-01T08:00:00.000Z')
  assert.equal(registered.windowEnd, '2026-11-02T08:00:00.000Z')

  // 2. Hash computation is deterministic
  const hash1 = computeCircleConfigHash(registered)
  const hash2 = computeCircleConfigHash(circleData)
  assert.equal(hash1, hash2)

  // 3. Walrus serialization includes timeZone and window fields
  const serialized = serializeCircleConfigForWalrus(registered)
  assert.ok(serialized.includes('"timeZone":"Africa/Lagos"'))
  assert.ok(serialized.includes('"cycleLength":"Daily"'))

  // 4. Recover from serialized Walrus memory record
  const recovered = validateWalrusRecordForRestore(
    { blob_id: 'mock-blob-cadence', text: serialized },
    circleId
  )
  assert.equal(recovered.valid, true)
  assert.equal(recovered.circleConfig.cycleLength, 'Daily')
  assert.equal(recovered.circleConfig.timeZone, 'Africa/Lagos')
  assert.equal(recovered.circleConfig.windowStart, '2026-11-01T08:00:00.000Z')
  assert.equal(recovered.circleConfig.windowEnd, '2026-11-02T08:00:00.000Z')
  assert.equal(recovered.configHash, hash1)
})

test('Schedule: backward compatibility preserves older circle records without timeZone', () => {
  const legacyCircle = {
    circleId: 'legacy-monthly-circle',
    circleName: 'Legacy Monthly Savings',
    poolAddress: '0x00000000000000000000000000000000000000000000000000000000000000bb',
    contributionPerMember: 100,
    tokenType: '0x2::sui::SUI',
    cycleLength: 'Monthly',
    currentCycle: 1,
    organizerAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
    members: [
      {
        id: 'm1',
        name: 'Legacy Alice',
        address: '0x0000000000000000000000000000000000000000000000000000000000000001',
      },
    ],
  }

  const serialized = serializeCircleConfigForWalrus(legacyCircle)
  const recovered = validateWalrusRecordForRestore(
    { blob_id: 'mock-legacy-blob', text: serialized },
    'legacy-monthly-circle'
  )

  assert.equal(recovered.valid, true)
  assert.equal(recovered.circleConfig.cycleLength, 'Monthly')
  assert.equal(recovered.circleConfig.timeZone, undefined)
})
