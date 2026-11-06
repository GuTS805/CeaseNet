import { useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Icon, Reveal } from "../../shared/design"

export function DemoPreview({ compact = false }: { compact?: boolean }) {
  const [stopped, setStopped] = useState(false)
  const [recalled, setRecalled] = useState(false)
  const [diary, setDiary] = useState(false)
  const [query, setQuery] = useState("")
  const reduced = useReducedMotion()
  const actions = [
    { icon: "stop" as const, label: stopped ? "Resume Momentum" : "Stop Momentum", action: () => setStopped(!stopped), hint: "01" },
    { icon: "layers" as const, label: recalled ? "Lift demo recall" : "Recall trade-broker-tool", action: () => setRecalled(!recalled), hint: "02" },
    { icon: "diary" as const, label: diary ? "Close activity diary" : "Open activity diary", action: () => setDiary(!diary), hint: "03" },
  ].filter(a => a.label.toLowerCase().includes(query.toLowerCase()))
  return <div className={`demo-stack ${compact ? "compact" : "expanded"}`}>
    <motion.div className="stack-receipt glass-panel" animate={{ y: reduced ? 0 : recalled || stopped ? -6 : 0 }} transition={{ type: "spring", stiffness: 160, damping: 22 }}><Icon name="check" /><span aria-live="polite">{recalled ? "Recall receipt recorded" : stopped ? "Stop receipt recorded" : "Your decisions. On the record."}</span></motion.div>
    <div className="stack-diary glass-panel"><div className="preview-title"><b>Activity diary</b><span>Demo / Sample data</span></div>{["Momentum", "Reversion", "Risk watcher"].map((a, i) => <div className="preview-agent" key={a}><span>{a}</span><span className={i === 2 || recalled || i === 0 && stopped ? "copper" : ""}>{i === 2 || recalled || i === 0 && stopped ? "Stopped" : "Active"}</span></div>)}</div>
    <div className="stack-command glass-panel"><div className="eyebrow">CEASENET / QUICK ACTIONS</div><label className="command-search"><Icon name="search" /><input aria-label="Search demo actions" placeholder="What do you want to control?" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="command-actions">{actions.map(a => <motion.button type="button" key={a.icon} className={`command-action ${a.icon === "layers" ? "highlight" : ""}`} onClick={a.action} whileHover={{ x: reduced ? 0 : 4 }} whileTap={{ scale: reduced ? 1 : .985 }}><Icon name={a.icon} size={23} /><span>{a.label}</span><kbd>{a.hint}</kbd></motion.button>)}{actions.length === 0 && <p className="muted">No matching actions.</p>}</div>
      <AnimatePresence initial={false}>{diary && <motion.div className="preview-history" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reduced ? 0 : .25 }}><div><span>01</span> Demo agents started</div>{stopped && <div><span>02</span> Momentum stopped by owner</div>}{recalled && <div><span>03</span> Broker tool recalled. Calls blocked.</div>}<div><Icon name="check" size={14} /> Illustrative receipt recorded</div></motion.div>}</AnimatePresence>
      {!compact && <p className="demo-disclaimer">Interactive sample. These controls only change this preview.</p>}
      <span className="sr-only" role="status">{recalled ? "Demo broker tool recalled. Both traders stopped." : stopped ? "Demo Momentum agent stopped." : "Demo Momentum and Reversion active."}</span>
    </div>
  </div>
}

export function DemoPage() {
  return <div className="page designed-page"><div className="page-lead"><span className="eyebrow">THE PRODUCT / INTERACTIVE PREVIEW</span><h1>Your decision.<br /><span className="text-dim">See it take effect.</span></h1><p>Try a stop, recall the broker tool, and open the diary. This sample runs in your browser; it does not control real agents.</p></div><Reveal className="demo-stage"><DemoPreview /></Reveal><div className="demo-bottom"><p className="muted">Ready for your own agents? Your local console connects these actions to real tools.</p><a className="button primary" href="#/console">Open your console <Icon name="arrow" size={18} /></a></div></div>
}

