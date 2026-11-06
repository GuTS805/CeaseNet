import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { Hex } from "@ceasenet/core"
import { AgentPage } from "./AgentPage"
import { CheckPage } from "./CheckPage"
import { LivePage } from "./LivePage"
import { RecallPage, RecallsPage } from "./RecallPages"
import "./styles.css"

function useHash() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  return hash.replace(/^#\/?/, "")
}

function App() {
  const route = useHash()
  const [page = "", arg = ""] = route.split("/")
  return (
    <>
      <header className="top">
        <a className="brand" href="#/">
          Cease<span>Net</span>
        </a>
        <span className="tagline">Recalls for AI agents</span>
        <nav className="nav">
          <a className={page === "" ? "on" : ""} href="#/">
            Live
          </a>
          <a className={page.startsWith("recall") ? "on" : ""} href="#/recalls">
            Recalls
          </a>
          <a className={page === "check" ? "on" : ""} href="#/check">
            Check a tool
          </a>
        </nav>
      </header>
      {page === "agent" ? (
        <AgentPage key={arg} address={arg as Hex} />
      ) : page === "recalls" ? (
        <RecallsPage />
      ) : page === "recall" ? (
        <RecallPage key={arg} recallKey={arg as Hex} />
      ) : page === "check" ? (
        <CheckPage />
      ) : (
        <LivePage />
      )}
    </>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
