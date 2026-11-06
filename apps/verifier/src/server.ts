import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  ADDRESSES,
  arkivPublicClient,
  arkivWalletClient,
  ArkivWriter,
  type Hex,
  lower,
  readEndorsements,
  readRecallsBy,
} from "@ceasenet/core"
import { accountFor } from "../../../scripts/roles"
import { CONFIRM_ACTION, Refused, Verifier, type WorldEnvironment } from "./verifier"

const PORT = Number(process.env.VERIFIER_PORT ?? 8788)
const MAX_BODY_BYTES = 64 * 1024
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...args)

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is missing from .env`)
  return value
}

const appId = required("WORLD_APP_ID")
const rpId = required("WORLD_RP_ID")
const environment = (process.env.WORLD_ENVIRONMENT || "staging") as WorldEnvironment

const accessKey = required("ARKIV_ACCESS_KEY")
const client = arkivPublicClient(accessKey)
const writer = new ArkivWriter(arkivWalletClient(accountFor("verifier"), accessKey))

const verifier = new Verifier({
  rpId,
  signingKey: required("WORLD_RP_SIGNING_KEY"),
  environment,
  readWarning: async (recall) => {
    const { rows } = await readRecallsBy(client, [ADDRESSES.verifier])
    return rows.find((r) => lower(r.key) === lower(recall) && r.level === "ADVISORY")
  },
  readEndorsements: (recall) => readEndorsements(client, [recall], ADDRESSES.verifier),
  endorse: (input) => writer.endorse(input),
})

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Refused("too_large", "This request is too large.")
    chunks.push(c as Buffer)
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
  } catch {
    throw new Refused("bad_request", "This request is not valid JSON.")
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {})
  const route = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`
  try {
    // Only public values. The signing key stays here.
    if (route === "GET /api/world-config") return send(res, 200, { appId, rpId, action: CONFIRM_ACTION, environment })
    if (route === "POST /api/rp-signature") return send(res, 200, verifier.rpSignature())
    if (route === "POST /api/confirm") {
      const body = await readBody(req)
      const done = await verifier.confirm({ recall: body.recall as Hex, stance: body.stance, result: body.result })
      log(`${body.stance} counted on ${body.recall}: ${done.key}`)
      return send(res, 200, done)
    }
    return send(res, 404, { error: "not found" })
  } catch (e) {
    if (e instanceof Refused) {
      log(`refused ${route}: ${e.code}`)
      return send(res, 400, { code: e.code, error: e.message })
    }
    log("failed", route, (e as Error).message.split("\n")[0])
    return send(res, 500, { code: "server_error", error: "Something went wrong, and nothing was counted." })
  }
})

server.listen(PORT, () => log(`verifier on http://localhost:${PORT}, World ID ${environment}, action ${CONFIRM_ACTION}`))
