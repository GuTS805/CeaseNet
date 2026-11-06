import { countConfirmations, demoPolicy, type Hex, isDismissed, isWithdrawn, type RecallRow, trustFromPolicy } from "@ceasenet/core"
import { RecallBoardCard } from "./Board"
import { explorerAddress, nameOf, shortHash, usePublicView } from "./lib"
import { WorldConfirm } from "./WorldConfirm"

const trust = trustFromPolicy(demoPolicy())

const levelName = (r: RecallRow) => (r.level === "STOP" ? "STOP" : "Warning")

/** Every recall from a key the demo's owners follow, newest first. */
export function RecallsPage() {
  const { data: view, error } = usePublicView(4000)
  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>
  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>Recalls</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Read straight from Arkiv in your browser. No server of ours is involved.
      </p>
      {view.recalls.length === 0 && <p className="muted">No recalls on record.</p>}
      {view.recalls.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Level</th>
                <th>Reason</th>
                <th>Issued by</th>
                <th>Block</th>
              </tr>
            </thead>
            <tbody>
              {view.recalls.slice(0, 50).map((r) => (
                <tr key={r.key}>
                  <td>
                    <a href={`#/recall/${r.key}`}>{levelName(r)}</a>
                  </td>
                  <td>{r.reason}</td>
                  <td>{nameOf(r.creator)}</td>
                  <td className="mono muted">{String(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** One recall: what it says, who issued it, who confirmed it and who obeyed. */
export function RecallPage({ recallKey }: { recallKey: Hex }) {
  const { data: view, error } = usePublicView(3000)
  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>
  const recall = view.recalls.find((r) => r.key === recallKey)
  if (!recall) {
    const receipt = view.acks.find((a) => a.recall === recallKey)
    return (
      <div className="page">
        <div className="notice bad">
          {receipt
            ? `This recall is no longer on Arkiv, but agents posted receipts for it, which proves it existed. Issued by ${nameOf(receipt.issuer)} (${receipt.issuer}), content hash ${receipt.recallHash}.`
            : "No key the demo's owners follow has issued a recall with this key."}
        </div>
      </div>
    )
  }

  const lifts = view.lifts.filter((l) => l.recall === recall.key)
  const counts = countConfirmations(recall, view.endorsements, view.block, trust)
  const fix = lifts.find((l) => l.kind === "FIX")
  const ended = recall.level === "STOP" ? isWithdrawn(recall, lifts, trust) : isDismissed(recall, lifts, trust)
  const known = view.artifacts.find((a) => a.hash.toLowerCase() === recall.artifact.toLowerCase())

  return (
    <div className="page" style={{ display: "grid", gap: 12 }}>
      <div className="card">
        <div className="row between">
          <h1>{levelName(recall)}</h1>
          <span className={`status ${ended ? "grey" : recall.level === "STOP" ? "red" : "amber"}`}>
            {ended ? "Ended" : recall.severity}
          </span>
        </div>
        <p>{recall.reason}</p>
        {recall.advice && <div className="notice">What to do: {recall.advice}</div>}
        <table>
          <tbody>
            {known && (
              <tr>
                <th>Tool</th>
                <td>
                  {known.name} {known.version}
                </td>
              </tr>
            )}
            <tr>
              <th>Exact file</th>
              <td className="mono">{recall.artifact}</td>
            </tr>
            {recall.pkg && recall.versions && (
              <tr>
                <th>Also covers</th>
                <td>
                  {recall.pkg} {recall.versions}
                </td>
              </tr>
            )}
            <tr>
              <th>Issued by</th>
              <td>
                {nameOf(recall.creator)}{" "}
                <a className="mono" href={explorerAddress(recall.creator)} target="_blank" rel="noreferrer">
                  {shortHash(recall.creator)}
                </a>
              </td>
            </tr>
            <tr>
              <th>Created at block</th>
              <td className="mono">{String(recall.createdAt)}</td>
            </tr>
            <tr>
              <th>Evidence</th>
              <td>{recall.sealedEvidence ? "Sealed until disclosure" : "None attached"}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {recall.level === "ADVISORY" && (
        <div className="card">
          <h2>Confirmed by real people</h2>
          <div className="big">
            {counts.confirms} of {trust.threshold}
          </div>
          <div className="meter">
            <div style={{ width: `${Math.min(100, (counts.effective / trust.threshold) * 100)}%` }} />
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {counts.disputes} disputed. At {trust.threshold} confirmations within 72 hours, while confirmations outnumber disputes,
            agents must ask a human before using this tool. Only the keys an owner follows can stop it outright.
          </p>
          <div style={{ marginTop: 10 }}>
            <WorldConfirm recall={recall.key} />
          </div>
        </div>
      )}

      {fix && (
        <div className="card">
          <h2>Fix{fix.fixedVersion ? `: version ${fix.fixedVersion}` : ""}</h2>
          <p style={{ marginTop: 0 }}>{fix.note}</p>
          <div className="mono">{fix.fixedHash}</div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Agents that move to this exact file use the tool again. Agents still on the old file stay blocked.
          </p>
        </div>
      )}

      <RecallBoardCard recall={recall} view={view} />
    </div>
  )
}
