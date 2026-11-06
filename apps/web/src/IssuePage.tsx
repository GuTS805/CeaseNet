import { useState } from "react"
import { agentArtifact, fetchNpmPackage, type LoadedFile, lower, parseSpec } from "@ceasenet/core"
import { forgetView, useNetworkView } from "./lib"
import { useWallet, WalletCard, walletMessage } from "./wallet"

/** Measures one version of a package in this browser: nothing is installed or run. */
export function MeasureNpm({ onMeasured, label = "Measure from npm" }: { onMeasured: (file: LoadedFile, fileCount: number) => void; label?: string }) {
  const [spec, setSpec] = useState("")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const measure = async () => {
    setBusy(true)
    setProblem(undefined)
    try {
      const { file, files } = await fetchNpmPackage(parseSpec(spec))
      onMeasured(file, files.length)
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="measure">
      <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="package@1.2.3" spellCheck={false} aria-label="Package and version on npm" />
      <button disabled={busy || !spec.trim()} onClick={() => void measure()}>
        {busy ? "Measuring…" : label}
      </button>
      {problem && <div className="error">{problem}</div>}
    </div>
  )
}

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]

/**
 * An owner stops their own agent, or a tool on their own agents, at once. No votes are needed: the agent obeys its
 * owner's wallet. The STOP is signed by that wallet and written straight to Arkiv.
 */
export function IssuePage() {
  const { address, writer } = useWallet()
  const { data: view } = useNetworkView(6000)
  const mine = view && address ? view.agents.filter((a) => lower(a.agent.owner) === lower(address)) : []
  const [target, setTarget] = useState<"agent" | "tool">("agent")
  const [picked, setPicked] = useState("")
  const agentPicked = mine.find((a) => a.agent.agent === picked) ?? mine[0]
  const [file, setFile] = useState<LoadedFile>({ kind: "tool", name: "", version: "", hash: "" })
  const [fileCount, setFileCount] = useState<number>()
  const [reason, setReason] = useState("")
  const [severity, setSeverity] = useState("CRITICAL")
  const [versions, setVersions] = useState("")
  const [advice, setAdvice] = useState("")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  const hashOk = /^0x[0-9a-fA-F]{64}$/.test(file.hash.trim())
  const ready = Boolean(writer && reason.trim() && (target === "agent" ? agentPicked : hashOk && file.name.trim()))

  const issue = async () => {
    if (!writer) return
    setBusy(true)
    setProblem(undefined)
    try {
      const { entityKey } = await writer.stop(
        target === "agent" && agentPicked
          ? { artifact: agentArtifact(agentPicked.agent.agent), severity, reason: reason.trim(), advice: advice.trim() || undefined }
          : {
              artifact: file.hash.trim(),
              severity,
              reason: reason.trim(),
              pkg: file.name.trim(),
              versions: versions.trim() || undefined,
              advice: advice.trim() || undefined,
            },
      )
      forgetView()
      window.location.hash = `#/recall/${entityKey}`
    } catch (e) {
      setProblem(walletMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page" style={{ display: "grid", gap: 12 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Stop it as the owner</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          An agent obeys only its owner, so your STOP binds your own agents, at once, with no votes. A STOP from anyone else does nothing to them. It goes straight to Arkiv, signed by your wallet, with no server of ours. Not the owner? <a href="#/report">Open a normal recall</a> instead.
        </p>
      </div>

      <WalletCard action="stop your agent" />

      <div className="card form">
        <label>
          What to stop
          <select value={target} onChange={(e) => setTarget(e.target.value as "agent" | "tool")}>
            <option value="agent">One of my agents, entirely</option>
            <option value="tool">A tool, on all my agents</option>
          </select>
        </label>
        {target === "agent" ? (
          mine.length === 0 ? (
            <div className="notice">
              {address ? `No agent on the list answers to ${address.slice(0, 10)}… yet.` : "Connect your wallet to see your agents."} <a href="#/register">Register one</a>.
            </div>
          ) : (
            <label>
              Which agent
              <select value={agentPicked?.agent.agent ?? ""} onChange={(e) => setPicked(e.target.value)}>
                {mine.map((a) => (
                  <option key={a.agent.agent} value={a.agent.agent}>
                    {a.agent.name} ({a.agent.agent.slice(0, 10)}…)
                  </option>
                ))}
              </select>
            </label>
          )
        ) : (
          <>
        <MeasureNpm
          onMeasured={(measured, count) => {
            setFile(measured)
            setFileCount(count)
          }}
        />
        <div className="form-row">
          <label>
            Package name
            <input value={file.name} onChange={(e) => setFile({ ...file, name: e.target.value })} spellCheck={false} />
          </label>
          <label>
            Version
            <input value={file.version} onChange={(e) => setFile({ ...file, version: e.target.value })} spellCheck={false} />
          </label>
        </div>
        <label>
          Exact file hash
          <input value={file.hash} onChange={(e) => setFile({ ...file, hash: e.target.value })} placeholder="0x…" spellCheck={false} />
        </label>
        <p className="small muted">
          {fileCount ? `Measured ${fileCount} files, in this browser. Nothing was installed or run. ` : ""}
          For something not on npm, run <code>ceasenet check ./folder</code> and paste the hash it prints.
        </p>
          </>
        )}

        <h2>Why?</h2>
        <label>
          What is wrong with it
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </label>
        <div className="form-row">
          <label>
            Severity
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {SEVERITIES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          {target === "tool" && (
            <label>
              Also covers these versions (optional)
              <input value={versions} onChange={(e) => setVersions(e.target.value)} placeholder=">=1.0.0 <1.1.0" spellCheck={false} />
            </label>
          )}
        </div>
        <label>
          What should be done about it? (optional)
          <input value={advice} onChange={(e) => setAdvice(e.target.value)} />
        </label>

        <h2>Sign it</h2>
        <div className="buttons">
          <button className="danger" disabled={!ready || busy} onClick={() => void issue()}>
            {busy ? "Waiting for your wallet and the chain…" : "Sign and publish this STOP"}
          </button>
        </div>
        {target === "tool" && !hashOk && file.hash.trim() !== "" && <div className="error">A file hash is 0x followed by 64 characters.</div>}
        {problem && <div className="error">{problem}</div>}
        <p className="small muted" style={{ marginBottom: 0 }}>
          A STOP can't be edited. You can withdraw it later, in public, from its page, and your agents start again.
        </p>
      </div>
    </div>
  )
}
