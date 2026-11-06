import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { decodeMemory, encodeMemory, type GateMemory, type GateStore } from "@ceasenet/core"

/** Writes through a temporary file, so another process never reads half of it. */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content)
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, path)
      return
    } catch (e) {
      // Windows refuses a rename while another process has the target open. That lasts moments.
      const code = (e as NodeJS.ErrnoException).code
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 20) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

/** A gate's memory on disk: a restart must not make an agent forget a STOP. */
export function fileStore(path: string): GateStore {
  return {
    load: () => (existsSync(path) ? decodeMemory(readFileSync(path, "utf8")) : undefined),
    save: (memory: GateMemory) => writeAtomic(path, encodeMemory(memory)),
  }
}
