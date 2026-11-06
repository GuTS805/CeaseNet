import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { clientSettings, isFolder, parseArgs } from "../src/cli"
import { agentAddress, changeFollowing, createIdentity, loadIdentity, policyFor } from "../src/identity"
import { toolEnv } from "../src/runGuarded"
import { chooseBin, readBin } from "../src/tools"

const temp: string[] = []
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "ceasenet-cli-"))
  temp.push(d)
  return d
}
afterEach(() => {
  for (const d of temp.splice(0)) rmSync(d, { recursive: true, force: true })
})

const WALLET = "0x00000000000000000000000000000000000000aa" as const

describe("keys on this machine", () => {
  it("creates an owner and an agent key, and keeps them", () => {
    const home = dir()
    const { identity, created } = createIdentity({ name: "Support agent" }, home)
    expect(created).toBe(true)
    expect(identity.ownerKey).toBeDefined()
    expect(agentAddress(identity)).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(loadIdentity(home)).toEqual(identity)
  })

  it("never replaces keys that already exist, because a lost key cannot be recovered", () => {
    const home = dir()
    const first = createIdentity({ name: "One" }, home).identity
    const second = createIdentity({ name: "Two" }, home)
    expect(second.created).toBe(false)
    expect(second.identity).toEqual(first)
  })

  it("holds no owner key when the owner signs with a wallet", () => {
    const { identity } = createIdentity({ name: "A", owner: WALLET }, dir())
    expect(identity.ownerKey).toBeUndefined()
    expect(identity.ownerAddress).toBe(WALLET)
  })

  it("refuses an owner that is not an address", () => {
    expect(() => createIdentity({ name: "A", owner: "not-an-address" }, dir())).toThrow(/not an address/)
  })

  it("starts out following nobody, not the demo's keys", () => {
    const { identity } = createIdentity({ name: "A" }, dir())
    expect(policyFor(identity).issuers).toEqual([])
  })

  it("adds and removes followed keys without caring about letter case or repeats", () => {
    const upper = WALLET.toUpperCase().replace("0X", "0x") as `0x${string}`
    expect(changeFollowing([WALLET], upper, true)).toEqual([upper])
    expect(changeFollowing([WALLET], upper, false)).toEqual([])
  })
})

describe("choosing which program to start", () => {
  it("takes the only one", () => {
    expect(chooseBin("@s/tool", { anything: "a.js" })).toBe("a.js")
  })

  it("takes the one named after the package", () => {
    expect(chooseBin("@s/tool", { other: "o.js", tool: "t.js" })).toBe("t.js")
  })

  it("asks rather than guessing", () => {
    expect(() => chooseBin("tool", { a: "a.js", b: "b.js" })).toThrow(/Choose one with --bin: a, b/)
  })

  it("follows an explicit choice, and refuses one that does not exist", () => {
    expect(chooseBin("tool", { a: "a.js", b: "b.js" }, "b")).toBe("b.js")
    expect(() => chooseBin("tool", { a: "a.js" }, "z")).toThrow(/no program called z/)
  })

  it("refuses a package with nothing to run", () => {
    expect(() => chooseBin("tool", {})).toThrow(/no program to run/)
  })

  it("reads both ways a package can name its program", () => {
    const d = dir()
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@s/tool", bin: "cli.js" }))
    expect(readBin(d)).toEqual({ tool: "cli.js" })
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "tool", bin: { x: "x.js" } }))
    expect(readBin(d)).toEqual({ x: "x.js" })
    expect(readFileSync(join(d, "package.json"), "utf8")).toContain("x.js")
  })
})

describe("what a tool can see", () => {
  it("hides the keys and settings of this project, whatever loaded them", () => {
    const seen = toolEnv({
      DEMO_MNEMONIC: "x",
      CEASENET_AGENT_KEY: "x",
      CEASENET_HOME: "x",
      ARKIV_ACCESS_KEY: "x",
      WORLD_IDP_CLIENT_SECRET: "x",
      WORLD_RP_SIGNING_KEY: "x",
      MODEL_API_KEY: "x",
      ZG_API_KEY: "x",
      SWARM_POSTAGE_BATCH_ID: "x",
      BEE_API_URL: "x",
    })
    expect(seen).toEqual({})
  })

  it("leaves everything else alone, including the tool's own settings", () => {
    const env = { PATH: "/bin", GITHUB_TOKEN: "t", DEMO_SANDBOX: "/s" }
    expect(toolEnv(env)).toEqual(env)
  })
})

describe("reading a command line", () => {
  it("separates words, flags and what belongs to the tool", () => {
    const { words, flags, rest } = parseArgs(["pkg@1.0.0", "--fast", "--bin", "server", "--", "--fast", "/data"])
    expect(words).toEqual(["pkg@1.0.0"])
    expect(flags.get("--fast")).toBe(true)
    expect(flags.get("--bin")).toBe("server")
    expect(rest).toEqual(["--fast", "/data"])
  })

  it("complains when a flag is missing its value", () => {
    expect(() => parseArgs(["--reason"])).toThrow("--reason needs a value")
  })
})

describe("telling a folder from a package", () => {
  it("treats paths as folders", () => {
    for (const path of ["./build", "../tool", "/opt/tool", "C:\\tools\\x", ".\\build"]) expect(isFolder(path)).toBe(true)
  })

  it("treats package names as packages, including scoped ones", () => {
    for (const name of ["tool", "tool@1.0.0", "@scope/tool", "@scope/tool@1.0.0"]) expect(isFolder(name)).toBe(false)
  })
})

describe("the settings for an MCP client", () => {
  const paths = { node: "/node", loader: "file:///tsx.mjs", cli: "/cli.ts" }

  it("uses absolute paths, and pins the exact version", () => {
    expect(clientSettings("tool", "tool@1.0.0", undefined, [], paths)).toEqual({
      mcpServers: { tool: { command: "/node", args: ["--import", "file:///tsx.mjs", "/cli.ts", "run", "tool@1.0.0"] } },
    })
  })

  it("passes the tool's own arguments after --", () => {
    const { args } = clientSettings("tool", "tool@1.0.0", "server", ["/data"], paths).mcpServers.tool!
    expect(args.slice(3)).toEqual(["run", "tool@1.0.0", "--bin", "server", "--", "/data"])
  })
})
