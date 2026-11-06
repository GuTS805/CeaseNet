import { useImperativeHandle, useRef, type Ref } from "react"
import { ADDRESSES } from "@ceasenet/core"
import { shortHash } from "../lib"
import type { MailLine } from "./events"
import {
  AGENT_W,
  AGENT_X,
  CUSTOMERS,
  customerPath,
  cutPoint,
  HUB,
  issuerPath,
  type IssuerId,
  ISSUERS,
  readPath,
  receiptPath,
  STAGE_H,
  STAGE_W,
  STRANGER,
  strangerPath,
} from "./geometry"

export type Tone = "red" | "teal" | "amber" | "white"

const COLOUR: Record<Tone, string> = { red: "#ff4b4b", teal: "#2de2c5", amber: "#ffb020", white: "#dfe7f2" }

const SVG = "http://www.w3.org/2000/svg"
const make = (tag: string, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el as SVGGraphicsElement
}

/** How long a stolen copy takes to arrive. The inbox waits this long before showing it. */
export const LEAK_MS = 800
const EASE = "cubic-bezier(.4,.05,.6,.95)"

/** What the page can set off on the map. Every call comes from a real event: see events.ts. */
export interface MapFx {
  email(i: number): void
  leak(i: number): void
  refused(i: number): void
  snap(i: number): void
  receipt(i: number, tone: Tone): void
  moved(i: number): void
  fromIssuer(id: IssuerId, tone: Tone): void
  startPulse(id: IssuerId, tone: Tone): void
  stopPulse(): void
  wave(tone: Tone, reachable: readonly boolean[]): void
  block(): void
}

function createFx(layer: SVGGElement): MapFx {
  let pulse: ReturnType<typeof setInterval> | undefined

  /** A dot with a tail that runs along a path. The paths are all measured as 100 long. */
  const comet = (d: string, tone: Tone, ms: number, to = 100, size = 1) => {
    const base = { d, fill: "none", pathLength: 100, stroke: COLOUR[tone], "stroke-linecap": "round" }
    const parts = [
      { width: 15 * size, opacity: 0.14, dash: 7 },
      { width: 3 * size, opacity: 0.6, dash: 16 },
      { width: 8 * size, opacity: 1, dash: 0.01 },
    ]
    // Past the end of the path, so the tail runs out too. A dot that stops short just stops.
    const stop = to === 100 ? 118 : to
    return Promise.all(
      parts.map(async ({ width, opacity, dash }) => {
        const el = make("path", { ...base, "stroke-width": width, opacity, "stroke-dasharray": `${dash} 400` })
        layer.append(el)
        const run = el.animate([{ strokeDashoffset: dash }, { strokeDashoffset: dash - stop }], { duration: ms, easing: EASE, fill: "forwards" })
        await run.finished.catch(() => undefined)
        el.remove()
      }),
    )
  }

  const ring = (x: number, y: number, r: number, tone: Tone, scale: number, ms: number, delay = 0, width = 2.5) => {
    const el = make("circle", { cx: x, cy: y, r, fill: "none", stroke: COLOUR[tone], "stroke-width": width, "vector-effect": "non-scaling-stroke", opacity: 0 })
    el.style.transformBox = "fill-box"
    el.style.transformOrigin = "center"
    layer.append(el)
    const run = el.animate(
      [
        { transform: "scale(1)", opacity: 0.95 },
        { transform: `scale(${scale})`, opacity: 0 },
      ],
      { duration: ms, delay, easing: "cubic-bezier(.15,.7,.3,1)", fill: "both" },
    )
    void run.finished.catch(() => undefined).then(() => el.remove())
  }

  const sparks = (x: number, y: number, tone: Tone, count: number, reach: number) => {
    for (let n = 0; n < count; n++) {
      const angle = (n / count) * Math.PI * 2 + Math.random() * 0.6
      const far = reach * (0.5 + Math.random() * 0.7)
      const el = make("circle", { cx: x, cy: y, r: 1.4 + Math.random() * 2.2, fill: COLOUR[tone] })
      layer.append(el)
      const run = el.animate(
        [
          { transform: "translate(0,0)", opacity: 1 },
          { transform: `translate(${Math.cos(angle) * far}px,${Math.sin(angle) * far}px)`, opacity: 0 },
        ],
        { duration: 340 + Math.random() * 380, easing: "cubic-bezier(.1,.7,.3,1)", fill: "forwards" },
      )
      void run.finished.catch(() => undefined).then(() => el.remove())
    }
  }

  const fromIssuer = (id: IssuerId, tone: Tone) => {
    void comet(issuerPath(id), tone, 620, 100, 1.1).then(() => ring(HUB.x, HUB.y, HUB.r, tone, 1.28, 600))
  }

  return {
    email: (i) => void comet(customerPath(i), "teal", LEAK_MS, 100, 0.8),
    leak: (i) => {
      const end = comet(strangerPath(i), "red", LEAK_MS, 100, 1.1)
      void end.then(() => {
        ring(STRANGER.x, STRANGER.y, 30, "red", 1.9, 620)
        sparks(STRANGER.x, STRANGER.y, "red", 7, 40)
      })
    },
    refused: (i) => {
      void comet(strangerPath(i), "red", 340, 50, 0.9).then(() => {
        const at = cutPoint(i)
        sparks(at.x, at.y, "red", 10, 34)
      })
    },
    snap: (i) => {
      const at = cutPoint(i)
      ring(at.x, at.y, 14, "red", 4.4, 560, 0, 3)
      sparks(at.x, at.y, "red", 26, 88)
    },
    receipt: (i, tone) => {
      void comet(receiptPath(i), tone, 720, 100, 1).then(() => ring(HUB.x, HUB.y, HUB.r, tone, 1.22, 520))
    },
    moved: (i) => {
      const x = AGENT_X + AGENT_W / 2
      sparks(x, 172 + i * 200, "teal", 20, 120)
    },
    fromIssuer,
    startPulse: (id, tone) => {
      clearInterval(pulse)
      fromIssuer(id, tone)
      pulse = setInterval(() => fromIssuer(id, tone), 520)
    },
    stopPulse: () => clearInterval(pulse),
    wave: (tone, reachable) => {
      for (const delay of [0, 170, 340]) ring(HUB.x, HUB.y, HUB.r, tone, 7.5, 1150, delay, 3)
      reachable.forEach((reached, i) => {
        void comet(readPath(i), tone, 460, reached ? 100 : 55, 1.15)
      })
    },
    block: () => ring(HUB.x, HUB.y, HUB.r, "teal", 1.18, 900, 0, 1.2),
  }
}

