import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentArtifact, agentFingerprint, canonicalJson, type DiaryRow, type EndorseRow, hashBytes, type Hex, identityFiles, isPublicSwarmRef, type LoadedFile, type RecallRow, SEALED_ON_SWARM } from "@ceasenet/core"
import { DIARY_START, decodePart, type DiaryEntry, type DiaryStore, encodePart, openSealedBytes, openSealedRef, sealBytes, SwarmClient, verifyPart } from "@ceasenet/guard"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildEntries, dataFor, type DiaryTarget, hasWaiting, localDiaryStore, readBack, readDiaryState, sealedSwarmStore, storeWaiting, waitingCount } from "../src/diaryService"
import { hashOf, journalPath, keep, KEEP_CHARS, type JournalCall, readJournal, recordFinishedCall, recordNote } from "../src/journal"
import { loadHandled, markHandled, recallReasonFor, reportsFor, type OwnAgent } from "../src/reports"

const AGENT = "0x00000000000000000000000000000000000000ee" as Hex
const OWNER = "0x00000000000000000000000000000000000000ff" as Hex
const SECRET = "the customer's card number is 4242"

let dir: string
let previous: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ceasenet-records-"))
  previous = process.env.CEASENET_HOME
  process.env.CEASENET_HOME = dir
  delete process.env.CEASENET_MAIN_HOME
})
afterEach(() => {
  if (previous === undefined) delete process.env.CEASENET_HOME
  else process.env.CEASENET_HOME = previous
  rmSync(dir, { recursive: true, force: true })
})

const tool = { server: "files", name: "server-filesystem", version: "2.2.0", hash: "0xf11e" }
const finished = (over: Partial<Parameters<typeof recordFinishedCall>[0]> = {}) => ({
  action: "read_text_file",
  decision: { allowed: true, verdict: "ALLOW" as const, message: "Allowed." },
  args: { path: "/a.txt" },
  result: { content: [{ type: "text", text: SECRET }] },
  ms: 12,
  ...over,
})

const target = (mode: DiaryTarget["mode"] = "public"): DiaryTarget => ({ id: "x", name: "X", home: dir, address: AGENT, mode })

function memoryStore() {
  const files = new Map<string, Uint8Array>()
  const store: DiaryStore = {
    put: async (bytes) => {
      const root = hashBytes(bytes)
      files.set(root, bytes)
      return { root }
    },
    get: async (root) => {
      const found = files.get(root)
      if (!found) throw new Error("not found")
      return found
    },
  }
  return { store, files }
}

const indexRows: DiaryRow[] = []
const indexWriter = async (agent: Hex, part: { root: string; head: string; entries: bigint; firstSeq: bigint; lastSeq: bigint; storage?: string }) => {
  indexRows.push({ key: `0x${indexRows.length}`, agent, ...part, creator: OWNER, createdAt: BigInt(indexRows.length + 1) })
}
beforeEach(() => void (indexRows.length = 0))

describe("the journal", () => {
  it("writes down each call, whole, with hashes", () => {
    recordFinishedCall(finished(), tool)
    const { records } = readJournal(dir, 0, 10)
    expect(records[0]).toMatchObject({ type: "call", action: "read_text_file", tool: "server-filesystem", allowed: true, args: { path: "/a.txt" }, argsHash: hashOf({ path: "/a.txt" }) })
    expect(JSON.stringify(records[0])).toContain(SECRET)
  })

  it("writes down a refusal, with what it said", () => {
    recordFinishedCall(finished({ decision: { allowed: false, verdict: "BLOCK", message: "It was recalled" }, result: undefined }), tool)
    const call = readJournal(dir, 0, 10).records[0] as JournalCall
    expect(call).toMatchObject({ allowed: false, verdict: "BLOCK", message: "It was recalled" })
    expect(call.resultHash).toBeUndefined()
  })

  it("shortens something huge, but its hash still covers all of it", () => {
    const huge = "x".repeat(KEEP_CHARS * 3)
    recordFinishedCall(finished({ result: huge }), tool)
    const call = readJournal(dir, 0, 10).records[0] as JournalCall
    expect(call.clipped).toBe(true)
    expect(String(call.result).length).toBeLessThan(KEEP_CHARS + 2)
    expect(call.resultHash).toBe(hashBytes(canonicalJson(huge)))
  })

  it("keeps short things exactly as they are", () => {
    expect(keep({ a: 1 })).toEqual({ kept: { a: 1 }, clipped: false })
  })

  it("carries on from where it left off, and leaves a line still being written", () => {
    recordNote("job", "one")
    const first = readJournal(dir, 0, 10)
    recordNote("job", "two")
    writeFileSync(journalPath(dir), `${readFileSync(journalPath(dir), "utf8")}{"type":"note","half`)
    const second = readJournal(dir, first.next, 10)
    expect(second.records).toEqual([expect.objectContaining({ text: "two" })])
    expect(readJournal(dir, second.next, 10).records).toEqual([])
  })

  it("does not let a damaged line stop the rest", () => {
    writeFileSync(journalPath(dir), 'not json\n{"type":"note","at":1,"note":"job","text":"fine"}\n')
    expect(readJournal(dir, 0, 10).records).toEqual([expect.objectContaining({ text: "fine" })])
  })
})

