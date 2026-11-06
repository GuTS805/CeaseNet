import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { evaluateAgent, makeTrust, recallCovers, verdictFor } from "../src/gate"
import type { LoadedFile, RecallRow } from "../src/types"

/**
 * The conformance vectors are the rules in a form any language can use. This holds our own gate to them. Another
 * implementation does the same: examples/check_gate_vectors.py runs them in Python with nothing of ours.
 */
const vectors = JSON.parse(readFileSync(new URL("../../../arkiv/vectors/gate.json", import.meta.url), "utf8"))

/** The records in a vector hold only what the rules read, with block numbers as strings. */
const withBlock = (row: { createdAt?: string }) => ({ ...row, createdAt: BigInt(row.createdAt ?? "0") }) as never

describe("the gate's decisions", () => {
  for (const v of vectors.decide) {
    it(`${v.id}: ${v.why}`, () => {
      const i = v.input
      const agent = evaluateAgent({
        files: i.files as LoadedFile[],
        rememberedStops: i.rememberedStops.map(withBlock),
        rememberedLifts: i.rememberedLifts.map(withBlock),
        advisories: i.advisories.map(withBlock),
        endorsements: i.endorsements.map(withBlock),
        currentBlock: BigInt(i.currentBlock),
        connectivity: i.connectivity,
        lastSupervised: i.lastSupervised.map(withBlock),
        trust: makeTrust({ ...i.trust, windowBlocks: BigInt(i.trust.windowBlocks) }),
        timers: i.timers,
      })
      expect(agent.core.mode).toBe(v.expect.agent)
      expect(verdictFor(agent, v.ask)).toBe(v.expect.verdict)
    })
  }
})

describe("what a recall covers", () => {
  for (const v of vectors.covers) {
    it(`${v.id}: ${v.why}`, () => {
      expect(recallCovers(v.recall as RecallRow, v.file as LoadedFile)).toBe(v.covers)
    })
  }
})

describe("the vectors themselves", () => {
  it("each have their own name", () => {
    const ids = [...vectors.decide, ...vectors.covers].map((v: { id: string }) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
