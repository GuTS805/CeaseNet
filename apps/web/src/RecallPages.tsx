import { useState } from "react"
import {
  countConfirmations,
  decodeBundle,
  followersOf,
  type Hex,
  isDismissed,
  isKillRecall,
  isWithdrawn,
  type LiftRow,
  measureFiles,
  type PublicView,
  type RecallRow,
} from "@ceasenet/core"
import { RecallBoardCard } from "./Board"
import { MeasureNpm } from "./IssuePage"
import { explorerAddress, forgetView, HOSTED, nameOf, shortHash, SWARM_GATEWAY, swarmLink, trustForRecall, useNetworkView } from "./lib"
import { useWallet, walletMessage } from "./wallet"
import { WorldConfirm } from "./WorldConfirm"

const levelName = (r: RecallRow) => (r.level === "STOP" ? "STOP" : r.severity === "REPORT" ? "Report" : "Warning")

/** What a recall is aimed at, in a few words. */
const targetOf = (r: RecallRow) => {
  if (r.artifact.startsWith("agent:")) return `Agent ${shortHash(r.artifact.slice(6))}`
  if (r.artifact.startsWith("fleet:")) return `All agents of ${shortHash(r.artifact.slice(6))}`
  return r.pkg ? `${r.pkg}${r.versions && r.versions !== "*" ? ` ${r.versions}` : ""}` : shortHash(r.artifact)
}

/** Every recall on record, newest first. On the demo's pages, only those from keys its owners follow. */
export function RecallList({ view }: { view: PublicView }) {
  const [everyone, setEveryone] = useState(false)
  if (view.recalls.length === 0) return <p className="muted">No recalls on record.</p>
  const followed = view.recalls.filter((r) => followersOf(r, view.agents) > 0)
  const hidden = view.recalls.length - followed.length
  const shown = everyone ? view.recalls : followed
  return (
    <div className="card">
      {shown.length === 0 && <p className="muted">No owner follows the key behind any recall yet.</p>}
      {hidden > 0 && (
        <label className="small muted check-line">
          <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /> Also show {hidden} recall{hidden === 1 ? "" : "s"} from keys nobody follows. Anyone can write one, and it binds nobody.
        </label>
      )}
      <table>
        <thead>
          <tr>
            <th>Level</th>
            <th>Aimed at</th>
            <th>Reason</th>
            <th>Issued by</th>
            <th>Following</th>
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
              <td>{nameOf(r.creator)}</td>
              <td>{followersOf(r, view.agents)}</td>
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
        <a href="#/report">Report an agent or a tool</a>
      </p>
      <p className="muted" style={{ marginTop: 0 }}>
        Read straight from Arkiv in your browser. No server of ours is involved.
        {HOSTED && " Anyone can publish a recall, so this list shows them all with who issued each one. A recall binds only the agents whose owners follow that key."}
      </p>
      <RecallList view={view} />
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
  const counts = countConfirmations(recall, view.endorsements, view.block, trust)
  const simulated = new Set(view.endorsements.filter((e) => e.recall === recall.key && e.stance === "CONFIRM" && e.human.startsWith("simulated-")).map((e) => e.human)).size
  const isReport = recall.severity === "REPORT"
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
            <tr>
              <th>Issued by</th>
              <td>
                {nameOf(recall.creator)}{" "}
                <a className="mono" href={explorerAddress(recall.creator)} target="_blank" rel="noreferrer">
                  {shortHash(recall.creator)}
                </a>
              </td>
            </tr>
            <tr>
              <th>Who obeys this key</th>
              <td>
                {followersOf(recall, view.agents)} owner(s) follow it. <a href={`#/protect/${recall.creator}`}>Follow it</a>
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
          {simulated > 0 && (
            <div className="notice" style={{ margin: "8px 0" }}>
              {simulated} of these {simulated === 1 ? "is" : "are"} simulated, in test mode, and not real people. Each says so on the public record.
            </div>
          )}
          <div className="meter">
            <div style={{ width: `${Math.min(100, (counts.effective / trust.threshold) * 100)}%` }} />
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {isReport
              ? `${counts.disputes} against. At ${trust.threshold} votes within 72 hours, while votes for outnumber votes against, its owner is told, and they decide whether to issue a recall. Votes alone stop nothing. World ID shows each vote is a different real person, without saying who.`
              : `${counts.disputes} disputed. At ${trust.threshold} confirmations within 72 hours, while confirmations outnumber disputes, agents must ask a human before using this tool. Only the keys an owner follows can stop it outright.`}
          </p>
          <div style={{ marginTop: 10 }}>
            <WorldConfirm
              recall={recall.key}
              onCounted={() => {
                // The vote is written. Give the network a block to show it.
                forgetView()
                setTimeout(() => void refresh(), 2500)
              }}
            />
          </div>
        </div>
      )}

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

      {/* A report is not an order, so there is nothing for anyone to obey until its owner issues a recall. */}
      {!isReport && <RecallBoardCard recall={recall} view={view} />}
    </div>
  )
}
