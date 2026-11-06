import { useState } from "react"
import { followersOf, isDismissed, isWithdrawn, recallCovers, type LoadedFile, type RecallRow } from "@ceasenet/core"
import { MeasureNpm } from "./IssuePage"
import { nameOf, trustForRecall, useNetworkView } from "./lib"

/** Answers one question for anyone, with no account: is this tool recalled? */
export function CheckPage() {
  const { data: view, error } = useNetworkView(5000)
  const [name, setName] = useState("")
  const [version, setVersion] = useState("")
  const [hash, setHash] = useState("")
  const [issuer, setIssuer] = useState("")

  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>

  const file: LoadedFile = { kind: "tool", name: name.trim(), version: version.trim(), hash: hash.trim() || "0x" }
  const live = (r: RecallRow) => {
    const lifts = view.lifts.filter((l) => l.recall === r.key)
    const trust = trustForRecall(r)
    return r.level === "STOP" ? !isWithdrawn(r, lifts, trust) : !isDismissed(r, lifts, trust)
  }
  const fromIssuer = (r: RecallRow) => !issuer.trim() || r.creator.toLowerCase() === issuer.trim().toLowerCase()
  const asked = Boolean(file.name || hash.trim())
  const matches = asked ? view.recalls.filter((r) => recallCovers(r, file) && live(r) && fromIssuer(r)) : []
  const stops = matches.filter((r) => r.level === "STOP" && followersOf(r, view.agents) > 0)
  const unfollowed = matches.filter((r) => r.level === "STOP" && followersOf(r, view.agents) === 0)

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
        <label>
          Only from this key, if you follow one
          <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="0x…" spellCheck={false} />
        </label>
      </div>
      <div className="card">
        <div className="small muted" style={{ marginBottom: 6 }}>
          Or measure a real package on npm, in this browser. Nothing is installed or run.
        </div>
        <MeasureNpm
          onMeasured={(measured) => {
            setName(measured.name)
            setVersion(measured.version)
            setHash(measured.hash)
          }}
        />
      </div>
      {asked && (
        <div className={`plate-head ${stops.length ? "red" : matches.length ? "amber" : "green"} result`}>
          {stops.length
            ? `Recalled by ${stops.length === 1 ? "one key" : `${stops.length} keys`} that owners follow. Check who issued it.`
            : unfollowed.length === matches.length && matches.length > 0
              ? "Someone recalled this, but no owner follows their key."
              : matches.length
                ? "There is a warning about this."
                : "Nothing on the list covers this."}
        </div>
      )}
      {matches.map((r) => (
        <div className="card" key={r.key}>
          <a className="big" href={`#/recall/${r.key}`}>
            {r.level === "STOP" ? "STOP" : "Warning"}
          </a>
          <p style={{ margin: "6px 0" }}>{r.reason}</p>
          {r.advice && <div className="notice">What to do: {r.advice}</div>}
          <div className="small muted" style={{ marginTop: 6 }}>
            Issued by {nameOf(r.creator)}, a key {followersOf(r, view.agents)} owner(s) follow
          </div>
        </div>
      ))}
      {asked && (
        <p className="small muted">
          Anyone can publish a recall, so what matters is who issued it: it binds an agent only if its owner follows that key. And nothing on the list does not prove a tool is safe.
        </p>
      )}
    </div>
  )
}
