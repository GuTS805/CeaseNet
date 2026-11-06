import { useEffect, useState } from "react"
import { type CallVerdict, type DemoAgent, statusColour, statusLabel } from "../lib"
import type { MailLine } from "./events"
import { AGENT_H, AGENT_W, AGENT_X, agentCentre } from "./geometry"

export type Act = (name: string, path: string, body?: unknown) => Promise<unknown>

const VERDICT: Record<CallVerdict, { label: string; colour: string }> = {
  ALLOW: { label: "Allowed", colour: "green" },
  NEEDS_APPROVAL: { label: "Needs a human", colour: "amber" },
  BLOCK: { label: "Blocked", colour: "red" },
}

/** How long the model's own words stay on the map after it says something. */
const BUBBLE_MS = 16_000

function Countdown({ until }: { until: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [])
  return <>{Math.max(0, Math.ceil((until - Date.now()) / 1000))} s</>
}

function Approval({ agent, act, worldId, top }: { agent: DemoAgent; act: Act; worldId: boolean; top: number }) {
  const approval = agent.approval!
  return (
    <div className="slot approval" style={{ top }}>
      <div className="slot-title">
        {approval.action} needs a human
      </div>
      <div className="slot-text">
        {approval.tool} {approval.version}. Answer within <Countdown until={approval.expiresAt} />, or it is refused.
      </div>
      {approval.pass && (
        <div className="slot-text">
          <a href={approval.pass.url} target="_blank" rel="noreferrer">
            Open World ID
          </a>{" "}
          and enter <strong className="mono">{approval.pass.userCode}</strong>
        </div>
      )}
      <div className="buttons">
        {worldId ? (
          !approval.pass && (
            <button className="primary" onClick={() => void act("World ID", `/api/agents/${agent.id}/approval/world`)}>
              Approve with World ID
            </button>
          )
        ) : (
          <button className="primary" onClick={() => void act("Approve", `/api/agents/${agent.id}/approval`, { approve: true })}>
            Approve (stand-in)
          </button>
        )}
        <button onClick={() => void act("Refuse", `/api/agents/${agent.id}/approval`, { approve: false })}>Refuse</button>
      </div>
    </div>
  )
}

interface NodeProps {
  agent: DemoAgent
  index: number
  line: MailLine
  busy: boolean
  act: Act
  canUpdate: boolean
  worldId: boolean
  realModel: boolean
}

/** One company's agent: what its guard reports, and the last thing it really did. */
export function AgentNode({ agent, index, line, busy, act, canUpdate, worldId, realModel }: NodeProps) {
  const y = agentCentre(index)
  const latest = agent.feed.at(-1)
  const said = [...agent.feed].reverse().find((f) => f.kind === "said")
  const speaking = said && Date.now() - said.at < BUBBLE_MS ? said : undefined

  return (
    <>
      <div
        className={`node agent is-${line} ${agent.online ? "" : "offline"}`}
        style={{ left: AGENT_X, top: y - AGENT_H / 2, width: AGENT_W, height: AGENT_H }}
      >
        <div className="node-head">
          <a className="agent-name" href={`#/agent/${agent.address}`}>
            {agent.company}
          </a>
          <span className={`status ${statusColour(agent.status)}`}>{statusLabel(agent.status)}</span>
        </div>

        <div className="node-tools">
          {agent.tools.map((t) => (
            <div className={`node-tool ${t.verdict === "BLOCK" ? "blocked" : ""}`} key={t.file.hash}>
              <span className="node-tool-name">
                {t.file.name} {t.file.version}
              </span>
              <span className={`verdict ${VERDICT[t.verdict].colour}`}>{VERDICT[t.verdict].label}</span>
            </div>
          ))}
        </div>

        <div className="node-stats">
          <div>
            <b>{agent.sent}</b> sent
          </div>
          <div className={agent.stolen > 0 ? "bad" : ""}>
            <b key={agent.stolen} className="pop">
              {agent.stolen}
            </b>{" "}
            stolen
          </div>
          <div>
            <b>{agent.drafts}</b> drafts
          </div>
        </div>

        <div className={`node-now ${latest?.kind ?? ""}`} title={latest?.text}>
          {latest?.text ?? "Starting…"}
        </div>

        <div className="node-buttons">
          {canUpdate && (
            <button className="primary" disabled={busy} onClick={() => void act("Update", `/api/agents/${agent.id}/update`)}>
              Install fix
            </button>
          )}
          <button disabled={busy} onClick={() => void act("Connection", `/api/agents/${agent.id}/network`, { up: !agent.online })}>
            {agent.online ? "Cut off" : "Reconnect"}
          </button>
          {agent.followsMaker !== undefined && !canUpdate && (
            <button
              disabled={busy}
              title={agent.followsMaker ? "The owner stops following the maker, publicly, on Arkiv" : "The owner follows the maker again, publicly, on Arkiv"}
              onClick={() => void act("Trust list", `/api/owners/${agent.id}/follow-maker`, { follow: !agent.followsMaker })}
            >
              {agent.followsMaker ? "Unfollow" : "Follow maker"}
            </button>
          )}
        </div>

        {line === "cut" && <div className="stamp">Ceased</div>}
        {line === "fixed" && <div className="fixed-tag">Fixed</div>}
      </div>

      {agent.approval ? (
        <Approval agent={agent} act={act} worldId={worldId} top={y - 74} />
      ) : speaking ? (
        <div key={speaking.id} className="slot bubble" style={{ top: y - 62 }} title={speaking.requestId ? `Model request ${speaking.requestId}` : undefined}>
          <div className="slot-label">{realModel ? "The model's own words" : "Built-in rules, not a model"}</div>
          {speaking.text}
        </div>
      ) : agent.approvalNote ? (
        <div className="slot note" style={{ top: y - 40 }}>
          {agent.approvalNote}
        </div>
      ) : null}
    </>
  )
}
