import { useState } from "react"
import { CONFIRMATION_THRESHOLD, type Hex, openRecallMessage } from "@ceasenet/core"
import { forgetView } from "./lib"
import { NeedLogin, postVerifier, useLogin, useWorldConfig, VerifierError } from "./login"
import { useWallet, walletMessage } from "./wallet"

type Opened = { key: Hex; already?: boolean }

/**
 * Anyone logged in with World can open a normal recall on an agent or a tool. It does nothing by itself: people vote
 * on it, and at enough votes the owner of the agent decides whether to approve it.
 */
export function ReportPage({ agent }: { agent?: string }) {
  const { human, address } = useLogin()
  const { sign } = useWallet()
  const config = useWorldConfig()
  const [kind, setKind] = useState<"agent" | "tool">("agent")
  const [target, setTarget] = useState(agent ?? "")
  const [name, setName] = useState("")
  const [version, setVersion] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string>()
  const [opened, setOpened] = useState<Opened>()
  const [busy, setBusy] = useState(false)

  const aimedAt = kind === "agent" ? { kind, address: target.trim() } : { kind, name: name.trim(), ...(version.trim() ? { version: version.trim() } : {}) }
  // The same name the verifier gives it, since the wallet signs exactly this.
  const artifact = kind === "agent" ? `agent:${target.trim().toLowerCase()}` : `package:${name.trim()}`.toLowerCase()
  const text = reason.trim()
  const targetReady = kind === "agent" ? /^0x[0-9a-fA-F]{40}$/.test(target.trim()) : name.trim().length > 0
  const ready = text.length >= 10 && targetReady
  // A greyed-out button with no reason looks broken.
  const missing = !targetReady ? (kind === "agent" ? "the agent's address, which starts with 0x and is 42 characters long" : "the tool's package name") : text.length < 10 ? "what is wrong, in at least 10 characters" : undefined

  const open = async () => {
    if (!address) return
    setError(undefined)
    setBusy(true)
    try {
      const at = Date.now()
      const signature = await sign(openRecallMessage(artifact, text, at))
      const done = await postVerifier<{ key: Hex }>("/api/report", { target: aimedAt, reason: text, address, signature, at })
      setOpened({ key: done.key })
      forgetView()
    } catch (e) {
      // Someone got there first, which is not a failure: they can vote on it instead.
      if (e instanceof VerifierError && e.code === "already_reported" && e.key) setOpened({ key: e.key, already: true })
      else setError(walletMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (opened) {
    return (
      <div className="page" style={{ display: "grid", gap: 12 }}>
        <h1 style={{ marginBottom: 0 }}>{opened.already ? "Someone has already opened a recall on this" : "Your recall is open"}</h1>
        <div className="card">
          <p style={{ marginTop: 0 }}>
            {opened.already ? "You can add your vote to theirs." : "It counts as your vote."} At {CONFIRMATION_THRESHOLD} votes from different people, the owner of the agent can approve it, and only then does the agent stop.
          </p>
          <a href={`#/recall/${opened.key}`}>See it and its votes</a>
        </div>
      </div>
    )
  }

  return (
    <div className="page" style={{ display: "grid", gap: 12 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Open a recall</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Think an agent is doing something it should not, or a tool has gone bad? You do not need to own it. Open a normal recall, and others vote on it. At {CONFIRMATION_THRESHOLD} votes from different people, its owner can approve it. An agent obeys only its owner, so nobody else can switch it off.
        </p>
        <p className="small muted" style={{ marginTop: 0 }}>
          Own the agent? You do not need votes: <a href="#/issue">stop it yourself, now</a>.
        </p>
      </div>

      {!human || !address ? (
        <NeedLogin to="open a recall" next={agent ? `report/${agent}` : "report"} />
      ) : (
        <>
          <div className="card check-form">
            <label>
              What is it about?
              <select value={kind} onChange={(e) => setKind(e.target.value as "agent" | "tool")}>
                <option value="agent">An agent</option>
                <option value="tool">A tool</option>
              </select>
            </label>
            {kind === "agent" ? (
              <label style={{ gridColumn: "span 2" }}>
                The agent's address
                <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0x…" spellCheck={false} />
              </label>
            ) : (
              <>
                <label>
                  Package name
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="some-mcp-server" spellCheck={false} />
                </label>
                <label>
                  Version, if it is only one
                  <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.2.3" spellCheck={false} />
                </label>
              </>
            )}
            <label style={{ gridColumn: "1 / -1" }}>
              What is wrong? People will vote on this, and it is public.
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} placeholder="It keeps placing trades nobody asked for" />
            </label>
          </div>

          {config === undefined && <p className="small muted">Connecting to the CeaseNet verifier…</p>}
          {config === null && <div className="notice bad">The CeaseNet verifier is not reachable from here, so recalls cannot be opened. It runs with: npm run verifier</div>}
          {config && (
            <div className="buttons">
              <button className="primary" disabled={!ready || busy} onClick={() => void open()}>
                {busy ? "Waiting for your wallet, then the chain…" : "Sign and open this recall"}
              </button>
            </div>
          )}
          {config && missing && <p className="small muted">To open it, fill in {missing}.</p>}
          {config && !missing && (
            <p className="small muted">
              Your wallet signs it, which costs nothing. The verifier checks the signature and your login, then writes it to Arkiv in your name, {address}.
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </div>
  )
}
