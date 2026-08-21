/**
 * 投递节流：静默时段 + 周频控。
 *
 * 复用：`Intl.DateTimeFormat`（Node 内置）做时区换算。
 * 静默时段判断只需要「某 UTC 时刻在某 IANA 时区是几点」，
 * `formatToParts` 直接给出，无需引入 date-fns/tz 或 moment-timezone。
 */

/** 一周的毫秒数，周频控窗口。 */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface QuietHours {
  /** 静默开始的本地小时（含）。 */
  readonly start: number
  /** 静默结束的本地小时（不含）。 */
  readonly end: number
  readonly timezone: string
}

/**
 * 取某个 UTC 时刻在指定时区的本地小时。
 *
 * @param at - UTC 时刻。
 * @param timezone - IANA 时区名。
 * @returns 0-23 的本地小时；时区名非法时退回 UTC 小时（不抛错——
 *   一个写错的时区不该让整个投递停摆）。
 */
export function localHour(at: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(at)
    const hour = parts.find((part) => part.type === 'hour')?.value
    const parsed = Number(hour)
    // `hour12: false` 在某些实现下 24 点表示午夜
    return Number.isFinite(parsed) ? parsed % 24 : at.getUTCHours()
  } catch {
    return at.getUTCHours()
  }
}

/**
 * 判断某时刻是否落在静默时段。
 *
 * 支持跨午夜的区间（如 22 → 9）。`start === end` 表示不设静默。
 *
 * @param at - 待判断的时刻。
 * @param quiet - 静默配置。
 * @returns 是否处于静默时段。
 */
export function isQuietHour(at: Date, quiet: QuietHours): boolean {
  if (quiet.start === quiet.end) return false
  const hour = localHour(at, quiet.timezone)
  return quiet.start < quiet.end
    ? hour >= quiet.start && hour < quiet.end
    : hour >= quiet.start || hour < quiet.end
}

/**
 * 求下一个可发送时刻。
 *
 * 若当前不在静默时段则原样返回；否则推进到静默结束的整点。
 *
 * @param at - 起始时刻。
 * @param quiet - 静默配置。
 * @returns 可发送的时刻。
 */
export function nextOpenSlot(at: Date, quiet: QuietHours): Date {
  if (!isQuietHour(at, quiet)) return at

  // 逐小时前进直到走出静默区间。最多 24 步，避免配置异常时死循环。
  const cursor = new Date(at.getTime())
  for (let step = 0; step < 24; step += 1) {
    cursor.setTime(cursor.getTime() + 60 * 60 * 1000)
    // 对齐到整点，避免每次推迟都留下分钟级偏移
    cursor.setUTCMinutes(0, 0, 0)
    if (!isQuietHour(cursor, quiet)) return cursor
  }
  return cursor
}

/**
 * 周频控：判断本次触达是否超过上限。
 *
 * @param recentTouches - 最近的触达时刻列表。
 * @param now - 当前时刻。
 * @param maxPerWeek - 周上限。
 * @returns 允许则 `undefined`，超限则返回原因文本。
 */
export function checkWeeklyCap(
  recentTouches: readonly Date[],
  now: Date,
  maxPerWeek: number,
): string | undefined {
  if (maxPerWeek <= 0) return '该节奏的周触达上限为 0，不发送'
  const withinWindow = recentTouches.filter((at) => now.getTime() - at.getTime() < WEEK_MS)
  if (withinWindow.length < maxPerWeek) return undefined
  return `本周已触达 ${withinWindow.length} 次，达到上限 ${maxPerWeek}`
}
