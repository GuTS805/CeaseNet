import { type AgentRecallState, type BoardRow, buildRecallBoard, type PublicView, type RecallRow } from "@ceasenet/core"

const STATE: Record<AgentRecallState, { label: string; colour: string }> = {
  FIXED: { label: "Fixed", colour: "green" },
  BLOCKED: { label: "Blocked it, receipt posted", colour: "red" },
  SUPERVISED: { label: "Asks a human, receipt posted", colour: "amber" },
  SILENT: { label: "Silent", colour: "grey" },
  NO_RECEIPT: { label: "Running, no receipt", colour: "amber" },
  NOT_FOLLOWING: { label: "Owner does not follow this issuer", colour: "grey" },
}

function Row({ row }: { row: BoardRow }) {
  const s = STATE[row.state]
  return (
    <tr>
      <td>
        <a href={`#/agent/${row.agent.agent}`}>{row.agent.name}</a>
      </td>
      <td>
        <span className={`status ${s.colour}`}>{s.label}</span>
      </td>
    </tr>
  )
}

/** Who a recall affects and whether they obeyed, built from public records alone. */
export function RecallBoardCard({ recall, view }: { recall: RecallRow; view: PublicView }) {
  const board = buildRecallBoard(recall, view.agents, view.acks)
  const extras = [
    board.silent > 0 ? `${board.silent} silent` : "",
    board.noReceipt > 0 ? `${board.noReceipt} with no receipt` : "",
    board.notFollowing > 0 ? `${board.notFollowing} not following` : "",
  ].filter(Boolean)
  return (
    <div className="card">
      <h2>Who obeyed</h2>
      <div className="big">
        {board.obeyed} of {board.affected} obeyed{extras.length ? `, ${extras.join(", ")}` : ""}
      </div>
      <table style={{ marginTop: 8 }}>
        <tbody>
          {board.rows.map((r) => (
            <Row key={r.agent.agent} row={r} />
          ))}
        </tbody>
      </table>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Silent means no receipt and no live heartbeat. Nobody can tell from outside whether that agent lost its connection or
        is ignoring the recall.
      </p>
    </div>
  )
}
