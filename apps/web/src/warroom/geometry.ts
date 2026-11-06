/** The live screen is laid out on a fixed stage and scaled to fit, so it looks the same on a laptop, a recording and a projector. */
export const STAGE_W = 1600
export const STAGE_H = 780

export const MAP_X = 306
export const MAP_W = 950

export const AGENT_X = 668
export const AGENT_W = 290
export const AGENT_H = 192
export const agentCentre = (index: number) => 172 + index * 200

export interface Point {
  x: number
  y: number
}

export type IssuerId = "maker" | "verifier" | "outsider"

export const ISSUERS: Record<IssuerId, Point> = {
  maker: { x: 358, y: 190 },
  verifier: { x: 358, y: 372 },
  outsider: { x: 358, y: 554 },
}

export const HUB: Point & { r: number } = { x: 510, y: 372, r: 76 }
export const CUSTOMERS: Point = { x: 1205, y: 232 }
export const STRANGER: Point = { x: 1205, y: 520 }

const curve = (a: Point, b: Point) => {
  const mid = (a.x + b.x) / 2
  return `M${a.x} ${a.y} C${mid} ${a.y} ${mid} ${b.y} ${b.x} ${b.y}`
}

const agentLeft = (i: number): Point => ({ x: AGENT_X, y: agentCentre(i) })
const agentRight = (i: number): Point => ({ x: AGENT_X + AGENT_W, y: agentCentre(i) })

export const issuerPath = (id: IssuerId) => curve(ISSUERS[id], HUB)
export const readPath = (i: number) => curve(HUB, agentLeft(i))
export const receiptPath = (i: number) => curve(agentLeft(i), HUB)
export const customerPath = (i: number) => curve(agentRight(i), CUSTOMERS)
export const strangerPath = (i: number) => curve(agentRight(i), STRANGER)

/** Where a stolen copy's line is cut: halfway along it, which is also its middle on the page. */
export const cutPoint = (i: number): Point => {
  const a = agentRight(i)
  return { x: (a.x + STRANGER.x) / 2, y: (a.y + STRANGER.y) / 2 }
}
