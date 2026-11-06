import { describe, expect, it } from "vitest"
import { exactAcos, exactAtan2, exactHypot } from "../src/exactMath"

describe("exact trigonometry", () => {
  it("agrees with Math.atan2 to within rounding, all around the circle", () => {
    for (let y = -3; y <= 3; y += 0.037) {
      for (let x = -3; x <= 3; x += 0.041) {
        expect(Math.abs(exactAtan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-14)
      }
    }
  })

  it("handles the axes", () => {
    expect(exactAtan2(0, 1)).toBe(0)
    expect(exactAtan2(1, 0)).toBeCloseTo(Math.PI / 2, 15)
    expect(exactAtan2(-1, 0)).toBeCloseTo(-Math.PI / 2, 15)
    expect(exactAtan2(0, -1)).toBeCloseTo(Math.PI, 15)
    expect(exactAtan2(0, 0)).toBe(0)
  })

  it("covers each range of the arctangent", () => {
    for (const v of [0.1, 0.43, 0.44, 0.68, 0.69, 1, 1.18, 1.19, 2.43, 2.44, 50, 1e6]) {
      expect(Math.abs(exactAtan2(v, 1) - Math.atan(v))).toBeLessThan(1e-14)
      expect(Math.abs(exactAtan2(-v, 1) - Math.atan(-v))).toBeLessThan(1e-14)
    }
  })

  it("agrees with Math.acos to within rounding", () => {
    for (let c = -1; c <= 1; c += 0.0013) {
      expect(Math.abs(exactAcos(c) - Math.acos(c))).toBeLessThan(1e-7)
    }
    for (let c = -0.99; c <= 0.99; c += 0.0013) {
      expect(Math.abs(exactAcos(c) - Math.acos(c))).toBeLessThan(1e-13)
    }
  })

  it("agrees with Math.hypot to within rounding", () => {
    for (let a = -2; a <= 2; a += 0.09) {
      for (let b = -2; b <= 2; b += 0.07) {
        expect(Math.abs(exactHypot(a, b) - Math.hypot(a, b))).toBeLessThan(1e-14)
      }
    }
  })

  it("uses only exact operations", () => {
    const source = exactAtan2.toString() + exactAcos.toString() + exactHypot.toString()
    expect(source).not.toMatch(/Math\.(atan|acos|asin|sin|cos|tan|hypot|exp|log|pow)/)
  })
})
