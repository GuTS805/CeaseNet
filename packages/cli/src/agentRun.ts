import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { type GateView, hashBytes, type Hex, type LoadedFile, PRODUCTION_TIMERS, type TrustPolicy } from "@ceasenet/core"
import { BrainBusy, BrainUnavailable, type Message, ModelBrain, PacedBrain } from "@ceasenet/demo/brain"
import { fileStore, Guard, type GuardNet, killTree, type ToolSpec } from "@ceasenet/guard"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import spawn from "cross-spawn"
import {
  type AgentEvent,
  type AgentPhase,
  type AgentState,
  chooseThinking,
  mcpSettingsPath,
  type Member,
  memberNamed,
  modelSettings,
  SHARED_RULES,
  TEAM,
  type Thinking,
  TOOLS,
  workspaceOf,
  writeAgentState,
} from "./fleet"
import { homeDir, identityOf, inHome, loadConfig, loadKeys, mainHome, nudgeTime, startingPolicy } from "./home"
import { recordNote } from "./journal"
import { ledgerFor } from "./ledger"
import { readSettings, type Settings } from "./settings"

/** How long between jobs, so three agents do not spend a person's model allowance faster than they can watch. */
const JOB_GAP_MS = 20_000
const JOB_LIMIT_MS = 150_000
/** With nobody looking, no new jobs start. A while after that, the agent leaves altogether. */
const PAUSE_AFTER_MS = 2 * 60_000
const LEAVE_AFTER_MS = 15 * 60_000
const MODEL_RETRY_MS = 30_000
const MODEL_RETRY_LIMIT_MS = 10 * 60_000
const NUDGE_POLL_MS = 400
const CLOSE_REPORT_LIMIT_MS = 45_000
/** Reading is free but limited on the public endpoint, and three agents share it. */
const CHECK_MS = { local: 2_000, keyed: 3_000, publicEndpoint: 6_000 }
const MAX_TURNS = 8

export interface JobResult {
  ok: boolean
  text: string
  /** How long the model's service asked to be left alone. */
  retryAfterMs?: number
}

export interface JobHandle {
  done: Promise<JobResult>
  kill(): void
}
export type StartJob = (prompt: string, system: string) => JobHandle

export interface AgentOptions {
  member: Member
  address: string
  tools: LoadedFile[]
  guard: Guard
  startJob: StartJob
  /** Ends what the jobs share, such as connections to its tools. */
  shutdown?: () => Promise<void>
  /** Where the agent's task files are, as the model should name them. */
  taskPath: (file: string) => string
  resultPath: (n: number) => string
  /** How long since a person looked at the page. */
  unwatchedForMs: () => number
  readInfo: () => { block: string; tookMs: number; stopsRead: number }
  write: (state: AgentState) => void
  event: (event: AgentEvent) => void
  /** The process leaves. */
  exit: (code: number) => void
  now?: () => number
  wait?: (ms: number) => Promise<void>
  jobGapMs?: number
  firstJob?: number
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * One agent's life: read the list, work, keep reading the list, and close when a recall covers it.
 *
 * It reads the list before it does anything, so a recall already in force means it never starts a job. And it does
 * not depend on the model: a model that has gone wrong, or that would rather carry on, is not asked.
 */
export class TeamAgent {
  private readonly state: AgentState
  private job: JobHandle | undefined
  private closing = false
  private stopChecks: () => void = () => undefined
  private readonly wait: (ms: number) => Promise<void>
  private jobNumber: number
  private lastProblem: string | undefined

  constructor(private readonly opts: AgentOptions) {
    this.wait = opts.wait ?? pause
    this.jobNumber = opts.firstJob ?? 1
    this.state = {
      id: opts.member.id,
      name: opts.member.name,
      pid: process.pid,
      phase: "starting",
      startedAt: this.now(),
      updatedAt: this.now(),
      address: opts.address,
      jobs: 0,
      checks: 0,
      tools: opts.tools,
    }
  }

