import { useEffect, useRef, type ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"

export function Icon({ name, size = 20 }: { name: "stop" | "layers" | "diary" | "search" | "check" | "arrow" | "close" | "menu" | "terminal"; size?: number }) {
  const paths: Record<string, ReactNode> = {
    stop: <rect x="5" y="5" width="14" height="14" rx="3" />,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    diary: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>,
    search: <><circle cx="10.5" cy="10.5" r="7" /><path d="m16 16 5 5" /></>,
    check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

// The CN monogram, traced from the logo artwork. The C's counter is closed by the N's first stem.
export const LOGO_MARK_PATH = "M90 0H200L312 117V0H370V216H327L221 101V216H90A90 90 0 0 1 0 126V90A90 90 0 0 1 90 0ZM165 59V157H86A28 28 0 0 1 58 129V87A28 28 0 0 1 86 59Z"

export function LogoMark({ className = "brand-mark" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 370 216" fill="currentColor" aria-hidden="true" focusable="false"><path fillRule="evenodd" d={LOGO_MARK_PATH} /></svg>
}

export function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduced = useReducedMotion()
  return <motion.div className={className} initial={{ opacity: 0, y: reduced ? 0 : 22 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.08 }} transition={{ duration: reduced ? 0 : 0.65, delay, ease: [0.22, 1, 0.36, 1] }}>{children}</motion.div>
}

export function PageTransition({ children, route, className = "" }: { children: ReactNode; route: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  useEffect(() => {
    const heading = ref.current?.querySelector<HTMLElement>("h1")
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }) }
  }, [route])
  return <motion.div ref={ref} key={route} className={`route-content ${className}`} initial={{ opacity: 0, y: reduced ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : 0.35, ease: [0.22, 1, 0.36, 1] }}>{children}</motion.div>
}
