import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { english, generateMnemonic } from "viem/accounts"
import { accountFor, ROLES } from "./roles"

// Creates .env with a new secret phrase if there is none, then writes the public addresses.
// The phrase is for testnets only and is never printed.
const ENV = ".env"
const existing = existsSync(ENV) ? readFileSync(ENV, "utf8") : ""
let mnemonic = existing.match(/^DEMO_MNEMONIC="?([^"\n]+)"?/m)?.[1]
if (!mnemonic) {
  mnemonic = generateMnemonic(english)
  const lines = [existing.trimEnd(), `DEMO_MNEMONIC="${mnemonic}"`].filter(Boolean)
  writeFileSync(ENV, lines.join("\n") + "\n")
  console.log("Created a new test secret phrase in .env")
}
const addresses = Object.fromEntries(ROLES.map((r) => [r, accountFor(r, mnemonic).address]))
writeFileSync("deployment.json", JSON.stringify({ chainId: 7794095, addresses }, null, 2) + "\n")
for (const [role, address] of Object.entries(addresses)) console.log(role.padEnd(12), address)