describe("who can read a call", () => {
  const record = (): JournalCall => {
    recordFinishedCall(finished(), tool)
    return readJournal(dir, 0, 10).records[0] as JournalCall
  }

  it("in the open, anyone can", () => {
    const data = dataFor(record(), "public")
    expect(JSON.stringify(data)).toContain(SECRET)
  })

  it("sealed, nobody can without the owner's key, and the owner can", () => {
    const key = generatePrivateKey()
    const data = dataFor(record(), "sealed", privateKeyToAccount(key).publicKey) as { sealed: string }
    expect(JSON.stringify(data)).not.toContain(SECRET)
    expect(openSealedRef(data.sealed, key)).toContain(SECRET)
    expect(() => openSealedRef(data.sealed, generatePrivateKey())).toThrow()
  })

  it("sealed with no key to seal to, the contents are left out, and never fall back to being public", () => {
    const data = dataFor(record(), "sealed")
    expect(JSON.stringify(data)).not.toContain(SECRET)
    expect(JSON.stringify(data)).not.toContain("/a.txt")
  })

  it("whichever it is, what happened and when stays public, and a copy can be proved", () => {
    const key = generatePrivateKey()
    for (const data of [dataFor(record(), "public"), dataFor(record(), "sealed", privateKeyToAccount(key).publicKey), dataFor(record(), "hashes")]) {
      expect(data).toMatchObject({ kind: "CALL", action: "read_text_file", tool: "server-filesystem", allowed: true, argsHash: hashOf({ path: "/a.txt" }) })
    }
  })
})

describe("storing a diary", () => {
  it("stores what is waiting, with its index, and picks up from there", async () => {
    const { store } = memoryStore()
    recordFinishedCall(finished(), tool)
    recordNote("said", "Done")
    expect(hasWaiting(dir)).toBe(true)
    expect(waitingCount(dir)).toBe(2)

    expect(await storeWaiting(target(), store, indexWriter)).toBe(true)
    expect(hasWaiting(dir)).toBe(false)
    expect(waitingCount(dir)).toBe(0)
    expect(indexRows).toHaveLength(1)
    expect(indexRows[0]).toMatchObject({ agent: AGENT, entries: 2n, firstSeq: 0n, lastSeq: 1n })

    recordNote("closed", "Closing")
    await storeWaiting(target(), store, indexWriter)
    expect(indexRows[1]).toMatchObject({ entries: 1n, firstSeq: 2n, lastSeq: 2n })
  })

  it("does nothing, and costs nothing, when there is nothing new", async () => {
    const { store } = memoryStore()
    expect(await storeWaiting(target(), store, indexWriter)).toBe(false)
    expect(indexRows).toEqual([])
  })

  it("loses nothing when storage fails, and tries the same thing again", async () => {
    const { store } = memoryStore()
    recordNote("said", "Done")
    let down = true
    const flaky: DiaryStore = { put: (b) => (down ? Promise.reject(new Error("no network")) : store.put(b)), get: store.get }
    await expect(storeWaiting(target(), flaky, indexWriter)).rejects.toThrow("no network")
    expect(hasWaiting(dir)).toBe(true)
    down = false
    expect(await storeWaiting(target(), flaky, indexWriter)).toBe(true)
    expect(indexRows).toHaveLength(1)
  })

  it("does not pay to store it twice when only the index failed", async () => {
    const { store } = memoryStore()
    recordNote("said", "Done")
    let puts = 0
    const counting: DiaryStore = {
      put: (b) => {
        puts += 1
        return store.put(b)
      },
      get: store.get,
    }
    let fail = true
    const index: typeof indexWriter = async (a, p) => {
      if (fail) throw new Error("no funds")
      return indexWriter(a, p)
    }
    await expect(storeWaiting(target(), counting, index)).rejects.toThrow("no funds")
    fail = false
    await storeWaiting(target(), counting, index)
    expect(puts).toBe(1)
    expect(indexRows).toHaveLength(1)
  })

  it("keeps parts in order, each following on from the last", async () => {
    const { store } = memoryStore()
    recordNote("job", "one")
    await storeWaiting(target(), store, indexWriter)
    recordNote("job", "two")
    await storeWaiting(target(), store, indexWriter)
    const state = readDiaryState(dir)
    expect(state.seq).toBe(2)
    const parts = await readBack(indexRows, store.get)
    expect(parts.every((p) => p.check.ok)).toBe(true)
    expect(parts[0]!.followsOn).toBe(true)
  })
})

