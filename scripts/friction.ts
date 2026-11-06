import { ExpirationTime } from "@arkiv-network/sdk"
import { gt } from "@arkiv-network/sdk/query"
import { u64 } from "@arkiv-network/sdk/schema"
import { createWalletClient } from "@arkiv-network/sdk"
import { http, keccak256, stringToBytes, stringToHex } from "viem"
import { arkivChain, arkivPublicClient, arkivWalletClient, ArkivWriter, Heartbeat, Recall } from "@ceasenet/core"
import { accountFor } from "./roles"

// Reproduces, on the live testnet, each item in arkiv/friction.md and prints what actually happens.
// It uses its own test wallets, so nothing here shows up in the demo.
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const client = arkivPublicClient(accessKey)
const account = accountFor("testMaker")
const wallet = arkivWalletClient(account, accessKey)
const writer = new ArkivWriter(wallet)
const artifact = keccak256(stringToHex(`friction-${Date.now()}`))

const firstLine = (e: unknown) => (e as Error).message.split("\n")[0]?.slice(0, 400)
const attempt = async (name: string, run: () => Promise<unknown>) => {
  try {
    const value = await run()
    console.log(`[${name}]\n  allowed${value === undefined ? "" : `: ${String(value)}`}`)
  } catch (e) {
    console.log(`[${name}]\n  refused: ${firstLine(e)}`)
  }
}

const textFields = { artifact, level: "STOP", severity: "HIGH", reason: stringToBytes("x"), contentHash: "0x01" }

await attempt("1. a 129-byte value in a str column", () =>
  wallet.createEntity(Recall, { ...textFields, severity: "x".repeat(129) } as any, { expiration: ExpirationTime.fromMinutes(5) }),
)

await attempt("2. a query with no filter", () => (client.select() as any).limit(1).fetch())

await attempt("3. filtering on $createdAt, which every row has", () => (client.select().from(Recall) as any).where(gt("$createdAt", u64(1n))).limit(1).fetch())

await attempt("4. an expiry beyond the maximum", () =>
  wallet.createEntity(Recall, textFields as any, { expiration: ExpirationTime.fromDays(400), flags: { readonly: true } }),
)

const { entityKey: readOnly } = await wallet.createEntity(Recall, textFields as any, {
  expiration: ExpirationTime.fromMinutes(5),
  flags: { readonly: true },
})
await attempt("5a. the owner editing a read-only entity", () => wallet.patchEntity(Recall, readOnly, { set: { severity: "LOW" } }))
await attempt("5b. the owner deleting that same read-only entity", async () => {
  await wallet.deleteEntity({ entityKey: readOnly })
  return "gone"
})

const beat = await writer.createHeartbeat({ mode: "RUNNING", loadoutSeq: 1n, ttlSeconds: 60 })
await attempt("6. one patch and one extension in a batch, with the gas the client estimates", () =>
  wallet.executeBatch({
    patches: [{ schema: Heartbeat, entityKey: beat.entityKey, set: { mode: "STOPPED", loadoutSeq: u64(2n) } }],
    extensions: [{ entityKey: beat.entityKey, expiration: ExpirationTime.fromSeconds(60) }],
  } as any),
)

const a = await wallet.createEntity(Recall, textFields as any, { expiration: ExpirationTime.fromMinutes(5) })
const b = await wallet.createEntity(Recall, textFields as any, { expiration: ExpirationTime.fromMinutes(5) })
await wallet.deleteEntity({ entityKey: a.entityKey })
await attempt("7. deleting two entities in a batch when one is already gone", () =>
  wallet.executeBatch({ deletes: [{ entityKey: a.entityKey }, { entityKey: b.entityKey }] }),
)
await attempt("7b. was the one that still existed deleted?", async () => {
  const left: any = await client.getEntity(b.entityKey).catch(() => undefined)
  return left ? "no, the whole batch failed" : "yes"
})

// Two writes at once from one key.
const [first, second] = await Promise.allSettled([
  wallet.createEntity(Recall, textFields as any, { expiration: ExpirationTime.fromMinutes(5) }),
  wallet.createEntity(Recall, textFields as any, { expiration: ExpirationTime.fromMinutes(5) }),
])
console.log(`[8. two writes at once from one key]\n  ${first.status}, ${second.status}${second.status === "rejected" ? `: ${firstLine(second.reason)}` : ""}`)

const timeWrite = async (w: typeof wallet) => {
  const t0 = Date.now()
  await w.createEntity(Recall, textFields as any, { expiration: ExpirationTime.fromMinutes(5) })
  return Date.now() - t0
}
const defaults = createWalletClient({ chain: arkivChain(accessKey), transport: http(), account })
const times = { defaults: [] as number[], tuned: [] as number[] }
for (let i = 0; i < 3; i++) {
  times.defaults.push(await timeWrite(defaults as typeof wallet))
  times.tuned.push(await timeWrite(wallet))
}
console.log(`[9. confirming a write on a chain with 2 second blocks]\n  default polling: ${times.defaults.join(", ")} ms\n  polling every 500 ms: ${times.tuned.join(", ")} ms`)

process.exitCode = 0
