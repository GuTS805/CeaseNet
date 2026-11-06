import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseRunArgs } from "../src/run"
import { inspectFile, isWrapped, knownClientFiles, protectFile, unprotectFile, unwrapEntry, wrapEntry } from "../src/protect"

const SELF = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\tools\\ceasenet.mjs"] }

let dir: string
let previousHome: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ceasenet-protect-"))
  previousHome = process.env.CEASENET_HOME
  process.env.CEASENET_HOME = join(dir, "home")
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.CEASENET_HOME
  else process.env.CEASENET_HOME = previousHome
  rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, content: unknown) => {
  const path = join(dir, name)
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2))
  return path
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"))

describe("wrapping one server", () => {
  const entry = { command: "npx", args: ["-y", "server", "--flag", "--"], env: { TOKEN: "secret" }, cwd: "/x" }

  it("keeps what the client needs and runs the original through the gate", () => {
    const wrapped = wrapEntry("files", entry, SELF)
    expect(wrapped.command).toBe(SELF.command)
    expect(wrapped.env).toEqual({ TOKEN: "secret" })
    expect(wrapped.cwd).toBe("/x")
    expect(isWrapped(wrapped)).toBe(true)
    expect(isWrapped(entry)).toBe(false)
  })

  it("can be undone exactly, even when the server's own arguments look like ours", () => {
    expect(unwrapEntry(wrapEntry("files", entry, SELF))).toEqual(entry)
  })

  it("hands the guard the right command, with the server's arguments untouched", () => {
    const wrapped = wrapEntry("my files", entry, SELF)
    const parsed = parseRunArgs(wrapped.args!.slice(SELF.args.length + 1))
    expect(parsed).toMatchObject({ server: "my files", command: "npx", args: ["-y", "server", "--flag", "--"] })
  })
})

describe("a settings file", () => {
  const settings = {
    theme: "dark",
    mcpServers: {
      files: { command: "npx", args: ["-y", "server"], env: { TOKEN: "x" } },
      hosted: { type: "http", url: "https://example.com/mcp" },
    },
  }

  it("has its local servers wrapped, and everything else kept", () => {
    const path = write("a.json", settings)
    const result = protectFile(path, SELF)
    expect(result.changed).toEqual(["files"])
    expect(result.remote).toEqual(["hosted"])
    const after = read(path)
    expect(after.theme).toBe("dark")
    expect(after.mcpServers.hosted).toEqual(settings.mcpServers.hosted)
    expect(isWrapped(after.mcpServers.files)).toBe(true)
  })

  it("keeps a copy of the old file", () => {
    const path = write("a.json", settings)
    const { backup } = protectFile(path, SELF)
    expect(existsSync(backup!)).toBe(true)
    expect(read(backup!)).toEqual(settings)
  })

  it("is not wrapped twice", () => {
    const path = write("a.json", settings)
    protectFile(path, SELF)
    const before = readFileSync(path, "utf8")
    const again = protectFile(path, SELF)
    expect(again.changed).toEqual([])
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  it("comes back as it was", () => {
    const path = write("a.json", settings)
    protectFile(path, SELF)
    expect(unprotectFile(path).changed).toEqual(["files"])
    expect(read(path)).toEqual(settings)
  })

  it("is left alone if it is not plain JSON, rather than being overwritten", () => {
    const text = '{ // a comment VS Code allows\n "servers": {} }'
    const path = write("a.json", text)
    const result = protectFile(path, SELF)
    expect(result.problem).toContain("left alone")
    expect(readFileSync(path, "utf8")).toBe(text)
  })

  it("makes no backup when nothing changes", () => {
    const path = write("a.json", { mcpServers: { hosted: { url: "https://example.com" } } })
    protectFile(path, SELF)
    expect(existsSync(join(dir, "home", "backups")) ? readdirSync(join(dir, "home", "backups")) : []).toEqual([])
  })

  it("covers the block VS Code calls servers", () => {
    const path = write("a.json", { servers: { files: { type: "stdio", command: "node", args: ["x.js"] } } })
    expect(protectFile(path, SELF).changed).toEqual(["files"])
    expect(read(path).servers.files.type).toBe("stdio")
  })

  it("covers Claude Code's servers for each project as well as its own", () => {
    const path = write("a.json", {
      mcpServers: { top: { command: "a" } },
      projects: { "D:\\work": { mcpServers: { inner: { command: "b" } }, other: 1 } },
    })
    expect(protectFile(path, SELF).changed.sort()).toEqual(["inner", "top"])
    const after = read(path)
    expect(isWrapped(after.projects["D:\\work"].mcpServers.inner)).toBe(true)
    expect(after.projects["D:\\work"].other).toBe(1)
  })

  it("reports what is and is not protected", () => {
    const path = write("a.json", settings)
    expect(inspectFile({ client: "x", path }).servers.map((s) => [s.name, s.state])).toEqual([
      ["files", "unprotected"],
      ["hosted", "remote"],
    ])
    protectFile(path, SELF)
    expect(inspectFile({ client: "x", path }).servers[0]!.state).toBe("protected")
  })
})

describe("finding clients", () => {
  it("knows where each one keeps its settings, on each system", () => {
    const win = knownClientFiles("D:\\p", "C:\\Users\\a", "win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" })
    expect(win.find((f) => f.client === "Claude Desktop")?.path).toContain("claude_desktop_config.json")
    expect(win.find((f) => f.client === "Claude Code")?.path).toContain(".claude.json")
    expect(knownClientFiles("/p", "/home/a", "linux", {}).find((f) => f.client === "Claude Desktop")?.path).toContain(".config")
    expect(knownClientFiles("/p", "/Users/a", "darwin", {}).find((f) => f.client === "Claude Desktop")?.path).toContain("Application Support")
  })
})

describe("the guard's command line", () => {
  it("needs a command", () => {
    expect(() => parseRunArgs(["--name", "x"])).toThrow(/command after --/)
    expect(() => parseRunArgs(["--name", "x", "--"])).toThrow(/command after --/)
  })

  it("does not mistake the server's flags for its own", () => {
    expect(parseRunArgs(["--ceasenet", "--name", "x", "--", "node", "--name", "y"])).toMatchObject({ server: "x", command: "node", args: ["--name", "y"] })
  })

  it("names a server after its command when not told otherwise", () => {
    expect(parseRunArgs(["--", "node", "x.js"]).server).toBe("node")
  })
})
