import { useState } from "react"
import { isDismissed, isWithdrawn, recallCovers, demoPolicy, trustFromPolicy, type LoadedFile, type RecallRow } from "@ceasenet/core"
import { nameOf, usePublicView } from "./lib"

const trust = trustFromPolicy(demoPolicy())

/** Answers one question for anyone, with no account: is this tool recalled? */
export function CheckPage() {
  const { data: view, error } = usePublicView(5000)
  const [name, setName] = useState("demo-mail-tool")
  const [version, setVersion] = useState("1.0.16")
  const [hash, setHash] = useState("")

  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>

  const file: LoadedFile = { kind: "tool", name: name.trim(), version: version.trim(), hash: hash.trim() || "0x" }
  const live = (r: RecallRow) => {
    const lifts = view.lifts.filter((l) => l.recall === r.key)
    return r.level === "STOP" ? !isWithdrawn(r, lifts, trust) : !isDismissed(r, lifts, trust)
  }
  const matches = view.recalls.filter((r) => recallCovers(r, file) && live(r))
  const stops = matches.filter((r) => r.level === "STOP")

  return (
    <div className="page" style={{ display: "grid", gap: 12 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Is this tool recalled?</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Your browser reads the whole list from Arkiv and checks it here, so nobody learns which tool you asked about.
        </p>
      </div>
      <div className="card check-form">
        <label>
          Package name
          <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>
        <label>
          Version
          <input value={version} onChange={(e) => setVersion(e.target.value)} spellCheck={false} />
        </label>
        <label>
          Exact hash, if you have it
          <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" spellCheck={false} />
        </label>
      </div>
      <div className={`plate-head ${stops.length ? "red" : matches.length ? "amber" : "green"} result`}>
        {stops.length ? "Recalled. Do not use this." : matches.length ? "There is a warning about this." : "Nothing on the list covers this."}
      </div>
      {matches.map((r) => (
        <div className="card" key={r.key}>
          <a className="big" href={`#/recall/${r.key}`}>
            {r.level === "STOP" ? "STOP" : "Warning"}
          </a>
          <p style={{ margin: "6px 0" }}>{r.reason}</p>
          {r.advice && <div className="notice">What to do: {r.advice}</div>}
          <div className="small muted" style={{ marginTop: 6 }}>
            Issued by {nameOf(r.creator)}
          </div>
        </div>
      ))}
      {matches.length === 0 && (
        <p className="small muted">This only means no key the demo's owners follow has recalled it. It does not prove a tool is safe.</p>
      )}
    </div>
  )
}