  get snapshot(): AgentState {
    return this.state
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private publish(): void {
    this.state.updatedAt = this.now()
    this.opts.write(this.state)
  }

  private setPhase(phase: AgentPhase): void {
    this.state.phase = phase
    this.publish()
  }

  private note(kind: AgentEvent["kind"], text: string): void {
    this.opts.event({ at: this.now(), kind, text })
  }

  /** Reads the list first, and only then does anything else. */
  async start(): Promise<void> {
    const { guard } = this.opts
    this.publish()
    guard.onChecked(() => this.afterCheck())
    await guard.check(true)
    if (this.closing) return
    this.note("started", "Read the recall list: nothing covers this agent, so it can start.")
    try {
      await guard.start()
    } catch (e) {
      // Reports cost money, and the agent's duty to obey does not depend on them.
      this.state.problem = "Public reports are paused until this agent's wallet has funds. It still obeys."
      this.note("problem", `${this.state.problem} (${(e as Error).message.split("\n")[0]})`)
    }
    if (this.closing) return
    this.stopChecks = guard.run()
    await this.workLoop()
  }

  private afterCheck(): void {
    const { guard, readInfo } = this.opts
    const last = guard.lastCheck
    const info = readInfo()
    this.state.checks += 1
    this.state.lastCheck = { at: this.now(), block: info.block, online: last?.online ?? false, tookMs: info.tookMs, stopsRead: info.stopsRead }
    const stop = this.coveringStop()
    if (stop) {
      this.close(stop)
      return
    }
    // The list has been out of reach for too long. Not knowing means not carrying on.
    if (last?.decision.core.mode === "STOPPED") {
      this.close({ reason: "It could not read the recall list for too long, so it stopped rather than carry on without knowing." })
      return
    }
    if (!this.closing) this.publish()
  }

  /** A STOP on the agent, on its team, or on anything it has loaded. */
  private coveringStop(): { reason: string; recall?: Hex; artifact?: string; tool?: string } | undefined {
    const { guard } = this.opts
    for (const file of guard.files) {
      const recall = guard.stopOn(file)
      if (recall) {
        const onTool = file.kind === "tool" && guard.lastCheck?.decision.core.activeStops.length === 0
        return { reason: recall.reason, recall: recall.key, artifact: recall.artifact, tool: onTool ? file.name : undefined }
      }
    }
    return undefined
  }

  /** Ends whatever it is doing, says why, posts its receipt, and leaves. */
  private close(why: { reason: string; recall?: Hex; artifact?: string; tool?: string }): void {
    if (this.closing) return
    this.closing = true
    const before = this.state.jobs === 0 && this.state.phase === "starting"
    this.state.closed = { at: this.now(), reason: why.reason, recall: why.recall, artifact: why.artifact, tool: why.tool, afterStart: !before }
    this.state.job = undefined
    this.setPhase("closing")
    this.note(
      "closed",
      before ? `A recall covers this agent, so it refused to start. ${why.reason}` : `${why.tool ? `${why.tool} was recalled` : "This agent was stopped"}. Closing. ${why.reason}`,
    )
    this.job?.kill()
    this.stopChecks()
    // Receipts for this reading are sent just after it is reported here, so they are waited for on the next turn.
    void this.finishClosing()
  }

  private async finishClosing(): Promise<void> {
    await this.wait(0)
    const { guard, shutdown } = this.opts
    await Promise.race([
      (async () => {
        await guard.settle()
        await guard.beat("STOPPED")
      })(),
      this.wait(CLOSE_REPORT_LIMIT_MS),
    ])
    await shutdown?.().catch(() => undefined)
    this.setPhase("closed")
    this.opts.exit(0)
  }

  private async workLoop(): Promise<void> {
    const { member, unwatchedForMs, startJob, taskPath, resultPath, guard, shutdown } = this.opts
    while (!this.closing) {
      const unwatched = unwatchedForMs()
      if (unwatched > LEAVE_AFTER_MS) {
        this.note("paused", "Nobody has looked for a long time, so it has shut itself down.")
        this.closing = true
        this.stopChecks()
        await shutdown?.().catch(() => undefined)
        this.setPhase("off")
        this.opts.exit(0)
        return
      }
      if (unwatched > PAUSE_AFTER_MS) {
        if (this.state.phase !== "paused") this.note("paused", "Nobody is watching, so it starts no new jobs. It keeps reading the list.")
        this.setPhase("paused")
        await this.wait(2_000)
        continue
      }
      // Cut off from the list, it does not start anything new, and closes if that goes on.
      if (guard.lastCheck && guard.lastCheck.decision.core.mode !== "RUNNING") {
        this.setPhase("waiting")
        await this.wait(2_000)
        continue
      }

      const n = this.jobNumber++
      const task = member.tasks[(n - 1) % member.tasks.length]!
      this.state.job = `Job ${n}: ${task.file}`
      if (!this.state.problem?.startsWith("Public")) this.state.problem = undefined
      this.setPhase("working")
      this.note("job", `Started job ${n} on ${task.file}.`)

      this.job = startJob(member.job({ task: taskPath(task.file), result: resultPath(n), n }), `${member.role} ${SHARED_RULES}`)
      const { ok, text, retryAfterMs } = await this.job.done
      this.job = undefined
      if (this.closing) return

      this.state.job = undefined
      if (ok) {
        this.lastProblem = undefined
        this.state.jobs += 1
        this.state.lastSaid = text
        this.note("said", text)
        this.setPhase("idle")
        await this.wait(this.opts.jobGapMs ?? JOB_GAP_MS)
      } else {
        // The job did not happen, so it is still to do. Numbering on would leave gaps in its work.
        this.jobNumber = n
        this.state.problem = text
        if (this.lastProblem !== text) this.note("problem", text)
        this.lastProblem = text
        this.setPhase("waiting")
        await this.wait(Math.min(MODEL_RETRY_LIMIT_MS, Math.max(MODEL_RETRY_MS, retryAfterMs ?? 0)))
      }
    }
  }
}

// ---- Thinking with Claude Code ----

/** A real model, deciding each step through real MCP servers. It has no built-in tools at all, only gated ones. */
export const claudeJob =
  (home: string, member: Member, model: string): StartJob =>
  (prompt, system) => {
    const allowed = member.tools.map((t) => `mcp__${t}`).join(",")
    const child = spawn(
      "claude",
      ["-p", "--model", model, "--mcp-config", mcpSettingsPath(home), "--strict-mcp-config", "--tools", "", "--allowedTools", allowed, "--no-session-persistence", "--system-prompt", system],
      { cwd: workspaceOf(home), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" },
    )
    child.stdin?.on("error", () => undefined)
    child.stdin?.end(prompt)
    let out = ""
    let err = ""
    child.stdout?.on("data", (d) => (out += String(d)))
    child.stderr?.on("data", (d) => (err += String(d)))
    let timer: ReturnType<typeof setTimeout>
    const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
      child.on("error", (e) => resolve({ ok: false, text: `Could not start the model: ${e.message}` }))
      child.on("exit", (code) => {
        clearTimeout(timer)
        const text = out.trim()
        resolve(code === 0 && text ? { ok: true, text } : { ok: false, text: (err.trim() || text || `The model stopped with code ${code}.`).split("\n")[0]! })
      })
    })
    timer = setTimeout(() => killTree(child), JOB_LIMIT_MS)
    return { done, kill: () => killTree(child) }
  }

// ---- Thinking with any service that speaks the OpenAI chat API ----

const BLANK_REPLY_REMINDER = "Carry on with the job: use a tool, or say in one short sentence what happened."

interface Connected {
  client: Client
  specs: ToolSpec[]
}

/**
 * A real agent loop: the model chooses each step, and each step goes to a real MCP server through the gate.
 * Connections stay open between jobs, as they would for any agent, so the tools' processes are really there to end.
 */
export function modelRunner(home: string, member: Member, settings: Settings): { startJob: StartJob; shutdown: () => Promise<void> } {
  const model = modelSettings(settings)
  // The limit belongs to the key, which all the agents share.
  const brain = new PacedBrain(new ModelBrain(model), 60_000 / (model.requestsPerMinute / TEAM.length))
  let connected: Promise<Connected[]> | undefined

  const connect = (): Promise<Connected[]> => {
    connected ??= (async () => {
      const servers = (JSON.parse(readFileSync(mcpSettingsPath(home), "utf8")) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }).mcpServers
      return Promise.all(
        Object.entries(servers).map(async ([id, entry]) => {
          const client = new Client({ name: `ceasenet-${member.id}`, version: "1.0.0" })
          // Only what the server needs: this agent's model key is not in its environment, and neither is anything else of ours.
          await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: entry.env, stderr: "ignore" }))
          const { tools } = await client.listTools()
          // Fewer tools means fewer tokens on every request, and these jobs need only these.
          const wanted = new Set(TOOLS[id as keyof typeof TOOLS].calls)
          return {
            client,
            specs: tools.filter((t) => wanted.has(t.name)).map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> })),
          }
        }),
      )
    })()
    return connected
  }

  const runJob = async (prompt: string, system: string, signal: AbortSignal): Promise<JobResult> => {
    const tools = await connect()
    const specs = tools.flatMap((t) => t.specs)
    const messages: Message[] = [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ]
    let reminded = false
    let reply = ""
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal.aborted) return { ok: false, text: "Ended." }
      const answer = await brain.next(messages, specs, signal)
      const calls = answer.message.tool_calls ?? []
      reply = answer.message.content?.trim() ?? reply
      if (calls.length === 0) {
        if (reply || reminded) return { ok: true, text: reply || "The model finished without saying anything." }
        reminded = true
        messages.push({ role: "user", content: BLANK_REPLY_REMINDER })
        continue
      }
      messages.push(answer.message)
      for (const call of calls) {
        const owner = tools.find((t) => t.specs.some((s) => s.name === call.function.name))
        let content: string
        if (!owner) {
          content = `There is no tool called ${call.function.name}.`
        } else {
          try {
            const result = (await owner.client.callTool({ name: call.function.name, arguments: JSON.parse(call.function.arguments || "{}") as Record<string, unknown> })) as { content?: { type: string; text?: string }[] }
            content = (result.content ?? []).map((c) => c.text ?? "").join("\n")
          } catch (e) {
            content = `That call failed: ${(e as Error).message.split("\n")[0]}`
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content })
      }
    }
    return { ok: true, text: reply || "It used all its turns on this job." }
  }

  return {
    startJob: (prompt, system) => {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), JOB_LIMIT_MS)
      const done = runJob(prompt, system, abort.signal)
        .catch((e): JobResult => {
          if (e instanceof BrainBusy) {
            return {
              ok: false,
              retryAfterMs: e.retryAfterMs,
              text: /per day/i.test(e.message)
                ? `Today's allowance for ${model.model} is used up. It will keep trying, or you can choose another model at the top of this page.`
                : `${model.model} has reached its limit for now. It will try again by itself.`,
            }
          }
          return { ok: false, text: e instanceof BrainUnavailable ? `Cannot reach the model: ${e.message.split("\n")[0]}` : ((e as Error).message.split("\n")[0] ?? "The job failed.") }
        })
        .finally(() => clearTimeout(timer))
      return { done, kill: () => abort.abort() }
    },
    shutdown: async () => {
      if (!connected) return
      const tools = await connected.catch(() => [] as Connected[])
      await Promise.allSettled(tools.map((t) => t.client.close()))
    },
  }
}

