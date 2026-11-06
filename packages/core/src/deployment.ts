import deployment from "../../../deployment.json"
import { CONFIRMATION_THRESHOLD } from "./timers"
import type { Hex, TrustPolicy } from "./types"

/** Public addresses of the demo's keys. The matching secrets stay in .env. */
export const ADDRESSES = deployment.addresses as Record<keyof typeof deployment.addresses, Hex>

export const DEMO_OWNERS: readonly Hex[] = [ADDRESSES.ownerA, ADDRESSES.ownerB, ADDRESSES.ownerC]
export const DEMO_AGENTS: readonly Hex[] = [ADDRESSES.agentA, ADDRESSES.agentB, ADDRESSES.agentC]

/** The trust list the demo's owners start from. Each owner publishes their own and can change it at any time. */
export const demoPolicy = (): TrustPolicy => ({
  issuers: [ADDRESSES.maker, ADDRESSES.regulator, ADDRESSES.publisher],
  regulators: [ADDRESSES.regulator],
  verifier: ADDRESSES.verifier,
  threshold: CONFIRMATION_THRESHOLD,
})
