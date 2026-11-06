import { useEffect, useState } from "react"
import { AnimatePresence, motion, MotionConfig } from "motion/react"
import type { Hex } from "@ceasenet/core"
import { Icon, PageTransition } from "../../shared/design"
import { AgentPage } from "./AgentPage"
import { CheckPage } from "./CheckPage"
import { IssuePage } from "./IssuePage"
import { LoginBadge, LoginPage } from "./login"
import { NetworkPage } from "./NetworkPage"
import { PublicHome } from "./PublicHome"
import { RecallPage, RecallsPage } from "./RecallPages"
import { RegisterPage } from "./RegisterPage"
import { ReportPage } from "./ReportPage"

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

/** The pages, in order. Each says whether it is the one showing. */
const NAV: { href: string; label: string; on: (page: string) => boolean }[] = [
  { href: "#/", label: "Home", on: (page) => page === "" },
  { href: "#/network", label: "Network", on: (page) => page === "network" },
  { href: "#/recalls", label: "Recalls", on: (page) => page.startsWith("recall") },
  { href: "#/check", label: "Check a tool", on: (page) => page === "check" },
  { href: "#/report", label: "Open a recall", on: (page) => page === "report" || page === "issue" },
  { href: "#/register", label: "Register an agent", on: (page) => page === "register" },
]

const TITLES: Record<string, string> = {
  agent: "Agent record",
  recalls: "Recalls",
  recall: "Recall record",
  check: "Check a tool",
  report: "Open a recall",
  network: "Network",
  issue: "Stop it as the owner",
  register: "Register an agent",
  login: "Log in with World",
}

export function WebApp() {
  const route = useHash()
  const [page = "", arg = ""] = route.split("/")
  const [menu, setMenu] = useState(false)
  useEffect(() => setMenu(false), [route])
  useEffect(() => {
    document.title = `CeaseNet — ${TITLES[page] ?? "Recalls for AI agents"}`
  }, [page])
  useEffect(() => {
    if (!menu) return
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false)
    }
    window.addEventListener("keydown", close)
    return () => window.removeEventListener("keydown", close)
  }, [menu])

  const content =
    page === "agent" ? (
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
    ) : page === "issue" ? (
      <IssuePage />
    ) : page === "register" ? (
      <RegisterPage />
    ) : page === "login" ? (
      <LoginPage next={route.split("/").slice(1).join("/")} />
    ) : (
      <PublicHome />
    )

  return (
    <MotionConfig reducedMotion="user">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById("main-content")?.focus()
        }}
      >
        Skip to content
      </a>
      <header className="site-header">
        <div className="brand-block">
          <a className="brand-word" href="#/" aria-label="CeaseNet home">
            CeaseNet
          </a>
          <span className="tagline">Recalls for AI agents</span>
        </div>
        <nav className="desktop-nav" aria-label="Main navigation">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className={n.on(page) ? "active" : ""} aria-current={n.on(page) ? "page" : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
        <LoginBadge route={route} />
        <button className="mobile-toggle" aria-label={menu ? "Close navigation" : "Open navigation"} aria-expanded={menu} aria-controls="mobile-nav" onClick={() => setMenu(!menu)}>
          <Icon name={menu ? "close" : "menu"} />
        </button>
      </header>
      <AnimatePresence>
        {menu && (
          <motion.nav id="mobile-nav" className="mobile-nav" aria-label="Mobile navigation" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className={n.on(page) ? "active" : ""} aria-current={n.on(page) ? "page" : undefined} onClick={() => setMenu(false)}>
                {n.label}
              </a>
            ))}
            <a href="#/login" className={page === "login" ? "active" : ""} aria-current={page === "login" ? "page" : undefined} onClick={() => setMenu(false)}>
              Log in with World
            </a>
          </motion.nav>
        )}
      </AnimatePresence>
      <main id="main-content" tabIndex={-1} className="workspace-content">
        <PageTransition key={route} route={route}>
          {content}
        </PageTransition>
      </main>
    </MotionConfig>
  )
}
