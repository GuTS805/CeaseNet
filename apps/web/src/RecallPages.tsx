import { countConfirmations, fleetTrust, isDismissed, isWithdrawn, type Hex, type RecallRow } from "@ceasenet/core"
import { RecallBoardCard } from "./Board"
import { explorerAddress, shortHash, useFleetView } from "./lib"

const trust = fleetTrust()

const levelName = (r: RecallRow) => (r.level === "STOP" ? "STOP" : "Warning")

/** Every recall from a key this site trusts, newest first. */
export function RecallsPage() {
  const { data: view, error } = useFleetView(4000)
  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>
  return (
    <div className="page">
      <h1 style={{ marginBottom: 12 }}>Recalls</h1>
      {view.recalls.length === 0 && <p className="muted">No recalls on record.</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Level</th>
              <th>Reason</th>
              <th>File</th>
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
                <td className="mono muted">{shortHash(r.artifact)}</td>
                <td className="mono muted">{String(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** One recall: what it says, who issued it, who confirmed it and who obeyed. */
export function RecallPage({ recallKey }: { recallKey: Hex }) {
  const { data: view, error } = useFleetView(3000)
  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>
  const recall = view.recalls.find((r) => r.key === recallKey)
  if (!recall) {
    const receipt = view.acks.find((a) => a.recall === recallKey)
    return (
      <div className="page">
        <div className="notice bad">
          {receipt
            ? `This recall is no longer on Arkiv, but robots have receipted it, which proves it existed. Issuer ${receipt.issuer}, content hash ${receipt.recallHash}.`
            : "No trusted key has issued a recall with this key."}
        </div>
      </div>
    )
  }

  const lifts = view.lifts.filter((l) => l.recall === recall.key)
  const counts = countConfirmations(recall, view.endorsements, view.block, trust)
  const fix = lifts.find((l) => l.kind === "FIX")
  const ended = recall.level === "STOP" ? isWithdrawn(recall, lifts, trust) : isDismissed(recall, lifts, trust)

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
            <tr>
              <th>File</th>
              <td className="mono">{recall.artifact}</td>
            </tr>
            <tr>
              <th>Issued by</th>
              <td className="mono">
                <a href={explorerAddress(recall.creator)} target="_blank" rel="noreferrer">
                  {recall.creator}
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
          <p className="small muted">
            {counts.disputes} disputed. Robots slow down at {trust.threshold} confirmations within 72 hours, while confirmations
            outnumber disputes. Only the maker, a regulator or the publisher can stop them.
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Confirming with World ID comes with the verifier service.
          </p>
        </div>
      )}

      {fix && (
        <div className="card">
          <h2>Fix</h2>
          <p style={{ marginTop: 0 }}>{fix.note}</p>
          <div className="mono">{fix.fixedHash}</div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Robots that install this exact file return to work. Robots still on the old file stay stopped.
          </p>
        </div>
      )}

      <RecallBoardCard recall={recall} view={view} />
    </div>
  )
}
