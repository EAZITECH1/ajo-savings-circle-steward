// Schedule, Cadence, and IANA Time Zone Utilities for Server / Backend
// Daylight-saving-aware date calculations and wall-clock preservation across cycles.

export const SUPPORTED_CYCLE_LENGTHS = [
  'Daily',
  'Weekly',
  'Bi-Weekly',
  'Monthly',
  'Yearly',
  '5 Minutes (Demo)',
]

export function detectSystemTimeZone() {
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

export function getDaysInMonth(year, month1Indexed) {
  return new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate()
}

export function utcToLocalParts(utcInput, timeZone) {
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
  const map = {}
  for (const p of parts) {
    map[p.type] = p.value
  }

  const year = parseInt(map.year, 10)
  const month = parseInt(map.month, 10)
  const day = parseInt(map.day, 10)
  const hour = parseInt(map.hour === '24' ? '0' : map.hour, 10)
  const minute = parseInt(map.minute, 10)
  const second = parseInt(map.second, 10)

  const pad = (n) => String(n).padStart(2, '0')
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

export function localToUtc(year, month, day, hour, minute, timeZone) {
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

  const getParts = (d) => {
    const parts = dtf.formatToParts(d)
    const obj = {}
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

export function calculateDaylightSavingAwareCycleEnd(startIsoUtc, cycleLength, timeZone) {
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

export function formatRotationDuration(cycleLength, memberCount) {
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
