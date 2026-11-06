#!/usr/bin/env node
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ARKIV_EXPLORER,
  arkivPublicClient,
  arkivWalletClient,
  ArkivWriter,
  DEMO_TIMERS,
  fetchNpmPackage,
  type Hex,
  isWithdrawn,
  type LoadedFile,
  type PackageSpec,
  parseSpec,
  PRODUCTION_TIMERS,
  readAgent,
  readEveryRecall,
  readLifts,
  readTrustPolicy,
  recallCovers,
  trustFromPolicy,
} from "@ceasenet/core"
import { formatEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { agentPassFromEnv, approverFromPass, fileLinks } from "./agentPass"
import { agentAddress, changeFollowing, createIdentity, homeDir, type Identity, isAddress, loadIdentity, policyFor, saveIdentity } from "./identity"
import { measurePackage } from "./measure"
import { runGuarded } from "./runGuarded"
import { chooseBin, installTool } from "./tools"

const FAUCET = "https://hub.arkiv.network/faucet"
/** Enough for a good many heartbeats. Below this an agent is treated as unfunded and only reads the list. */
const MIN_AGENT_BALANCE = 2_000_000_000_000_000n
const FIX_CHECK_MS = 3_000

const HELP = `ceasenet: recalls for AI agents

  ceasenet init [--name "My agent"] [--owner 0xWallet] [--access-key KEY]
                                       Creates this agent's keys. --owner means the owner signs on the website with a wallet
  ceasenet register                    Publishes the agent's passport and whom it follows. Needs tGLM on the owner key
  ceasenet follow <0xAddress>          Obey this key's STOPs
  ceasenet unfollow <0xAddress>        Stop obeying this key
  ceasenet add <package[@version]> [--bin NAME] [-- tool args]
                                       Installs one exact version with scripts off, measures it, prints the MCP client settings
  ceasenet run <package@version> [--bin NAME] [--fast] [--read-only] [--auto-fix] [-- tool args]
                                       Runs the tool behind the gate. This is what an MCP client starts
  ceasenet check <package[@version]>   Is this version recalled, and by whom? Also takes a folder, such as ./build
  ceasenet recall <package@version or folder> --reason "..." [--severity CRITICAL] [--versions ">=1.0.0 <1.1.0"] [--advice "..."]
                                       Issues a STOP, signed by the owner key. It binds only those who follow that key
  ceasenet fix <recallKey> <package@version or folder>
                                       Publishes the exact fixed version for your STOP
  ceasenet status                      This agent's keys, balances and what is on the record

  --fast checks every 2 seconds instead of every 30, for trying things out.
  --auto-fix moves to a fix on its own. It means a key you follow can choose the code you run, so it is off unless you ask.`

const VALUE_FLAGS = new Set(["--name", "--owner", "--access-key", "--bin", "--reason", "--severity", "--versions", "--advice"])

/** Splits a command line into words, --flags, and whatever comes after a bare --. */
export function parseArgs(argv: readonly string[]) {
  const split = argv.indexOf("--")
  const before = split === -1 ? argv : argv.slice(0, split)
  const words: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < before.length; i++) {
    const word = before[i]!
    if (!word.startsWith("--")) {
      words.push(word)
      continue
    }
    if (!VALUE_FLAGS.has(word)) {
      flags.set(word, true)
      continue
    }
    const value = before[++i]
    if (value === undefined) throw new Error(`${word} needs a value`)
    flags.set(word, value)
  }
  return { words, flags, rest: split === -1 ? [] : argv.slice(split + 1) }
}

const needIdentity = (home: string): Identity => {
  const identity = loadIdentity(home)
  if (!identity) throw new Error("No keys here yet. Run: ceasenet init")
  return identity
}

const accessKeyOf = (identity?: Identity) => process.env.ARKIV_ACCESS_KEY || identity?.accessKey || ""
const reader = (identity?: Identity) => arkivPublicClient(accessKeyOf(identity))

function ownerWriter(identity: Identity): ArkivWriter {
  if (!identity.ownerKey) throw new Error(`The owner key is your wallet ${identity.ownerAddress}, not on this machine. Do this on the website instead.`)
  return new ArkivWriter(arkivWalletClient(privateKeyToAccount(identity.ownerKey), accessKeyOf(identity)))
}

const say = (line = "") => console.log(line)
const entityLink = (key: string) => `${ARKIV_EXPLORER}/entity/${key}`

function needVersion(spec: PackageSpec): PackageSpec & { version: string } {
  if (!spec.version) throw new Error(`Say which version: ${spec.name}@1.2.3`)
  return spec as PackageSpec & { version: string }
}

