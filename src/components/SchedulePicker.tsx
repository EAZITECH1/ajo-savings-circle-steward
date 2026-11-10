import React, { useState, useEffect, useMemo } from 'react'
import { Calendar, Clock, Globe, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react'
import {
  SUPPORTED_CYCLE_LENGTHS,
  getAllSupportedTimeZones,
  detectUserTimeZone,
  utcToLocalParts,
  localDateTimeStringToUtc,
  calculateDaylightSavingAwareCycleEnd,
  formatLocalDateTimeWithZone,
  validateSchedule,
  formatRotationDuration,
} from '../services/schedule'

export interface SchedulePickerProps {
  cycleLength: string
  onCycleLengthChange: (length: string) => void
  windowStart: string // ISO UTC string
  onWindowStartChange: (isoUtc: string) => void
  windowEnd: string // ISO UTC string
  onWindowEndChange: (isoUtc: string) => void
  timeZone: string
  onTimeZoneChange: (tz: string) => void
  memberCount?: number
  className?: string
}

export const SchedulePicker: React.FC<SchedulePickerProps> = ({
  cycleLength,
  onCycleLengthChange,
  windowStart,
  onWindowStartChange,
  windowEnd,
  onWindowEndChange,
  timeZone,
  onTimeZoneChange,
  memberCount = 1,
  className = '',
}) => {
  const allTimeZones = useMemo(() => getAllSupportedTimeZones(), [])
  const activeTz = timeZone || detectUserTimeZone()

  // Local datetime-local strings (YYYY-MM-DDTHH:mm) derived from UTC props
  const localStartStr = useMemo(() => {
    try {
      return utcToLocalParts(windowStart, activeTz).isoDateTime
    } catch {
      return ''
    }
  }, [windowStart, activeTz])

  const localEndStr = useMemo(() => {
    try {
      return utcToLocalParts(windowEnd, activeTz).isoDateTime
    } catch {
      return ''
    }
  }, [windowEnd, activeTz])

  // Validation
  const validation = useMemo(() => {
    return validateSchedule(windowStart, windowEnd, cycleLength, activeTz)
  }, [windowStart, windowEnd, cycleLength, activeTz])

  // Handle local start change
  const handleLocalStartChange = (newLocalStr: string) => {
    if (!newLocalStr) return
    try {
      const newUtcStart = localDateTimeStringToUtc(newLocalStr, activeTz)
      onWindowStartChange(newUtcStart)

      // Auto-recalculate end using daylight-saving-aware logic
      const calculatedEnd = calculateDaylightSavingAwareCycleEnd(newUtcStart, cycleLength, activeTz)
      onWindowEndChange(calculatedEnd)
    } catch (err) {
      console.error('Error updating window start:', err)
    }
  }

  // Handle local end change (manual edit)
  const handleLocalEndChange = (newLocalStr: string) => {
    if (!newLocalStr) return
    try {
      const newUtcEnd = localDateTimeStringToUtc(newLocalStr, activeTz)
      onWindowEndChange(newUtcEnd)
    } catch (err) {
      console.error('Error updating window end:', err)
    }
  }

  // Handle cycle length change
  const handleCycleLengthSelect = (newLength: string) => {
    onCycleLengthChange(newLength)
    try {
      let effectiveStart = windowStart
      if (newLength.toLowerCase().includes('5 min') && Date.parse(windowStart) < Date.now() - 60000) {
        effectiveStart = new Date().toISOString()
        onWindowStartChange(effectiveStart)
      }
      const calculatedEnd = calculateDaylightSavingAwareCycleEnd(effectiveStart, newLength, activeTz)
      onWindowEndChange(calculatedEnd)
    } catch (err) {
      console.error('Error recalculating end on cycle change:', err)
    }
  }

  // Handle time zone change
  const handleTimeZoneSelect = (newTz: string) => {
    onTimeZoneChange(newTz)
    try {
      // Re-calculate the deadline in the new timezone so wall-clock alignment is preserved
      const calculatedEnd = calculateDaylightSavingAwareCycleEnd(windowStart, cycleLength, newTz)
      onWindowEndChange(calculatedEnd)
    } catch (err) {
      console.error('Error recalculating end on timezone change:', err)
    }
  }

  // Reset/sync end to calculated cycle length
  const handleAutoSyncDeadline = () => {
    try {
      const calculatedEnd = calculateDaylightSavingAwareCycleEnd(windowStart, cycleLength, activeTz)
      onWindowEndChange(calculatedEnd)
    } catch (err) {
      console.error('Error syncing deadline:', err)
    }
  }

  return (
    <div className={`space-y-lg ${className}`}>
      {/* Cycle Length Options */}
      <div className="flex flex-col gap-sm">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-secondary">
            Cycle Frequency / Cadence
          </label>
          <span className="text-xs text-tertiary">
            Rotation: <strong className="text-primary font-medium">{formatRotationDuration(cycleLength, memberCount)}</strong>
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-xs">
          {SUPPORTED_CYCLE_LENGTHS.map((opt) => {
            const isSelected = opt === cycleLength
            return (
              <button
                key={opt}
                type="button"
                onClick={() => handleCycleLengthSelect(opt)}
                className={`py-sm px-md rounded-lg border text-xs font-semibold transition-all ${
                  isSelected
                    ? 'border-brand-solid bg-utility-brand-50 text-utility-brand-700 shadow-2xs ring-1 ring-brand-solid'
                    : 'border-secondary bg-primary text-secondary hover:border-primary hover:bg-secondary/40'
                }`}
              >
                {opt}
              </button>
            )
          })}
        </div>
      </div>

      {/* Region-based IANA Time Zone Selector */}
      <div className="flex flex-col gap-sm">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-secondary flex items-center gap-xs">
            <Globe className="size-4 text-fg-brand-primary shrink-0" />
            <span>Circle Time Zone (Region-based IANA)</span>
          </label>
          <span className="text-[11px] font-mono text-tertiary">
            Selected: <strong className="text-primary font-medium">{activeTz}</strong>
          </span>
        </div>
        <select
          value={activeTz}
          onChange={(e) => handleTimeZoneSelect(e.target.value)}
          className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring cursor-pointer"
        >
          {allTimeZones.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-tertiary leading-tight">
          Wall-clock times across cycles (Daily, Weekly, Monthly, Yearly) will remain aligned to this time zone across daylight-saving transitions.
        </p>
      </div>

      {/* Cycle Window Start & Deadline (Date & Time Pickers) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
        {/* Cycle Window Start */}
        <div className="flex flex-col gap-xs p-md rounded-xl bg-secondary/40 border border-secondary">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-secondary flex items-center gap-xs">
              <Calendar className="size-3.5 text-fg-brand-primary shrink-0" />
              <span>Cycle Window Start</span>
            </label>
            <div className="flex items-center gap-xs">
              <button
                type="button"
                onClick={() => {
                  const nowIso = new Date().toISOString()
                  onWindowStartChange(nowIso)
                  const endIso = calculateDaylightSavingAwareCycleEnd(nowIso, cycleLength, activeTz)
                  onWindowEndChange(endIso)
                }}
                className="inline-flex items-center gap-xxs text-[10px] text-brand-primary hover:text-brand-secondary font-medium transition-colors"
                title="Set start to current local time and auto-advance deadline"
              >
                <Clock className="size-3 shrink-0" />
                <span>Set to Now</span>
              </button>
              <span className="text-[10px] uppercase font-mono px-xs py-0.5 rounded bg-utility-brand-50 text-utility-brand-700 font-semibold border border-utility-brand-200">
                Local Wall-Clock
              </span>
            </div>
          </div>

          <input
            type="datetime-local"
            value={localStartStr}
            onChange={(e) => handleLocalStartChange(e.target.value)}
            className="rounded-md bg-primary px-md py-xs text-sm text-primary font-mono border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
          />

          <div className="space-y-xxs pt-xxs text-[11px] text-tertiary">
            <div className="flex items-center justify-between">
              <span className="text-secondary font-medium">Local ({activeTz}):</span>
              <span className="text-primary font-medium">{formatLocalDateTimeWithZone(windowStart, activeTz, 'short')}</span>
            </div>
            <div className="flex items-center justify-between font-mono text-[10px] text-tertiary pt-xxs border-t border-secondary/40">
              <span>Equivalent UTC:</span>
              <span className="text-secondary">{windowStart}</span>
            </div>
          </div>
        </div>

        {/* Cycle Deadline / Window End */}
        <div
          className={`flex flex-col gap-xs p-md rounded-xl bg-secondary/40 border transition-colors ${
            !validation.valid ? 'border-error-subtle bg-utility-error-50/20' : 'border-secondary'
          }`}
        >
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-secondary flex items-center gap-xs">
              <Clock className="size-3.5 text-fg-brand-primary shrink-0" />
              <span>Cycle Deadline / Window End</span>
            </label>
            <button
              type="button"
              onClick={handleAutoSyncDeadline}
              title="Reset to daylight-saving-aware duration from start"
              className="inline-flex items-center gap-xxs text-[10px] text-brand-primary hover:text-brand-secondary font-medium transition-colors"
            >
              <RefreshCw className="size-3 shrink-0" />
              <span>Auto-calculate</span>
            </button>
          </div>

          <input
            type="datetime-local"
            value={localEndStr}
            onChange={(e) => handleLocalEndChange(e.target.value)}
            className={`rounded-md bg-primary px-md py-xs text-sm text-primary font-mono border focus-visible:ring-2 focus-visible:ring-focus-ring ${
              !validation.valid ? 'border-error-subtle text-error-primary' : 'border-primary'
            }`}
          />

          <div className="space-y-xxs pt-xxs text-[11px] text-tertiary">
            <div className="flex items-center justify-between">
              <span className="text-secondary font-medium">Local ({activeTz}):</span>
              <span className="text-primary font-medium">{formatLocalDateTimeWithZone(windowEnd, activeTz, 'short')}</span>
            </div>
            <div className="flex items-center justify-between font-mono text-[10px] text-tertiary pt-xxs border-t border-secondary/40">
              <span>Equivalent UTC:</span>
              <span className="text-secondary">{windowEnd}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Validation status badge */}
      {!validation.valid ? (
        <div className="p-sm rounded-lg bg-utility-error-50 border border-error-subtle text-xs text-error-primary flex items-center gap-xs">
          <AlertCircle className="size-4 shrink-0" />
          <span>{validation.error}</span>
        </div>
      ) : (
        <div className="p-xs px-sm rounded-lg bg-utility-success-50/50 border border-utility-success-200 text-[11px] text-utility-success-700 flex items-center justify-between">
          <div className="flex items-center gap-xs">
            <CheckCircle2 className="size-3.5 text-fg-success-primary shrink-0" />
            <span>
              Valid <strong>{cycleLength}</strong> cycle schedule · Daylight-saving aware in <strong>{activeTz}</strong>
            </span>
          </div>
          <span className="font-mono text-[10px] text-secondary">
            {Math.round((validation.durationMs || 0) / (1000 * 60 * 60 * 24))}d duration
          </span>
        </div>
      )}
    </div>
  )
}
