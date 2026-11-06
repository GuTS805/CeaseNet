import { formatEther, keccak256, stringToHex } from "viem"
import {
  ArkivWriter,
  arkivPublicClient,
  arkivWalletClient,
  readAcks,
  readDiaries,
  readEndorsements,
  readGateView,
  readHeartbeat,
  readLatestLoadout,
  readLifts,
  readRecallsBy,
  readTrustPolicy,
  Recall,
  type TrustPolicy,
} from "@ceasenet/core"
import { accountFor, type Role } from "./roles"

// Checks, against the live testnet, every Arkiv behaviour the design relies on.
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const client = arkivPublicClient(accessKey)
const writer = (role: Role) => new ArkivWriter(arkivWalletClient(accountFor(role), accessKey))

// These wallets are separate from the demo's, so test records never show up on a demo agent's page.
const maker = writer("testMaker")
const outsider = writer("testOutsider")
const verifier = writer("testVerifier")
const agent = writer("testRobot")
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

const policy: TrustPolicy = { issuers: [maker.address], regulators: [], verifier: verifier.address, threshold: 3 }

const before = await client.getBalance({ address: maker.address })
const t0 = Date.now()
const LONG_REASON = "A long explanation that does not fit in a short text field. ".repeat(8)
const stop = await maker.stop({ artifact, severity: "HIGH", reason: LONG_REASON, advice: LONG_REASON })
console.log(`STOP written in ${Date.now() - t0} ms, key ${stop.entityKey}`)
console.log("cost of one record:", formatEther(before - (await client.getBalance({ address: maker.address }))), "tGLM")

const fake = await outsider.stop({ artifact, severity: "HIGH", reason: "fake" })

const view = await readGateView(client, undefined, policy)
check("a real STOP is found", view.stops.some((s) => s.key === stop.entityKey))
check("a fake STOP from a key nobody follows is not read at all", !view.stops.some((s) => s.key === fake.entityKey))
const real = view.stops.find((s) => s.key === stop.entityKey)
check("creator is the maker", real?.creator.toLowerCase() === maker.address.toLowerCase())
check("long text comes back intact", real?.reason === LONG_REASON && real?.advice === LONG_REASON)
check("creation block is readable", typeof real?.createdAt === "bigint" && real.createdAt > 0n, String(real?.createdAt))
check("a STOP lives about half a year", (real?.expiresAt ?? 0n) - view.block > 7_000_000n, String(real?.expiresAt))

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
const forged = await outsider.endorse({ recall: stop.entityKey, stance: "CONFIRM", human: "0xdef" })
const counted = await readEndorsements(client, [stop.entityKey], verifier.address)
check("a confirmation is found by the recall it answers", counted.some((e) => e.key === endorse.entityKey))
check("a forged confirmation is not read", !counted.some((e) => e.key === forged.entityKey))

const ack = await agent.ack({
  recall: stop.entityKey,
  recallHash: real?.contentHash ?? "",
  agent: agent.address,
  artifact,
  action: "BLOCKED",
  issuer: maker.address,
})
const acks = await readAcks(client, [stop.entityKey])
check("a receipt is readable by recall", acks.some((a) => a.key === ack.entityKey))

const lift = await maker.lift({ recall: stop.entityKey, artifact, kind: "FIX", fixedHash: artifact, fixedVersion: "2.0.0" })
const lifts = await readLifts(client, [stop.entityKey])
check("a fix is readable by the recall it ends", lifts.some((l) => l.key === lift.entityKey && l.fixedVersion === "2.0.0"))

const seq = BigInt(Date.now())
await agent.loadout({ seq, files: [{ kind: "tool", name: "p", version: "1", hash: artifact }] })
const manyFiles = ["tool", "skill", "prompt", "model"].map((kind) => ({ kind, name: "a-long-file-name", version: "2", hash: artifact }))
await agent.loadout({ seq: seq + 1n, files: manyFiles })
const latest = await readLatestLoadout(client, agent.address)
check("the latest loadout comes back first", latest?.seq === seq + 1n && latest.files.length === 4 && latest.files[0]?.version === "2")

const beat = await agent.createHeartbeat({ mode: "RUNNING", loadoutSeq: seq, ttlSeconds: 30 })
await agent.updateHeartbeat(beat.entityKey, { mode: "STOPPED", loadoutSeq: seq + 1n, ttlSeconds: 30 })
const hb = await readHeartbeat(client, agent.address)
check("a heartbeat updates in place", hb?.key === beat.entityKey && hb.mode === "STOPPED", hb?.mode)
let beatFailures = 0
for (let i = 0; i < 5; i++) {
  await agent
    .updateHeartbeat(beat.entityKey, { mode: i % 2 ? "RUNNING" : "STOPPED", loadoutSeq: seq + BigInt(i), ttlSeconds: 30 })
    .catch(() => beatFailures++)
  await agent.extendHeartbeat(beat.entityKey, 30).catch(() => beatFailures++)
}
check("repeated heartbeat writes never fail", beatFailures === 0, `${beatFailures} failed`)
const blockNow = await client.getBlockNumber({ cacheTime: 0 })
const hb2 = await readHeartbeat(client, agent.address)
check("an extension counts as an update", blockNow - (hb2?.updatedAt ?? 0n) <= 2n, `${blockNow - (hb2?.updatedAt ?? 0n)} blocks old`)

await maker.trustList({ seq: 1n, policy })
await maker.trustList({ seq: 2n, policy: { ...policy, threshold: 5 } })
check("the highest trust list wins", (await readTrustPolicy(client, maker.address))?.threshold === 5)

await agent.diary({ root: "0x01", head: "0x02", entries: 3n, firstSeq: 0n, lastSeq: 2n })
const diaries = await readDiaries(client, agent.address)
check("a diary part is found by its agent", diaries.some((d) => d.root === "0x01" && d.entries === 3n))

const beforeDelete = await readRecallsBy(client, [maker.address])
await maker.deleteRecord(stop.entityKey)
const afterDelete = await readRecallsBy(client, [maker.address])
check(
  "the owner can delete its own STOP, which is why gates must remember what they saw",
  beforeDelete.rows.some((r) => r.key === stop.entityKey) && !afterDelete.rows.some((r) => r.key === stop.entityKey),
)
check("receipts outlive the STOP they answer", (await readAcks(client, [stop.entityKey])).some((a) => a.key === ack.entityKey))

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks FAILED.`)
process.exit(failures === 0 ? 0 : 1)
