// Schedule, Cadence, and IANA Time Zone Utilities for Ajo Savings Circle
// Daylight-saving-aware date calculations and wall-clock preservation across cycles.

export const SUPPORTED_CYCLE_LENGTHS = [
  'Daily',
  'Weekly',
  'Bi-Weekly',
  'Monthly',
  'Yearly',
  '5 Minutes (Demo)',
] as const

export type CycleLength = (typeof SUPPORTED_CYCLE_LENGTHS)[number]

/**
 * Common region-based IANA time zones covering global financial and diaspora hubs,
 * with priority given to Africa, Americas, Europe, Asia, and Pacific.
 */
export const POPULAR_TIME_ZONES = [
  { value: 'Africa/Lagos', label: 'Africa/Lagos (West Africa Time, WAT)' },
  { value: 'Africa/Accra', label: 'Africa/Accra (GMT)' },
  { value: 'Africa/Nairobi', label: 'Africa/Nairobi (East Africa Time, EAT)' },
  { value: 'Africa/Johannesburg', label: 'Africa/Johannesburg (SAST)' },
  { value: 'Africa/Cairo', label: 'Africa/Cairo (EET)' },
  { value: 'Europe/London', label: 'Europe/London (GMT / BST)' },
  { value: 'Europe/Paris', label: 'Europe/Paris (CET / CEST)' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin (CET / CEST)' },
  { value: 'America/New_York', label: 'America/New_York (Eastern Time, EST / EDT)' },
  { value: 'America/Chicago', label: 'America/Chicago (Central Time, CST / CDT)' },
  { value: 'America/Denver', label: 'America/Denver (Mountain Time, MST / MDT)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (Pacific Time, PST / PDT)' },
  { value: 'America/Toronto', label: 'America/Toronto (Eastern Time)' },
  { value: 'America/Sao_Paulo', label: 'America/Sao_Paulo (BRT)' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (Gulf Standard Time, GST)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (Indian Standard Time, IST)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (SGT)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (Japan Standard Time, JST)' },
  { value: 'Asia/Hong_Kong', label: 'Asia/Hong_Kong (HKT)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney (AEST / AEDT)' },
  { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
]

/**
 * Safely detects the user's local system time zone via standard Intl API.
 */
export function detectUserTimeZone(): string {
  try {
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz && typeof tz === 'string' && tz.trim().length > 0) {
        return tz.trim()
      }
    }
  } catch {
    // Fall back to UTC
  }
  return 'UTC'
}

/**
 * Returns a complete, deduplicated list of region-based IANA time zones
 * combining popular hubs and platform-supported zones.
 */
export function getAllSupportedTimeZones(): Array<{ value: string; label: string }> {
  const map = new Map<string, string>()

  // Popular first
  for (const item of POPULAR_TIME_ZONES) {
    map.set(item.value, item.label)
  }

  // System detected
  const detected = detectUserTimeZone()
  if (!map.has(detected)) {
    map.set(detected, `${detected} (Detected System Time Zone)`)
  }

  // Complete IANA list from Intl if available
  try {
    if (typeof (Intl as any).supportedValuesOf === 'function') {
      const allZones: string[] = (Intl as any).supportedValuesOf('timeZone')
      for (const z of allZones) {
        if (!map.has(z)) {
          map.set(z, z)
        }
      }
    }
  } catch {
    // Keep popular + detected
  }

  return Array.from(map.entries()).map(([value, label]) => ({ value, label }))
}

/**
 * Helper to get the number of days in a specific calendar month.
 */
export function getDaysInMonth(year: number, month1Indexed: number): number {
  return new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate()
}

/**
 * Converts a UTC Date or ISO string into local wall-clock components in a target IANA time zone.
 */
export function utcToLocalParts(
  utcInput: Date | string | number,
  timeZone: string
): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  isoDate: string
  isoTime: string
  isoDateTime: string
} {
  const dateObj = typeof utcInput === 'object' ? utcInput : new Date(utcInput)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const parts = dtf.formatToParts(dateObj)
  const map: Record<string, string> = {}
  for (const p of parts) {
    map[p.type] = p.value
  }

  const year = parseInt(map.year, 10)
  const month = parseInt(map.month, 10)
  const day = parseInt(map.day, 10)
  const hour = parseInt(map.hour === '24' ? '0' : map.hour, 10)
  const minute = parseInt(map.minute, 10)
  const second = parseInt(map.second, 10)

  const pad = (n: number) => String(n).padStart(2, '0')
  const isoDate = `${year}-${pad(month)}-${pad(day)}`
  const isoTime = `${pad(hour)}:${pad(minute)}`
  const isoDateTime = `${isoDate}T${isoTime}`

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    isoDate,
    isoTime,
    isoDateTime,
  }
}

