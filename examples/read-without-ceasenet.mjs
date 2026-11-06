// Reads CeaseNet's public recall list using only the official Arkiv SDK and none of CeaseNet's code. Everything it needs
// is in arkiv/schema.md, and this file is the proof.
//
//   node examples/read-without-ceasenet.mjs            every STOP, who signed it, and how many agents have obeyed it
//   node examples/read-without-ceasenet.mjs 0xOwner    only what that owner has signed, which is all their agents obey
import { createPublicClient } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { http } from "viem" // What the SDK is built on, and its own examples use.

const RPC = process.env.ARKIV_RPC || "https://rpc.rabdi.db-chain.testnet.arkiv.network/"
const owner = process.argv[2]
if (owner && !/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error(`${owner} is not an address.`)

// Once, and not for long: the public endpoint can ask for a wait of many minutes, and this should say so instead.
const client = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http(RPC, { retryCount: 0, timeout: 20_000 }) })

const ATTRIBUTES = { artifact: true, severity: true, recall: true, kind: true }

/** One page of one query, as a plain string. Every read that matters filters on `$creator`, which the chain sets and nobody can fake. */
async function query(text) {
  const { data } = await client.request({
    method: "arkiv_query",
    params: [`${text} ORDER BY $key:key ASC`, { select: { key: true, creator: true, attributes: ATTRIBUTES }, limit: "0x64" }],
  })
  return data.map((e) => ({ key: e.key, creator: e.creator, ...Object.fromEntries((e.attributes ?? []).map((a) => [a.name, a.value])) }))
}

try {
  const stops = await query(`arkiv.schema = str('ceasenet.recall') AND level = str('STOP')${owner ? ` AND $creator = addr(${owner})` : ""}`)
  console.log(`${stops.length} STOPs${owner ? ` signed by ${owner}` : ", from anyone. Each binds only the agents of the owner who signed it"}:\n`)

  if (stops.length > 0) {
    const anyOf = stops.map((s) => `recall = key(${s.key})`).join(" OR ")
    const [lifts, receipts] = await Promise.all([query(`arkiv.schema = str('ceasenet.lift') AND (${anyOf})`), query(`arkiv.schema = str('ceasenet.ack') AND (${anyOf})`)])
    for (const stop of stops) {
      // A lift counts only from the key that issued the STOP. A receipt is one agent's own record.
      const ended = lifts.some((l) => l.recall === stop.key && l.kind === "WITHDRAWN" && l.creator === stop.creator)
      const agents = new Set(receipts.filter((r) => r.recall === stop.key).map((r) => r.creator)).size
      console.log(`  ${stop.artifact.slice(0, 50).padEnd(50)} ${stop.severity.padEnd(8)} from ${stop.creator.slice(0, 10)}…  ${agents} agent${agents === 1 ? "" : "s"} obeyed${ended ? ", ended" : ""}`)
    }
  }
} catch (e) {
  // Only the short message, because a full one names the node's address, which can hold an access key.
  console.error(`Cannot read the list: ${e.shortMessage ?? e.message}${e.status === 429 ? " The node is asking us to slow down. Wait a while, or set ARKIV_RPC to another node." : ""}`)
  process.exitCode = 1
}
