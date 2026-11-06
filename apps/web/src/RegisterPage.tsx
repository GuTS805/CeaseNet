import { useState } from "react"
import { type Hex, lower, readAgent } from "@ceasenet/core"
import { approvalsOf, client, enoughVotes, forgetView, isNormalRecall, ownersFor, shortHash, statusColour, statusLabel, useNetworkView } from "./lib"
import { NeedLogin, useLogin } from "./login"
import { useWallet, WalletCard, walletMessage } from "./wallet"

const FRAMEWORKS = ["Claude Code", "Claude Desktop", "Cursor", "OpenAI Agents SDK", "LangChain", "CrewAI", "Custom"]

/** The agent's own key makes these. Its owner's passport is what ties it to them. */
const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v.trim())

/**
 * An owner registers an agent: a passport on Arkiv, signed by the owner's own wallet. From then on the agent answers
 * to that wallet, and obeys nothing else. People can open recalls on it, and its owner decides.
 */
export function RegisterPage() {
  const { human, address } = useLogin()
  const { writer } = useWallet()
  const [agent, setAgent] = useState("")
  const [name, setName] = useState("")
  const [framework, setFramework] = useState(FRAMEWORKS[0]!)
  const [purpose, setPurpose] = useState("")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [done, setDone] = useState<Hex>()

  const ready = Boolean(writer && isAddress(agent) && name.trim() && purpose.trim().length >= 10)
  const missing = !isAddress(agent)
    ? "the agent's address, which starts with 0x and is 42 characters long"
    : !name.trim()
      ? "a name for it"
      : purpose.trim().length < 10
        ? "what it does, in at least 10 characters"
        : undefined

  const register = async () => {
    if (!writer || !address) return
    setBusy(true)
    setProblem(undefined)
    try {
      const existing = await readAgent(client, agent.trim() as Hex)
      if (existing) {
        setProblem(lower(existing.owner) === lower(address) ? "You have already registered this agent." : `Another owner, ${shortHash(existing.owner)}, has already registered this agent.`)
        return
      }
      await writer.agent({ agent: agent.trim() as Hex, name: name.trim(), framework, purpose: purpose.trim() })
      forgetView()
      setDone(agent.trim() as Hex)
    } catch (e) {
      setProblem(walletMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page" style={{ display: "grid", gap: 12 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Register an agent</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Your wallet signs the agent's passport on Arkiv. From then on the agent matches its owner's wallet, yours, and obeys only you: a STOP from anyone else does nothing to it. People can open recalls on it and vote, and you decide.
        </p>
      </div>

      {!human || !address ? (
        <NeedLogin to="register an agent" next="register" />
      ) : done ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Registered</h2>
          <p style={{ marginTop: 0 }}>
            {name.trim()} now answers to you, {shortHash(address)}. It shows up on the network in a few seconds.
          </p>
          <div className="buttons">
            <a className="button primary" href={`#/agent/${done}`}>
              See its page
            </a>
            <button
              onClick={() => {
                setDone(undefined)
                setAgent("")
                setName("")
                setPurpose("")
              }}
            >
              Register another
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>1. Give the agent its own key</h2>
            <p style={{ marginTop: 0 }}>On the machine the agent runs on, run this. It makes the agent's key there, and makes it answer to your wallet. Your own key never leaves your wallet.</p>
            <pre className="mono">
              ceasenet init --name "My agent" --owner {address}
              {"\n"}ceasenet protect
            </pre>
            <p className="small muted" style={{ marginBottom: 0 }}>
              It prints the agent's address: paste it below. <code>ceasenet protect</code> puts the gate in front of the agent's MCP tools, so a STOP from you closes them. To get <code>ceasenet</code>, run <code>npm run install-cli</code> inside a clone of the repository. If this machine already has a CeaseNet agent, give the new one a folder of its own first. In PowerShell: <code>{'$env:CEASENET_HOME = "$HOME\\.ceasenet-2"'}</code>
            </p>
          </div>

          <div className="card form">
            <h2>2. Its passport</h2>
            <label>
              The agent's address
              <input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="0x…" spellCheck={false} />
            </label>
            <div className="form-row">
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Invoice assistant" />
              </label>
              <label>
                Built with
                <select value={framework} onChange={(e) => setFramework(e.target.value)}>
                  {FRAMEWORKS.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              What it does
              <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} maxLength={400} placeholder="Reads incoming invoices and drafts replies. It never sends money." />
            </label>

            <h2>3. Sign it</h2>
            <WalletCard action="register an agent" />
            <div className="buttons">
              <button className="primary" disabled={!ready || busy} onClick={() => void register()}>
                {busy ? "Waiting for your wallet and the chain…" : "Sign and register"}
              </button>
            </div>
            {missing && <p className="small muted" style={{ margin: 0 }}>To register, fill in {missing}.</p>}
            {problem && <div className="error">{problem}</div>}
          </div>
        </>
      )}

      {address && <YourAgents owner={address} />}
    </div>
  )
}

/** The agents this wallet owns, and the normal recalls on them that are waiting for its decision. */
function YourAgents({ owner }: { owner: Hex }) {
  const { data: view } = useNetworkView(6000)
  if (!view) return null
  const mine = view.agents.filter((a) => lower(a.agent.owner) === lower(owner))
  const waiting = view.recalls.filter((r) => isNormalRecall(r) && ownersFor(r, view).has(lower(owner)) && !approvalsOf(r, view).some((a) => lower(a.creator) === lower(owner)))
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Your agents</h2>
      {mine.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          No agent on the list answers to {shortHash(owner)} yet.
        </p>
      ) : (
        <table>
          <tbody>
            {mine.map((a) => (
              <tr key={a.agent.key}>
                <td>
                  <a href={`#/agent/${a.agent.agent}`}>{a.agent.name}</a>
                </td>
                <td className="mono muted">{shortHash(a.agent.agent)}</td>
                <td>
                  <span className={`status ${statusColour(a.heartbeat?.mode)}`}>{statusLabel(a.heartbeat?.mode)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {waiting.length > 0 && (
        <>
          <h2>Recalls on your agents</h2>
          <table>
            <tbody>
              {waiting.map((r) => (
                <tr key={r.key}>
                  <td>
                    <a href={`#/recall/${r.key}`}>{r.reason}</a>
                  </td>
                  <td>{enoughVotes(r, view) ? <span className="status amber">Ready for your decision</span> : <span className="status grey">Collecting votes</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
