import { MAX_MONITOR_HEIGHT, optionalMonitorInteger } from './monitorValidation'

const MAX_RECOVERY_RANGES = 128
export type RecoveryRange = [number, number]

/** A bounded, lossless superset of pending heights, persisted in monitor_events. */
export class ReorgRecovery {
  ranges: RecoveryRange[] = []
  cursor = 0
  reviewedHash?: string

  static parse(details: string): ReorgRecovery | undefined {
    if (details.length > 8192) return undefined
    try {
      const value: unknown = JSON.parse(details)
      if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
      const record = value as Record<string, unknown>
      if (!Array.isArray(record.ranges) || record.ranges.length > MAX_RECOVERY_RANGES) return undefined
      const cursor = optionalMonitorInteger(record.cursor, 0, MAX_MONITOR_HEIGHT)
      if (cursor === undefined) return undefined
      if (
        record.reviewedHash !== undefined &&
        (typeof record.reviewedHash !== 'string' || record.reviewedHash.length > 128)
      )
        return undefined
      const recovery = new ReorgRecovery()
      recovery.cursor = cursor
      recovery.reviewedHash = record.reviewedHash as string | undefined
      for (const range of record.ranges) {
        if (!Array.isArray(range) || range.length !== 2) return undefined
        const min = optionalMonitorInteger(range[0], 0, MAX_MONITOR_HEIGHT)
        const max = optionalMonitorInteger(range[1], 0, MAX_MONITOR_HEIGHT)
        if (min === undefined || max === undefined || min > max) return undefined
        recovery.add(min, max)
      }
      return recovery
    } catch {
      return undefined
    }
  }

  add(min: number, max: number): void {
    const sorted = [...this.ranges, [min, max] as RecoveryRange].sort((a, b) => a[0] - b[0])
    this.ranges = []
    for (const range of sorted) {
      const last = this.ranges.at(-1)
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
      else this.ranges.push([...range])
    }
    // Coalescing can add harmless intervening reviews, never remove pending work.
    // 128 pairs of bounded heights keep the checkpoint well below 8192 bytes.
    while (this.ranges.length > MAX_RECOVERY_RANGES) {
      let closest = 0
      for (let i = 1; i < this.ranges.length - 1; i++) {
        if (this.ranges[i + 1][0] - this.ranges[i][1] < this.ranges[closest + 1][0] - this.ranges[closest][1])
          closest = i
      }
      this.ranges.splice(closest, 2, [this.ranges[closest][0], this.ranges[closest + 1][1]])
    }
  }

  next(tipHeight: number, budget: number): RecoveryRange | undefined {
    const eligible = this.ranges.filter(range => range[0] <= tipHeight)
    const range = eligible.find(range => range[1] >= this.cursor) ?? eligible[0]
    if (!range) return undefined
    const start = this.cursor >= range[0] && this.cursor <= Math.min(range[1], tipHeight) ? this.cursor : range[0]
    return [start, Math.min(range[1], tipHeight, start + budget - 1)]
  }

  complete([min, max]: RecoveryRange, unresolved: number[]): void {
    this.ranges = this.ranges.flatMap(([start, end]): RecoveryRange[] => {
      if (end < min || start > max) return [[start, end]]
      const remainder: RecoveryRange[] = []
      if (start < min) remainder.push([start, min - 1])
      if (end > max) remainder.push([max + 1, end])
      return remainder
    })
    for (const height of unresolved) this.add(height, height)
    this.cursor = max === MAX_MONITOR_HEIGHT ? 0 : max + 1
  }
}
