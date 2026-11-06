import { useEffect, useState } from "react"
import { AnimatePresence, motion, MotionConfig } from "motion/react"
import type { Hex } from "@ceasenet/core"
import { Icon, PageTransition } from "../../shared/design"
import { AgentPage } from "./AgentPage"
import { CheckPage } from "./CheckPage"
import { IssuePage } from "./IssuePage"
import { LivePage } from "./LivePage"
import { NetworkPage } from "./NetworkPage"
import { ProtectPage } from "./ProtectPage"
import { RecallPage, RecallsPage } from "./RecallPages"
import { ReportPage } from "./ReportPage"
import { LandingPage } from "./LandingPage"
import { DemoPage, DocsPage, ProductPage } from "./ProductPages"
import { HOSTED } from "./lib"

const tools = [["network", "Network"], ["recalls", "Recalls"], ["check", "Check a tool"], ["report", "Reports"], ["protect", "Protect an agent"], ["issue", "Recall a tool"]] as const
const titles: Record<string, string> = { "": "Your final say", product: "Product", demo: "Interactive demo", docs: "Documentation", console: "Your console", network: "Network", recalls: "Recalls", recall: "Recall record", check: "Check a tool", report: "Report a problem", protect: "Protect an agent", issue: "Recall a tool", agent: "Agent record" }

export function WebApp() {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#\/?/, ""))
  const [menu, setMenu] = useState(false)
  const [page = "", arg = ""] = route.split("/")
  useEffect(() => {
    const on = () => { setRoute(window.location.hash.replace(/^#\/?/, "")); setMenu(false); window.scrollTo({ top: 0, behavior: "instant" }) }
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  useEffect(() => { document.title = `CeaseNet — ${titles[page] ?? "Page not found"}` }, [page])
  useEffect(() => {
    if (!menu) return
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false) }
    window.addEventListener("keydown", close)
    return () => window.removeEventListener("keydown", close)
  }, [menu])
  const operational = ["network", "recalls", "recall", "check", "report", "protect", "issue", "agent"].includes(page)
  const content = page === "" ? <LandingPage /> : page === "product" ? <ProductPage /> : page === "demo" ? HOSTED ? <DemoPage /> : <LivePage /> : page === "docs" ? <DocsPage /> : page === "console" ? <DocsPage consoleSetup /> : page === "agent" ? <AgentPage key={arg} address={arg as Hex} /> : page === "recalls" ? <RecallsPage /> : page === "recall" ? <RecallPage key={arg} recallKey={arg as Hex} /> : page === "check" ? <CheckPage /> : page === "report" ? <ReportPage key={arg} agent={arg || undefined} /> : page === "network" ? <NetworkPage /> : page === "protect" ? <ProtectPage key={arg} suggested={arg} /> : page === "issue" ? <IssuePage /> : <div className="page empty-state"><h1>Page not found.</h1><p>This address doesn't point to a CeaseNet page.</p><a className="button primary" href="#/">Back to home</a></div>
  return <MotionConfig reducedMotion="user">
    <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); document.getElementById("main-content")?.focus() }}>Skip to content</a>
    <header className="site-header"><a className="brand-word" href="#/" aria-label="CeaseNet home">CeaseNet</a><nav className="desktop-nav" aria-label="Main navigation">{[["product", "Product"], ["network", "Network"], ["docs", "Docs"]].map(([path, label]) => <a key={path} href={`#/${path}`} className={page === path ? "active" : ""} aria-current={page === path ? "page" : undefined}>{label}</a>)}<a className="button primary console-link" href="#/console">Open console</a></nav><button className="mobile-toggle" aria-label={menu ? "Close navigation" : "Open navigation"} aria-expanded={menu} aria-controls="mobile-nav" onClick={() => setMenu(!menu)}><Icon name={menu ? "close" : "menu"} /></button></header>
    <AnimatePresence>{menu && <motion.nav id="mobile-nav" className="mobile-nav" aria-label="Mobile navigation" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>{[["", "Home"], ["product", "Product"], ["demo", "Demo"], ...tools, ["docs", "Docs"], ["console", "Open console"]].map(([path, label]) => <a key={path} href={`#/${path}`} onClick={() => setMenu(false)}>{label}</a>)}</motion.nav>}</AnimatePresence>
    {operational && <nav className="workspace-nav" aria-label="Network tools"><span className="eyebrow">PUBLIC WORKSPACE</span><div>{tools.map(([path, label]) => <a key={path} href={`#/${path}`} className={page === path || path === "recalls" && page === "recall" || path === "network" && page === "agent" ? "active" : ""} aria-current={page === path ? "page" : undefined}>{label}</a>)}</div><span className="testnet-label">Arkiv testnet</span></nav>}
    <main id="main-content" tabIndex={-1} className={operational ? "workspace-content" : "marketing-content"}><PageTransition key={route} route={route}>{content}</PageTransition></main>
    <footer className="site-footer"><div><a className="brand-word" href="#/">CeaseNet</a><p>Powerful agents. Your final say.</p><span className="eyebrow">Independent control / Arkiv testnet</span></div><div className="footer-links"><a href="#/product">Product</a><a href="#/demo">Demo</a><a href="#/network">Network</a><a href="#/recalls">Recalls</a><a href="#/check">Check a tool</a><a href="#/protect">Protect an agent</a><a href="#/report">Report a problem</a><a href="#/docs">Documentation</a><a href="https://github.com/GuTS805/CeaseNet" target="_blank" rel="noreferrer">GitHub</a></div><div className="footer-bottom"><span>Stop. Recall. Verify.</span><span>Built for your final say.</span></div></footer>
  </MotionConfig>
}
