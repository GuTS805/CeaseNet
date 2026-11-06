import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path"
import { hashBytes, type LoadedFile, measureFiles } from "@ceasenet/core"
import { measurePackage, readPackage } from "@ceasenet/guard"
import spawn from "cross-spawn"
import { mainHome, safeName } from "./home"

/**
 * How well a tool is known.
 * pinned: this exact package was installed here and its files are measured, so what runs is what was measured.
 * measured: its files on disk are measured, but something else manages them.
 * command: its files cannot be seen, as with Docker or a Python runner, so it is known only by how it is started.
 */
export type Strength = "pinned" | "measured" | "command"

export interface LaunchPlan {
  file: LoadedFile
  command: string
  args: string[]
  strength: Strength
  /** Asks whether a pinned tool is still what was installed, and says what changed if not. */
  integrity?: () => string | undefined
}

export interface NpxCommand {
  spec: string
  bin?: string
  rest: string[]
}

/** Clients on Windows often start a server through cmd. What matters is the command inside. */
export function unwrapShell(command: string, args: readonly string[]): { command: string; args: string[] } {
  const name = basename(command).toLowerCase()
  const flag = args[0]?.toLowerCase()
  if ((name === "cmd" || name === "cmd.exe") && (flag === "/c" || flag === "/k") && args[1]) {
    return { command: args[1], args: args.slice(2) }
  }
  return { command, args: [...args] }
}

const NPX_FLAGS_WITH_VALUE = new Set(["-p", "--package", "-c", "--call", "--cache", "--userconfig", "--registry"])

/** Reads what an `npx` line is asking for. Undefined when it is not one, or when it is something too unusual to pin safely. */
export function parseNpx(command: string, args: readonly string[]): NpxCommand | undefined {
  const name = basename(command).toLowerCase().replace(/\.(cmd|exe|ps1)$/, "")
  if (name !== "npx") return undefined
  let spec: string | undefined
  let pkg: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--") {
      const [first, ...rest] = args.slice(i + 1)
      if (!first) return undefined
      return pkg ? { spec: pkg, bin: first, rest } : { spec: first, rest }
    }
    if (a === "-c" || a === "--call" || a.startsWith("--call=")) return undefined
    if (a === "-p" || a === "--package") {
      pkg = args[++i]
      continue
    }
    if (a.startsWith("--package=")) {
      pkg = a.slice("--package=".length)
      continue
    }
    if (a.startsWith("-")) {
      if (NPX_FLAGS_WITH_VALUE.has(a)) i++
      continue
    }
    spec = a
    const rest = args.slice(i + 1)
    return pkg ? { spec: pkg, bin: spec, rest } : { spec, rest }
  }
  return undefined
}

/** Splits `@scope/name@1.2.3` into its name and what was asked for. */
export function parseSpec(spec: string): { name: string; range: string } {
  const at = spec.lastIndexOf("@")
  return at > 0 ? { name: spec.slice(0, at), range: spec.slice(at + 1) } : { name: spec, range: "latest" }
}

function runQuiet(command: string, args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    // Nothing from here may reach stdout: when the guard runs, stdout belongs to the agent's protocol.
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let out = ""
    let err = ""
    child.stdout!.on("data", (d) => (out += String(d)))
    child.stderr!.on("data", (d) => (err += String(d)))
    child.on("error", reject)
    child.on("exit", (code) => resolve({ code: code ?? 1, out, err }))
  })
}

interface Pin {
  name: string
  version: string
  dir: string
  bin?: string
  /** The package as it was installed, so this stays its identity whatever it later writes beside itself. */
  hash?: string
  /** Each file's path and hash, as installed. */
  files?: Record<string, string>
}

/** Pins live with the owner, so a team's agents all run the same installed copy. */
const inPins = (...parts: string[]): string => join(mainHome(), ...parts)

/** Files a program would run. A tool may keep data beside itself, but it may not add code. */
const CODE = /\.(m?js|cjs|ts|node|wasm|sh|cmd|bat|ps1|py)$/i

/**
 * Whether a package is still what was installed.
 *
 * Comparing one hash of everything would be simpler and wrong: some tools keep data in their own folder. The official
 * memory server does, by default. So what was installed must stay exactly as it was, and new files only matter if
 * they could run.
 */
