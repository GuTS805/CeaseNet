import { useEffect, useState } from "react"
import { reportSignal } from "@ceasenet/core"
import { IDKitRequestWidget, proofOfHuman, type RpContext } from "@worldcoin/idkit"
import { forgetView, VERIFIER_URL } from "./lib"

interface WorldConfig {
  appId: `app_${string}`
  rpId: string
  action: string
  environment: "production" | "staging" | "sandbox"
  simulated?: boolean
}

type Filed = { key: string; simulated?: boolean; already?: boolean }

const post = async (path: string, body: unknown = {}): Promise<any> => {
  const res = await fetch(VERIFIER_URL + path, { method: "POST", body: JSON.stringify(body) })
  const json = (await res.json()) as { error?: string; code?: string; key?: string }
  // Someone got there first, which is not a failure: they can vote on it instead.
  if (res.status === 409 && json.key) return { key: json.key, already: true }
  if (!res.ok) throw new Error(json.error ?? "The verifier refused this.")
  return json
}

/**
 * Anyone can report an agent or a tool, once World ID has shown they are a real person.
 * The report does nothing by itself: people vote on it, and at enough votes the owner is told.
 */
export function ReportPage({ agent }: { agent?: string }) {
  const [kind, setKind] = useState<"agent" | "tool">("agent")
  const [address, setAddress] = useState(agent ?? "")
  const [name, setName] = useState("")
  const [version, setVersion] = useState("")
  const [reason, setReason] = useState("")
  const [config, setConfig] = useState<WorldConfig | null>()
  const [rpContext, setRpContext] = useState<RpContext>()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [filed, setFiled] = useState<Filed>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!VERIFIER_URL) return setConfig(null)
    fetch(`${VERIFIER_URL}/api/world-config`)
      .then((r) => r.json() as Promise<WorldConfig>)
      .then(setConfig)
      .catch(() => setConfig(null))
  }, [])

  const target = kind === "agent" ? { kind, address: address.trim() } : { kind, name: name.trim(), ...(version.trim() ? { version: version.trim() } : {}) }
  const artifact = kind === "agent" ? `agent:${address.trim().toLowerCase()}` : `package:${name.trim()}`.toLowerCase()
  const text = reason.trim()
  const targetReady = kind === "agent" ? /^0x[0-9a-fA-F]{40}$/.test(address.trim()) : name.trim().length > 0
  const ready = text.length >= 10 && targetReady
  // A greyed-out button with no reason looks broken.
  const missing = !targetReady ? (kind === "agent" ? "the agent's address, which starts with 0x and is 42 characters long" : "the tool's package name") : text.length < 10 ? "what is wrong, in at least 10 characters" : undefined

  const start = async () => {
    setError(undefined)
    setBusy(true)
    try {
      const sig = await post("/api/rp-signature")
      setRpContext({ rp_id: config!.rpId, nonce: sig.nonce, created_at: sig.created_at, expires_at: sig.expires_at, signature: sig.sig })
      setOpen(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const fileSimulated = async () => {
    setError(undefined)
    setBusy(true)
    try {
      setFiled(await post("/api/simulated/report", { target, reason: text }))
      forgetView()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (filed) {
    return (
      <div className="page" style={{ display: "grid", gap: 12 }}>
        <h1 style={{ marginBottom: 0 }}>{filed.already ? "Someone has already reported this" : "Your report is filed"}</h1>
        <div className="card">
          <p style={{ marginTop: 0 }}>
            {filed.already ? "You can add your vote to theirs." : "It counts as your vote."} When enough different people have voted, its owner is told, and they decide whether to issue a recall.
            {filed.simulated ? " This one was filed by a simulated person, and it says so on the record." : ""}
          </p>
          <a href={`#/recall/${filed.key}`}>See the report and its votes</a>
        </div>
      </div>
    )
  }

  return (
    <div className="page" style={{ display: "grid", gap: 12 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Report an agent or a tool</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Think an agent is doing something it should not, or a tool has gone bad? You do not need to own it. World ID shows you are a real person, without saying who. Others vote the same way, and at enough votes the owner is told.
        </p>
      </div>
      <div className="card check-form">
        <label>
          What are you reporting?
          <select value={kind} onChange={(e) => setKind(e.target.value as "agent" | "tool")}>
            <option value="agent">An agent</option>
            <option value="tool">A tool</option>
          </select>
        </label>
        {kind === "agent" ? (
          <label style={{ gridColumn: "span 2" }}>
            The agent's address
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} />
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
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} placeholder="It copies every email it sends to an address nobody configured" />
        </label>
      </div>

      {config === undefined && <p className="small muted">Connecting to the World ID service…</p>}
      {config === null && <div className="notice bad">The World ID service is not reachable from here, so reports cannot be filed. It runs with: npm run verifier</div>}
      {config && (
        <div className="buttons">
          <button className="primary" disabled={!ready || busy} onClick={() => void start()}>
            {busy ? "Working, which takes a few seconds…" : "File with World ID"}
          </button>
          {config.simulated && (
            <button disabled={!ready || busy} onClick={() => void fileSimulated()}>
              File as a simulated person
            </button>
          )}
        </div>
      )}
      {config && missing && <p className="small muted">To file this, fill in {missing}.</p>}
      {error && <p className="error">{error}</p>}
      {config && config.environment !== "production" && (
        <p className="small muted">
          Test mode: use the{" "}
          <a href="https://simulator.worldcoin.org/" target="_blank" rel="noreferrer">
            World ID simulator
          </a>{" "}
          instead of a phone. It can only ever be one identity, so simulated people stand in for the others, and are marked as simulated on the record.
        </p>
      )}
      {rpContext && config && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) setRpContext(undefined)
          }}
          app_id={config.appId}
          action={config.action}
          rp_context={rpContext}
          environment={config.environment}
          allow_legacy_proofs={false}
          preset={proofOfHuman({ signal: reportSignal(artifact, text) })}
          handleVerify={async (result) => {
            try {
              setFiled(await post("/api/report", { target, reason: text, result }))
              forgetView()
            } catch (e) {
              setError((e as Error).message)
              throw e
            }
          }}
          onSuccess={() => undefined}
          onError={(code) => setError((current) => current ?? `Not filed: World ID reported ${code}.`)}
        />
      )}
    </div>
  )
}
