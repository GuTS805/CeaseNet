import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { hashBytes, type LoadedFile } from "@ceasenet/core"
import { measurePackage, type ToolProcess } from "@ceasenet/guard"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const TOOLS = join(ROOT, "tools")

export const SYSTEM_PROMPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "agent-prompt.txt"), "utf8")

export interface ToolPackage {
  file: LoadedFile
  dir: string
}

const load = (folder: string): ToolPackage => {
  const dir = join(TOOLS, folder)
  return { file: measurePackage(dir), dir }
}

/** The demo's tools, measured from their real files. */
export const catalog = () => ({
  badMail: load("demo-mail-tool-1.0.16"),
  fixedMail: load("demo-mail-tool-1.0.17"),
  files: load("demo-files-tool-2.1.0"),
})

/** Measures what the agent thinks with. A recall on either of these stops the whole agent. */
export const coreFiles = (model: string, host: string): LoadedFile[] => [
  { kind: "model", name: model, version: host, hash: hashBytes(model) },
  { kind: "prompt", name: "office-assistant", version: "1", hash: hashBytes(SYSTEM_PROMPT) },
]

/** How to start a tool. It sees only its sandbox: no keys and nothing else from this process's environment. */
export const toolProcess = (pkg: ToolPackage, sandbox: string, company: string): ToolProcess => ({
  command: process.execPath,
  args: [join(pkg.dir, "server.mjs")],
  cwd: ROOT,
  env: { DEMO_SANDBOX: sandbox, DEMO_COMPANY: company, PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
})
