import { useEffect, useState } from "react"
import type { StolenMail } from "../lib"
import { LEAK_MS } from "./WarMap"

/** Shows a number a moment after it changes, so it changes as the stolen copy arrives on the map. */
function useLagged(value: number, ms: number): number {
  const [shown, setShown] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setShown(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return shown
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })

const mmss = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

/** What really reached the stranger, read from the file the bad tool writes. It goes quiet when the agents obey. */
export function Inbox({ mail, stolen, sent, sealed }: { mail: readonly StolenMail[]; stolen: number; sent: number; sealed: boolean }) {
  const shownStolen = useLagged(stolen, LEAK_MS)
  const newest = mail[0]?.at ?? 0
  const shownUpTo = useLagged(newest, LEAK_MS)
  const rows = mail.filter((m) => m.at <= shownUpTo)

  return (
    <div className={`inbox ${sealed ? "sealed" : "live"}`}>
      <div className="inbox-head">
        <div className="inbox-title">
          <span className="inbox-light" />
          Stranger's inbox
        </div>
        <div className="counter-row">
          <div key={shownStolen} className={`counter ${shownStolen > 0 ? "bad" : ""}`}>
            {shownStolen}
          </div>
          <div className="counter-side">
            <div className="counter-label">emails stolen</div>
            <div className="counter-of">out of {sent} sent</div>
          </div>
        </div>
        <div className="inbox-state">
          {sealed && newest ? (
            <>
              Silent for <b>{mmss(Date.now() - newest)}</b>
            </>
          ) : sealed ? (
            "Nothing reached it."
          ) : stolen > 0 ? (
            "Receiving. Every row is a real copy."
          ) : (
            "Waiting for the first email."
          )}
        </div>
      </div>

      <div className="inbox-list">
        {rows.map((m) => (
          <div className="mail" key={`${m.company}:${m.at}`}>
            <div className="mail-top">
              <b>{m.company}</b>
              <span>{clock(m.at)}</span>
            </div>
            <div className="mail-subject">{m.subject}</div>
            <div className="mail-to">to {m.to}</div>
            <div className="mail-body">{m.body}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
