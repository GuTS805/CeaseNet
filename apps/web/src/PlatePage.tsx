import QRCode from "qrcode"
import { useEffect, useState } from "react"
import { type CustodyRow, deletedStops, type Hex, plateColour, readCustody } from "@ceasenet/core"
import { client, explorerAddress, shortHash, statusLabel, useFleetView, usePoll } from "./lib"

const HEAD: Record<string, string> = {
  green: "Running",
  amber: "Slow mode or paused",
  red: "Stopped",
  grey: "Unknown",
}

/** What anyone sees after scanning a robot. Only records created by the right keys are shown. */
export function PlatePage({ address }: { address: Hex }) {
  const { data: view, error } = useFleetView(3000)
  const entry = view?.robots.find((r) => r.robot.robot.toLowerCase() === address.toLowerCase())
  const maker = entry?.robot.maker
  const { data: custody } = usePoll<CustodyRow | undefined>(
    () => (maker ? readCustody(client, address, maker) : Promise.resolve(undefined)),
    8000,
    [maker],
  )
  const [qr, setQr] = useState<string>()

  useEffect(() => {
    void QRCode.toDataURL(window.location.href, { margin: 1, width: 300 }).then(setQr)
  }, [])

  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>
  if (!entry) {
    return (
      <div className="page">
        <div className="notice bad">
          No maker we trust has registered this robot. A passport anyone else wrote would not count.
        </div>
      </div>
    )
  }

  const colour = plateColour(address, entry.heartbeat)
  const hashes = new Set(entry.loadout?.files.map((f) => f.hash.toLowerCase()))
  const open = view.recalls.filter((r) => hashes.has(r.artifact.toLowerCase()))
  const mine = view.acks.filter((a) => a.creator.toLowerCase() === address.toLowerCase())
  const deleted = deletedStops(mine, view.recalls)
  const policy = entry.loadout?.files.find((f) => f.kind === "policy")

  return (
    <div className="page">
      <div className="plate">
        <div className={`plate-head ${colour}`}>{HEAD[colour]}</div>
        <div className="plate-body">
          <div className="row between" style={{ alignItems: "flex-start" }}>
            <div className="field">
              <div className="label">Robot</div>
              <div className="big">{entry.robot.serial}</div>
              <div className="muted">
                {entry.robot.model} · {entry.robot.city}
              </div>
            </div>
            {qr && <img className="qr" src={qr} alt="QR code for this page" />}
          </div>

          <div className="field">
            <div className="label">Heartbeat</div>
            {entry.heartbeat ? (
              <div>
                {statusLabel(entry.heartbeat.mode)}, updated {Math.max(0, Number(view.block - entry.heartbeat.updatedAt) * 2)} s ago
              </div>
            ) : (
              <div>None. Nobody can vouch for this robot right now.</div>
            )}
          </div>

          <div className="field">
            <div className="label">Running</div>
            {policy ? (
              <div>
                Policy {policy.version} <span className="mono muted">{shortHash(policy.hash)}</span>
              </div>
            ) : (
              <div className="muted">Nothing published</div>
            )}
            <div className="small muted">
              {entry.loadout?.files.filter((f) => f.kind !== "policy").map((f) => `${f.kind}: ${f.name}`).join(" · ")}
            </div>
          </div>

          <div className="field">
            <div className="label">Recalls on this software</div>
            {open.length === 0 ? (
              <div>None</div>
            ) : (
              open.map((r) => (
                <div key={r.key}>
                  <a href={`#/recall/${r.key}`}>{r.level === "STOP" ? "STOP" : "Warning"}</a>: {r.reason}
                </div>
              ))
            )}
          </div>

          {deleted.length > 0 && (
            <div className="notice bad">
              This robot obeyed a STOP that its issuer has since deleted ({shortHash(deleted[0]!.recall)}). The robot keeps
              obeying it, and its receipt keeps the proof.
            </div>
          )}

          <div className="field">
            <div className="label">Responsible operator</div>
            <div>{custody ? custody.operator : "Not on record"}</div>
          </div>

          <div className="small">
            <a href={explorerAddress(address)} target="_blank" rel="noreferrer">
              See this robot's records on the Arkiv explorer
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
