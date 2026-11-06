import { eq } from "@arkiv-network/sdk/query"
import { addr } from "@arkiv-network/sdk/schema"
import { ADDRESSES, arkivPublicClient, readAcks, Recall, toRecallRow } from "@ceasenet/core"

// Reads CeaseNet's public records with no wallet, no key and no server of ours.
// Without an access key it uses Arkiv's public endpoint, which is rate limited but fine for this.
const client = arkivPublicClient(process.env.ARKIV_ACCESS_KEY ?? "")

const res: any = await client.select().from(Recall).where(eq("$creator", addr(ADDRESSES.maker))).limit(20).fetch()
const recalls = res.entities.map(toRecallRow)
console.log(`${recalls.length} recall(s) issued by the maker's key ${ADDRESSES.maker}, at block ${res.blockNumber}\n`)
for (const r of recalls) {
  const receipts = await readAcks(client, [r.key])
  console.log(`${r.level}  ${r.severity}  ${r.key}`)
  console.log(`  ${r.reason}`)
  console.log(`  file ${r.artifact}${r.pkg ? `, also ${r.pkg} ${r.versions}` : ""}`)
  console.log(`  receipts: ${receipts.map((a) => `${a.agent.slice(0, 8)} ${a.action}`).join(", ") || "none yet"}\n`)
}
