// Starts the robots with the local development planner, for trying things out without a 0G key.
// The website shows a clear warning while this is on. A real demo must use `npm run fleet`, which uses 0G.
export {}

process.env.DEV_PLANNER = "1"
await import("../apps/fleet/src/server")