const IssuerNode = ({ id, label, sub, address, tone }: { id: IssuerId; label: string; sub: string; address: string; tone: string }) => {
  const { x, y } = ISSUERS[id]
  return (
    <g className={`issuer ${tone}`}>
      <circle cx={x} cy={y} r={25} />
      <circle cx={x} cy={y} r={7} className="core" />
      <text x={x} y={y + 44} className="n-label">
        {label}
      </text>
      <text x={x} y={y + 60} className="n-mono">
        {shortHash(address)}
      </text>
      <text x={x} y={y + 75} className="n-sub">
        {sub}
      </text>
    </g>
  )
}

export interface MapAgent {
  line: MailLine
  online: boolean
  follows: boolean
}

/** The map: who holds the keys, the public record, the agents, and where each email goes. */
export function WarMap({ ref, agents, block, sent, stolenLive }: { ref: Ref<MapFx | null>; agents: readonly MapAgent[]; block?: bigint; sent: number; stolenLive: boolean }) {
  const layer = useRef<SVGGElement>(null)
  useImperativeHandle(ref, () => createFx(layer.current!), [])
  return (
    <svg className="map" viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} width={STAGE_W} height={STAGE_H} aria-hidden="true">
      <defs>
        <radialGradient id="hub-fill">
          <stop offset="0%" stopColor="#15303a" />
          <stop offset="100%" stopColor="#0a1219" />
        </radialGradient>
      </defs>

      {(Object.keys(ISSUERS) as IssuerId[]).map((id) => (
        <path key={id} d={issuerPath(id)} pathLength={100} className={`wire issuer-wire ${id}`} />
      ))}

      {agents.map((a, i) => (
        <g key={i}>
          <path d={readPath(i)} pathLength={100} className={`wire read ${a.online ? "" : "offline"} ${a.follows ? "" : "unfollowed"}`} />
          <path d={customerPath(i)} pathLength={100} className="wire mail" />
          <path d={strangerPath(i)} pathLength={100} className={`wire steal ${a.line}`} />
        </g>
      ))}

      <g ref={layer} />

      {agents.map((a, i) =>
        a.line === "cut" ? (
          <g key={i} className="cut-mark" transform={`translate(${cutPoint(i).x} ${cutPoint(i).y})`}>
            <circle r={11} />
            <path d="M-4.5 -4.5 L4.5 4.5 M4.5 -4.5 L-4.5 4.5" />
          </g>
        ) : null,
      )}

      <IssuerNode id="maker" label="MAKER" sub="owners follow this key" address={ADDRESSES.maker} tone="trusted" />
      <IssuerNode id="verifier" label="VERIFIER" sub="counts World ID proofs" address={ADDRESSES.verifier} tone="watch" />
      <IssuerNode id="outsider" label="OUTSIDER" sub="nobody follows this key" address={ADDRESSES.outsider} tone="stranger" />

      <g className="hub">
        <circle cx={HUB.x} cy={HUB.y} r={HUB.r + 12} className="hub-orbit" />
        <circle cx={HUB.x} cy={HUB.y} r={HUB.r} fill="url(#hub-fill)" className="hub-body" />
        <text x={HUB.x} y={HUB.y - 8} className="hub-name">
          ARKIV
        </text>
        <text x={HUB.x} y={HUB.y + 12} className="hub-label">
          BLOCK
        </text>
        <text x={HUB.x} y={HUB.y + 32} className="hub-block">
          {block === undefined ? "…" : String(block)}
        </text>
      </g>

      <g className="sink customers">
        <circle cx={CUSTOMERS.x} cy={CUSTOMERS.y} r={30} />
        <text x={CUSTOMERS.x} y={CUSTOMERS.y + 8} className="sink-count">
          {sent}
        </text>
        <text x={CUSTOMERS.x} y={CUSTOMERS.y + 50} className="n-label">
          CUSTOMERS
        </text>
      </g>
      <g className={`sink stranger ${stolenLive ? "live" : "dark"}`}>
        <circle cx={STRANGER.x} cy={STRANGER.y} r={30} />
        <path d={`M${STRANGER.x - 10} ${STRANGER.y - 10} L${STRANGER.x + 10} ${STRANGER.y + 10} M${STRANGER.x + 10} ${STRANGER.y - 10} L${STRANGER.x - 10} ${STRANGER.y + 10}`} />
        <text x={STRANGER.x} y={STRANGER.y + 50} className="n-label">
          STRANGER
        </text>
      </g>
    </svg>
  )
}
