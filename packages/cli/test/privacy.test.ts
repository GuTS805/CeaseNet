import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentFingerprint, type ArkivWriter, type DiaryRow, type Hex, identityFiles, KEPT_BY_OWNER, type LoadedFile, type LoadoutRow, teamFile } from "@ceasenet/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type Config, initHome } from "../src/home"
import { readBack } from "../src/diaryService"
import { ArkivAgentNet, savePrivateLoadout, withPrivateLoadout } from "../src/ledger"

const AGENT = "0x00000000000000000000000000000000000000a1" as Hex
const OWNER = "0x00000000000000000000000000000000000000b2" as Hex
const tool: LoadedFile = { kind: "tool", name: "fetch-prices", version: "1.2.0", hash: "0x1111" }
const model: LoadedFile = { kind: "model", name: "some-model", version: "1", hash: "0x2222" }
const files = [tool, model, ...identityFiles(AGENT, OWNER), teamFile(OWNER)]

let dir: string
let previousHome: string | undefined
let config: Config
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ceasenet-privacy-"))
  previousHome = process.env.CEASENET_HOME
  process.env.CEASENET_HOME = dir
  config = initHome({ name: "Test", network: "arkiv", accessKey: "" }).config
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.CEASENET_HOME
  else process.env.CEASENET_HOME = previousHome
  rmSync(dir, { recursive: true, force: true })
})

/** Stands in for the chain: keeps whatever the agent would have published. */
const fakeWriter = () => {
  const published: { seq: bigint; files: LoadedFile[] }[] = []
  const writer = { address: AGENT, loadout: async (input: { seq: bigint; files: LoadedFile[] }) => void published.push(input) }
  return { writer: writer as unknown as ArkivWriter, published }
}

const publicRow = (seq: bigint, rowFiles: LoadedFile[]): LoadoutRow => ({
  key: "0xabc" as Hex,
  agent: AGENT,
  seq,
  files: rowFiles,
  fingerprint: agentFingerprint(rowFiles),
  creator: AGENT,
  createdAt: 1n,
})

describe("an agent kept private", () => {
  it("publishes who it is, and nothing it runs", async () => {
    const { writer, published } = fakeWriter()
    const kept: { seq: bigint; files: LoadedFile[] }[] = []
    const net = new ArkivAgentNet({} as never, OWNER, writer, 60, (seq, f) => void kept.push({ seq, files: f }))
    await net.writeLoadout(7n, files)
    expect(published).toHaveLength(1)
    expect(published[0]!.files.map((f) => f.kind).sort()).toEqual(["agent", "fleet", "team"])
    expect(JSON.stringify(published[0]!.files)).not.toContain("fetch-prices")
    expect(JSON.stringify(published[0]!.files)).not.toContain("some-model")
    expect(kept).toEqual([{ seq: 7n, files }])
  })

  it("publishes everything when its owner keeps it open", async () => {
    const { writer, published } = fakeWriter()
    const net = new ArkivAgentNet({} as never, OWNER, writer, 60)
    await net.writeLoadout(7n, files)
    expect(published[0]!.files).toEqual(files)
  })

  it("still shows its owner, on this machine, what it runs", () => {
    savePrivateLoadout(config, AGENT, 7n, files)
    const row = withPrivateLoadout(config, publicRow(7n, identityFiles(AGENT, OWNER)))
    expect(row!.files).toEqual(files)
    expect(row!.fingerprint).toBe(agentFingerprint(files))
  })

  it("never pairs what it kept with a different public record", () => {
    savePrivateLoadout(config, AGENT, 7n, files)
    const later = publicRow(8n, identityFiles(AGENT, OWNER))
    expect(withPrivateLoadout(config, later)).toBe(later)
  })

  it("leaves records alone when nothing was kept here", () => {
    const row = publicRow(3n, files)
    expect(withPrivateLoadout(config, row)).toBe(row)
    expect(withPrivateLoadout(config, undefined)).toBeUndefined()
  })
})

describe("a diary part kept on its owner's machine", () => {
  const row = { key: "0xabc", agent: AGENT, root: "0x01", head: "0x02", entries: 1n, firstSeq: 0n, lastSeq: 0n, storage: KEPT_BY_OWNER, creator: AGENT, createdAt: 1n } as unknown as DiaryRow
  const nothingHere = async (): Promise<Uint8Array> => {
    throw new Error("not on this machine")
  }

  it("is out of reach elsewhere, and is not reported as failing its check", async () => {
    const [part] = await readBack([row], nothingHere)
    expect(part!.locked).toBe(true)
    expect(part!.check.ok).toBe(true)
  })

  it("still fails its check when any other part cannot be read", async () => {
    const [part] = await readBack([{ ...row, storage: undefined }], nothingHere)
    expect(part!.check.ok).toBe(false)
  })
})
