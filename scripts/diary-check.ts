import { type DiaryEntry, DIARY_START, decodePart, Diary, verifyPart } from "@ceasenet/guard"
import { toHex } from "viem"
import { fetchFromZeroG, ZeroGStore } from "../apps/demo/src/zeroG"
import { accountFor } from "./roles"

// Checks the diary on the live 0G Storage network: stores a real part, reads it back over plain HTTP with no
// wallet, and checks it against the head that would be pinned on Arkiv. It pins nothing on Arkiv itself.
const store = new ZeroGStore(toHex(accountFor("treasury").getHdKey().privateKey!))

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}

let pinned: { root: string; head: string; entries: bigint } | undefined
const diary = new Diary(store, {
  diary: async (input) => {
    pinned = input
  },
})

const nonce = Date.now()
diary.append({
  kind: "CALL",
  tool: "demo-mail-tool",
  version: "1.0.16",
  hash: "0x957d",
  action: "send_email",
  argsHash: "0xabc",
  verdict: "ALLOW",
  allowed: true,
  requestId: `check-${nonce}`,
  model: "glm-5.2",
})
diary.append({ kind: "RECEIPT", recall: "0x01", action: "BLOCKED" })
diary.append({
  kind: "CALL",
  tool: "demo-mail-tool",
  version: "1.0.16",
  hash: "0x957d",
  action: "send_email",
  argsHash: "0xdef",
  verdict: "BLOCK",
  allowed: false,
  requestId: `check-${nonce + 1}`,
  model: "glm-5.2",
})

let t0 = Date.now()
await diary.flush()
check("a diary part reaches 0G Storage", diary.lastError === undefined && pinned !== undefined, diary.lastError ?? `${((Date.now() - t0) / 1000).toFixed(1)} s, root ${pinned?.root}`)

if (pinned) {
  t0 = Date.now()
  let entries: DiaryEntry[] | undefined
  let lastProblem = ""
  while (Date.now() - t0 < 180_000 && !entries) {
    try {
      entries = decodePart(await fetchFromZeroG(pinned.root))
    } catch (e) {
      lastProblem = (e as Error).message
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  check("it can be read back over plain HTTP, with no wallet", Boolean(entries), entries ? `${((Date.now() - t0) / 1000).toFixed(1)} s` : lastProblem)
  if (entries) {
    check("the entries match the hash that would be pinned on Arkiv", verifyPart(entries, pinned.head, DIARY_START).ok, `${entries.length} entries`)
    check("the model request IDs survive", entries.some((e) => e.kind === "CALL" && e.requestId === `check-${nonce}`))
    const changed = entries.map((e) => (e.seq === 0 ? ({ ...e, at: e.at + 1 } as DiaryEntry) : e))
    check("a changed copy fails the check", !verifyPart(changed, pinned.head).ok)
    check("a shortened copy fails the check", !verifyPart(entries.slice(0, 2), pinned.head).ok)
  }
}

console.log(failures === 0 ? "\nall good" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
