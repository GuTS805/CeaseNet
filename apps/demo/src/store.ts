import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { GateStore } from "@ceasenet/core"
import { fileStore } from "@ceasenet/guard"

/** Local state lives in the repository root, in a folder Git ignores. */
export const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".ceasenet")

export const gateStore = (name: string): GateStore => fileStore(join(STATE_DIR, name))

export const sandboxDir = (id: string): string => {
  const dir = join(STATE_DIR, "sandbox", id)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Counts lines in one of a sandbox's files. Missing means nothing has happened yet. */
export function countLines(dir: string, file: string): number {
  const path = join(dir, file)
  if (!existsSync(path)) return 0
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length
}
