import { useState } from "react"
import {
  ADDRESSES,
  CONFIRMATION_THRESHOLD,
  decodeBundle,
  endedByIssuer,
  type Hex,
  isDismissed,
  isKillRecall,
  isWithdrawn,
  type LiftRow,
  lower,
  measureFiles,
  type PublicView,
  type RecallRow,
} from "@ceasenet/core"
import { RecallBoardCard } from "./Board"
import { MeasureNpm } from "./IssuePage"
import {
  approvalsOf,
  boundBy,
  explorerAddress,
  forgetView,
  isNormalRecall,
  nameOf,
  ownersFor,
  shortHash,
  SWARM_GATEWAY,
  swarmLink,
  trustForRecall,
  useNetworkView,
  votesOn,
} from "./lib"
import { VoteButtons } from "./Vote"
import { useWallet, WalletCard, walletMessage } from "./wallet"

const levelName = (r: RecallRow) => (r.level === "STOP" ? "STOP" : isNormalRecall(r) ? "Normal recall" : "Warning")

/** Where a recall stands, in a few words. */
function standing(r: RecallRow, view: PublicView): string {
  if (r.level === "STOP") {
    const n = boundBy(r, view).length
    return `Binds ${n} agent${n === 1 ? "" : "s"} of its owner`
  }
  if (isNormalRecall(r) && approvalsOf(r, view).length > 0) return "Approved by the owner"
  return `${votesOn(r, view).confirms} of ${CONFIRMATION_THRESHOLD} votes`
}

/** Who a recall came from: the person who opened a normal one, or the key that signed a STOP. */
const openerOf = (r: RecallRow) => (isNormalRecall(r) ? (r.opener ? shortHash(r.opener) : "A person checked by World ID") : nameOf(r.creator))

/** What a recall is aimed at, in a few words. */
const targetOf = (r: RecallRow) => {
  if (r.artifact.startsWith("agent:")) return `Agent ${shortHash(r.artifact.slice(6))}`
  if (r.artifact.startsWith("fleet:")) return `All agents of ${shortHash(r.artifact.slice(6))}`
  return r.pkg ? `${r.pkg}${r.versions && r.versions !== "*" ? ` ${r.versions}` : ""}` : shortHash(r.artifact)
}

