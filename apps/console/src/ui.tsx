import { useEffect, useRef, useState, type ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"

export const short = (value: string) => (value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value)

export function ago(at: number | undefined, now: number): string {
  if (!at) return "never"
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

export function Copyable({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button type="button" className="copy mono" title={`Copy ${value}`} onClick={copy}>
      {copied ? "Copied" : (label ?? short(value))}
    </button>
  )
}

export type Tone = "green" | "amber" | "red" | "grey"

const ICON: Record<Tone, string> = { green: "●", amber: "▲", red: "■", grey: "○" }

/** A state is never colour alone: it always carries a shape and a word, for anyone who cannot tell the colours apart. */
export function Status({ tone, children, small }: { tone: Tone; children: ReactNode; small?: boolean }) {
  return (
    <span className={`pill ${tone} ${small ? "small-pill" : ""}`}>
      <span aria-hidden="true" className="pill-icon">
        {ICON[tone]}
      </span>{" "}
      {children}
    </span>
  )
}

/** One number or short fact, with what it is. */
export function Tile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  )
}

export type Run = (work: () => Promise<unknown>) => Promise<boolean>

/** What the person is being asked to confirm. Every stop needs a reason, because the agent is told it. */
export interface Ask {
  title: string
  body: ReactNode
  confirm: string
  danger?: boolean
  needsReason?: boolean
  placeholder?: string
  options?: { value: string; label: string; hint: string }[]
  go: (input: { reason: string; option?: string; advice: string }) => Promise<unknown>
  withAdvice?: boolean
}

export function AskDialog({ ask, close, run }: { ask: Ask; close: () => void; run: Run }) {
  const reduced = useReducedMotion()
  const dialog = useRef<HTMLDialogElement>(null)
  const [reason, setReason] = useState("")
  const [advice, setAdvice] = useState("")
  const [option, setOption] = useState(ask.options?.[0]?.value)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const ok = await run(() => ask.go({ reason, option, advice }))
    setBusy(false)
    if (ok) close()
    // A failure is shown behind the dialog, so it has to get out of the way for it to be read.
    else close()
  }

  return (
    <dialog ref={dialog} className="ask" onClose={close}>
      <motion.form initial={{ opacity: 0, y: reduced ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .2 }} onSubmit={(e) => void submit(e)}>
        <h2>{ask.title}</h2>
        <div className="ask-body">{ask.body}</div>
        {ask.options && (
          <fieldset>
            {ask.options.map((o) => (
              <label key={o.value} className="option">
                <input type="radio" name="scope" checked={option === o.value} onChange={() => setOption(o.value)} />
                <span>
                  {o.label}
                  <small>{o.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {ask.needsReason && (
          <label className="field">
            Reason
            <small>The agent is told this, and it goes on the record.</small>
            <input autoFocus required value={reason} placeholder={ask.placeholder} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        {ask.withAdvice && (
          <label className="field">
            What should people do? <small>Optional.</small>
            <input value={advice} placeholder="Rotate the API key and move to 1.2.4" onChange={(e) => setAdvice(e.target.value)} />
          </label>
        )}
        <div className="ask-actions">
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={ask.danger ? "danger" : "primary"} disabled={busy || (ask.needsReason && !reason.trim())}>
            {busy ? "Working…" : ask.confirm}
          </button>
        </div>
      </motion.form>
    </dialog>
  )
}