export function packageProblem(dir: string, installed: Record<string, string>): string | undefined {
  const now = new Map(readPackage(dir).map((f) => [f.path, hashBytes(f.content)]))
  for (const [path, hash] of Object.entries(installed)) {
    if (!now.has(path)) return `${path} was removed`
    if (now.get(path) !== hash) return `${path} changed`
  }
  for (const path of now.keys()) {
    if (!(path in installed) && CODE.test(path)) return `${path} was added`
  }
  return undefined
}

const manifestOf = (dir: string) => {
  const files = readPackage(dir)
  return { hash: measureFiles(files), files: Object.fromEntries(files.map((f) => [f.path, hashBytes(f.content)])) }
}

const loadPins = (): Record<string, Pin> => {
  try {
    return JSON.parse(readFileSync(inPins("pins.json"), "utf8")) as Record<string, Pin>
  } catch {
    return {}
  }
}

const savePin = (key: string, pin: Pin) => {
  const pins = loadPins()
  pins[key] = pin
  mkdirSync(inPins(), { recursive: true })
  writeFileSync(inPins("pins.json"), `${JSON.stringify(pins, null, 2)}\n`)
}

/** Forgets a pin, so the next start looks up the version again. */
export function clearPin(spec: string): boolean {
  const pins = loadPins()
  if (!pins[spec]) return false
  delete pins[spec]
  writeFileSync(inPins("pins.json"), `${JSON.stringify(pins, null, 2)}\n`)
  return true
}

/** The exact version a spec means today, without downloading or running anything. */
export async function lookUpVersion(spec: string): Promise<{ name: string; version: string }> {
  const { name } = parseSpec(spec)
  const { code, out, err } = await runQuiet("npm", ["view", spec, "name", "version", "--json"])
  if (code !== 0) throw new Error(`npm could not find ${spec}: ${err.trim().split("\n")[0] ?? ""}`)
  const parsed = JSON.parse(out) as { version?: string } | { version?: string }[]
  // A range can match several versions, listed oldest first. npx would use the newest.
  const version = Array.isArray(parsed) ? parsed[parsed.length - 1]?.version : parsed.version
  if (!version) throw new Error(`npm did not say which version of ${spec} to use`)
  return { name, version }
}

/**
 * Installs one exact version into a folder of its own and remembers it.
 * Install scripts do not run: a package's install script is a favourite way to attack a machine.
 */
export async function installPin(spec: string, name: string, version: string, bin?: string): Promise<Pin> {
  const dir = inPins("tools", safeName(`${name}@${version}`))
  const packageDir = join(dir, "node_modules", name)
  if (!existsSync(join(packageDir, "package.json"))) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), '{"private":true}\n')
    const { code, err } = await runQuiet("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact", `${name}@${version}`], dir)
    if (code !== 0) throw new Error(`could not install ${name}@${version}: ${err.trim().split("\n")[0] ?? ""}`)
  }
  const pin: Pin = { name, version, dir, ...(bin ? { bin } : {}), ...manifestOf(packageDir) }
  savePin(spec, pin)
  return pin
}

export const pinFor = (spec: string): Pin | undefined => loadPins()[spec]

function launchFromPin(key: string, stored: Pin, rest: string[]): LaunchPlan {
  const packageDir = join(stored.dir, "node_modules", stored.name)
  // A pin made before files were recorded one by one is taken as it stands today.
  let pin = stored
  if (!pin.files || !pin.hash) {
    pin = { ...stored, ...manifestOf(packageDir) }
    savePin(key, pin)
  }
  const installed = pin.files!
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin?: string | Record<string, string> }
  const bins = typeof manifest.bin === "string" ? { [basename(pin.name)]: manifest.bin } : (manifest.bin ?? {})
  const chosen = (pin.bin && bins[pin.bin]) || bins[basename(pin.name)] || Object.values(bins)[0]
  if (!chosen) throw new Error(`${pin.name} ${pin.version} has no program to run`)
  const script = join(packageDir, chosen)
  return {
    file: { kind: "tool", name: pin.name, version: pin.version, hash: pin.hash! },
    // The file itself rather than npm's wrapper, so what starts is what was measured.
    command: process.execPath,
    args: [script, ...rest],
    strength: "pinned",
    integrity: () => packageProblem(packageDir, installed),
  }
}

