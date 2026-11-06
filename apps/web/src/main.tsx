import "@fontsource/big-shoulders-display/800"
import "@fontsource/big-shoulders-display/900"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "@fontsource/ibm-plex-mono/600.css"
import "@fontsource/ibm-plex-sans/400.css"
import "@fontsource/ibm-plex-sans/500.css"
import "@fontsource/ibm-plex-sans/600.css"
import "@fontsource/ibm-plex-sans/700.css"
import "./styles.css"
import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { Hex } from "@ceasenet/core"
import { AgentPage } from "./AgentPage"
import { CheckPage } from "./CheckPage"
import { HOSTED } from "./lib"
import { IssuePage } from "./IssuePage"
import { LivePage } from "./LivePage"
import { NetworkPage } from "./NetworkPage"
import { ProtectPage } from "./ProtectPage"
import { PublicHome } from "./PublicHome"
import { RecallPage, RecallsPage } from "./RecallPages"
import { ReportPage } from "./ReportPage"
import { WalletProvider } from "./wallet"

function useHash() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash)
      // A new page starts at its top, or it opens partway down with its heading out of sight.
      window.scrollTo(0, 0)
    }
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
            {HOSTED ? "Home" : "Live demo"}
          </a>
          <a className={page === "network" ? "on" : ""} href="#/network">
            Network
          </a>
          <a className={page.startsWith("recall") ? "on" : ""} href="#/recalls">
            Recalls
          </a>
          <a className={page === "check" ? "on" : ""} href="#/check">
            Check a tool
          </a>
          <a className={page === "report" ? "on" : ""} href="#/report">
            Report
          </a>
          <a className={page === "protect" ? "on" : ""} href="#/protect">
            Protect an agent
          </a>
          <a className={page === "issue" ? "on" : ""} href="#/issue">
            Recall a tool
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
      ) : page === "report" ? (
        <ReportPage key={arg} agent={arg || undefined} />
      ) : page === "network" ? (
        <NetworkPage />
      ) : page === "protect" ? (
        <ProtectPage key={arg} suggested={arg} />
      ) : page === "issue" ? (
        <IssuePage />
      ) : HOSTED ? (
        <PublicHome />
      ) : (
        <LivePage />
      )}
    </>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </StrictMode>,
)
