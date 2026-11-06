import { describe, expect, it } from "vitest"
import { DIARY_WINDOW_MS, diaryInRange, diaryWindowOf } from "../src/diaryTime"

const W = 1_000 * DIARY_WINDOW_MS

describe("time windows of a diary", () => {
  it("puts every moment in the window that starts on the clock before it", () => {
    expect(diaryWindowOf(W)).toBe(W)
    expect(diaryWindowOf(W + DIARY_WINDOW_MS - 1)).toBe(W)
    expect(diaryWindowOf(W + DIARY_WINDOW_MS)).toBe(W + DIARY_WINDOW_MS)
    expect(diaryWindowOf(W - 1)).toBe(W - DIARY_WINDOW_MS)
  })
})

describe("whether a part falls in a span of time", () => {
  const part = { firstAt: W + 1_000, lastAt: W + 2_000 }

  it("is in when it overlaps the span at all", () => {
    expect(diaryInRange(part, { from: W, to: W + 3_000 })).toBe(true)
    expect(diaryInRange(part, { from: W + 1_500, to: W + 1_600 })).toBe(true)
    expect(diaryInRange(part, { from: W + 2_000 })).toBe(true)
    expect(diaryInRange(part, { to: W + 1_000 })).toBe(true)
  })

  it("is out when it ended before the span, or began after it", () => {
    expect(diaryInRange(part, { from: W + 2_001 })).toBe(false)
    expect(diaryInRange(part, { to: W + 999 })).toBe(false)
  })

  it("with no span asked for, every part is in, even one with no times", () => {
    expect(diaryInRange(part)).toBe(true)
    expect(diaryInRange({}, {})).toBe(true)
  })

  it("a part with no times is left out of any span, since nothing says when it happened", () => {
    expect(diaryInRange({}, { from: 0 })).toBe(false)
  })
})
