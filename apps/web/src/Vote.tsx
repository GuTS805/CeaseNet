import { useState } from "react"
import { type Hex, type Stance, voteMessage } from "@ceasenet/core"
import { NeedLogin, postVerifier, useLogin } from "./login"
import { useWallet, walletMessage } from "./wallet"

/**
 * One logged-in person, one vote on one normal recall. The wallet signs the vote, which costs nothing, and the
 * verifier writes it to Arkiv after checking the signature and that this address logged in with World.
 */
export function VoteButtons({ recall, onCounted }: { recall: Hex; onCounted?: () => void }) {
  const { human, address } = useLogin()
  const { sign } = useWallet()
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string }>()

  if (!human || !address) return <NeedLogin to="vote" next={`recall/${recall}`} />

  const vote = async (stance: Stance) => {
    setBusy(true)
    setOutcome(undefined)
    try {
      const at = Date.now()
      const signature = await sign(voteMessage(recall, stance, at))
      await postVerifier("/api/confirm", { recall, stance, address, signature, at })
      setOutcome({ ok: true, text: `${stance === "CONFIRM" ? "Your vote for it" : "Your vote against it"} was counted. It shows up on Arkiv in a few seconds.` })
      onCounted?.()
    } catch (e) {
      setOutcome({ ok: false, text: walletMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="world">
      <div className="buttons">
        <button className="primary" disabled={busy} onClick={() => void vote("CONFIRM")}>
          {busy ? "Waiting for your wallet…" : "Vote for this recall"}
        </button>
        <button disabled={busy} onClick={() => void vote("DISPUTE")}>
          Vote against
        </button>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        Your wallet signs the vote. It costs nothing. Each logged-in person has one vote here, and it is public, under your address.
      </p>
      {outcome && <p className={outcome.ok ? "ok small" : "error"}>{outcome.text}</p>}
    </div>
  )
}
