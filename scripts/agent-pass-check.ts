import { agentPassFromEnv } from "@ceasenet/guard"

// Runs one real Agent Pass attempt against World: asks for a person, waits for them, and validates what comes back.
// Press Ctrl+C, refuse in the app, or let it expire to see the other outcomes. Nothing goes ahead on any of them.
const pass = agentPassFromEnv()
if (!pass) {
  console.log("Set WORLD_IDP_CLIENT_ID and WORLD_IDP_CLIENT_SECRET in .env first, from the portal at /portal on your issuer.")
  process.exit(1)
}

const t0 = Date.now()
console.log(`issuer ${pass.opts.issuer}`)
const attempt = await pass.start()
console.log(`\nOpen ${attempt.verificationUriComplete ?? attempt.verificationUri}\nCode ${attempt.userCode}\n`)
console.log(`Waiting, until ${new Date(attempt.expiresAt).toLocaleTimeString()}…`)

const result = await attempt.result
if (result.ok) {
  // The subject identifies the person to this app, so it stays out of the output.
  console.log(`validated after ${((Date.now() - t0) / 1000).toFixed(0)} s: issuer ${result.issuer}, class ${result.acr}, methods ${result.amr.join(", ")}`)
  console.log("A real run would now let the paused call go ahead.")
  process.exit(0)
}
console.log(`not approved (${result.reason}): ${result.message}`)
console.log("A real run would keep the call paused and refuse it.")
process.exit(1)
