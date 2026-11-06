import { createServer } from "node:http"
import { accountFor } from "../../../scripts/roles"
import { verifierHandler } from "./handler"
import { CONFIRM_ACTION, type WorldEnvironment } from "./verifier"

const PORT = Number(process.env.VERIFIER_PORT ?? 8788)

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is missing from .env`)
  return value
}

const environment = (process.env.WORLD_ENVIRONMENT || "staging") as WorldEnvironment

const handle = verifierHandler({
  appId: required("WORLD_APP_ID"),
  rpId: required("WORLD_RP_ID"),
  signingKey: required("WORLD_RP_SIGNING_KEY"),
  environment,
  accessKey: process.env.ARKIV_ACCESS_KEY ?? "",
  account: accountFor("verifier"),
  trackRequests: true,
  allowBypass: process.env.VERIFIER_ALLOW_BYPASS === "1",
})

createServer((req, res) => void handle(req, res)).listen(PORT, () =>
  console.log(`${new Date().toISOString().slice(11, 23)} verifier on http://localhost:${PORT}, World ID ${environment}, action ${CONFIRM_ACTION}`),
)
