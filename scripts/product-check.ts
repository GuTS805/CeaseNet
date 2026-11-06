import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { asc, startsWith } from "@arkiv-network/sdk/query"
import { arkivPublicClient, arkivWalletClient, buildRecallBoard, fetchNpmPackage, followersOf, type Hex, readNetworkView } from "@ceasenet/core"
import { agentAddress, loadIdentity, measurePackage } from "@ceasenet/guard"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { parseEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { accountFor } from "./roles"

// The whole product, the way a stranger would use it, on the live testnet, with no demo key anywhere:
//
//   Someone runs an MCP server behind `ceasenet`, and a standard MCP client talks to it.
//   A stranger's recall changes nothing. The recall from the key the owner chose stops the tool.
//   The receipt lands on Arkiv, a fix is published, and the tool moves to it with the client still connected.
//
// By default the tool is this repository's own, so nothing from outside gets run.
// With --npm the tool is a real package, @modelcontextprotocol/server-filesystem, downloaded from npm and run on this
// machine with its install scripts off. That is a choice to make for yourself.
//
// New keys are made for each run. The treasury only pays their gas. Run with --keep to leave the records on Arkiv.
const useNpm = process.argv.includes("--npm")
const keep = process.argv.includes("--keep")
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const client = arkivPublicClient(accessKey)
const CLI = resolve("packages", "guard", "src", "cli.ts")

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Inside the repository, so this repository's own tools can find their dependencies. Git ignores this folder.
mkdirSync(".ceasenet", { recursive: true })
const root = resolve(mkdtempSync(join(".ceasenet", "product-check-")))
const home = (who: string) => join(root, who)
const ceasenet = (who: string, ...args: string[]) => {
  const res = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CEASENET_HOME: home(who) },
    timeout: 180_000,
  })
  return { ok: res.status === 0, out: `${res.stdout}${res.stderr}`, status: res.status }
}
const must = (who: string, ...args: string[]) => {
  const res = ceasenet(who, ...args)
  if (!res.ok) throw new Error(`ceasenet ${args.join(" ")} failed: ${res.out}`)
  return res.out
}

async function fund(address: Hex, amount: string): Promise<void> {
  const treasury = arkivWalletClient(accountFor("treasury"), accessKey)
  const hash = await treasury.sendTransaction({ to: address, value: parseEther(amount) })
  await client.waitForTransactionReceipt({ hash })
}

/** Puts one of this repository's tools where `ceasenet` keeps installed tools, as if it had been installed. */
function placeOwnTool(version: string): string {
  const dir = join(home("agent"), "tools", `demo-mail-tool@${version}`, "node_modules", "demo-mail-tool")
  cpSync(join("tools", `demo-mail-tool-${version}`), dir, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...manifest, bin: { "demo-mail-tool": "server.mjs" } }))
  return dir
}

