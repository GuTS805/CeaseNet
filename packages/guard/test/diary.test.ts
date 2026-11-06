import { describe, expect, it } from "vitest"
import { decodePart, Diary, type DiaryData, type DiaryEntry, DIARY_START, type DiaryStore, encodePart, entryHash, verifyPart } from "../src/diary"

const call = (action: string): DiaryData => ({
  kind: "CALL",
  tool: "demo-mail-tool",
  version: "1.0.16",
  hash: "0xbad",
  action,
  argsHash: "0xabc",
  verdict: "ALLOW",
  allowed: true,
  requestId: "req-1",
})

class MemoryStore implements DiaryStore {
  parts = new Map<string, Uint8Array>()
  fail = false
  async put(bytes: Uint8Array) {
    if (this.fail) throw new Error("storage down")
    const root = `0xroot${this.parts.size}`
    this.parts.set(root, bytes)
    return { root }
  }
  async get(root: string) {
    return this.parts.get(root)!
  }
}

function make(start?: { head: `0x${string}`; seq: number }) {
  const store = new MemoryStore()
  const index: { root: string; head: string; entries: bigint; firstSeq: bigint; lastSeq: bigint }[] = []
  let t = 100
  const diary = new Diary(
    store,
    {
      diary: async (i) => {
        index.push(i)
      },
    },
    () => t++,
    start,
  )
  return { diary, store, index }
}

describe("Diary", () => {
  it("chains each entry to the one before", () => {
    const { diary } = make()
    const a = diary.append(call("a"))
    const b = diary.append(call("b"))
    expect(a.prev).toBe(DIARY_START)
    expect(b.prev).toBe(entryHash(a))
    expect([a.seq, b.seq]).toEqual([0, 1])
  })

  it("stores a part and pins its head on the index", async () => {
    const { diary, index, store } = make()
    diary.append(call("a"))
    const b = diary.append(call("b"))
    await diary.flush()
    expect(index).toHaveLength(1)
    expect(index[0]).toMatchObject({ head: entryHash(b), entries: 2n, firstSeq: 0n, lastSeq: 1n })
    expect(diary.waiting).toBe(0)
    expect(store.parts.size).toBe(1)
  })

  it("does nothing when there is nothing to store", async () => {
    const { diary, index } = make()
    await diary.flush()
    expect(index).toHaveLength(0)
  })

  it("loses nothing when storage fails, and reports it", async () => {
    const { diary, store, index } = make()
    diary.append(call("a"))
    store.fail = true
    await diary.flush()
    expect(diary.waiting).toBe(1)
    expect(diary.lastError).toBe("storage down")
    expect(index).toHaveLength(0)
    store.fail = false
    await diary.flush()
    expect(diary.waiting).toBe(0)
    expect(diary.lastError).toBeUndefined()
    expect(index).toHaveLength(1)
  })

  it("keeps entries added while a part is being stored", async () => {
    const { diary, index } = make()
    diary.append(call("a"))
    const flushing = diary.flush()
    diary.append(call("b"))
    await flushing
    expect(diary.waiting).toBe(1)
    await diary.flush()
    expect(index.map((i) => Number(i.entries))).toEqual([1, 1])
  })

  it("continues the chain from one part to the next", async () => {
    const { diary, index, store } = make()
    diary.append(call("a"))
    await diary.flush()
    diary.append(call("b"))
    await diary.flush()
    const first = decodePart(await store.get(index[0]!.root))
    const second = decodePart(await store.get(index[1]!.root))
    expect(verifyPart(first, index[0]!.head, DIARY_START).ok).toBe(true)
    expect(verifyPart(second, index[1]!.head, index[0]!.head).ok).toBe(true)
  })

  it("can carry on from where an earlier run ended", () => {
    const { diary } = make({ head: "0xabc", seq: 7 })
    expect(diary.append(call("a"))).toMatchObject({ seq: 7, prev: "0xabc" })
  })
})

describe("checking a stored part", () => {
  async function stored() {
    const { diary, index, store } = make()
    diary.append(call("a"))
    diary.append({ kind: "RECEIPT", recall: "0x01", action: "BLOCKED" })
    diary.append(call("c"))
    await diary.flush()
    return { entries: decodePart(await store.get(index[0]!.root)), head: index[0]!.head }
  }

  it("passes an honest part", async () => {
    const { entries, head } = await stored()
    expect(verifyPart(entries, head, DIARY_START)).toMatchObject({ ok: true, entries: 3 })
  })

  it("survives being stored and read back byte for byte", async () => {
    const { entries, head } = await stored()
    expect(verifyPart(decodePart(encodePart(entries)), head).ok).toBe(true)
  })

  it("catches a changed entry", async () => {
    const { entries, head } = await stored()
    const changed: DiaryEntry[] = entries.map((e) => (e.seq === 0 ? ({ ...e, action: "something else" } as DiaryEntry) : e))
    const check = verifyPart(changed, head)
    expect(check.ok).toBe(false)
    expect(check).toMatchObject({ atSeq: 1 })
  })

  it("catches a removed entry", async () => {
    const { entries, head } = await stored()
    const check = verifyPart([entries[0]!, entries[2]!], head)
    expect(check.ok).toBe(false)
  })

  it("catches a shortened part", async () => {
    const { entries, head } = await stored()
    const check = verifyPart(entries.slice(0, 2), head)
    expect(check).toMatchObject({ ok: false, problem: "the entries do not end on the hash recorded on Arkiv" })
  })

  it("catches a changed last entry", async () => {
    const { entries, head } = await stored()
    const changed = entries.map((e) => (e.seq === 2 ? ({ ...e, allowed: false } as DiaryEntry) : e))
    expect(verifyPart(changed, head).ok).toBe(false)
  })

  it("catches a part that does not follow on from the one before", async () => {
    const { entries, head } = await stored()
    expect(verifyPart(entries, head, "0xsomething-else").ok).toBe(false)
  })

  it("does not pass an empty part", () => {
    expect(verifyPart([], "0x").ok).toBe(false)
  })
})
