import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { decodeMemory, encodeMemory, type GateMemory, type GateStore } from "@ceasenet/core"

/** Local state lives in the repository root, in a folder Git ignores. */
export const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".ceasenet")

/** A gate's memory on disk: a restart must not make an agent forget a STOP. */
export function fileStore(name: string): GateStore {
  const path = join(STATE_DIR, name)
  return {
    load: () => (existsSync(path) ? decodeMemory(readFileSync(path, "utf8")) : undefined),
    save: (memory: GateMemory) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, encodeMemory(memory))
    },
  }
}

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