export function ProductPage() {
  return <div className="page designed-page"><div className="page-lead"><span className="eyebrow">THE PRODUCT / BUILT FOR YOUR FINAL SAY</span><h1>Autonomy.<br /><span className="text-dim">With accountability.</span></h1><p>A safety layer for the tools your AI agents already use. You choose who they trust. You keep control.</p><a className="button primary" href="#/demo">Try the interactive demo <Icon name="arrow" size={18} /></a></div>
    {[
      ["01", "Stop.", "A decision that reaches your agents.", "Stop one agent or all the agents you own. Covered tool calls are refused and their processes end. In Claude Code, protected built-in tools are covered too.", "Open console", "#/console"],
      ["02", "Recall.", "One tool. Every agent that follows you.", "Bind a recall to an exact package version or fingerprint. Gates independently read it from Arkiv. Only owners who follow your key obey your decision.", "Recall a tool", "#/issue"],
      ["03", "Verify.", "An activity history you can check.", "Tool calls and gate decisions go into an agent's diary. Its hashes and index make changes detectable. Discover registered agents and inspect their public records.", "Explore the network", "#/network"],
      ["04", "Report.", "A human voice. An owner's decision.", "Anyone can report a problem. World ID verifies unique people, and enough verified votes notify the owner. The owner decides whether to issue a recall.", "Report a problem", "#/report"],
    ].map(([n, title, subtitle, text, label, href]) => <Reveal key={n} className="product-chapter"><span className="eyebrow">{n} / CAPABILITY</span><h2>{title}</h2><div><h3>{subtitle}</h3><p>{text}</p><a className="text-link" href={href}>{label}<Icon name="arrow" size={18} /></a></div></Reveal>)}
  </div>
}

export function DocsPage({ consoleSetup = false }: { consoleSetup?: boolean }) {
  const [copied, setCopied] = useState("")
  const [copyError, setCopyError] = useState("")
  const copy = async (command: string) => { try { await navigator.clipboard.writeText(command); setCopied(command); setCopyError("") } catch { setCopyError("Clipboard is unavailable. Select and copy the command below.") } }
  return <div className="page designed-page docs-page"><div className="page-lead"><span className="eyebrow">{consoleSetup ? "YOUR WORKSPACE / LOCAL CONSOLE" : "DOCUMENTATION / GET STARTED"}</span><h1>{consoleSetup ? "Your control room." : "Protection starts here."}</h1><p>{consoleSetup ? "Your console runs on your machine and connects to your agents. Start it locally, then open your workspace." : "Bring CeaseNet to your existing agents. Start locally, then move to the public recall list when you're ready."}</p></div>
    {consoleSetup && <Reveal className="console-connect card"><Icon name="terminal" size={32} /><div><h2>Open your local console</h2><p className="muted">After running the command below, open the address printed in your terminal. The program supplies the session token needed for access.</p><pre className="commands">ceasenet console</pre><a className="button" href="http://127.0.0.1:7787" target="_blank" rel="noreferrer">Open localhost:7787 <Icon name="arrow" size={17} /></a><small className="muted">If a token is requested, use the full URL from your terminal.</small></div></Reveal>}
    <div className="docs-layout"><aside className="docs-aside"><span className="eyebrow">IN THIS GUIDE</span><a href="#/docs">Quick start</a><a href="#/protect">Register an agent</a><a href="#/issue">Recall a tool</a><a href="#/check">Check a version</a><a href="https://github.com/GuTS805/CeaseNet#readme" target="_blank" rel="noreferrer">Full documentation <Icon name="arrow" size={15} /></a></aside><div className="docs-steps">
    <p className="muted">Requires Node.js 22.10 or newer. Run these commands in a terminal. On Windows, use <code>npm.cmd</code> if PowerShell blocks npm scripts.</p>
    {[
      ["01", "Get the project", "Clone the repository and install its dependencies.", "git clone https://github.com/GuTS805/CeaseNet.git\ncd CeaseNet\nnpm install\nnpm run install-cli"],
      ["02", "Create your identity", "Start on this machine without a wallet or test tokens.", "ceasenet init --local"],
      ["03", "Protect your tools", "CeaseNet finds supported clients and puts the gate in front of their MCP tools. Restart your agent client afterwards.", "ceasenet protect"],
      ["04", "Open the console", "Watch calls, review approvals, and stop your agents from one workspace.", "ceasenet console"],
    ].map(([n, title, text, command]) => <Reveal className="docs-step" key={n}><span className="eyebrow">STEP {n}</span><h2>{title}</h2><p>{text}</p><div className="code-frame"><pre>{command}</pre><button onClick={() => void copy(command!)} aria-label={`Copy commands for ${title}`}>{copied === command ? "Copied" : "Copy"}</button></div></Reveal>)}
    <p role="status" className="muted">{copyError || (copied ? "Command copied to clipboard." : "")}</p>
    <Reveal className="card"><h2>Move beyond this machine.</h2><p className="muted">The public list runs on Arkiv testnet. Fund your owner wallet with test tokens, then switch networks from your console. Agents on other machines can follow your owner key.</p><a className="text-link" href="#/protect">Set up your public identity <Icon name="arrow" size={18} /></a></Reveal>
    </div></div>
  </div>
}
