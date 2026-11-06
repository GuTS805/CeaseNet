import { arkivPublicClient, readDiaryIndex, readWholeList } from "@ceasenet/core"

// Reads CeaseNet's public records with no wallet, no key and no server of ours.
// Without an access key it uses Arkiv's public endpoint, which is rate limited but fine for this.
const client = arkivPublicClient(process.env.ARKIV_ACCESS_KEY ?? "")
const short = (value: string) => `${value.slice(0, 10)}…`

const view = await readWholeList(client)
const stops = view.recalls.filter((r) => r.level === "STOP")
const reports = view.recalls.filter((r) => r.level === "ADVISORY")
console.log(`At block ${view.block}: ${stops.length} STOPs, ${reports.length} open reports, ${view.agents.length} agents, ${view.acks.length} receipts`)

console.log("\nSTOPs. Anyone can write one, so each says who did, and it binds only agents whose owner follows that key:")
for (const r of stops.slice(0, 10)) {
  const receipts = view.acks.filter((a) => a.recall === r.key && a.creator.toLowerCase() === a.agent.toLowerCase())
  const ended = view.lifts.some((l) => l.recall === r.key && l.creator.toLowerCase() === r.creator.toLowerCase())
  console.log(`  ${short(r.key)} from ${short(r.creator)}${ended ? " (ended)" : ""}, ${receipts.length} ${receipts.length === 1 ? "receipt" : "receipts"}: ${r.reason}`)
}

console.log("\nReports from people, checked by the verifier, with their votes:")
for (const r of reports.slice(0, 10)) {
  const votes = view.endorsements.filter((e) => e.recall === r.key && e.stance === "CONFIRM")
  const simulated = votes.filter((v) => v.human.startsWith("simulated-")).length
  console.log(`  ${short(r.key)} on ${r.artifact.slice(0, 18)}…, ${votes.length} votes${simulated ? ` (${simulated} simulated)` : ""}: ${r.reason}`)
}
if (reports.length === 0) console.log("  None open. A report lasts 72 hours unless people keep voting.")

console.log("\nAgents: who answers for each, what it is made of, and where its diary is:")
for (const entry of view.agents.slice(0, 10)) {
  const diary = await readDiaryIndex(client, entry.agent.agent, entry.agent.owner)
  const tools = entry.loadout?.files.filter((f) => f.kind === "tool").map((f) => `${f.name} ${f.version}`) ?? []
  console.log(`  ${entry.agent.name} ${short(entry.agent.agent)}, owner ${short(entry.agent.owner)}`)
  console.log(`    fingerprint ${entry.loadout?.fingerprint ? short(entry.loadout.fingerprint) : "not published"}, tools: ${tools.join(", ") || "none published"}`)
  if (diary[0]) console.log(`    diary: ${diary.length} ${diary.length === 1 ? "part" : "parts"} on 0G, the newest at ${diary[0].root}`)
}
process.exit(0)
