import { useEffect, useState } from "react"
import { confirmationSignal, type Hex, type Stance } from "@ceasenet/core"
import { IDKitRequestWidget, proofOfHuman, type RpContext } from "@worldcoin/idkit"
import { VERIFIER_URL } from "./lib"

interface WorldConfig {
  appId: `app_${string}`
  rpId: string
  action: string
  environment: "production" | "staging" | "sandbox"
}

type Outcome = { kind: "counted"; stance: Stance } | { kind: "stopped"; message: string }

const post = async <T,>(path: string, body: unknown = {}): Promise<T> => {
  const res = await fetch(VERIFIER_URL + path, { method: "POST", body: JSON.stringify(body) })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? "The verifier refused this.")
  return json
}

/**
 * One person, one answer on one warning.
 *
 * The browser only passes the proof along. The verifier checks it with World, and nothing here is believed
 * until it has. People see what happened either way, including when they cancel.
 */
export function WorldConfirm({ recall }: { recall: Hex }) {
  const [config, setConfig] = useState<WorldConfig | null>()
  const [stance, setStance] = useState<Stance>("CONFIRM")
  const [rpContext, setRpContext] = useState<RpContext>()
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>()
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!VERIFIER_URL) {
      setConfig(null)
      return
    }
    fetch(`${VERIFIER_URL}/api/world-config`)
      .then((r) => r.json() as Promise<WorldConfig>)
      .then(setConfig)
      .catch(() => setConfig(null))
  }, [])

  const start = async (chosen: Stance) => {
    setOutcome(undefined)
    setStarting(true)
    try {
      const sig = await post<{ sig: string; nonce: string; created_at: number; expires_at: number }>("/api/rp-signature")
      setRpContext({
        rp_id: config!.rpId,
        nonce: sig.nonce,
        created_at: sig.created_at,
        expires_at: sig.expires_at,
        signature: sig.sig,
      })
      setStance(chosen)
      setOpen(true)
    } catch (e) {
      setOutcome({ kind: "stopped", message: (e as Error).message })
    } finally {
      setStarting(false)
    }
  }

  if (config === undefined) return <p className="small muted">Connecting to the World ID service…</p>
  if (config === null) return <p className="small muted">The World ID service is not reachable right now, so answers cannot be counted.</p>

  return (
    <div className="world">
      <div className="buttons">
        <button className="primary" disabled={starting} onClick={() => void start("CONFIRM")}>
          Confirm with World ID
        </button>
        <button disabled={starting} onClick={() => void start("DISPUTE")}>
          Dispute with World ID
        </button>
      </div>
      {outcome?.kind === "counted" && (
        <p className="ok small">{outcome.stance === "CONFIRM" ? "Your confirmation was counted." : "Your dispute was counted."} It shows up on Arkiv in a few seconds.</p>
      )}
      {outcome?.kind === "stopped" && <p className="error">{outcome.message}</p>}
      {config.environment !== "production" && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Test mode: use the{" "}
          <a href="https://simulator.worldcoin.org/" target="_blank" rel="noreferrer">
            World ID simulator
          </a>{" "}
          instead of a phone. Its identities are not real people.
        </p>
      )}
      {rpContext && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) {
              setRpContext(undefined)
              // Closing with no result yet means the person walked away.
              setOutcome((current) => current ?? { kind: "stopped", message: "Cancelled. Nothing was counted." })
            }
          }}
          app_id={config.appId}
          action={config.action}
          rp_context={rpContext}
          environment={config.environment}
          allow_legacy_proofs={false}
          preset={proofOfHuman({ signal: confirmationSignal(recall, stance) })}
          handleVerify={async (result) => {
            // Throwing here makes the widget show the failure instead of a success.
            try {
              await post("/api/confirm", { recall, stance, result })
            } catch (e) {
              setOutcome({ kind: "stopped", message: (e as Error).message })
              throw e
            }
          }}
          onSuccess={() => setOutcome({ kind: "counted", stance })}
          onError={(code) => {
            setOutcome((current) => current ?? { kind: "stopped", message: `Not counted: World ID reported ${code}.` })
          }}
        />
      )}
    </div>
  )
}
