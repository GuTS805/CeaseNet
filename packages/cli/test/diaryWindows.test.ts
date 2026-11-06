import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DIARY_WINDOW_MS, type DiaryRow, hashBytes, type Hex } from "@ceasenet/core"
import type { DiaryStore } from "@ceasenet/guard"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type DiaryTarget, readBack, readDiaryState, storeWaiting, windowEnded } from "../src/diaryService"
import { readJournal, recordNote } from "../src/journal"
import { timeRange } from "../src/recordsApi"

const AGENT = "0x00000000000000000000000000000000000000ee" as Hex
const OWNER = "0x00000000000000000000000000000000000000ff" as Hex
/** The start of a window, well away from any real clock. */
const W = 1_000 * DIARY_WINDOW_MS

let dir: string
let previous: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ceasenet-windows-"))
  previous = process.env.CEASENET_HOME
  process.env.CEASENET_HOME = dir
})
afterEach(() => {
  if (previous === undefined) delete process.env.CEASENET_HOME
  else process.env.CEASENET_HOME = previous
  rmSync(dir, { recursive: true, force: true })
})

const target = (): DiaryTarget => ({ id: "x", name: "X", home: dir, address: AGENT, mode: "public" })

function memoryStore(): DiaryStore {
  const files = new Map<string, Uint8Array>()
  return {
    put: async (bytes) => {
      const root = hashBytes(bytes)
      files.set(root, bytes)
      return { root }
    },
    get: async (root) => files.get(root)!,
  }
}

const rows: DiaryRow[] = []
const index = async (agent: Hex, part: Omit<DiaryRow, "key" | "agent" | "creator" | "createdAt">) => {
  rows.push({ key: `0x${rows.length}`, agent, ...part, creator: OWNER, createdAt: BigInt(rows.length + 1) })
}
beforeEach(() => void (rows.length = 0))

const note = (text: string, at: number) => recordNote("job", text, dir, at)

describe("diary parts and time windows", () => {
  it("never puts two windows in one part, and records when each part's entries happened", async () => {
    const store = memoryStore()
    note("first", W + 1_000)
    note("second", W + 4_000)
    note("next window", W + DIARY_WINDOW_MS + 500)

    await storeWaiting(target(), store, index)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entries: 2n, firstSeq: 0n, lastSeq: 1n, firstAt: W + 1_000, lastAt: W + 4_000 })

    await storeWaiting(target(), store, index)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ entries: 1n, firstSeq: 2n, lastSeq: 2n, firstAt: W + DIARY_WINDOW_MS + 500, lastAt: W + DIARY_WINDOW_MS + 500 })
    expect(readDiaryState(dir).parts.map((p) => [p.firstAt, p.lastAt])).toEqual([
      [W + 1_000, W + 4_000],
      [W + DIARY_WINDOW_MS + 500, W + DIARY_WINDOW_MS + 500],
    ])
  })

  it("keeps the chain whole across windows, so nothing can go missing between them", async () => {
    const store = memoryStore()
    note("a", W + 10)
    note("b", W + DIARY_WINDOW_MS + 10)
    await storeWaiting(target(), store, index)
    await storeWaiting(target(), store, index)
    const parts = await readBack(rows, store.get)
    expect(parts.every((p) => p.check.ok)).toBe(true)
    expect(parts[0]!.followsOn).toBe(true)
    expect(parts.map((p) => p.firstAt)).toEqual([W + DIARY_WINDOW_MS + 10, W + 10])
  })

  it("says a window is ready to store only once it is over", () => {
    expect(windowEnded(dir, W + 2 * DIARY_WINDOW_MS)).toBe(false)
    note("a", W + 1_000)
    expect(windowEnded(dir, W + 2_000)).toBe(false)
    expect(windowEnded(dir, W + DIARY_WINDOW_MS - 1)).toBe(false)
    expect(windowEnded(dir, W + DIARY_WINDOW_MS)).toBe(true)
  })

  it("leaves what belongs to the next window in the journal for next time", () => {
    note("a", W + 1)
    note("b", W + DIARY_WINDOW_MS + 1)
    const first = readJournal(dir, 0, 10, (a, b) => Math.floor(a.at / DIARY_WINDOW_MS) === Math.floor(b.at / DIARY_WINDOW_MS))
    expect(first.records.map((r) => (r as { text: string }).text)).toEqual(["a"])
    expect(readJournal(dir, first.next, 10).records.map((r) => (r as { text: string }).text)).toEqual(["b"])
  })
})

describe("a span of time asked of the console", () => {
  it("reads from and to as milliseconds, and leaves anything else open", () => {
    expect(timeRange({ from: "1000", to: "2000" })).toEqual({ from: 1000, to: 2000 })
    expect(timeRange({ from: "1000" })).toEqual({ from: 1000 })
    expect(timeRange({ from: "", to: "soon" })).toEqual({})
    expect(timeRange({ from: "-5" })).toEqual({})
    expect(timeRange({})).toEqual({})
  })
})
