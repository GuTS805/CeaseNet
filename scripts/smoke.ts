import { formatEther, keccak256, stringToHex } from "viem"
import {
  ArkivWriter,
  arkivPublicClient,
  arkivWalletClient,
  CONFIRMATION_WINDOW_BLOCKS,
  makeTrust,
  readAcks,
  readGateView,
  readHeartbeat,
  readLatestLoadout,
  readRecalls,
  Recall,
} from "@ceasenet/core"
import { accountFor, type Role } from "./roles"

// Checks, against the live testnet, every Arkiv behaviour the design relies on.
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const client = arkivPublicClient(accessKey)
const writer = (role: Role) => new ArkivWriter(arkivWalletClient(accountFor(role), accessKey))

// These wallets are separate from the demo's, so test records never show up on a demo robot's plate.
const maker = writer("testMaker")
const outsider = writer("testOutsider")
const verifier = writer("testVerifier")
const robot = writer("testRobot")
const artifact = keccak256(stringToHex(`smoke-${Date.now()}`))

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const refuses = async (name: string, attempt: () => Promise<unknown>) => {
  try {
    await attempt()
    check(name, false, "the chain allowed it")
  } catch (e) {
    check(name, true, (e as Error).message.split("\n")[0]?.slice(0, 80))
  }
}

const trust = makeTrust({
  stopKeys: [maker.address],
  regulators: [],
  verifier: verifier.address,
  threshold: 3,
  windowBlocks: CONFIRMATION_WINDOW_BLOCKS,
})

const before = await client.getBalance({ address: maker.address })
const t0 = Date.now()
const LONG_REASON = "A long explanation that does not fit in a short text field. ".repeat(8)
const stop = await maker.stop({ artifact, severity: "HIGH", reason: LONG_REASON, advice: LONG_REASON })
console.log(`STOP written in ${Date.now() - t0} ms, key ${stop.entityKey}`)
console.log("cost of one record:", formatEther(before - (await client.getBalance({ address: maker.address }))), "tGLM")

const fake = await outsider.stop({ artifact, severity: "HIGH", reason: "fake" })

const view = await readGateView(client, [artifact], trust)
check("a real STOP is found", view.stops.some((s) => s.key === stop.entityKey))
check("a fake STOP is filtered out by the query", !view.stops.some((s) => s.key === fake.entityKey))
const real = view.stops.find((s) => s.key === stop.entityKey)
check("creator is the maker", real?.creator.toLowerCase() === maker.address.toLowerCase())
check("long text comes back intact", real?.reason === LONG_REASON && real?.advice === LONG_REASON)
check("creation block is readable", typeof real?.createdAt === "bigint" && real.createdAt > 0n, String(real?.createdAt))
check("STOP lives about half a year", (real?.expiresAt ?? 0n) - view.block > 7_000_000n, String(real?.expiresAt))

await refuses("nobody can edit a read-only STOP, not even its owner", () =>
  maker.wallet.patchEntity(Recall, stop.entityKey, { set: { severity: "LOW" } }),
)
await refuses("an outsider cannot delete a STOP", () => outsider.deleteRecord(stop.entityKey))

try {
  await outsider.extendRecall(stop.entityKey)
  check("anyone can extend a STOP", true)
} catch (e) {
  check("anyone can extend a STOP", false, (e as Error).message.split("\n")[0])
}

const endorse = await verifier.endorse({ recall: stop.entityKey, stance: "CONFIRM", human: "0xabc" })
await refuses("an outsider cannot extend a confirmation", () => outsider.extendAdvisory(endorse.entityKey))

const ack = await robot.ack({
  recall: stop.entityKey,
  recallHash: real?.contentHash ?? "",
  robot: robot.address,
  artifact,
  action: "STOPPED",
  issuer: maker.address,
})
const acks = await readAcks(client, [stop.entityKey])
check("receipt is readable by recall", acks.some((a) => a.key === ack.entityKey))

const seq = BigInt(Date.now())
await robot.loadout({ seq, files: [{ kind: "policy", name: "p", version: "1", hash: artifact }] })
const manyFiles = ["policy", "firmware", "prompt", "model"].map((kind) => ({ kind, name: "a-long-file-name", version: "2", hash: artifact }))
await robot.loadout({ seq: seq + 1n, files: manyFiles })
const latest = await readLatestLoadout(client, robot.address)
check("latest loadout comes back first", latest?.seq === seq + 1n && latest.files.length === 4 && latest.files[0]?.version === "2")

const beat = await robot.createHeartbeat({ mode: "RUNNING", loadoutSeq: seq, ttlSeconds: 30 })
await robot.updateHeartbeat(beat.entityKey, { mode: "STOPPED", loadoutSeq: seq + 1n, ttlSeconds: 30 })
const hb = await readHeartbeat(client, robot.address)
check("heartbeat updates in place", hb?.key === beat.entityKey && hb.mode === "STOPPED", hb?.mode)
let beatFailures = 0
for (let i = 0; i < 5; i++) {
  await robot
    .updateHeartbeat(beat.entityKey, { mode: i % 2 ? "RUNNING" : "STOPPED", loadoutSeq: seq + BigInt(i), ttlSeconds: 30 })
    .catch(() => beatFailures++)
  await robot.extendHeartbeat(beat.entityKey, 30).catch(() => beatFailures++)
}
check("repeated heartbeat writes never fail", beatFailures === 0, `${beatFailures} failed`)
const blockNow = await client.getBlockNumber({ cacheTime: 0 })
const hb2 = await readHeartbeat(client, robot.address)
check("an extension counts as an update", blockNow - (hb2?.updatedAt ?? 0n) <= 2n, `${blockNow - (hb2?.updatedAt ?? 0n)} blocks old`)

const custody = await maker.custody({ robot: robot.address, operator: "A", contact: "a@example.com" })
await maker.transfer(custody.entityKey, outsider.address)
await refuses("the old owner can no longer edit custody", () =>
  maker.updateCustody(custody.entityKey, { operator: "X", contact: "x" }),
)
await outsider.updateCustody(custody.entityKey, { operator: "B", contact: "b@example.com" })
const entity = await client.getEntity(custody.entityKey)
check(
  "custody keeps its creator after transfer",
  entity.$creator?.toLowerCase() === maker.address.toLowerCase() && entity.$owner?.toLowerCase() === outsider.address.toLowerCase(),
)

await maker.deleteRecord(stop.entityKey)
const gone = await readRecalls(client, [artifact], [maker.address])
check("the owner can delete its own STOP, which is why gates must remember", gone.rows.length === 0)

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks FAILED.`)
process.exitCode = failures === 0 ? 0 : 1
