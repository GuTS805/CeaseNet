// The verifier, with simulated people allowed, for showing the whole flow: World's simulator can only ever be one
// identity, so three different people cannot vote with it. Each simulated vote says so on the public record, and the
// verifier refuses this outright in production.
export {}

process.env.VERIFIER_ALLOW_SIMULATED = "1"
await import("../apps/verifier/src/server")
