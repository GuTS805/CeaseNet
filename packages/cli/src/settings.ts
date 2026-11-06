import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseEnv } from "node:util"
import { loadConfig, mainHome, saveConfig } from "./home"

/**
 * Settings for the optional services, kept in one file only this user reads.
 *
 * They are returned rather than put in the environment. A guard hands its environment to the tool it runs, and a tool
 * must never see a key for a model or a service.
 */
const ALLOWED = [
  "ARKIV_ACCESS_KEY",
  "MODEL_API_KEY",
  "MODEL_API_URL",
  "MODEL_NAME",
  "MODEL_REQUESTS_PER_MINUTE",
  "MODEL_REASONING_EFFORT",
  "WORLD_APP_ID",
  "WORLD_RP_ID",
  "WORLD_RP_SIGNING_KEY",
  "WORLD_ENVIRONMENT",
  "WORLD_IDP_ISSUER",
  "WORLD_IDP_CLIENT_ID",
  "WORLD_IDP_CLIENT_SECRET",
  "BEE_API_URL",
  "SWARM_POSTAGE_BATCH_ID",
  "SWARM_GATEWAY_URL",
  "ZG_API_KEY",
  "ZG_MODEL",
  "REPORT_VOTES_NEEDED",
  "REPORT_VERIFIER",
  "DIARY_MODE",
] as const

export type Settings = Record<string, string | undefined>

export const settingsPath = (): string => join(mainHome(), ".env")

export function readSettings(): Settings {
  try {
    return { ...parseEnv(readFileSync(settingsPath(), "utf8")) }
  } catch {
    return {}
  }
}

function writeSettings(settings: Settings): void {
  mkdirSync(mainHome(), { recursive: true })
  const lines = Object.entries(settings)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  // Readable only by this user on Linux and macOS. On Windows, a folder in the user's profile already is.
  writeFileSync(settingsPath(), `${lines.join("\n")}\n`, { mode: 0o600 })
}

/** Keeps one setting of the console's own, among the rest. */
export const saveSetting = (name: string, value: string): void => writeSettings({ ...readSettings(), [name]: value })

export interface ImportResult {
  imported: string[]
  /** Set in the file, and deliberately left behind. */
  left: string[]
}

/**
 * Copies the settings CeaseNet uses out of another file.
 *
 * Only names on the list above move. A wallet's secret phrase is not on it, and never should be: this program has no
 * use for one, and a copy of it is one more place to lose it from.
 */
export function importSettings(from: string): ImportResult {
  if (!existsSync(from)) throw new Error(`There is no file at ${from}.`)
  const source = parseEnv(readFileSync(from, "utf8"))
  const allowed = new Set<string>(ALLOWED)
  const merged: Settings = { ...readSettings() }
  const imported: string[] = []
  const left: string[] = []
  for (const [name, value] of Object.entries(source)) {
    if (!value) continue
    if (!allowed.has(name)) {
      left.push(name)
      continue
    }
    merged[name] = value
    imported.push(name)
  }
  writeSettings(merged)
  if (merged.ARKIV_ACCESS_KEY) saveConfig({ ...loadConfig(), accessKey: merged.ARKIV_ACCESS_KEY })
  return { imported, left }
}