describe("reading a diary back", () => {
  const stored = async () => {
    const memory = memoryStore()
    recordFinishedCall(finished(), tool)
    recordNote("closed", "It was recalled")
    await storeWaiting(target(), memory.store, indexWriter)
    return memory
  }

  it("shows what really happened, and says it matches", async () => {
    const { store } = await stored()
    const [part] = await readBack(indexRows, store.get)
    expect(part!.check.ok).toBe(true)
    expect(part!.items.map((i) => i.kind)).toEqual(["CALL", "NOTE"])
    expect(JSON.stringify(part!.items[0])).toContain(SECRET)
  })

  it("catches a changed entry", async () => {
    const { store, files } = await stored()
    const root = indexRows[0]!.root
    const entries = decodePart(files.get(root)!)
    files.set(root, encodePart(entries.map((e) => (e.seq === 0 ? ({ ...e, allowed: false } as DiaryEntry) : e))))
    const [part] = await readBack(indexRows, store.get)
    expect(part!.check.ok).toBe(false)
  })

  it("catches a removed entry", async () => {
    const { store, files } = await stored()
    const root = indexRows[0]!.root
    files.set(root, encodePart(decodePart(files.get(root)!).slice(0, 1)))
    const [part] = await readBack(indexRows, store.get)
    expect(part!.check.ok).toBe(false)
  })

  it("shows a whole missing part as a gap", async () => {
    const { store } = memoryStore()
    for (const text of ["one", "two", "three"]) {
      recordNote("job", text)
      await storeWaiting(target(), store, indexWriter)
    }
    const parts = await readBack([indexRows[0]!, indexRows[2]!], store.get)
    expect(parts[0]!.followsOn).toBe(false)
  })

  it("says so when a part cannot be read, rather than leaving it out", async () => {
    const { store, files } = await stored()
    files.delete(indexRows[0]!.root)
    const [part] = await readBack(indexRows, store.get)
    expect(part!.check.ok).toBe(false)
    expect(part!.check.problem).toContain("Could not read")
  })

  it("opens sealed contents for the owner and nobody else", async () => {
    const key = generatePrivateKey()
    const { store } = memoryStore()
    recordFinishedCall(finished(), tool)
    await storeWaiting(target("sealed"), store, indexWriter, privateKeyToAccount(key).publicKey)
    const [forOwner] = await readBack(indexRows, store.get, key)
    expect(forOwner!.check.ok).toBe(true)
    expect(JSON.stringify((forOwner!.items[0] as { opened?: unknown }).opened)).toContain(SECRET)
    const [forAnyone] = await readBack(indexRows, store.get)
    expect(forAnyone!.check.ok).toBe(true)
    expect(JSON.stringify(forAnyone!.items[0])).not.toContain(SECRET)
    const [forSomeoneElse] = await readBack(indexRows, store.get, generatePrivateKey())
    expect((forSomeoneElse!.items[0] as { opened?: unknown }).opened).toBeUndefined()
  })

  it("does not put a sealed secret in what storage holds", async () => {
    const key = generatePrivateKey()
    const { store, files } = memoryStore()
    recordFinishedCall(finished(), tool)
    await storeWaiting(target("sealed"), store, indexWriter, privateKeyToAccount(key).publicKey)
    expect(new TextDecoder().decode(files.get(indexRows[0]!.root)!)).not.toContain(SECRET)
  })

  it("can be checked by anyone with just the bytes and the index", async () => {
    const { store } = await stored()
    const entries = decodePart(await store.get(indexRows[0]!.root))
    expect(verifyPart(entries, indexRows[0]!.head, DIARY_START).ok).toBe(true)
  })
})