/** The settings an MCP client needs. Absolute paths, because a client starts this from a folder of its own choosing. */
export function clientSettings(toolName: string, spec: string, bin: string | undefined, toolArgs: readonly string[], paths: { node: string; loader: string; cli: string }) {
  return {
    mcpServers: {
      [toolName]: {
        command: paths.node,
        args: ["--import", paths.loader, paths.cli, "run", spec, ...(bin ? ["--bin", bin] : []), ...(toolArgs.length ? ["--", ...toolArgs] : [])],
      },
    },
  }
}

export const isFolder = (subject: string) => /^(\.{1,2}[\\/]|[\\/]|[a-zA-Z]:[\\/])/.test(subject)

/** Measures what a command is about: a version on npm, or a folder on this machine. Neither is run. */
async function measureSubject(subject: string | undefined, versionNeeded: boolean): Promise<LoadedFile> {
  if (subject && isFolder(subject)) return measurePackage(subject)
  const spec = parseSpec(subject ?? "")
  return (await fetchNpmPackage(versionNeeded ? needVersion(spec) : spec)).file
}

const commands: Record<string, (a: ReturnType<typeof parseArgs>, home: string) => Promise<void>> = {
  async init({ flags }, home) {
    const { identity, created } = createIdentity(
      { name: String(flags.get("--name") ?? "My agent"), owner: flags.get("--owner") as string | undefined, accessKey: flags.get("--access-key") as string | undefined },
      home,
    )
    say(created ? `Created keys in ${home}. They are not shown, and this file should stay private.` : `Keys already exist in ${home}. Keeping them.`)
    say(`Agent  ${agentAddress(identity)}`)
    say(`Owner  ${identity.ownerAddress}${identity.ownerKey ? "" : " (your wallet)"}`)
    say()
    say(`Next: claim free tGLM for the ${identity.ownerKey ? "owner" : "agent"} address at ${FAUCET}`)
    say(identity.ownerKey ? "then run: ceasenet follow <key to obey>, ceasenet register" : "then register this agent on the website with your wallet")
    say("You are protected without any of that once you follow a key: with no tGLM, the agent reads the list and publishes nothing.")
  },

  async register(_a, home) {
    const identity = needIdentity(home)
    const writer = ownerWriter(identity)
    const client = reader(identity)
    const agent = agentAddress(identity)

    const have = await client.getBalance({ address: identity.ownerAddress })
    if (have === 0n) throw new Error(`The owner key has no tGLM. Claim some for ${identity.ownerAddress} at ${FAUCET}`)

    const passport = await readAgent(client, agent)
    if (passport) say(`Passport already on record: ${passport.key}`)
    else {
      const res = await writer.agent({ agent, name: identity.name, framework: "MCP", purpose: `Runs tools behind the CeaseNet gate.` })
      say(`Passport published: ${entityLink(res.entityKey)}`)
    }

    const published = await readTrustPolicy(client, identity.ownerAddress)
    if (published) say(`Trust list already on record: follows ${published.issuers.length} key(s)`)
    else {
      const res = await writer.trustList({ seq: BigInt(Date.now()), policy: policyFor(identity) })
      say(`Trust list published, following ${identity.following.length} key(s): ${entityLink(res.entityKey)}`)
    }

    const agentHas = await client.getBalance({ address: agent })
    if (agentHas < MIN_AGENT_BALANCE) {
      const left = await client.getBalance({ address: identity.ownerAddress })
      const hash = await writer.wallet.sendTransaction({ to: agent, value: left / 2n })
      await client.waitForTransactionReceipt({ hash })
      say(`Sent the agent ${formatEther(left / 2n)} tGLM, for its heartbeats and receipts`)
    }
  },

  follow: (a, home) => changeFollow(a, home, true),
  unfollow: (a, home) => changeFollow(a, home, false),

  async add({ words, flags, rest }, home) {
    const spec = parseSpec(words[0] ?? "")
    const tool = await installTool(home, spec)
    const exact = `${tool.file.name}@${tool.file.version}`
    const wanted = flags.get("--bin") as string | undefined
    chooseBin(tool.file.name, tool.bin, wanted)
    say(`Installed ${exact}, with install scripts off`)
    say(`Measured ${tool.file.hash}`)
    say()
    say("Put this in your MCP client's settings (Claude Desktop, Cursor, or any other):")
    const short = tool.file.name.split("/").pop()!
    const paths = { node: process.execPath, loader: import.meta.resolve("tsx"), cli: fileURLToPath(import.meta.url) }
    say(JSON.stringify(clientSettings(short, exact, wanted, rest, paths), null, 2))
  },

  async run({ words, flags, rest }, home) {
    // stdout belongs to the protocol from here on: everything for people goes to stderr.
    const log = (line: string) => console.error(`ceasenet: ${line}`)
    const spec = needVersion(parseSpec(words[0] ?? ""))
    const identity = loadIdentity(home)
    const tool = await installTool(home, spec)
    const binPath = (dir: string, bin: Record<string, string>, name: string) => join(dir, chooseBin(name, bin, flags.get("--bin") as string | undefined))
    const accessKey = accessKeyOf(identity)

    let agentKey: Hex | undefined
    if (identity && !flags.has("--read-only")) {
      const client = arkivPublicClient(accessKey)
      const funded = (await client.getBalance({ address: agentAddress(identity) })) >= MIN_AGENT_BALANCE
      if (funded) agentKey = identity.agentKey
      else log(`the agent key has no tGLM, so this agent reads the list and publishes nothing. Claim some for ${agentAddress(identity)} at ${FAUCET}`)
    }
    const following = identity?.following ?? []
    if (following.length === 0 && !identity) log("no keys here yet, so this follows nobody. Run: ceasenet init, then ceasenet follow <key>")

    const pass = agentPassFromEnv()
    const owner = identity?.ownerAddress
    const approve = pass && approverFromPass(pass, fileLinks(join(home, "approvers.json")), owner ?? "this-machine", log)
    const { guard, proxy } = await runGuarded({
      file: tool.file,
      command: process.execPath,
      args: [binPath(tool.dir, tool.bin, tool.file.name), ...rest],
      owner,
      policy: policyFor({ following }),
      agentKey,
      accessKey,
      timers: flags.has("--fast") ? DEMO_TIMERS : PRODUCTION_TIMERS,
      memoryDir: home,
      approve,
      onEvent: (e) => {
        if (e.kind === "RECEIPT") log(`receipt posted: ${e.action}`)
        else if (e.kind === "STATUS") log(`status: ${e.from} to ${e.to}`)
        else if (e.kind === "UPDATE") log(`moved from ${e.from.version} to ${e.to.version}`)
      },
      log,
    })
    log(`guarding ${tool.file.name} ${tool.file.version} (${tool.file.hash})${flags.has("--fast") ? ", checking every 2 s" : ""}`)
    if (guard.lastCheck?.policy) log(`obeying the owner's public list: ${guard.lastCheck.policy.issuers.length} key(s)`)
    else log(`obeying the local list: ${following.length} key(s). Nothing published yet`)

    let announced = ""
    let moving = false
    setInterval(() => {
      const fix = guard.lastCheck?.fixes.find((f) => f.file.hash.toLowerCase() === proxy.current.hash.toLowerCase())
      if (!fix || moving || !fix.lift.fixedHash) return
      const version = fix.lift.fixedVersion
      if (announced !== fix.lift.key) {
        announced = fix.lift.key
        log(`a fix is published: ${tool.file.name} ${version ?? fix.lift.fixedHash}.${flags.has("--auto-fix") ? "" : ` To move to it, change your client's settings to ${tool.file.name}@${version} and restart it.`}`)
      }
      if (!flags.has("--auto-fix") || !version) return
      moving = true
      void (async () => {
        const next = await installTool(home, { name: tool.file.name, version })
        if (next.file.hash.toLowerCase() !== fix.lift.fixedHash!.toLowerCase()) throw new Error(`${version} does not match the hash in the published fix, so it was refused`)
        await proxy.swap({ file: next.file, command: process.execPath, args: [binPath(next.dir, next.bin, next.file.name), ...rest] })
        await guard.adoptFix(fix, next.file)
      })()
        .catch((e) => log(`staying blocked: ${(e as Error).message}`))
        .finally(() => {
          moving = false
        })
    }, FIX_CHECK_MS).unref()
  },

  async check({ words }, home) {
    const identity = loadIdentity(home)
    const file = await measureSubject(words[0], false)
    const client = reader(identity)
    const policy = (identity && (await readTrustPolicy(client, identity.ownerAddress))) ?? policyFor(identity ?? { following: [] })
    const trust = trustFromPolicy(policy)
    const { rows } = await readEveryRecall(client)
    const covering = rows.filter((r) => recallCovers(r, file))
    const lifts = await readLifts(
      client,
      covering.map((r) => r.key),
    )
    const live = covering.filter((r) => !isWithdrawn(r, lifts, trust))
    say(`${file.name} ${file.version}  ${file.hash}`)
    if (live.length === 0) return say("Nothing on Arkiv covers this version.")
    let binding = false
    for (const r of live) {
      const followed = r.level === "STOP" && policy.issuers.some((i) => i.toLowerCase() === r.creator.toLowerCase())
      binding ||= followed
      say(`${r.level} ${r.severity} by ${r.creator}${followed ? " (you follow this key)" : " (you do not follow this key)"}`)
      say(`  ${r.reason}`)
      say(`  ${entityLink(r.key)}`)
    }
    if (binding) process.exitCode = 1
  },

  async recall({ words, flags }, home) {
    const identity = needIdentity(home)
    const reason = flags.get("--reason")
    if (typeof reason !== "string" || !reason.trim()) throw new Error('Say why, with --reason "..."')
    const file = await measureSubject(words[0], true)
    const res = await ownerWriter(identity).stop({
      artifact: file.hash,
      severity: String(flags.get("--severity") ?? "CRITICAL"),
      reason,
      pkg: file.name,
      versions: flags.get("--versions") as string | undefined,
      advice: flags.get("--advice") as string | undefined,
    })
    say(`STOP on Arkiv for ${file.name} ${file.version}`)
    say(`Key   ${res.entityKey}`)
    say(`Link  ${entityLink(res.entityKey)}`)
    say(`It binds every agent whose owner follows ${identity.ownerAddress}, and nobody else.`)
  },

  async fix({ words }, home) {
    const identity = needIdentity(home)
    const recallKey = words[0] as Hex | undefined
    if (!recallKey?.startsWith("0x")) throw new Error("Say which recall: ceasenet fix <recallKey> <package@version>")
    const client = reader(identity)
    const { rows } = await readEveryRecall(client)
    const recall = rows.find((r) => r.key.toLowerCase() === recallKey.toLowerCase())
    if (!recall) throw new Error(`No recall on Arkiv has the key ${recallKey}`)
    const file = await measureSubject(words[1], true)
    const res = await ownerWriter(identity).lift({
      recall: recall.key,
      artifact: recall.artifact,
      kind: "FIX",
      fixedHash: file.hash,
      fixedVersion: file.version,
      note: `${file.name} ${file.version} is the fix`,
    })
    say(`Fix on Arkiv: ${file.name} ${file.version}, ${file.hash}`)
    say(`Link  ${entityLink(res.entityKey)}`)
  },

  async status(_a, home) {
    const identity = needIdentity(home)
    const client = reader(identity)
    const agent = agentAddress(identity)
    const [agentHas, ownerHas, passport, published, block] = await Promise.all([
      client.getBalance({ address: agent }),
      client.getBalance({ address: identity.ownerAddress }),
      readAgent(client, agent),
      readTrustPolicy(client, identity.ownerAddress),
      client.getBlockNumber(),
    ])
    say(`Agent     ${agent}  ${formatEther(agentHas)} tGLM`)
    say(`Owner     ${identity.ownerAddress}  ${formatEther(ownerHas)} tGLM${identity.ownerKey ? "" : " (your wallet)"}`)
    say(`Passport  ${passport ? passport.key : "not published"}`)
    say(`Follows   ${published ? published.issuers.join(", ") || "nobody" : `not published. Locally: ${identity.following.join(", ") || "nobody"}`}`)
    say(`Arkiv     block ${block}`)
  },
}

async function changeFollow({ words }: ReturnType<typeof parseArgs>, home: string, follow: boolean): Promise<void> {
  const identity = needIdentity(home)
  const address = words[0] ?? ""
  if (!isAddress(address)) throw new Error(`"${address}" is not an address`)
  const following = changeFollowing(identity.following, address, follow)
  saveIdentity({ ...identity, following }, home)
  say(`${follow ? "Following" : "No longer following"} ${address}, on this machine`)
  if (!identity.ownerKey) return say("Your owner key is a wallet, so publish this on the website.")
  const client = reader(identity)
  const published = await readTrustPolicy(client, identity.ownerAddress)
  const have = await client.getBalance({ address: identity.ownerAddress })
  // A published list decides over the local one, so leaving it stale would change nothing for the agent.
  if (have === 0n) {
    if (published) throw new Error(`Your public list still says otherwise, and the owner key has no tGLM to change it. Claim some at ${FAUCET}`)
    return say("Not published, because the owner key has no tGLM. The agent still obeys this list.")
  }
  const base = published ?? policyFor({ following })
  const res = await ownerWriter(identity).trustList({ seq: BigInt(Date.now()), policy: { ...base, issuers: following } })
  say(`Published: ${entityLink(res.entityKey)}`)
}

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv
  if (!command || command === "help" || command === "--help") return say(HELP)
  const run = commands[command]
  if (!run) throw new Error(`There is no command "${command}". Try: ceasenet help`)
  await run(parseArgs(rest), homeDir())
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  await main(process.argv.slice(2)).catch((e) => {
    console.error(`ceasenet: ${(e as Error).message.split("\n")[0]}`)
    process.exit(1)
  })
}
