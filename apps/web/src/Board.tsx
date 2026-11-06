import { type BoardRow, buildRecallBoard, type FleetView, type RecallRow, type RobotRecallState } from "@ceasenet/core"
import { shortHash } from "./lib"

const STATE: Record<RobotRecallState, { label: string; colour: string }> = {
  FIXED: { label: "Fixed", colour: "green" },
  STOPPED: { label: "Stopped, receipt posted", colour: "red" },
  SLOWED: { label: "Slowed, receipt posted", colour: "amber" },
  SILENT: { label: "Silent", colour: "grey" },
  NO_RECEIPT: { label: "Running, no receipt", colour: "amber" },
}

function Row({ row }: { row: BoardRow }) {
  const s = STATE[row.state]
  return (
    <tr>
      <td>
        <a href={`#/plate/${row.robot.robot}`}>{row.robot.serial}</a>
        <div className="muted small">{row.robot.city}</div>
      </td>
      <td>
        <span className={`status ${s.colour}`}>{s.label}</span>
      </td>
      <td className="mono muted">{row.loadout?.files.find((f) => f.kind === "policy")?.version ?? "?"}</td>
    </tr>
  )
}

/** Who a recall affects and whether they obeyed, built from public records alone. */
export function RecallBoardCard({ recall, view }: { recall: RecallRow; view: FleetView }) {
  const board = buildRecallBoard(recall, view.robots, view.acks)
  const extras = [
    board.silent > 0 ? `${board.silent} silent` : "",
    board.noReceipt > 0 ? `${board.noReceipt} with no receipt` : "",
  ].filter(Boolean)
  return (
    <div className="card">
      <h2>Who obeyed</h2>
      <div className="big">
        {board.obeyed} of {board.affected} obeyed{extras.length ? `, ${extras.join(", ")}` : ""}
      </div>
      <table style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th>Robot</th>
            <th>Status</th>
            <th>Policy</th>
          </tr>
        </thead>
        <tbody>
          {board.rows.map((r) => (
            <Row key={r.robot.robot} row={r} />
          ))}
        </tbody>
      </table>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Silent means no receipt and no live heartbeat. Nobody can tell from outside whether that robot lost its internet
        or is ignoring the recall. File {shortHash(recall.artifact)}.
      </p>
    </div>
  )
}