async function latestTwoVersions(name: string): Promise<[string, string]> {
  const meta = (await (await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`)).json()) as { versions: Record<string, unknown>; "dist-tags": { latest: string } }
  const latest = meta["dist-tags"].latest
  const versions = Object.keys(meta.versions)
  const older = versions[versions.indexOf(latest) - 1]
  if (!older) throw new Error(`${name} has no version before ${latest}`)
  return [older, latest]
}

const PACKAGE = useNpm ? "@modelcontextprotocol/server-filesystem" : "demo-mail-tool"
const [older, latest] = useNpm ? await latestTwoVersions(PACKAGE) : ["1.0.16", "1.0.17"]
console.log(`tool: ${PACKAGE}, running ${older}, with ${latest} as the fix${useNpm ? ", from npm" : ", this repository's own"}\n`)

// Three people who have never met, each with their own new keys.
for (const who of ["agent", "maker", "stranger"]) must(who, "init", "--name", `Product check ${who}`)
const identityOf = (who: string) => loadIdentity(home(who))!
const owner = identityOf("agent").ownerAddress
const maker = identityOf("maker").ownerAddress
const stranger = identityOf("stranger").ownerAddress
const demoKeys = (["maker", "regulator", "publisher", "verifier", "outsider", "ownerA", "ownerB", "ownerC"] as const).map((r) => accountFor(r).address.toLowerCase())
check("no demo key is involved", ![owner, maker, stranger].some((a) => demoKeys.includes(a.toLowerCase())))
check("each person has their own keys", identityOf("maker").agentKey !== identityOf("agent").agentKey)
const initOut = must("agent", "init")
check("init does not print a key", !initOut.includes(identityOf("agent").agentKey.slice(2)) && !initOut.includes(identityOf("agent").ownerKey!.slice(2)))

await fund(owner, "0.03")
await fund(maker, "0.01")
await fund(stranger, "0.01")

check("the owner follows the maker's key", must("agent", "follow", maker).includes("Following"))
const registered = must("agent", "register")
check("the agent's passport and trust list go on Arkiv", registered.includes("Passport published") && registered.includes("Sent the agent"))
console.log(must("agent", "status").replace(/^/gm, "     "))

const oldDir = useNpm ? undefined : placeOwnTool(older)
const newDir = useNpm ? undefined : placeOwnTool(latest)
const shared = join(root, "shared")
mkdirSync(shared)
writeFileSync(join(shared, "hello.txt"), "real file")

const added = must("agent", "add", `${PACKAGE}@${older}`)
const expectedHash = useNpm ? (await fetchNpmPackage({ name: PACKAGE, version: older })).file.hash : measurePackage(oldDir!).hash
check("it reports the exact version it measured", added.includes(`${PACKAGE}@${older}`) && added.includes(expectedHash), expectedHash)

const settings = JSON.parse(added.slice(added.indexOf("{"))) as { mcpServers: Record<string, { command: string; args: string[] }> }
const server = Object.values(settings.mcpServers)[0]!
check("the settings it prints use absolute paths", server.args.some((a) => a.startsWith("file:")) && resolve(server.args[2]!) === server.args[2]!)

// A standard MCP client, started from those settings and from another folder. It knows nothing about CeaseNet.
const mcp = new Client({ name: "any-mcp-client", version: "1.0.0" })
const logs: string[] = []
const transport = new StdioClientTransport({
  command: server.command,
  args: [...server.args, "--fast", "--auto-fix", ...(useNpm ? ["--", shared] : [])],
  cwd: shared,
  stderr: "pipe",
  env: { ...(process.env as Record<string, string>), CEASENET_HOME: home("agent"), ARKIV_ACCESS_KEY: accessKey, DEMO_SANDBOX: shared, DEMO_COMPANY: "Product check" },
})
transport.stderr?.on("data", (d) => logs.push(String(d)))
await mcp.connect(transport)

type Reply = { isError?: boolean; content: { text: string }[] }
const callName = useNpm ? "list_directory" : "send_email"
const useTool = () =>
  mcp.callTool({ name: callName, arguments: useNpm ? { path: shared } : { to: "someone@example.com", subject: "Invoice", body: "Attached" } }) as Promise<Reply>
const worked = (r: Reply) => !r.isError && r.content[0]!.text.includes(useNpm ? "hello.txt" : "Email sent")
const stolen = () => {
  const path = join(shared, "attacker-inbox.jsonl")
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0
}

const { tools } = await mcp.listTools()
check("the client sees the tool's functions", tools.some((t) => t.name === callName), `${tools.length} of them`)
const first = await useTool()
check("a real call does real work", worked(first), first.content[0]!.text.slice(0, 40))

// Anyone can write to Arkiv. That must change nothing here.
const measured = oldDir ?? `${PACKAGE}@${older}`
must("stranger", "recall", measured, "--reason", "A stranger says so")
await wait(6000)
check("a recall from a stranger changes nothing", worked(await useTool()))

const pressed = Date.now()
const recallOut = must("maker", "recall", measured, "--reason", "Product check: this version must not run", "--advice", "Move to the published fix")
const recallKey = recallOut.match(/Key\s+(0x[0-9a-f]+)/)?.[1] as Hex
check("the maker's STOP goes on Arkiv", Boolean(recallKey), recallKey)

let refused: Reply | undefined
for (let i = 0; i < 60 && !refused; i++) {
  const r = await useTool()
  if (r.isError) refused = r
  else await wait(500)
}
check("the tool is refused", Boolean(refused), `${((Date.now() - pressed) / 1000).toFixed(1)} s after pressing`)
check("the client is told why, in words a model can act on", refused?.content[0]?.text.includes("must not run") ?? false, refused?.content[0]?.text.slice(0, 90))
const stolenAtStop = stolen()
await useTool()
check("a refused call does not reach the tool", stolen() === stolenAtStop, useNpm ? "" : `${stolenAtStop} copies, unchanged`)

let view = await readNetworkView(client)
for (let i = 0; i < 40 && !view.acks.some((a) => a.recall === recallKey && a.action === "BLOCKED"); i++) {
  await wait(1500)
  view = await readNetworkView(client)
}
const agent = agentAddress(identityOf("agent")).toLowerCase()
const mine = view.agents.find((a) => a.agent.agent.toLowerCase() === agent)
check("anyone can find the agent on Arkiv with no list of keys", Boolean(mine), mine?.agent.name)
check("the record shows the tool it really runs", mine?.loadout?.files.some((f) => f.name === PACKAGE && f.version === older) ?? false)
check("its heartbeat is live", Boolean(mine?.heartbeat), mine?.heartbeat?.mode)
const recall = view.recalls.find((r) => r.key === recallKey)!
check("the receipt is on Arkiv, from the agent's own key", view.acks.some((a) => a.recall === recallKey && a.action === "BLOCKED" && a.creator.toLowerCase() === agent))
check("the board says it obeyed, from public records alone", buildRecallBoard(recall, view.agents, view.acks).obeyed >= 1)
check("one owner follows the maker", followersOf(recall, view.agents) >= 1)
const strangers = view.recalls.find((r) => r.creator.toLowerCase() === stranger.toLowerCase())
check("nobody follows the stranger, and the record shows that", strangers !== undefined && followersOf(strangers, view.agents) === 0)

const checked = ceasenet("agent", "check", measured)
check("ceasenet check reports both, with an exit code a script can use", checked.status === 1 && checked.out.includes("you follow this key") && checked.out.includes("you do not follow this key"))
const newer = newDir ?? `${PACKAGE}@${latest}`
check("the fixed version is not recalled", ceasenet("agent", "check", newer).out.includes("Nothing on Arkiv covers"))

must("maker", "fix", recallKey, newer)
let fixed = false
const fixPressed = Date.now()
for (let i = 0; i < 120 && !fixed; i++) {
  fixed = worked(await useTool())
  if (!fixed) await wait(1000)
}
check("the tool moves to the fix with the client still connected", fixed, `${((Date.now() - fixPressed) / 1000).toFixed(1)} s`)
check("it says what it did", logs.join("").includes(`moved from ${older} to ${latest}`))
const { tools: after } = await mcp.listTools()
check("the same client still sees the tool's functions", after.some((t) => t.name === callName))
if (!useNpm) {
  const before = stolen()
  check("the fix really is different: its emails work and no copy is taken", worked(await useTool()) && stolen() === before, `${before} copies, unchanged`)
}

for (let i = 0; i < 30 && !view.acks.some((a) => a.recall === recallKey && a.action === "UPDATED"); i++) {
  await wait(1500)
  view = await readNetworkView(client)
}
check("the UPDATED receipt is on Arkiv", view.acks.some((a) => a.recall === recallKey && a.action === "UPDATED"))
const moved = view.agents.find((a) => a.agent.agent.toLowerCase() === agent)
check("the record now shows the fixed version", moved?.loadout?.files.some((f) => f.version === latest) ?? false)
const row = buildRecallBoard(recall, view.agents, view.acks).rows.find((r) => r.agent.agent.toLowerCase() === agent)
check("the board says fixed", row?.state === "FIXED", row?.state)

await mcp.close()

if (!keep) {
  for (const k of [identityOf("agent").agentKey, identityOf("agent").ownerKey!, identityOf("maker").ownerKey!, identityOf("stranger").ownerKey!]) {
    const account = privateKeyToAccount(k)
    const wallet = arkivWalletClient(account, accessKey)
    const page: any = await client.select({ $key: true }).where(startsWith("arkiv.schema", "ceasenet.")).ownedBy(account.address).orderBy(asc("$key", "key" as never)).limit(100).fetch()
    for (const e of page.entities) await wallet.deleteEntity({ entityKey: e.$key }).catch(() => undefined)
  }
  console.log("\nremoved this run's records from Arkiv. Use --keep to leave them")
}
await wait(500)
try {
  rmSync(root, { recursive: true, force: true })
} catch {
  // Windows can hold a folder briefly after a process ends. Git ignores it, and reset clears nothing it needs.
}
console.log(failures === 0 ? "\nall good" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
