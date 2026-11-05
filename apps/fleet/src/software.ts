import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { hashBytes, type LoadedFile } from "@ceasenet/core"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "software")

export type PolicyVersion = "1.5.2" | "1.5.3"

/**
 * Hashes a file together with the demo run's salt.
 *
 * Recalls from earlier rehearsals stay on Arkiv for months. The salt gives each run its own hashes, so
 * every demo starts clean without anyone having to lift old recalls.
 */
function measure(bytes: Uint8Array | string, salt: string): string {
  const content = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")
  return hashBytes(`${content}\n#run:${salt}`)
}

export interface Software {
  version: PolicyVersion
  files: LoadedFile[]
  policyHash: string
  prompt: string
  model: string
}

/** Measures everything a robot loads, including the planner's prompt and model name. */
export function loadSoftware(version: PolicyVersion, salt: string, model: string): Software {
  const policy = readFileSync(join(ROOT, `v${version}`, "policy.json"))
  const firmware = readFileSync(join(ROOT, "firmware.json"))
  const prompt = readFileSync(join(ROOT, "planner-prompt.txt"), "utf8")
  const policyHash = measure(policy, salt)
  return {
    version,
    policyHash,
    prompt,
    model,
    files: [
      { kind: "policy", name: "acme-arm-policy", version, hash: policyHash },
      { kind: "firmware", name: "acme-arm-firmware", version: "4.0.1", hash: measure(firmware, salt) },
      { kind: "prompt", name: "planner-prompt", version: "1", hash: measure(prompt, salt) },
      { kind: "model", name: model, version: "0g", hash: measure(model, salt) },
    ],
  }
}
