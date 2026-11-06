import { motion, useReducedMotion, useScroll, useTransform } from "motion/react"
import { useRef } from "react"
import { Icon, Reveal } from "../../shared/design"
import { DemoPreview } from "./ProductPages"

export function LandingPage() {
  const hero = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: hero, offset: ["start start", "end start"] })
  const y = useTransform(scrollYProgress, [0, 1], [0, 110])
  return <div className="after-home">
    <section className="after-hero" ref={hero}>
      <motion.div className="metal-art" style={{ y: reduced ? 0 : y }} aria-hidden="true" />
      <div className="hero-grid"><div className="hero-copy">
        <motion.h1 initial={{ opacity: 0, y: reduced ? 0 : 25 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .8, ease: [.22, 1, .36, 1] }}><span>Powerful agents.</span><span>Your final say.</span></motion.h1>
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: .15, duration: .7 }}>Stop agents. Recall tools. Keep the record.</motion.p>
        <motion.div className="hero-ctas" initial={{ opacity: 0, y: reduced ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .25, duration: .6 }}><a className="button primary" href="#/demo">Explore demo</a><a className="button ghost" href="#/protect">Protect an agent</a></motion.div>
      </div><motion.div className="hero-product" initial={{ opacity: 0, y: reduced ? 0 : 40 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .2, duration: .9, ease: [.22, 1, .36, 1] }}><DemoPreview compact /></motion.div></div>
      <div className="hero-verbs"><a href="#/product">Stop.</a><a href="#/issue">Recall.</a><a href="#/check">Verify.</a><span className="eyebrow">Autonomy.<br />With accountability.</span></div>
    </section>
    <section className="editorial-section"><Reveal className="section-intro"><span className="eyebrow">01 / Your agents. Your control.</span><h2>Let them do the work.<br /><span className="text-dim">Keep the final word.</span></h2><p>CeaseNet sits between your agents and their tools. You decide what can run, what must stop, and whose recalls to trust.</p></Reveal><div className="feature-columns">
      {[
        { n: "01", icon: "stop" as const, title: "A real off switch.", text: "Stop your agent's covered tool calls and end its tool processes. Your instruction takes effect at the next check.", href: "#/console", label: "Meet your console" },
        { n: "02", icon: "layers" as const, title: "Recall the tool.", text: "Recall an exact tool version. Agents whose owners follow your key refuse it, wherever they run.", href: "#/issue", label: "Issue a recall" },
        { n: "03", icon: "diary" as const, title: "Leave a record.", text: "Review what an agent did. Verify its diary against the public index and discover if anything changed.", href: "#/network", label: "Explore the records" },
      ].map((f, i) => <Reveal key={f.n} delay={i * .08} className="feature-column"><div className="feature-top"><Icon name={f.icon} size={25} /><span className="eyebrow">{f.n}</span></div><h3>{f.title}</h3><p>{f.text}</p><a href={f.href}>{f.label}<Icon name="arrow" size={17} /></a></Reveal>)}
    </div></section>
    <section className="record-section"><Reveal><span className="eyebrow">02 / Independent by design</span><h2>Your control.<br />Without a central switch.</h2><p>Each gate reads the public recall list on Arkiv independently. Your agents can obey your decision even when the CeaseNet console is offline.</p><a className="text-link" href="#/network">Explore the network <Icon name="arrow" /></a></Reveal><Reveal className="record-art" delay={.1}><div className="record-paper"><div className="eyebrow">CEASENET / ON THE RECORD</div><Icon name="check" size={39} /><h3>Accountability,<br />built in.</h3><dl><div><dt>Recall list</dt><dd>Arkiv</dd></div><div><dt>Control</dt><dd>Your owner key</dd></div><div><dt>History</dt><dd>Verifiable diary</dd></div><div><dt>Network</dt><dd>Testnet</dd></div></dl></div></Reveal></section>
    <Reveal className="closing-section"><span className="eyebrow">Start with one agent.</span><h2>Make the call.</h2><p>Protect the tools your agents already use.</p><div className="hero-ctas"><a className="button primary" href="#/protect">Protect an agent <Icon name="arrow" size={18} /></a><a className="button ghost" href="#/docs">Read the docs</a></div></Reveal>
  </div>
}