describe("parts kept on this machine", () => {
  it("go in and come back by their hash", async () => {
    const local = localDiaryStore(join(dir, "store"))
    const bytes = new TextEncoder().encode("hello")
    const { root } = await local.put(bytes)
    expect(root).toBe(hashBytes(bytes))
    expect(new TextDecoder().decode(await local.get(root))).toBe("hello")
  })

  it("refuse a name that could reach outside the folder", async () => {
    const local = localDiaryStore(join(dir, "store"))
    await expect(local.get("../../keys.json")).rejects.toThrow(/not a diary part/)
  })
})

describe("chaining entries", () => {
  it("starts from where the last part ended", () => {
    const built = buildEntries([{ type: "note", at: 1, note: "job", text: "a" }], { head: DIARY_START, seq: 0 }, "public")
    const next = buildEntries([{ type: "note", at: 2, note: "job", text: "b" }], { head: built.head, seq: built.seq }, "public")
    expect(next.entries[0]!.prev).toBe(built.head)
    expect(next.entries[0]!.seq).toBe(1)
  })

  it("keeps the time each thing happened, not when it was stored", () => {
    expect(buildEntries([{ type: "note", at: 123, note: "job", text: "a" }], { head: DIARY_START, seq: 0 }, "public").entries[0]!.at).toBe(123)
  })
})

describe("fingerprints", () => {
  const a: LoadedFile = { kind: "tool", name: "a", version: "1.0.0", hash: "0xa" }
  const b: LoadedFile = { kind: "tool", name: "b", version: "1.0.0", hash: "0xb" }

  it("are the same whatever order things were loaded in", () => {
    expect(agentFingerprint([a, b])).toBe(agentFingerprint([b, a]))
  })

  it("change when anything an agent runs changes", () => {
    expect(agentFingerprint([a])).not.toBe(agentFingerprint([{ ...a, hash: "0xc" }]))
    expect(agentFingerprint([a])).not.toBe(agentFingerprint([a, b]))
    expect(agentFingerprint([a])).not.toBe(agentFingerprint([{ ...a, version: "1.0.1" }]))
  })

  it("describe what an agent is made of, not who it is", () => {
    expect(agentFingerprint([a, ...identityFiles(AGENT, OWNER)])).toBe(agentFingerprint([a, ...identityFiles(OWNER, AGENT)]))
  })
})

