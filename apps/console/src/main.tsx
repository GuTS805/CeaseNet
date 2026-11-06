import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "@fontsource/ibm-plex-sans/400.css"
import "@fontsource/ibm-plex-sans/500.css"
import "@fontsource/ibm-plex-sans/600.css"
import "./console.css"
import { StrictMode, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { useConsoleState } from "./api"
import { AgentsPage } from "./AgentsPage"
import { ArkivPage } from "./ArkivPage"
import { DiaryPage } from "./DiaryPage"
import { MachinePage } from "./MachinePage"
import { ReportsPage } from "./ReportsPage"
import { ServicesPage } from "./ServicesPage"
import { type Ask, AskDialog, type Run, useNow } from "./ui"

const PAGES = [
  { path: "", label: "Agents" },
  { path: "machine", label: "This machine" },
  { path: "reports", label: "Reports" },
  { path: "diary", label: "Diary" },
  { path: "arkiv", label: "Arkiv" },
  { path: "services", label: "Services" },
]

function useRoute(): string {
  const read = () => window.location.hash.replace(/^#\/?/, "")
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  return route
}

/** Tells the owner when a report reaches enough votes, even if this page is in the background. */
function useReportNotifications(waiting: { key: string; target: string; reason: string; votes: number }[] | undefined) {
  const told = useRef(new Set<string>(JSON.parse(localStorage.getItem("told") ?? "[]") as string[]))
  useEffect(() => {
    document.title = waiting?.length ? `(${waiting.length}) CeaseNet console` : "CeaseNet console"
    if (!waiting || typeof Notification === "undefined" || Notification.permission !== "granted") return
    for (const r of waiting) {
      if (told.current.has(r.key)) continue
      told.current.add(r.key)
      localStorage.setItem("told", JSON.stringify([...told.current]))
      const notice = new Notification(`${r.votes} people have reported ${r.target}`, { body: r.reason })
      notice.onclick = () => {
        window.focus()
        window.location.hash = "#/reports"
      }
    }
  }, [waiting])
}

function Console() {
  const { state, unreachable, refresh } = useConsoleState()
  const now = useNow()
  const route = useRoute()
  useReportNotifications(state?.reportsWaiting)
  const [ask, setAsk] = useState<Ask>()
  const [error, setError] = useState<string>()

  const run: Run = async (work) => {
    setError(undefined)
    try {
      await work()
      await refresh()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    }
  }

  if (!state) {
    return <div className="loading">{unreachable ? "Cannot reach the console. Run: ceasenet console" : "Loading…"}</div>
  }

  return (
    <>
      <nav className="top" aria-label="Pages">
        <span className="brand">CeaseNet</span>
        <div className="pages">
          {PAGES.map((p) => (
            <a key={p.path} href={`#/${p.path}`} className={route === p.path ? "page-link on" : "page-link"} aria-current={route === p.path ? "page" : undefined}>
              {p.label}
              {p.path === "machine" && state.approvals.length > 0 && <span className="tab-count alert">{state.approvals.length}</span>}
              {p.path === "reports" && state.reportsWaiting.length > 0 && <span className="tab-count alert">{state.reportsWaiting.length}</span>}
            </a>
          ))}
        </div>
        <span className="top-right">
          {state.network === "local" ? (
            <span className="network local" title="Recalls live in a file on this machine. Nothing is public, and only agents on this machine obey them.">
              Local mode: this machine only
            </span>
          ) : (
            <span className="network" title="Recalls are public records on Arkiv, a test network. Any agent that obeys you can read them from anywhere.">
              Public list: Arkiv testnet
            </span>
          )}
          {unreachable && <span className="network bad">Lost contact with the console</span>}
        </span>
      </nav>
      <main>
        {error && (
          <div className="notice bad" role="alert">
            {error}
            <button className="link" onClick={() => setError(undefined)}>
              Dismiss
            </button>
          </div>
        )}
        {route !== "reports" &&
          state.reportsWaiting.map((r) => (
            <div className="notice bad" role="alert" key={r.key}>
              <span>
                <b>
                  {r.votes} {r.votes === 1 ? "person has" : "people have"} reported {r.target}
                  {r.simulated > 0 ? ` (${r.simulated} simulated)` : ""}.
                </b>{" "}
                {r.reason}
              </span>
              <a href="#/reports">Decide</a>
            </div>
          ))}
        {route === "reports" ? (
          <ReportsPage onAsk={setAsk} run={run} canSign={state.owner.canSign} />
        ) : route === "diary" ? (
          <DiaryPage run={run} />
        ) : route === "machine" ? (
          <MachinePage state={state} now={now} onAsk={setAsk} run={run} />
        ) : route === "arkiv" ? (
          <ArkivPage onAsk={setAsk} run={run} />
        ) : route === "services" ? (
          <ServicesPage />
        ) : (
          <AgentsPage onAsk={setAsk} run={run} />
        )}
      </main>
      {ask && <AskDialog ask={ask} close={() => setAsk(undefined)} run={run} />}
    </>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Console />
  </StrictMode>,
)
