/**
 * Fails if any real secret from this machine's settings appears in a file git tracks or is about to commit, or with
 * --history anywhere in the repository's past.
 *
 * Arkiv entity keys and transaction hashes look exactly like private keys, 32 bytes of hex, so a pattern cannot tell
 * them apart. Comparing against the actual secrets can. It prints only the names of the settings, never their values.
 *
 *   npm run check:secrets
 *   npm run check:secrets -- --history
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parseEnv } from "node:util"

/** Settings that are meant to be seen, such as a public app id or a web address. */
const NOT_SECRET = new Set([
  "BEE_API_URL",
  "MODEL_API_URL",
  "MODEL_NAME",
  "MODEL_REASONING_EFFORT",
  "MODEL_REQUESTS_PER_MINUTE",
  "REPORT_VERIFIER",
  "REPORT_VOTES_NEEDED",
  "SWARM_GATEWAY_URL",
  "SWARM_POSTAGE_BATCH_ID",
  "VERCEL_URL",
  "VERIFIER_ALLOW_BYPASS",
  "VERIFIER_URL",
  "WORLD_APP_ID",
  "WORLD_ENVIRONMENT",
  "WORLD_IDP_CLIENT_ID",
  "WORLD_IDP_ISSUER",
  "WORLD_RP_ID",
  "ZG_MODEL",
])

const root = resolve(import.meta.dirname, "..")
const home = process.env.CEASENET_HOME ?? join(homedir(), ".ceasenet")

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Every secret this machine holds for the project: its settings, and the wallets of each agent here. */
function secrets(): Map<string, string> {
  const found = new Map<string, string>()
  const add = (name: string, value: unknown) => {
    if (typeof value !== "string" || value.length < 16) return
    found.set(value.toLowerCase().replace(/^0x/, ""), name)
  }
  for (const file of [join(root, ".env"), join(root, ".env.local"), join(home, ".env")]) {
    if (!existsSync(file)) continue
    for (const [name, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) if (!NOT_SECRET.has(name)) add(name, value)
  }
  const homes = [home, ...(existsSync(join(home, "team")) ? readdirSync(join(home, "team")).map((m) => join(home, "team", m)) : [])]
  for (const h of homes) {
    for (const [name, value] of Object.entries(readJson(join(h, "keys.json")) ?? {})) add(`${name} key in ${h === home ? "this home" : "a team member's home"}`, value)
    add("the Arkiv access key in a config", readJson(join(h, "config.json"))?.accessKey)
  }
  return found
}

const hitsIn = (text: string, known: Map<string, string>): string[] => [...known].filter(([value]) => text.includes(value)).map(([, name]) => name)

function checkFiles(known: Map<string, string>): string[] {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean)
  const hits: string[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(join(root, file), "utf8").toLowerCase()
    } catch {
      continue
    }
    for (const name of hitsIn(text, known)) hits.push(`${file}: contains ${name}`)
  }
  console.log(`Checked ${known.size} secrets against ${files.length} files.`)
  return hits
}

function checkHistory(known: Map<string, string>): string[] {
  const commits = execFileSync("git", ["rev-list", "--all"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean)
  const hits: string[] = []
  for (const commit of commits) {
    const shown = spawnSync("git", ["show", "--format=%B", "--no-color", commit], { cwd: root, encoding: "utf8", maxBuffer: 1 << 30 })
    if (shown.status !== 0) throw new Error(`Could not read ${commit}`)
    for (const name of hitsIn(shown.stdout.toLowerCase(), known)) hits.push(`${commit.slice(0, 7)}: contains ${name}`)
  }
  console.log(`Checked ${known.size} secrets against ${commits.length} commits.`)
  return hits
}

const known = secrets()
if (known.size === 0) {
  console.log("No secrets on this machine, so nothing to compare.")
  process.exit(0)
}
const hits = process.argv.includes("--history") ? checkHistory(known) : checkFiles(known)
if (hits.length > 0) {
  console.error(`Secrets found:\n${hits.join("\n")}`)
  process.exit(1)
}
console.log("None of them appear.")
