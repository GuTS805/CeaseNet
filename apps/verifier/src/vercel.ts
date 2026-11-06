import type { IncomingMessage, ServerResponse } from "node:http"
import { type Hex } from "@ceasenet/core"
import { privateKeyToAccount } from "viem/accounts"
import { verifierHandler } from "./handler"
import type { WorldEnvironment } from "./verifier"

/**
 * The verifier as a serverless function, for the hosted site. Its keys come from the platform's settings, and only
 * the verifier's own key is there: not the phrase the other wallets come from.
 */
let handle: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined

const MISSING = ["WORLD_APP_ID", "WORLD_RP_ID", "WORLD_RP_SIGNING_KEY", "VERIFIER_PRIVATE_KEY"]

export default async function verifier(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const missing = MISSING.filter((name) => !process.env[name])
  if (missing.length) {
    res.writeHead(503, { "content-type": "application/json", "access-control-allow-origin": "*" })
    res.end(JSON.stringify({ code: "not_set_up", error: `The verifier is not set up here yet: ${missing.join(", ")} missing.` }))
    return
  }
  handle ??= verifierHandler({
    appId: process.env.WORLD_APP_ID!,
    rpId: process.env.WORLD_RP_ID!,
    signingKey: process.env.WORLD_RP_SIGNING_KEY!,
    environment: (process.env.WORLD_ENVIRONMENT || "production") as WorldEnvironment,
    accessKey: process.env.ARKIV_ACCESS_KEY ?? "",
    account: privateKeyToAccount(process.env.VERIFIER_PRIVATE_KEY as Hex),
    trackRequests: false,
    allowBypass: process.env.VERIFIER_ALLOW_BYPASS === "1",
  })
  // The site's /api/<route> is rewritten to this one function, with the route passed along.
  const route = new URL(req.url ?? "/", "http://x").searchParams.get("route")
  if (route) req.url = `/api/${route}`
  return handle(req, res)
}
