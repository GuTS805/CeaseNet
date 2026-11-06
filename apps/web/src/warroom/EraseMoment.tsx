import type { AckRow, RecallRow } from "@ceasenet/core"
import { explorerEntity, shortHash } from "../lib"

/** Pieces of the STOP, each with its own outline and the way it flies. */
const SHARDS = (() => {
  const cols = 5
  const rows = 3
  // A fixed sequence, so every run breaks the same way.
  let seed = 11
  const next = () => {
    seed = (seed * 16807) % 2147483647
    return (seed & 0xffff) / 0xffff
  }
  const grid = Array.from({ length: rows + 1 }, (_, r) =>
    Array.from({ length: cols + 1 }, (_, c) => ({
      x: (c / cols) * 100 + (c > 0 && c < cols ? (next() - 0.5) * 14 : 0),
      y: (r / rows) * 100 + (r > 0 && r < rows ? (next() - 0.5) * 22 : 0),
    })),
  )
  const pieces: { clip: string; dx: number; dy: number; turn: number; delay: number }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [a, b, d, e] = [grid[r]![c]!, grid[r]![c + 1]!, grid[r + 1]![c + 1]!, grid[r + 1]![c]!]
      const mx = (a.x + b.x + d.x + e.x) / 4 - 50
      const my = (a.y + b.y + d.y + e.y) / 4 - 50
      pieces.push({
        clip: `polygon(${[a, b, d, e].map((p) => `${p.x.toFixed(1)}% ${p.y.toFixed(1)}%`).join(",")})`,
        dx: mx * (9 + next() * 7),
        dy: my * (7 + next() * 7) + 120,
        turn: (next() - 0.5) * 150,
        delay: next() * 180,
      })
    }
  }
  return pieces
})()

interface EraseProps {
  stop?: RecallRow
  receipts: readonly AckRow[]
  nameOf: (address: string) => string
  stillRefusing: readonly string[]
  onClose: () => void
}

/** The maker deleted its STOP. The record went, and the receipts that point at it did not. */
export function EraseMoment({ stop, receipts, nameOf, stillRefusing, onClose }: EraseProps) {
  const STOP_CARD = (
    <div className="erase-card">
      <div className="erase-card-word">STOP</div>
      <div className="erase-card-text">{stop?.reason ?? "demo-mail-tool 1.0.16"}</div>
      <div className="erase-card-meta">
        {stop ? `${stop.severity}, block ${String(stop.createdAt)}` : ""}
      </div>
    </div>
  )
  return (
    <div className="erase" role="dialog" aria-label="The STOP was erased from Arkiv">
      <div className="erase-shatter">
        {SHARDS.map((s, i) => (
          <div
            key={i}
            className="shard"
            style={
              {
                clipPath: s.clip,
                "--dx": `${s.dx}px`,
                "--dy": `${s.dy}px`,
                "--turn": `${s.turn}deg`,
                animationDelay: `${s.delay}ms`,
              } as React.CSSProperties
            }
          >
            {STOP_CARD}
          </div>
        ))}
      </div>

      <div className="erase-word" data-text="Erased from Arkiv">
        Erased from Arkiv
      </div>
      <div className="erase-sub">The maker deleted its own STOP. Arkiv lets an owner do that.</div>

      <div className="erase-receipts">
        {receipts.map((r, i) => (
          <a key={r.key} className="erase-receipt" style={{ animationDelay: `${1500 + i * 450}ms` }} href={explorerEntity(r.key)} target="_blank" rel="noreferrer">
            <span className="erase-receipt-who">{nameOf(r.agent)}</span>
            <span className="erase-receipt-what">
              receipt {r.action}, block {String(r.createdAt)}
              <br />
              STOP's content hash {shortHash(r.recallHash)}
            </span>
            <span className="erase-stamp">Still proven</span>
          </a>
        ))}
      </div>

      <div className="erase-foot" style={{ animationDelay: `${1700 + receipts.length * 450}ms` }}>
        {stillRefusing.length > 0 && (
          <div>
            {stillRefusing.join(", ")} {stillRefusing.length === 1 ? "still refuses the tool: its gate remembers" : "still refuse the tool: their gates remember"} the STOP.
          </div>
        )}
        <button onClick={onClose}>Back to the map</button>
      </div>
    </div>
  )
}
