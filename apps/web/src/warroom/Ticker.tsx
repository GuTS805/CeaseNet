import { useMemo } from "react"
import { explorerEntity } from "../lib"
import type { ChainRecord, RecordKind } from "./events"

const CELLS = 60

const TONE: Record<RecordKind, string> = {
  STOP: "red",
  WARNING: "amber",
  RECEIPT: "white",
  FIX: "teal",
  LIFT: "teal",
  CONFIRM: "amber",
  DISPUTE: "amber",
  DISCLOSED: "white",
  HEARTBEAT: "dim",
}

/** Real blocks, as they are produced, with the records that landed in each. Records stay here even if they are later deleted. */
export function Ticker({ latest, records, erased }: { latest?: bigint; records: readonly ChainRecord[]; erased: ReadonlySet<string> }) {
  const byBlock = useMemo(() => {
    const blocks = new Map<string, ChainRecord[]>()
    for (const r of records) blocks.set(String(r.block), [...(blocks.get(String(r.block)) ?? []), r])
    return blocks
  }, [records])

  const blocks = latest === undefined ? [] : Array.from({ length: CELLS }, (_, i) => latest - BigInt(CELLS - 1 - i)).filter((b) => b >= 0n)

  return (
    <div className="ticker">
      <div className="ticker-label">
        <b>Arkiv, live</b>
        <span>Rabdi testnet</span>
      </div>
      <div className="ticker-chain">
        {blocks.map((b) => {
          const here = byBlock.get(String(b)) ?? []
          const major = here.filter((r) => r.kind !== "HEARTBEAT")
          const beats = here.length - major.length
          return (
            <div key={String(b)} className={`cell ${major.length ? "major" : ""}`}>
              <div className="cell-no">{major.length ? String(b) : String(b).slice(-3)}</div>
              {beats > 0 && (
                <div className="cell-beats" title={`${beats} heartbeat${beats > 1 ? "s" : ""}`}>
                  {Array.from({ length: beats }, (_, i) => (
                    <i key={i} />
                  ))}
                </div>
              )}
              {major.length > 0 && (
                <div className="cell-records">
                  {major.map((r) => (
                    <a key={r.id} className={`chip ${TONE[r.kind]} ${erased.has(r.key) ? "erased" : ""}`} href={explorerEntity(r.key)} target="_blank" rel="noreferrer">
                      <b>{r.kind}</b> {r.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