/**
 * Converts local wall-clock calendar parts in a specific IANA time zone into
 * an unambiguous UTC ISO timestamp, accurately converging across daylight saving transitions.
 */
export function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const targetTz = timeZone || 'UTC'
  let utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: targetTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const getParts = (d: Date) => {
    const parts = dtf.formatToParts(d)
    const obj: Record<string, string> = {}
    for (const p of parts) obj[p.type] = p.value
    return {
      year: parseInt(obj.year, 10),
      month: parseInt(obj.month, 10),
      day: parseInt(obj.day, 10),
      hour: parseInt(obj.hour === '24' ? '0' : obj.hour, 10),
      minute: parseInt(obj.minute, 10),
      second: parseInt(obj.second, 10),
    }
  }

  // Iterate to converge on exact UTC timestamp (handles DST offsets cleanly)
  for (let i = 0; i < 4; i++) {
    const p = getParts(utcDate)
    const asLocal = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0)
    const diff = desired - asLocal
    if (diff === 0) break
    utcDate = new Date(utcDate.getTime() + diff)
  }

  return utcDate
}

/**
 * Converts a local datetime-local string (YYYY-MM-DDTHH:mm) in a target timeZone
 * to an unambiguous UTC ISO string.
 */
export function localDateTimeStringToUtc(dateTimeLocalStr: string, timeZone: string): string {
  const clean = dateTimeLocalStr.trim()
  const match = clean.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) {
    throw new Error(`Invalid local datetime string: "${dateTimeLocalStr}". Expected YYYY-MM-DDTHH:mm.`)
  }

  const year = parseInt(match[1], 10)
  const month = parseInt(match[2], 10)
  const day = parseInt(match[3], 10)
  const hour = parseInt(match[4], 10)
  const minute = parseInt(match[5], 10)

  const utc = localToUtc(year, month, day, hour, minute, timeZone)
  return utc.toISOString()
}

/**
 * Daylight-Saving-Aware cycle deadline calculation.
 * Preserves the intended local wall-clock time (e.g. 10:00 AM) across daylight-saving changes
 * instead of naively adding a fixed number of milliseconds.
 */
export function calculateDaylightSavingAwareCycleEnd(
  startIsoUtc: string,
  cycleLength: string,
  timeZone: string
): string {
  const startDate = new Date(startIsoUtc)
  if (isNaN(startDate.getTime())) {
    throw new Error(`Invalid start timestamp: "${startIsoUtc}"`)
  }

  const local = utcToLocalParts(startDate, timeZone)
  let y = local.year
  let m = local.month
  let d = local.day
  const h = local.hour
  const min = local.minute

  switch (cycleLength) {
    case '5 Minutes (Demo)':
    case '5 Minutes':
    case '5 mins':
    case '5 min': {
      const end = new Date(startDate.getTime() + 5 * 60 * 1000)
      return end.toISOString()
    }
    case 'Daily': {
      const tempDate = new Date(Date.UTC(y, m - 1, d + 1))
      y = tempDate.getUTCFullYear()
      m = tempDate.getUTCMonth() + 1
      d = tempDate.getUTCDate()
      break
    }
    case 'Weekly': {
      const tempDate = new Date(Date.UTC(y, m - 1, d + 7))
      y = tempDate.getUTCFullYear()
      m = tempDate.getUTCMonth() + 1
      d = tempDate.getUTCDate()
      break
    }
    case 'Bi-Weekly': {
      const tempDate = new Date(Date.UTC(y, m - 1, d + 14))
      y = tempDate.getUTCFullYear()
      m = tempDate.getUTCMonth() + 1
      d = tempDate.getUTCDate()
      break
    }
    case 'Monthly': {
      m += 1
      if (m > 12) {
        y += 1
        m = 1
      }
      const maxDays = getDaysInMonth(y, m)
      if (d > maxDays) d = maxDays
      break
    }
    case 'Yearly': {
      y += 1
      const maxDays = getDaysInMonth(y, m)
      if (d > maxDays) d = maxDays
      break
    }
    default: {
      // Default to Monthly behavior if unknown
      m += 1
      if (m > 12) {
        y += 1
        m = 1
      }
      const maxDays = getDaysInMonth(y, m)
      if (d > maxDays) d = maxDays
      break
    }
  }

  const endUtc = localToUtc(y, m, d, h, min, timeZone)
  return endUtc.toISOString()
}