/** Every recall on record, newest first. Ended ones are hidden until asked for. */
export function RecallList({ view }: { view: PublicView }) {
  const [everyone, setEveryone] = useState(false)
  if (view.recalls.length === 0) return <p className="muted">No recalls on record.</p>
  const current = view.recalls.filter((r) => !endedByIssuer(r, view.lifts))
  const hidden = view.recalls.length - current.length
  const shown = everyone ? view.recalls : current
  return (
    <div className="card">
      {shown.length === 0 && <p className="muted">No recall is open right now.</p>}
      {hidden > 0 && (
        <label className="small muted check-line">
          <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /> Also show {hidden} recall{hidden === 1 ? "" : "s"} that {hidden === 1 ? "has" : "have"} ended.
        </label>
      )}
      <table>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Aimed at</th>
            <th>Reason</th>
            <th>From</th>
            <th>Where it stands</th>
            <th>Block</th>
          </tr>
        </thead>
        <tbody>
          {shown.slice(0, 50).map((r) => (
            <tr key={r.key}>
              <td>
                <a href={`#/recall/${r.key}`}>{levelName(r)}</a>
              </td>
              <td>{targetOf(r)}</td>
              <td>{r.reason}</td>
              <td>{openerOf(r)}</td>
              <td>{standing(r, view)}</td>
              <td className="mono muted">{String(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RecallsPage() {
  const { data: view, error } = useNetworkView(4000)
  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>
  return (
    <div className="page">
      <h1 style={{ marginBottom: 4 }}>Recalls</h1>
      <p style={{ marginTop: 0 }}>
        <a href="#/report">Open a recall</a>
      </p>
      <p className="muted" style={{ marginTop: 0 }}>
        A normal recall is opened by someone logged in with World, and needs {CONFIRMATION_THRESHOLD} votes from different people. Then the owner of the agent it names can approve it, and only then does the agent stop. An owner can also stop their own agents at once. An agent obeys nobody but its owner. Read
        straight from Arkiv in your browser.
      </p>
      <RecallList view={view} />
    </div>
  )
}

/**
 * The owner's decision on a normal recall. Votes alone stop nothing: once enough people agree, the owner of an agent
 * it covers can approve it, which is a STOP signed by the owner's own wallet. Their agents obey that, and nothing else.
 */
function OwnerApproval({ recall, view }: { recall: RecallRow; view: PublicView }) {
  const { address, writer } = useWallet()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const owners = ownersFor(recall, view)
  const approvals = approvalsOf(recall, view)
  const votes = votesOn(recall, view)
  const enough = votes.effective >= CONFIRMATION_THRESHOLD
  const mine = address ? owners.get(lower(address)) : undefined
  const approvedByMe = Boolean(address && approvals.some((a) => lower(a.creator) === lower(address)))

  const approve = async () => {
    if (!writer) return
    setBusy(true)
    setProblem(undefined)
    try {
      const { entityKey } = await writer.stop({
        artifact: recall.artifact,
        severity: "HIGH",
        reason: `Approved by the owner after ${votes.confirms} ${votes.confirms === 1 ? "vote" : "votes"}: ${recall.reason}`,
        pkg: recall.pkg,
        versions: recall.versions,
        approves: recall.key,
      })
      forgetView()
      window.location.hash = `#/recall/${entityKey}`
    } catch (e) {
      setProblem(walletMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2>The owner's decision</h2>
      {approvals.map((a) => (
        <div key={a.key} className="notice" style={{ marginBottom: 8 }}>
          Approved by its owner, {shortHash(a.creator)}. Their agents obey it: <a href={`#/recall/${a.key}`}>see the STOP</a>.
        </div>
      ))}
      {owners.size === 0 ? (
        <p className="muted" style={{ marginTop: 0 }}>
          No registered agent on the list is covered by this yet, so there is no owner to approve it.
        </p>
      ) : (
        <p style={{ marginTop: 0 }}>
          Who can approve it:{" "}
          {[...owners.entries()].map(([owner, agents], i) => (
            <span key={owner}>
              {i > 0 && "; "}
              the owner {shortHash(owner)}, for {agents.map((a) => a.agent.name).join(", ")}
            </span>
          ))}
          .
        </p>
      )}
      {!enough && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          At {CONFIRMATION_THRESHOLD} votes, while votes for outnumber votes against, the owner can approve it. Until then it stops nothing.
        </p>
      )}
      {enough && mine && !approvedByMe && (
        <div style={{ display: "grid", gap: 8 }}>
          <WalletCard action="approve this recall" />
          <div className="buttons">
            <button className="danger" disabled={!writer || busy} onClick={() => void approve()}>
              {busy ? "Waiting for your wallet and the chain…" : `Approve, and stop it on ${mine.length === 1 ? mine[0]!.agent.name : `my ${mine.length} agents`}`}
            </button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Your wallet signs a STOP on Arkiv. Your agents obey it within seconds, because it comes from you. You can withdraw it later.
          </p>
          {problem && <div className="error">{problem}</div>}
        </div>
      )}
      {enough && !mine && owners.size > 0 && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Enough people agree. It is now up to the owner. If you own one of these agents, connect the wallet you registered it with.
        </p>
      )}
    </div>
  )
}

/** Fetches the fix from Swarm in this browser and hashes it here, so nobody has to take this site's word for it. */
function FixOnSwarm({ fix }: { fix: LiftRow }) {
  const [said, setSaid] = useState<{ ok: boolean; text: string }>()
  const [busy, setBusy] = useState(false)
  const check = async () => {
    setBusy(true)
    setSaid(undefined)
    try {
      const res = await fetch(`${SWARM_GATEWAY}/bzz/${fix.fixedRef}`)
      if (!res.ok) throw new Error(`Swarm answered HTTP ${res.status}`)
      const files = decodeBundle(new Uint8Array(await res.arrayBuffer()))
      const hash = measureFiles(files)
      const ok = hash.toLowerCase() === fix.fixedHash?.toLowerCase()
      setSaid({
        ok,
        text: ok
          ? `Matches the published fix: ${files.length} files, unchanged.`
          : `Does not match the published fix. Do not run this file. It hashes to ${shortHash(hash)}.`,
      })
    } catch (e) {
      setSaid({ ok: false, text: `Could not read it from Swarm: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small">
        Stored on Swarm:{" "}
        <a className="mono" href={swarmLink(fix.fixedRef ?? "")} target="_blank" rel="noreferrer">
          {shortHash(fix.fixedRef ?? "")}
        </a>
      </div>
      <div className="buttons" style={{ marginTop: 6 }}>
        <button disabled={busy} onClick={() => void check()}>
          {busy ? "Reading from Swarm…" : "Download from Swarm and check"}
        </button>
      </div>
      {said && <div className={`small ${said.ok ? "ok" : "warn"}`} style={{ marginTop: 6 }}>{said.text}</div>}
    </div>
  )
}

/** What the key behind a recall can do about it. Each action is signed by that key's own wallet, and is public. */
function IssuerActions({ recall, hasFix, ended }: { recall: RecallRow; hasFix: boolean; ended: boolean }) {
  const { address, writer, connect, missing } = useWallet()
  const [version, setVersion] = useState("")
  const [hash, setHash] = useState("")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const mine = address?.toLowerCase() === recall.creator.toLowerCase()
  if (ended || recall.level !== "STOP") return null
  if (!mine) {
    return missing || address ? null : (
      <div className="small muted">
        Issued this? <button className="link" onClick={() => void connect()}>Connect the wallet that signed it</button> to publish a fix.
      </div>
    )
  }
  const act = async (write: () => Promise<unknown>) => {
    setBusy(true)
    setProblem(undefined)
    try {
      await write()
      forgetView()
    } catch (e) {
      setProblem(walletMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const publishFix = () =>
    act(() =>
      writer!.lift({
        recall: recall.key,
        artifact: recall.artifact,
        kind: "FIX",
        fixedHash: hash.trim(),
        fixedVersion: version.trim(),
        note: `${recall.pkg ?? "This tool"} ${version.trim()} is the fix`,
      }),
    )
  const hashOk = /^0x[0-9a-fA-F]{64}$/.test(hash.trim())
  return (
    <div className="card form">
      <h2>You issued this</h2>
      {!hasFix && (
        <>
          <MeasureNpm
            label="Measure the fix on npm"
            onMeasured={(file) => {
              setVersion(file.version)
              setHash(file.hash)
            }}
          />
          <div className="form-row">
            <label>
              Fixed version
              <input value={version} onChange={(e) => setVersion(e.target.value)} spellCheck={false} />
            </label>
            <label>
              Its exact file hash
              <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" spellCheck={false} />
            </label>
          </div>
          <div className="buttons">
            <button className="primary" disabled={busy || !version.trim() || !hashOk} onClick={() => void publishFix()}>
              {busy ? "Waiting for your wallet and the chain…" : "Sign and publish the fix"}
            </button>
          </div>
        </>
      )}
      <div className="buttons">
        <button disabled={busy} onClick={() => void act(() => writer!.lift({ recall: recall.key, artifact: recall.artifact, kind: "WITHDRAWN", note: "Withdrawn by the issuer" }))}>
          Withdraw this STOP
        </button>
      </div>
      {problem && <div className="error">{problem}</div>}
    </div>
  )
}

/** One recall: what it says, who issued it, who confirmed it and who obeyed. */
export function RecallPage({ recallKey }: { recallKey: Hex }) {
  const { data: view, error, fresh, refresh } = useNetworkView(3000)
  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>
  const recall = view.recalls.find((r) => r.key === recallKey)
  // What this page already knows may be from before this recall was made, so that is not an answer yet.
  if (!recall && !fresh) return <div className="page muted">Reading Arkiv…</div>
  if (!recall) {
    const receipt = view.acks.find((a) => a.recall === recallKey)
    return (
      <div className="page">
        <div className="notice bad">
          {receipt
            ? `This recall is no longer on Arkiv, but agents posted receipts for it, which proves it existed. Issued by ${nameOf(receipt.issuer)} (${receipt.issuer}), content hash ${receipt.recallHash}.`
            : "There is no recall with this key on the list."}
        </div>
      </div>
    )
  }

  const trust = trustForRecall(recall)
  const lifts = view.lifts.filter((l) => l.recall === recall.key)
  const counts = votesOn(recall, view)
  const isReport = isNormalRecall(recall)
  const bound = boundBy(recall, view)
  const fix = lifts.find((l) => l.kind === "FIX")
  const ended = recall.level === "STOP" ? isWithdrawn(recall, lifts, trust) : isDismissed(recall, lifts, trust)
  const known = view.artifacts.find((a) => a.hash.toLowerCase() === recall.artifact.toLowerCase())
  const disclosure = view.disclosures.find((d) => d.recall === recall.key)

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
            {known ? (
              <tr>
                <th>Tool</th>
                <td>
                  {known.name} {known.version}
                </td>
              </tr>
            ) : recall.pkg ? (
              <tr>
                <th>Tool</th>
                <td>{recall.pkg}</td>
              </tr>
            ) : null}
            <tr>
              <th>{isKillRecall(recall.artifact) ? "Aimed at" : "Exact file"}</th>
              <td className="mono">{recall.artifact.startsWith("agent:") ? <a href={`#/agent/${recall.artifact.slice(6)}`}>{recall.artifact}</a> : recall.artifact}</td>
            </tr>
            {recall.pkg && recall.versions && (
              <tr>
                <th>Also covers</th>
                <td>
                  {recall.pkg} {recall.versions}
                </td>
              </tr>
            )}
            {isReport ? (
              <tr>
                <th>Opened by</th>
                <td>
                  {recall.opener ? (
                    <a className="mono" href={explorerAddress(recall.opener)} target="_blank" rel="noreferrer">
                      {recall.opener}
                    </a>
                  ) : (
                    "A person checked by World ID"
                  )}{" "}
                  <span className="muted small">written to Arkiv by the CeaseNet verifier</span>
                </td>
              </tr>
            ) : (
              <tr>
                <th>Signed by</th>
                <td>
                  {nameOf(recall.creator)}{" "}
                  <a className="mono" href={explorerAddress(recall.creator)} target="_blank" rel="noreferrer">
                    {shortHash(recall.creator)}
                  </a>
                </td>
              </tr>
            )}
            {recall.approves && (
              <tr>
                <th>Approves</th>
                <td>
                  <a href={`#/recall/${recall.approves}`}>the normal recall people voted for</a>
                </td>
              </tr>
            )}
            <tr>
              <th>Who must obey</th>
              <td>
                {recall.level === "STOP"
                  ? bound.length === 0
                    ? "No agent owned by this key is covered. An agent obeys only its own owner."
                    : `${bound.map((a) => a.agent.name).join(", ")}: owned by the key that signed it.`
                  : "Nobody yet. An agent obeys only its owner, so this binds nobody until the owner approves it."}
              </td>
            </tr>
            <tr>
              <th>Created at block</th>
              <td className="mono">{String(recall.createdAt)}</td>
            </tr>
            <tr>
              <th>Evidence</th>
              <td>
                {disclosure?.reproductionRef
                  ? "Public: see the disclosure below"
                  : recall.sealedEvidence
                    ? "Encrypted on Swarm. Only the security council can open it until it is disclosed."
                    : "None attached"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {recall.level === "ADVISORY" && (
        <div className="card">
          <h2>{isReport ? "Votes" : "Confirmed by real people"}</h2>
          <div className="big">
            {counts.confirms} of {trust.threshold}
          </div>
          <div className="meter">
            <div style={{ width: `${Math.min(100, (counts.effective / trust.threshold) * 100)}%` }} />
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {counts.disputes} against. Each vote is from a different person logged in with World, and is public. At {trust.threshold} votes within 72 hours, while votes for outnumber votes against, the owner can approve it. Votes alone stop nothing.
          </p>
          {lower(recall.creator) === lower(ADDRESSES.verifier) && (
            <div style={{ marginTop: 10 }}>
              <VoteButtons
                recall={recall.key}
                onCounted={() => {
                  // The vote is written. Give the network a few seconds to show it.
                  forgetView()
                  setTimeout(() => void refresh(), 2500)
                  setTimeout(() => void refresh(), 6000)
                }}
              />
            </div>
          )}
        </div>
      )}

      {isReport && <OwnerApproval recall={recall} view={view} />}

      {fix && (
        <div className="card">
          <h2>Fix{fix.fixedVersion ? `: version ${fix.fixedVersion}` : ""}</h2>
          <p style={{ marginTop: 0 }}>{fix.note}</p>
          <div className="mono">{fix.fixedHash}</div>
          {fix.fixedRef && <FixOnSwarm fix={fix} />}
          <p className="small muted" style={{ marginBottom: 0 }}>
            Agents that move to this exact file use the tool again. Agents still on the old file stay blocked.
          </p>
        </div>
      )}

      {disclosure && (
        <div className="card">
          <h2>Disclosed</h2>
          <p style={{ marginTop: 0 }}>{disclosure.description}</p>
          {disclosure.reproductionRef && (
            <div className="small">
              Evidence on Swarm:{" "}
              <a className="mono" href={swarmLink(disclosure.reproductionRef)} target="_blank" rel="noreferrer">
                {shortHash(disclosure.reproductionRef)}
              </a>
            </div>
          )}
        </div>
      )}

      <IssuerActions recall={recall} hasFix={Boolean(fix)} ended={ended} />

      {/* A normal recall is not an order, so there is nothing for anyone to obey until an owner approves it. */}
      {recall.level === "STOP" && <RecallBoardCard recall={recall} view={view} />}
    </div>
  )
}
