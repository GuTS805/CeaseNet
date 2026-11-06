import { useState } from "react"
import { post, type ReportsState, type ReportView, usePoll } from "./api"
import { type Ask, type Run, short, Status } from "./ui"

function Votes({ report }: { report: ReportView }) {
  const share = Math.min(1, report.votes / report.votesNeeded)
  return (
    <div className="votes">
      <div className="vote-meter" role="meter" aria-valuenow={report.votes} aria-valuemin={0} aria-valuemax={report.votesNeeded} aria-label="Votes so far">
        <div style={{ width: `${share * 100}%` }} />
      </div>
      <span className="small nowrap">
        {report.votes} of {report.votesNeeded} votes
        {report.disputes > 0 ? `, ${report.disputes} against` : ""}
        {report.simulated > 0 ? `, ${report.simulated} simulated` : ""}
      </span>
    </div>
  )
}

function ReportCard({ report, onAsk, run, canSign }: { report: ReportView; onAsk: (ask: Ask) => void; run: Run; canSign: boolean }) {
  const recall = () =>
    onAsk({
      title: `Recall ${report.target}`,
      body: (
        <p>
          {report.kind === "agent" ? "This agent stops" : "This tool stops, on every agent that obeys you"}, and any of your agents that use it close. The reason says it came from people's reports. You can lift it afterwards.
        </p>
      ),
      confirm: "Issue the recall",
      danger: true,
      go: () => post(`/api/reports/${report.key}/recall`),
    })
  return (
    <article className={`report ${report.state === "waiting" ? "report-waiting" : ""}`}>
      <div className="report-main">
        <div className="recall-head">
          {report.state === "waiting" ? (
            <Status tone="red">Needs your decision</Status>
          ) : report.state === "recalled" ? (
            <Status tone="grey">You recalled it</Status>
          ) : report.state === "dismissed" ? (
            <Status tone="grey">You dismissed it</Status>
          ) : (
            <Status tone="amber">Collecting votes</Status>
          )}
          <b>{report.target}</b>
          {report.kind === "tool" && report.versions && report.versions !== "*" && <span className="muted small">{report.versions}</span>}
        </div>
        <p>{report.reason}</p>
        <Votes report={report} />
        <div className="muted small">
          Affects {report.about.map((a) => (a.through === "the agent itself" ? a.agent : `${a.agent}, through ${a.through}`)).join("; ")}
        </div>
      </div>
      {report.state === "waiting" && (
        <div className="report-actions">
          <button className="danger" disabled={!canSign} onClick={recall}>
            Issue the recall
          </button>
          <button onClick={() => void run(() => post(`/api/reports/${report.key}/dismiss`))}>Dismiss</button>
        </div>
      )}
      {report.state === "collecting" && canSign && (
        <div className="report-actions">
          <button className="danger-quiet" onClick={recall}>
            Recall now anyway
          </button>
        </div>
      )}
    </article>
  )
}

export function ReportsPage({ onAsk, run, canSign }: { onAsk: (ask: Ask) => void; run: Run; canSign: boolean }) {
  const { data, error, refresh } = usePoll<ReportsState>("/api/reports", 5000)
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission)
  if (!data) return <div className="loading">{error ?? "Reading reports…"}</div>

  const act: Run = async (work) => {
    const ok = await run(work)
    await refresh()
    return ok
  }
  const ask = (a: Ask) => onAsk({ ...a, go: async (input) => { await a.go(input); await refresh() } })

  const waiting = data.reports.filter((r) => r.state === "waiting")
  const collecting = data.reports.filter((r) => r.state === "collecting")
  const handled = data.reports.filter((r) => r.state === "recalled" || r.state === "dismissed")

  return (
    <div className="page-body">
      <div className="page-title">
        <div>
          <h1>Reports</h1>
          <p className="muted">
            Anyone logged in with World can open a recall on one of your agents or the tools it uses, and others can vote. One person logs in with one wallet, so each vote is a different real person. At {data.votesNeeded} votes you are told here, and the decision is yours: your agents obey only you, so votes alone never stop anything. You can always stop something yourself, with no votes at all.
          </p>
        </div>
        <div className="page-actions">
          {permission === "default" && (
            <button onClick={() => void Notification.requestPermission().then(setPermission)}>Tell me with a notification</button>
          )}
          {permission === "granted" && <span className="muted small">Notifications are on</span>}
          {permission === "denied" && <span className="muted small">Notifications are blocked in this browser</span>}
        </div>
      </div>

      {data.problem && <div className="notice">{data.problem}</div>}

      <section className="report-list">
        {waiting.length === 0 && collecting.length === 0 && (
          <div className="panel">
            <div className="empty">
              <p>Nobody has reported any of your agents or the tools they use.</p>
              <p className="muted small">Only reports checked by the verifier {short(data.verifier)} count. Anything else anyone writes on the chain is ignored.</p>
            </div>
          </div>
        )}
        {waiting.map((r) => (
          <ReportCard key={r.key} report={r} onAsk={ask} run={act} canSign={canSign} />
        ))}
        {collecting.map((r) => (
          <ReportCard key={r.key} report={r} onAsk={ask} run={act} canSign={canSign} />
        ))}
        {handled.map((r) => (
          <ReportCard key={r.key} report={r} onAsk={ask} run={act} canSign={canSign} />
        ))}
      </section>
    </div>
  )
}
