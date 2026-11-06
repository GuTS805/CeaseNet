import type { DiaryRow, TimeRange } from "./types"

/**
 * An agent's diary is stored in parts, one for each window of this length, counted from the clock (12:00, 12:05 and so
 * on). A part never spans two windows, so the index on Arkiv says which window each part covers, and anyone can ask
 * for what an agent did between two times. A busy window, or a store forced partway through one, can have more than
 * one part, and every part still stays inside its window.
 */
export const DIARY_WINDOW_MS = 5 * 60_000

/** The start of the window a moment falls in, in milliseconds since 1970. */
export const diaryWindowOf = (at: number, windowMs = DIARY_WINDOW_MS): number => Math.floor(at / windowMs) * windowMs

/**
 * Whether a part has anything inside a span of time. A part with no times, written before they were recorded, is
 * only shown when no span is asked for, because nothing says when it happened.
 */
export function diaryInRange(row: Pick<DiaryRow, "firstAt" | "lastAt">, range: TimeRange = {}): boolean {
  if (range.from === undefined && range.to === undefined) return true
  if (row.firstAt === undefined || row.lastAt === undefined) return false
  if (range.from !== undefined && row.lastAt < range.from) return false
  if (range.to !== undefined && row.firstAt > range.to) return false
  return true
}
