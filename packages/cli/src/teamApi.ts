import { type Hex, type LoadedFile, recallCovers } from "@ceasenet/core"
import { explainWriteError, type RecallLike } from "./actions"
import { chooseThinking, claudeAvailable, listModels, markWatched, memberView, type PreparedTool, prepareMember, prepareTools, shutDownMember, startMember, selfForFleet, TEAM, testModel, THINKING_SETTING, TOOLS, type ToolDefinition } from "./fleet"
import { type Config, homeDir, type Keys } from "./home"
import type { Ledger } from "./ledger"
import { readSettings, saveSetting } from "./settings"

export interface TeamContext {
  config: Config
  ledger: Ledger
  keys: Keys
  /** When a person pressed Stop for each recall, so the page can say how long closing really took. */
  pressed: ReadonlyMap<string, number>
  recalls: () => RecallLike[]
  block: () => string | undefined
}

/** How much of the owner's wallet each agent is given, once, to pay for its own reports. */
const AGENT_SHARE_DIVISOR = 16n
const MODEL_LIST_MS = 5 * 60_000

const installedTools = (prepared: PreparedTool[] | undefined): (ToolDefinition & { file?: LoadedFile })[] => {
  if (prepared) return prepared
  try {
    return prepareTools()
  } catch {
    return Object.values(TOOLS)
  }
}

/** Everything the agents' page reads, and what it can ask for. */
export function teamRoutes(ctx: TeamContext) {
  const { config, ledger, keys, pressed } = ctx
  const owner = config.owner.address
  let preparing: string | undefined
  let startError: string | undefined
  let prepared: PreparedTool[] | undefined
  let models: { at: number; list: string[] } | undefined
  const refreshModels = () => {
    if (models && Date.now() - models.at < MODEL_LIST_MS) return
    models = { at: Date.now(), list: models?.list ?? [] }
    listModels(readSettings())
      .then((list) => {
        models = { at: Date.now(), list }
      })
      .catch(() => undefined)
  }

  /** Passports tie each agent to its owner, and on the public list each needs a little money for its own reports. */
  const registerAndFund = async (members: { name: string; address: Hex }[]) => {
    if (!keys.owner) return
    const mine = await ledger.balance(owner)
    if (mine === 0n) return
    const writer = ledger.writer(keys.owner)
    const known = new Set((await ledger.agents(owner)).map((a) => a.agent.toLowerCase()))
    for (const m of members) {
      if (!known.has(m.address.toLowerCase())) await writer.agent({ agent: m.address, name: m.name, framework: "MCP", purpose: "One of three paper trading agents that show how CeaseNet works." })
    }
    if (ledger.kind !== "arkiv" || !mine) return
    const share = mine / AGENT_SHARE_DIVISOR
    for (const m of members) {
      const has = (await ledger.balance(m.address)) ?? 0n
      if (has * 2n < share) await writer.send(m.address, share)
    }
  }

  const start = async (ids?: string[]) => {
    const thinking = chooseThinking(readSettings())
    if (!thinking) throw new Error("There is no model to think with. Add MODEL_API_KEY with ceasenet import-settings, or install Claude Code and log in.")
    if (preparing) throw new Error("They are already starting.")
    startError = undefined
    const chosen = TEAM.filter((m) => !ids || ids.includes(m.id))
    const self = selfForFleet()
    const terminals: string[] = []
    const background: string[] = []
    const running: string[] = []
    try {
      preparing = "Measuring their tools"
      prepared = prepareTools()
      preparing = ledger.kind === "arkiv" ? "Registering them on Arkiv and funding their wallets" : "Registering them"
      const members = chosen.map((m) => {
        const made = prepareMember(m, config, self, homeDir())
        return { name: m.name, address: made.agent.address }
      })
      await registerAndFund(members).catch((e) => {
        startError = explainWriteError(e, owner).message
      })
      preparing = "Starting them"
      const compact = readSettings().AGENT_TERMINALS === "compact"
      for (const m of chosen) {
        if (memberView(m).alive) running.push(m.name)
        else (startMember(m, homeDir(), self, prepared, { compact }) === "terminal" ? terminals : background).push(m.name)
      }
    } finally {
      preparing = undefined
    }
    return { started: chosen.map((m) => m.id), terminals, background, running }
  }

  return {
    "GET /api/team": () => {
      markWatched()
      const settings = readSettings()
      const recalls = ctx.recalls()
      const members = TEAM.map((m) => {
        const view = memberView(m)
        const closed = view.state?.closed
        const pressedAt = closed?.recall ? pressed.get(closed.recall) : undefined
        const recall = closed?.recall ? recalls.find((r) => r.key === closed.recall) : undefined
        return {
          ...view,
          closedAfterMs: closed && pressedAt ? Math.max(0, closed.at - pressedAt) : undefined,
          recallEnded: recall?.ended,
          recallMine: recall?.mine,
          receiptPosted: Boolean(view.address && recall?.receiptAgents?.includes(view.address.toLowerCase())),
        }
      })
      const tools = installedTools(prepared).map((tool) => {
        const covering = tool.file && tool.file.hash ? recalls.find((r) => !r.ended && r.level === "STOP" && recallCovers(r as never, tool.file!)) : undefined
        return {
          id: tool.id,
          label: tool.label,
          spec: tool.spec,
          file: tool.file,
          usedBy: TEAM.filter((m) => m.tools.includes(tool.id)).map((m) => m.name),
          recall: covering && { key: covering.key, reason: covering.reason, mine: covering.mine },
        }
      })
      const teamRecall = recalls.find((r) => !r.ended && r.artifact.startsWith("team:"))
      refreshModels()
      const thinking = chooseThinking(settings)
      const current = thinking?.kind === "claude" ? "claude" : thinking?.model
      return {
        network: config.network,
        block: ctx.block(),
        thinking,
        choices: [...new Set([...(models?.list ?? []), ...(current && current !== "claude" ? [current] : [])])].map((m) => ({ value: m, label: m })).concat(claudeAvailable().ok ? [{ value: "claude", label: "Claude Code, on your plan" }] : []),
        choice: current,
        preparing,
        startError,
        members,
        tools,
        teamRecall: teamRecall && { key: teamRecall.key, reason: teamRecall.reason },
        canSign: Boolean(keys.owner),
      }
    },
    "POST /api/team/start": (b: Record<string, unknown>) => start(Array.isArray(b.ids) ? (b.ids as string[]) : undefined),
    /** Tries the model first, since nothing but asking says whether it can do this work today. Those running move to it. */
    "POST /api/team/thinking": async (b: Record<string, unknown>) => {
      const choice = String(b.choice ?? "")
      if (!choice) throw new Error("Say which model.")
      if (choice === "claude") {
        const claude = claudeAvailable()
        if (!claude.ok) throw new Error(claude.problem)
      } else {
        const result = await testModel(readSettings(), choice)
        if (!result.ok) throw new Error(result.limited ?? result.problem)
      }
      saveSetting(THINKING_SETTING, choice)
      const running = TEAM.filter((m) => memberView(m).alive)
      for (const m of running) shutDownMember(m)
      if (running.length > 0) await start(running.map((m) => m.id))
      return { choice }
    },
    /** Ends them with no recall, which is how you put the demonstration away. */
    "POST /api/team/shutdown": () => {
      for (const m of TEAM) shutDownMember(m)
      return { shutDown: true }
    },
  }
}
