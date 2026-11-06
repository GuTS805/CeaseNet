import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { decodeMemory, encodeMemory, type GateMemory, type GateStore } from "@ceasenet/core"

/** A gate's memory on disk: a restart must not make an agent forget a STOP. */
export function fileStore(path: string): GateStore {
  return {
    load: () => (existsSync(path) ? decodeMemory(readFileSync(path, "utf8")) : undefined),
    save: (memory: GateMemory) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, encodeMemory(memory))
    },
  }
}
