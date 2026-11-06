// Starts the demo with simple built-in rules instead of an AI model, for trying things out without spending credits.
// The website shows a clear warning while this is on. A real demo must use `npm run demo`.
export {}

process.env.DEV_BRAIN = "1"
await import("../apps/demo/src/server")
