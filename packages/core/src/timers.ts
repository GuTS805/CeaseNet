/** Arkiv produces a block every 2 seconds. */
export const BLOCK_SECONDS = 2

export const blocksIn = (seconds: number): bigint => BigInt(Math.ceil(seconds / BLOCK_SECONDS))

export interface Timers {
  /** How often the gate reads Arkiv, on top of the check before every task. */
  checkIntervalMs: number
  heartbeatIntervalMs: number
  /** A heartbeat that is not refreshed within this time disappears, which reads as "unknown". */
  heartbeatTtlSeconds: number
  /** After losing Arkiv: keep working this long. */
  graceMs: number
  /** Then run supervised this long, then stop. */
  offlineSupervisedMs: number
}

export const PRODUCTION_TIMERS: Timers = {
  checkIntervalMs: 30_000,
  heartbeatIntervalMs: 60_000,
  heartbeatTtlSeconds: 600,
  graceMs: 300_000,
  offlineSupervisedMs: 300_000,
}

/** Shortened so a recall can be watched live. Say so out loud in the demo. */
export const DEMO_TIMERS: Timers = {
  checkIntervalMs: 2_000,
  heartbeatIntervalMs: 8_000,
  heartbeatTtlSeconds: 30,
  graceMs: 20_000,
  offlineSupervisedMs: 20_000,
}

/** Confirmations older than this do not count, whatever their expiry says. */
export const CONFIRMATION_WINDOW_BLOCKS = blocksIn(72 * 3600)

export const CONFIRMATION_THRESHOLD = 3