/** The parts of an agent that are not its tools. Knowing them, and its tools, tells you exactly what it was. */
export const madeOf = (member: Member, thinking: Thinking): LoadedFile[] => {
  const model = thinking.kind === "claude" ? `claude-code:${thinking.model}` : thinking.model
  return [
    { kind: "model", name: model, version: "1.0.0", hash: hashBytes(`model:${model}`) },
    { kind: "prompt", name: `${member.id}-instructions`, version: "1.0.0", hash: hashBytes(`${member.role} ${SHARED_RULES}`) },
  ]
}

export const checkIntervalFor = (network: string, accessKey: string): number => (network === "local" ? CHECK_MS.local : accessKey ? CHECK_MS.keyed : CHECK_MS.publicEndpoint)

/** Runs one agent, in this process, until it closes. */
export async function runAgent(argv: readonly string[]): Promise<void> {
  const value = (name: string) => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  const member = memberNamed(value("--id") ?? "")
  const tools = JSON.parse(value("--tools") ?? "[]") as LoadedFile[]

  const home = homeDir()
  const config = loadConfig()
  const keys = loadKeys()
  const ledger = ledgerFor(config)
  const owner = config.owner.address
  const workspace = workspaceOf(home)

  const settings = readSettings()
  const thinking = chooseThinking(settings)
  if (!thinking) throw new Error("There is no model to think with.")
  const runner = thinking.kind === "api" ? modelRunner(home, member, settings) : { startJob: claudeJob(home, member, thinking.model), shutdown: async () => undefined }

  // Timed here, so the page can show what each check really cost and really read.
  const info = { block: "0", tookMs: 0, stopsRead: 0 }
  const inner: GuardNet = ledger.agentNet(keys.agent, PRODUCTION_TIMERS.heartbeatTtlSeconds)
  const net: GuardNet = {
    readView: async (policy: TrustPolicy, remembered: readonly Hex[]): Promise<GateView> => {
      const startedAt = Date.now()
      const view = await inner.readView(policy, remembered)
      info.block = String(view.block)
      info.tookMs = Date.now() - startedAt
      info.stopsRead = view.stops.length
      return view
    },
    writeLoadout: (seq, files) => inner.writeLoadout(seq, files),
    writeHeartbeat: (status, seq) => inner.writeHeartbeat(status, seq),
    writeAck: (intent, newHash) => inner.writeAck(intent, newHash),
    extendRecall: (key) => inner.extendRecall(key),
  }

  const guard = new Guard({
    policy: startingPolicy(owner),
    timers: { ...PRODUCTION_TIMERS, checkIntervalMs: checkIntervalFor(config.network, config.accessKey) },
    store: fileStore(inHome("gates", "_agent.json")),
    // Being stopped covers its own identity, its team and its owner's whole fleet, and so does recalling what it loaded.
    // Its model and instructions are part of what it is, so they count towards its fingerprint and can be recalled too.
    files: [...tools, ...madeOf(member, thinking), ...identityOf(config)],
    net,
    startSeq: BigInt(Date.now()),
  })

  let nudged = nudgeTime()
  const nudges = setInterval(() => {
    const now = nudgeTime()
    if (now !== nudged) {
      nudged = now
      void guard.check(true)
    }
  }, NUDGE_POLL_MS)

  mkdirSync(home, { recursive: true })
  const agent = new TeamAgent({
    member,
    address: config.agent.address,
    tools,
    guard,
    startJob: runner.startJob,
    shutdown: runner.shutdown,
    taskPath: (file) => join(workspace, "inbox", file),
    resultPath: (n) => join(workspace, "outbox", `result-${n}.txt`),
    unwatchedForMs: () => {
      try {
        return Date.now() - statSync(join(mainHome(), "team-watched")).mtimeMs
      } catch {
        return 0
      }
    },
    readInfo: () => info,
    write: (state) => writeAgentState(home, state),
    event: (event) => {
      appendFileSync(join(home, "events.jsonl"), `${JSON.stringify(event)}\n`)
      recordNote(event.kind, event.text, home, event.at)
    },
    exit: (code) => {
      clearInterval(nudges)
      process.exit(code)
    },
    firstJob: nextJobNumber(home),
  })

  // Asked to leave without a recall. Nothing of its own may be left running.
  const leave = () => {
    writeAgentState(home, { ...agent.snapshot, phase: "off", updatedAt: Date.now() })
    void runner.shutdown().finally(() => process.exit(0))
  }
  process.on("SIGTERM", leave)
  process.on("SIGINT", leave)

  await agent.start()
}

/** A restart carries on numbering where it left off, so it does not overwrite earlier work. */
function nextJobNumber(home: string): number {
  try {
    const events = readFileSync(join(home, "events.jsonl"), "utf8")
    return (events.match(/"kind":"job"/g)?.length ?? 0) + 1
  } catch {
    return 1
  }
}