describe("reports, for an owner", () => {
  const VERIFIER = "0x00000000000000000000000000000000000000cc" as Hex
  const report = (over: Partial<RecallRow> = {}): RecallRow => ({
    key: "0x01",
    artifact: agentArtifact(AGENT),
    level: "ADVISORY",
    severity: "REPORT",
    reason: "It is sending customer data somewhere",
    contentHash: "0xc",
    creator: VERIFIER,
    createdAt: 5n,
    expiresAt: 9n,
    ...over,
  })
  const vote = (human: string, stance: "CONFIRM" | "DISPUTE" = "CONFIRM", over: Partial<EndorseRow> = {}): EndorseRow => ({ key: `0x${human}`, recall: "0x01", stance, human, creator: VERIFIER, createdAt: 6n, ...over })
  const mine: OwnAgent = { name: "Support agent", address: AGENT, files: [...identityFiles(AGENT, OWNER), { kind: "tool", name: "good-tool", version: "1.2.3", hash: "0xf11e" }] }

  it("are collecting votes until there are enough", () => {
    const [view] = reportsFor([report()], [vote("a"), vote("b")], [mine], 3, {})
    expect(view).toMatchObject({ state: "collecting", votes: 2, votesNeeded: 3, kind: "agent", target: "Support agent" })
  })

  it("wait for the owner once there are enough", () => {
    expect(reportsFor([report()], [vote("a"), vote("b"), vote("c")], [mine], 3, {})[0]!.state).toBe("waiting")
  })

  it("do not bother an owner when more people disagree", () => {
    const votes = [vote("a"), vote("b"), vote("c"), vote("d", "DISPUTE"), vote("e", "DISPUTE"), vote("f", "DISPUTE")]
    expect(reportsFor([report()], votes, [mine], 3, {})[0]!.state).toBe("collecting")
  })

  it("count each person once", () => {
    expect(reportsFor([report()], [vote("a"), vote("a"), vote("a")], [mine], 3, {})[0]).toMatchObject({ votes: 1, state: "collecting" })
  })

  it("ignore votes written by anyone but the verifier that filed the report", () => {
    const forged = ["a", "b", "c"].map((h) => vote(h, "CONFIRM", { creator: "0x00000000000000000000000000000000000000dd" }))
    expect(reportsFor([report()], forged, [mine], 3, {})[0]).toMatchObject({ votes: 0, state: "collecting" })
  })

  it("ignore votes on a different report", () => {
    expect(reportsFor([report()], [vote("a", "CONFIRM", { recall: "0x02" })], [mine], 3, {})[0]!.votes).toBe(0)
  })

  it("say how many votes were simulated", () => {
    expect(reportsFor([report()], [vote("real"), vote("simulated-1"), vote("simulated-2")], [mine], 3, {})[0]).toMatchObject({ votes: 3, simulated: 2 })
  })

  it("about someone else's agent are not shown", () => {
    expect(reportsFor([report({ artifact: agentArtifact("0x00000000000000000000000000000000000000ab") })], [], [mine], 3, {})).toEqual([])
  })

  it("about a tool reach the owners whose agents use it", () => {
    const [view] = reportsFor([report({ artifact: "package:good-tool", pkg: "good-tool", versions: "*" })], [], [mine], 3, {})
    expect(view).toMatchObject({ kind: "tool", target: "good-tool", about: [{ agent: "Support agent", through: "good-tool" }] })
  })

  it("about a version of a tool not in use are not shown", () => {
    expect(reportsFor([report({ artifact: "package:good-tool", pkg: "good-tool", versions: "<1.0.0" })], [], [mine], 3, {})).toEqual([])
  })

  it("stay handled once the owner has decided", () => {
    const votes = [vote("a"), vote("b"), vote("c")]
    markHandled("0x01", "dismissed")
    expect(reportsFor([report()], votes, [mine], 3, loadHandled())[0]!.state).toBe("dismissed")
    markHandled("0x01", "recalled", "0x99")
    expect(reportsFor([report()], votes, [mine], 3, loadHandled())[0]).toMatchObject({ state: "recalled", recall: "0x99" })
  })

  it("newest come first", () => {
    const views = reportsFor([report({ key: "0x01", createdAt: 1n }), report({ key: "0x02", createdAt: 9n })], [], [mine], 3, {})
    expect(views.map((v) => v.key)).toEqual(["0x02", "0x01"])
  })

  it("carry through into a recall's reason, saying where it came from", () => {
    expect(recallReasonFor({ reason: "It leaks", votes: 3, simulated: 2 })).toBe("Reported by 3 people checked by World ID (2 simulated): It leaks")
    expect(recallReasonFor({ reason: "It leaks", votes: 1, simulated: 0 })).toBe("Reported by 1 person checked by World ID: It leaks")
  })
})