/**
 * Formats a UTC ISO timestamp as a rich local date and time string with the time zone.
 */
export function formatLocalDateTimeWithZone(
  utcInput: Date | string | number,
  timeZone: string,
  style: 'full' | 'short' | 'dateOnly' = 'full'
): string {
  try {
    const d = typeof utcInput === 'object' ? utcInput : new Date(utcInput)
    if (isNaN(d.getTime())) return 'Invalid date'

    const targetTz = timeZone || 'UTC'

    if (style === 'dateOnly') {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: targetTz,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(d)
    }

    if (style === 'short') {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: targetTz,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(d)
    }

    return new Intl.DateTimeFormat('en-US', {
      timeZone: targetTz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(d)
  } catch {
    return String(utcInput)
  }
}

/**
 * Returns human-readable rotation duration for any cycle length and member count.
 * Handles Daily ("5 days"), Weekly ("5 weeks"), Bi-Weekly ("10 weeks (5 bi-weekly cycles)"),
 * Monthly ("5 months"), and Yearly ("5 years").
 */
export function formatRotationDuration(cycleLength: string, memberCount: number): string {
  const count = Math.max(0, memberCount)
  const norm = (cycleLength || 'Monthly').trim()

  switch (norm) {
    case '5 Minutes (Demo)':
    case '5 Minutes':
    case '5 mins':
    case '5 min':
      return `${count * 5} minute${count * 5 === 1 ? '' : 's'} (${count} 5-minute cycle${count === 1 ? '' : 's'})`
    case 'Daily':
      return `${count} day${count === 1 ? '' : 's'}`
    case 'Weekly':
      return `${count} week${count === 1 ? '' : 's'}`
    case 'Bi-Weekly':
      return `${count * 2} weeks (${count} bi-weekly rotation${count === 1 ? '' : 's'})`
    case 'Monthly':
      return `${count} month${count === 1 ? '' : 's'}`
    case 'Yearly':
      return `${count} year${count === 1 ? '' : 's'}`
    default:
      return `${count} cycles`
  }
}

/**
 * Validates that start and end timestamps form a valid, non-negative cycle schedule
 * for the given cycle length and time zone.
 */
export function validateSchedule(
  startIsoUtc: string,
  endIsoUtc: string,
  cycleLength: string,
  timeZone: string
): { valid: boolean; error?: string; durationMs?: number } {
  const startMs = Date.parse(startIsoUtc)
  const endMs = Date.parse(endIsoUtc)

  if (!Number.isFinite(startMs)) {
    return { valid: false, error: 'Cycle window start must be a valid timestamp.' }
  }
  if (!Number.isFinite(endMs)) {
    return { valid: false, error: 'Cycle deadline / window end must be a valid timestamp.' }
  }
  if (endMs <= startMs) {
    return {
      valid: false,
      error: 'Cycle deadline must be strictly after cycle window start time.',
    }
  }

  const durationMs = endMs - startMs
  const isDemo =
    cycleLength.toLowerCase().includes('5 min') || cycleLength.toLowerCase().includes('demo')
  const minRequiredMs = isDemo ? 60 * 1000 : 15 * 60 * 1000 // 1 minute for demo, 15 minutes for standard
  if (durationMs < minRequiredMs) {
    return {
      valid: false,
      error: isDemo
        ? 'Cycle window duration is too short (minimum 1 minute required for demo).'
        : 'Cycle window duration is too short (minimum 15 minutes required).',
      durationMs,
    }
  }

  return { valid: true, durationMs }
}
