import {
  ADDRESSES,
  arkivPublicClient,
  arkivWalletClient,
  ArkivWriter,
  demoPolicy,
  readAgents,
  readArtifacts,
  readTrustPolicy,
} from "@ceasenet/core"
import { catalog } from "../apps/demo/src/catalog"
import { accountFor, type Role } from "./roles"

// Sets up the demo on Arkiv: publishes the tools, registers each company's agent and publishes each trust list.
// It skips whatever is already there, so it is safe to run twice.
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const client = arkivPublicClient(accessKey)
const writer = (role: Role) => new ArkivWriter(arkivWalletClient(accountFor(role), accessKey))

const COMPANIES = [
  { owner: "ownerA", agent: "agentA", name: "Asha Exports office agent" },
  { owner: "ownerB", agent: "agentB", name: "Bandra Freight office agent" },
  { owner: "ownerC", agent: "agentC", name: "Coastal Foods office agent" },
] as const

const tools = catalog()
const published = new Set((await readArtifacts(client, [ADDRESSES.maker, ADDRESSES.publisher])).map((a) => a.hash.toLowerCase()))
const publish = async (who: Role, file: { kind: string; name: string; version: string; hash: string }) => {
  if (published.has(file.hash.toLowerCase())) return console.log(`${file.name} ${file.version} already published`)
  await writer(who).artifact(file)
  console.log(`published ${file.name} ${file.version} ${file.hash}`)
}
await publish("maker", tools.badMail.file)
await publish("maker", tools.fixedMail.file)
await publish("publisher", tools.files.file)

const owners = COMPANIES.map((c) => accountFor(c.owner).address)
const registered = new Set((await readAgents(client, owners)).map((a) => a.agent.toLowerCase()))
for (const c of COMPANIES) {
  const owner = writer(c.owner)
  const agent = accountFor(c.agent).address
  if (registered.has(agent.toLowerCase())) {
    console.log(`${c.name} already registered`)
  } else {
    await owner.agent({ agent, name: c.name, framework: "MCP", purpose: "Sends each customer their invoice." })
    console.log(`registered ${c.name}`)
  }
  if (await readTrustPolicy(client, owner.address)) {
    console.log(`${c.name}: trust list already published`)
  } else {
    await owner.trustList({ seq: BigInt(Date.now()), policy: demoPolicy() })
    console.log(`${c.name}: trust list published`)
  }
}
console.log("ready")