describe("a diary kept on Swarm", () => {
  /** A Bee node that keeps what it is given, so a test can see exactly what left this machine. */
  function fakeBee() {
    const files = new Map<string, Uint8Array>()
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const reference = hashBytes(init.body as Uint8Array).slice(2)
        files.set(reference, init.body as Uint8Array)
        return new Response(JSON.stringify({ reference }), { status: 201 })
      }
      const found = files.get(String(url).split("/bzz/")[1]!)
      return found ? new Response(found as BodyInit, { status: 200 }) : new Response("{}", { status: 404 })
    }) as typeof fetch
    return { files, swarm: new SwarmClient({ url: "http://bee", batch: "ab".repeat(32), fetch: fetchImpl }) }
  }
  const ownerKey = generatePrivateKey()
  const ownerPublic = privateKeyToAccount(ownerKey).publicKey

  it("sends only what cannot be read, and only the owner can open it", async () => {
    recordFinishedCall(finished(), tool)
    recordNote("said", "Bought 200 dollars of BTC", dir)
    const bee = fakeBee()
    await storeWaiting(target("public"), sealedSwarmStore(bee.swarm, ownerPublic), indexWriter, ownerPublic)

    const [uploaded] = [...bee.files.values()]
    const text = Buffer.from(uploaded!).toString("latin1")
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain("Bought 200 dollars")
    expect(text).not.toContain("read_text_file")
    expect(() => openSealedBytes(uploaded!, generatePrivateKey())).toThrow()
    expect(decodePart(openSealedBytes(uploaded!, ownerKey))).toHaveLength(2)
  })

  it("puts a reference on the index that holds no key, and says how it is kept", async () => {
    recordFinishedCall(finished(), tool)
    await storeWaiting(target(), sealedSwarmStore(fakeBee().swarm, ownerPublic), indexWriter, ownerPublic)
    expect(indexRows[0]!.storage).toBe(SEALED_ON_SWARM)
    expect(isPublicSwarmRef(indexRows[0]!.root)).toBe(true)
    expect(readDiaryState(dir).parts[0]!.storage).toBe(SEALED_ON_SWARM)
  })

  it("reads back whole for the owner, and matches the hash on the index", async () => {
    recordFinishedCall(finished(), tool)
    recordNote("closed", "It was recalled", dir)
    const bee = fakeBee()
    const store = sealedSwarmStore(bee.swarm, ownerPublic)
    await storeWaiting(target("public"), store, indexWriter, ownerPublic)
    const [part] = await readBack(indexRows, store.get, ownerKey)
    expect(part!.check.ok).toBe(true)
    expect(part!.locked).toBeUndefined()
    expect(part!.items).toHaveLength(2)
    expect(JSON.stringify(part!.items)).toContain(SECRET)
  })

  it("says it is locked, not broken, to anyone without the key", async () => {
    recordFinishedCall(finished(), tool)
    const store = sealedSwarmStore(fakeBee().swarm, ownerPublic)
    await storeWaiting(target(), store, indexWriter, ownerPublic)
    const [part] = await readBack(indexRows, store.get)
    expect(part).toMatchObject({ locked: true, check: { ok: true }, items: [] })
  })

  it("says so when the wrong key tries, and when the file has been changed", async () => {
    recordFinishedCall(finished(), tool)
    const bee = fakeBee()
    const store = sealedSwarmStore(bee.swarm, ownerPublic)
    await storeWaiting(target(), store, indexWriter, ownerPublic)
    const [wrongKey] = await readBack(indexRows, store.get, generatePrivateKey())
    expect(wrongKey!.check.ok).toBe(false)

    const changed = new Uint8Array(sealBytes(new Uint8Array([1, 2, 3]), ownerPublic))
    changed[changed.length - 1]! ^= 1
    expect(() => openSealedBytes(changed, ownerKey)).toThrow()
  })

  it("does not lose anything if the upload fails, and does not pay twice if the index does", async () => {
    recordFinishedCall(finished(), tool)
    const bee = fakeBee()
    const store = sealedSwarmStore(bee.swarm, ownerPublic)
    let uploads = 0
    let down = true
    const flaky: DiaryStore = {
      put: (b) => {
        if (down) return Promise.reject(new Error("no node"))
        uploads++
        return store.put(b)
      },
      get: store.get,
    }
    await expect(storeWaiting(target(), flaky, indexWriter, ownerPublic)).rejects.toThrow("no node")
    down = false
    let indexed = false
    const index: typeof indexWriter = async (agent, part) => {
      if (!indexed) {
        indexed = true
        throw new Error("no funds")
      }
      return indexWriter(agent, part)
    }
    await expect(storeWaiting(target(), flaky, index, ownerPublic)).rejects.toThrow("no funds")
    await storeWaiting(target(), flaky, index, ownerPublic)
    expect(uploads).toBe(1)
    expect(indexRows[0]!.storage).toBe(SEALED_ON_SWARM)
  })
})
