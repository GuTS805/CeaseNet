import deployment from "../../../deployment.json"
import { makeTrust } from "./gate"
import { CONFIRMATION_THRESHOLD, CONFIRMATION_WINDOW_BLOCKS } from "./timers"
import type { Hex } from "./types"

/** Public addresses of the demo's keys. The matching secrets stay in .env. */
export const ADDRESSES = deployment.addresses as Record<keyof typeof deployment.addresses, Hex>

export const ROBOT_ADDRESSES: readonly Hex[] = [ADDRESSES.robot1, ADDRESSES.robot2, ADDRESSES.robot3]

/** Who a robot in this demo listens to. A real fleet would set this per operator. */
export const fleetTrust = () =>
  makeTrust({
    stopKeys: [ADDRESSES.maker, ADDRESSES.regulator, ADDRESSES.publisher],
    regulators: [ADDRESSES.regulator],
    verifier: ADDRESSES.verifier,
    threshold: CONFIRMATION_THRESHOLD,
    windowBlocks: CONFIRMATION_WINDOW_BLOCKS,
  })
