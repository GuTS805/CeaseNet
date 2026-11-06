import { useState } from "react"
import { fetchNpmPackage, type LoadedFile, parseSpec } from "@ceasenet/core"
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

/** Issue a real STOP, signed by your own wallet and written straight to Arkiv. */
export function IssuePage() {
  const { address, writer } = useWallet()
  const [file, setFile] = useState<LoadedFile>({ kind: "tool", name: "", version: "", hash: "" })
  const [fileCount, setFileCount] = useState<number>()
  const [reason, setReason] = useState("")
  const [severity, setSeverity] = useState("CRITICAL")
  const [versions, setVersions] = useState("")
  const [advice, setAdvice] = useState("")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  const hashOk = /^0x[0-9a-fA-F]{64}$/.test(file.hash.trim())
  const ready = Boolean(writer && hashOk && file.name.trim() && reason.trim())

  const issue = async () => {
    if (!writer) return
    setBusy(true)
    setProblem(undefined)
    try {
      const { entityKey } = await writer.stop({
        artifact: file.hash.trim(),
        severity,
        reason: reason.trim(),
        pkg: file.name.trim(),
        versions: versions.trim() || undefined,
        advice: advice.trim() || undefined,
      })
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
        <h1 style={{ marginBottom: 4 }}>Recall a tool</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Anyone can issue a STOP. It binds only the agents whose owners chose to follow your key, so nobody can stop a tool on someone else's machine. It goes straight to Arkiv, with no server of ours.
        </p>
      </div>

      <WalletCard action="issue a recall" />

      <div className="card form">
        <h2>1. Which exact version?</h2>
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

        <h2>2. Why?</h2>
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
          <label>
            Also covers these versions (optional)
            <input value={versions} onChange={(e) => setVersions(e.target.value)} placeholder=">=1.0.0 <1.1.0" spellCheck={false} />
          </label>
        </div>
        <label>
          What should owners do? (optional)
          <input value={advice} onChange={(e) => setAdvice(e.target.value)} />
        </label>

        <h2>3. Sign it</h2>
        <div className="buttons">
          <button className="danger" disabled={!ready || busy} onClick={() => void issue()}>
            {busy ? "Waiting for your wallet and the chain…" : "Sign and publish this STOP"}
          </button>
        </div>
        {!hashOk && file.hash.trim() !== "" && <div className="error">A file hash is 0x followed by 64 characters.</div>}
        {problem && <div className="error">{problem}</div>}
        {address && (
          <p className="small muted" style={{ marginBottom: 0 }}>
            A STOP can't be edited, and you can only delete or withdraw it in public. Owners can follow your key at <a href={`#/protect/${address}`}>this link</a>.
          </p>
        )}
      </div>
    </div>
  )
}
