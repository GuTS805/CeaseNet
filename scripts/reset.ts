import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { asc, gt, startsWith } from "@arkiv-network/sdk/query"
import { key } from "@arkiv-network/sdk/schema"
import { arkivPublicClient, arkivWalletClient, type Hex } from "@ceasenet/core"
import { STATE_DIR } from "../apps/demo/src/store"
import { accountFor, ROLES } from "./roles"

// Clears rehearsals: deletes every CeaseNet record these demo wallets own, so a demo starts from nothing.
// Run `npm run seed` afterwards. It touches only wallets from this project's .env.
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const client = arkivPublicClient(accessKey)
const BATCH = 25

let total = 0
for (const role of ROLES) {
  if (role === "treasury") continue
  const account = accountFor(role)
  const wallet = arkivWalletClient(account, accessKey)
  const keys: Hex[] = []
  let after: Hex | undefined
  for (;;) {
    const page: any = await client
      .select({ $key: true })
      .where(startsWith("arkiv.schema", "ceasenet."), ...(after ? [gt("$key", key(after))] : []))
      .ownedBy(account.address)
      .orderBy(asc("$key", "key" as never))
      .limit(100)
      .fetch()
    keys.push(...page.entities.map((e: any) => e.$key as Hex))
    if (page.entities.length < 100) break
    after = page.entities[page.entities.length - 1].$key
  }
  let deleted = 0
  for (let i = 0; i < keys.length; i += BATCH) {
    const deletes = keys.slice(i, i + BATCH).map((entityKey) => ({ entityKey }))
    try {
      await wallet.executeBatch({ deletes })
      deleted += deletes.length
    } catch {
      // A record can expire between reading and deleting, which fails the batch. Go one at a time.
      for (const d of deletes) {
        await wallet.deleteEntity(d).then(
          () => deleted++,
          () => undefined,
        )
      }
    }
  }
  if (keys.length) console.log(role.padEnd(13), `deleted ${deleted} of ${keys.length}`)
  total += deleted
}
console.log(`deleted ${total} records in all`)

// Gate memory and the demo's sandbox folders go too, or a new run would remember the last one.
for (const name of existsSync(STATE_DIR) ? readdirSync(STATE_DIR) : []) {
  if (name.startsWith("gate-") || name === "sandbox") rmSync(join(STATE_DIR, name), { recursive: true, force: true })
}
console.log("cleared local demo state")
