import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { decodeMemory, encodeMemory, type GateMemory, type GateStore } from "@ceasenet/core"

/** Local state lives in the repository root, in a folder Git ignores. */
export const STATE_DIR = join(process.cwd().replace(/[\\/]apps[\\/]fleet$/, ""), ".ceasenet")

/** A gate's memory on disk: a restart must not make a robot forget a STOP. */
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

export interface RunInfo {
  salt: string
  createdAt: string
}

const RUN = () => join(STATE_DIR, "run.json")

export function readRun(): RunInfo | undefined {
  return existsSync(RUN()) ? (JSON.parse(readFileSync(RUN(), "utf8")) as RunInfo) : undefined
}

export function writeRun(run: RunInfo): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(RUN(), JSON.stringify(run, null, 2))
}