const MAX_MEASURE_FILES = 5_000

function countFiles(dir: string, limit: number): number {
  let count = 0
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue
    const path = join(dir, name)
    count += statSync(path).isDirectory() ? countFiles(path, limit - count) : 1
    if (count > limit) return count
  }
  return count
}

/** The package a script belongs to, if it has one nearby. */
function packageOf(script: string): string | undefined {
  let dir = dirname(script)
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
  return undefined
}

function fileArgument(args: readonly string[], cwd: string): string | undefined {
  for (const a of args) {
    if (a.startsWith("-")) continue
    const path = isAbsolute(a) ? a : resolvePath(cwd, a)
    if (existsSync(path) && statSync(path).isFile()) return path
  }
  return undefined
}

const COMMAND_VERSION = "0.0.0"

/** A short name for a tool known only by how it is started. */
export function nameFromCommand(command: string, args: readonly string[]): string {
  const base = basename(command).toLowerCase().replace(/\.(cmd|exe|ps1)$/, "")
  const words = args.filter((a) => !a.startsWith("-"))
  if (base === "uvx" || base === "pipx" || base === "bunx") return parseSpec(words[base === "pipx" && words[0] === "run" ? 1 : 0] ?? base).name
  if (base === "docker") return words[words.length - 1]?.split(":")[0] ?? base
  if (base === "python" || base === "python3" || base === "py") {
    const module = args[args.indexOf("-m") + 1]
    return args.includes("-m") && module ? module : basename(words[0] ?? base)
  }
  return base
}

export interface ResolveOptions {
  /** A folder given by hand, which settles the question. */
  packageDir?: string
  cwd?: string
  /** Offered a package's name and exact version before anything is downloaded. Returning a reason stops there. */
  beforeInstall?: (file: LoadedFile) => Promise<string | undefined>
}

export class RecalledBeforeInstall extends Error {
  constructor(
    readonly file: LoadedFile,
    readonly reason: string,
  ) {
    super(`${file.name} ${file.version} was not installed: ${reason}`)
  }
}

/** Works out what a server really is and how to start exactly that. */
export async function resolvePlan(rawCommand: string, rawArgs: readonly string[], options: ResolveOptions = {}): Promise<LaunchPlan> {
  const { command, args } = unwrapShell(rawCommand, rawArgs)
  const cwd = options.cwd ?? process.cwd()

  if (options.packageDir) {
    return { file: measurePackage(options.packageDir), command, args, strength: "measured" }
  }

  const npx = parseNpx(command, args)
  if (npx) {
    const key = npx.bin ? `${npx.spec}#${npx.bin}` : npx.spec
    const pin = pinFor(key)
    if (pin && existsSync(join(pin.dir, "node_modules", pin.name, "package.json"))) return launchFromPin(key, pin, npx.rest)

    const { name, version } = await lookUpVersion(npx.spec)
    // By name and version only: the point is to be able to refuse before a byte of it is on this machine.
    const reason = await options.beforeInstall?.({ kind: "tool", name, version, hash: `unmeasured:${name}@${version}` })
    if (reason) throw new RecalledBeforeInstall({ kind: "tool", name, version, hash: `unmeasured:${name}@${version}` }, reason)
    return launchFromPin(key, await installPin(key, name, version, npx.bin), npx.rest)
  }

  const script = fileArgument(args, cwd)
  const packageDir = script && packageOf(script)
  if (packageDir && countFiles(packageDir, MAX_MEASURE_FILES) <= MAX_MEASURE_FILES) {
    try {
      return { file: measurePackage(packageDir), command, args, strength: "measured" }
    } catch {
      // A package.json with no name or version says nothing. It is known by its command instead.
    }
  }

  return {
    file: {
      kind: "tool",
      name: nameFromCommand(command, args),
      version: COMMAND_VERSION,
      hash: hashBytes(`command:${[command, ...args].join("\0")}`),
    },
    command,
    args,
    strength: "command",
  }
}
