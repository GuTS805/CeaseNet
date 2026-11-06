import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeBundle, isEncryptedSwarmRef, isPublicSwarmRef } from "@ceasenet/core"
import { fetchPackage, measureDir, openSealedRef, readPackage, sealRef, SwarmClient } from "@ceasenet/guard"
import { catalog } from "../apps/demo/src/catalog"
import { evidenceFor } from "../apps/demo/src/swarmFiles"
import { accountFor } from "./roles"
import { toHex } from "viem"

// Checks the Swarm parts on a real Bee node: stores a fix and sealed evidence, then reads both back.
// It writes nothing to Arkiv. Each file spends a little of the postage batch.
const url = process.env.BEE_API_URL
const batch = process.env.SWARM_POSTAGE_BATCH_ID
if (!url || !batch) {
  console.log("Set BEE_API_URL and SWARM_POSTAGE_BATCH_ID in .env first.")
  process.exit(1)
}

const swarm = new SwarmClient({ url, batch })
const tools = catalog()

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const timed = async <T>(run: () => Promise<T>): Promise<[T, string]> => {
  const t0 = Date.now()
  const value = await run()
  return [value, `${((Date.now() - t0) / 1000).toFixed(1)} s`]
}

const [fixRef, uploadTime] = await timed(() =>
  swarm.upload(`${tools.fixedMail.file.name}-${tools.fixedMail.file.version}.ceasenet.json`, encodeBundle(readPackage(tools.fixedMail.dir)), {
    contentType: "application/json",
  }),
)
check("a fix uploads and gets a public reference", isPublicSwarmRef(fixRef), `${uploadTime}, ${fixRef}`)

const installRoot = mkdtempSync(join(tmpdir(), "ceasenet-swarm-check-"))
const [fetched, fetchTime] = await timed(() => fetchPackage(swarm, fixRef, tools.fixedMail.file.hash, installRoot))
check("it downloads, and matches the published hash", fetched.file.hash === tools.fixedMail.file.hash, fetchTime)
check("what landed on disk measures the same", measureDir(fetched.dir) === tools.fixedMail.file.hash)
await fetchPackage(swarm, fixRef, tools.badMail.file.hash, installRoot).then(
  () => check("a reference to the wrong file is refused", false),
  (e: Error) => check("a reference to the wrong file is refused", e.message.includes("does not match")),
)
rmSync(installRoot, { recursive: true, force: true })

const evidence = evidenceFor(tools.badMail)
const [encrypted, encryptedTime] = await timed(() => swarm.upload("evidence.json", evidence, { contentType: "application/json", encrypt: true }))
check("evidence uploads encrypted, with the long reference", isEncryptedSwarmRef(encrypted), encryptedTime)
const regulator = accountFor("regulator")
const sealed = sealRef(encrypted, regulator.publicKey)
check("the sealed text does not contain the reference", !sealed.includes(encrypted) && !sealed.includes(encrypted.slice(64)))
const opened = openSealedRef(sealed, toHex(regulator.getHdKey().privateKey!))
check("the security council can open the seal", opened === encrypted)
let othersCanOpen = true
try {
  openSealedRef(sealed, toHex(accountFor("maker").getHdKey().privateKey!))
} catch {
  othersCanOpen = false
}
check("nobody else can", !othersCanOpen)
const read = new TextDecoder().decode(await swarm.read(opened))
check("the evidence reads back whole", read === new TextDecoder().decode(evidence))

console.log(failures === 0 ? "\nall good" : `\n${failures} failed`)
console.log(`\nFor arkiv/swarm.md: batch ${batch}, node ${url}, public fix reference ${fixRef}`)
process.exit(failures === 0 ? 0 : 1)
