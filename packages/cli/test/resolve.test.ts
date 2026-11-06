import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { nameFromCommand, parseNpx, parseSpec, resolvePlan, unwrapShell } from "../src/resolve"

describe("reading an npx line", () => {
  it("finds the package and leaves the server's own arguments alone", () => {
    expect(parseNpx("npx", ["-y", "@scope/server@1.2.3", "/some/path", "--flag"])).toEqual({ spec: "@scope/server@1.2.3", rest: ["/some/path", "--flag"] })
  })

  it("copes with the long form of yes", () => {
    expect(parseNpx("npx", ["--yes", "server"])).toEqual({ spec: "server", rest: [] })
  })

  it("understands a package and a separate program", () => {
    expect(parseNpx("npx", ["-p", "tools-pkg", "mail-server", "x"])).toEqual({ spec: "tools-pkg", bin: "mail-server", rest: ["x"] })
    expect(parseNpx("npx", ["--package=tools-pkg", "--", "mail-server", "x"])).toEqual({ spec: "tools-pkg", bin: "mail-server", rest: ["x"] })
  })

  it("recognises npx however it is spelled on Windows", () => {
    expect(parseNpx("npx.cmd", ["server"])?.spec).toBe("server")
    expect(parseNpx("C:\\Program Files\\nodejs\\npx.cmd", ["server"])?.spec).toBe("server")
  })

  it("does not try to pin an arbitrary shell command", () => {
    expect(parseNpx("npx", ["-c", "rm -rf /"])).toBeUndefined()
  })

  it("says nothing about other commands", () => {
    expect(parseNpx("node", ["server.js"])).toBeUndefined()
    expect(parseNpx("npx", ["-y"])).toBeUndefined()
  })
})

describe("cmd on Windows", () => {
  it("looks through it to the command inside", () => {
    expect(unwrapShell("cmd", ["/c", "npx", "-y", "server"])).toEqual({ command: "npx", args: ["-y", "server"] })
    expect(unwrapShell("C:\\Windows\\System32\\cmd.exe", ["/C", "node", "x.js"])).toEqual({ command: "node", args: ["x.js"] })
  })

  it("leaves everything else as it is", () => {
    expect(unwrapShell("node", ["x.js"])).toEqual({ command: "node", args: ["x.js"] })
  })
})

describe("package specs", () => {
  it("splits a name from a version, with or without a scope", () => {
    expect(parseSpec("server@1.2.3")).toEqual({ name: "server", range: "1.2.3" })
    expect(parseSpec("@scope/server@1.2.3")).toEqual({ name: "@scope/server", range: "1.2.3" })
    expect(parseSpec("@scope/server")).toEqual({ name: "@scope/server", range: "latest" })
    expect(parseSpec("server")).toEqual({ name: "server", range: "latest" })
  })
})

describe("naming a tool known only by its command", () => {
  it("uses the name that matters to a person", () => {
    expect(nameFromCommand("uvx", ["mcp-server-git", "--repository", "."])).toBe("mcp-server-git")
    expect(nameFromCommand("uvx", ["mcp-server-git@1.0.0"])).toBe("mcp-server-git")
    expect(nameFromCommand("pipx", ["run", "mcp-thing"])).toBe("mcp-thing")
    expect(nameFromCommand("docker", ["run", "-i", "--rm", "mcp/github:latest"])).toBe("mcp/github")
    expect(nameFromCommand("python", ["-m", "my_server"])).toBe("my_server")
    expect(nameFromCommand("some-binary.exe", [])).toBe("some-binary")
  })
})

describe("working out what a server is", () => {
  const temp: string[] = []
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "ceasenet-resolve-"))
    temp.push(d)
    return d
  }
  afterEach(() => {
    for (const d of temp.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("measures the package a script belongs to", async () => {
    const d = dir()
    writeFileSync(join(d, "package.json"), '{"name":"my-tool","version":"1.2.3"}')
    mkdirSync(join(d, "dist"))
    writeFileSync(join(d, "dist", "server.js"), "console.log(1)")
    const plan = await resolvePlan("node", [join(d, "dist", "server.js")])
    expect(plan.strength).toBe("measured")
    expect(plan.file).toMatchObject({ name: "my-tool", version: "1.2.3" })
    expect(plan.file.hash).toMatch(/^0x/)
  })

  it("knows a tool by its command when its files cannot be seen", async () => {
    const plan = await resolvePlan("docker", ["run", "-i", "mcp/github"])
    expect(plan.strength).toBe("command")
    expect(plan.file.name).toBe("mcp/github")
    expect(plan.command).toBe("docker")
  })

  it("gives a different identity to a different command, even with the same name", async () => {
    const one = await resolvePlan("docker", ["run", "-i", "mcp/github"])
    const two = await resolvePlan("docker", ["run", "-i", "--privileged", "mcp/github"])
    expect(one.file.hash).not.toBe(two.file.hash)
  })

  it("uses a package folder given by hand", async () => {
    const d = dir()
    writeFileSync(join(d, "package.json"), '{"name":"given","version":"2.0.0"}')
    const plan = await resolvePlan("anything", ["at-all"], { packageDir: d })
    expect(plan.file.name).toBe("given")
    expect(plan.strength).toBe("measured")
  })
})
