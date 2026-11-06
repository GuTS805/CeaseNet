import type { IncomingMessage, ServerResponse } from "node:http"
import {
  ADDRESSES,
  arkivPublicClient,
  arkivWalletClient,
  ArkivWriter,
  type Hex,
  lower,
  readAgent,
  readEndorsements,
  readHuman,
  readHumanById,
  readRecallsBy,
} from "@ceasenet/core"
import type { LocalAccount } from "viem/accounts"
import { AlreadyReported, CONFIRM_ACTION, Refused, Verifier, type WorldEnvironment } from "./verifier"

const MAX_BODY_BYTES = 64 * 1024
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...args)

export interface VerifierSettings {
  appId: string
  rpId: string
  signingKey: string
  environment: WorldEnvironment
  accessKey: string
  /** The verifier's own wallet. It must be the one in deployment.json, or nobody would believe what it writes. */
  account: LocalAccount
  /**
   * Remember which World ID requests this verifier started. A server that runs for a while does. A serverless one,
   * where the next request may reach another copy, cannot.
   */
  trackRequests?: boolean
}

/** What the verifier answers, for any Node server: our own, or a serverless function. */
export function verifierHandler(settings: VerifierSettings): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  if (lower(settings.account.address) !== lower(ADDRESSES.verifier)) {
    throw new Error(`This key is for ${settings.account.address}, but the verifier everyone checks for is ${ADDRESSES.verifier}.`)
  }
  const { appId, rpId, environment } = settings
  const client = arkivPublicClient(settings.accessKey)
  const writer = new ArkivWriter(arkivWalletClient(settings.account, settings.accessKey))

  const verifier = new Verifier({
    rpId,
    signingKey: settings.signingKey,
    environment,
    trackRequests: settings.trackRequests,
    readWarning: async (recall) => {
      const { rows } = await readRecallsBy(client, [ADDRESSES.verifier])
      return rows.find((r) => lower(r.key) === lower(recall) && r.level === "ADVISORY")
    },
    readEndorsements: (recall) => readEndorsements(client, [recall], ADDRESSES.verifier),
    endorse: (input) => writer.endorse(input),
    readOpenReports: async (artifact) => {
      const { rows } = await readRecallsBy(client, [ADDRESSES.verifier])
      return rows.filter((r) => r.level === "ADVISORY" && lower(r.artifact) === lower(artifact))
    },
    agentExists: async (address) => Boolean(await readAgent(client, address)),
    fileReport: (input) => writer.advisory({ artifact: input.artifact, severity: "REPORT", reason: input.reason, pkg: input.pkg, versions: input.versions, opener: input.opener }),
    readHuman: (address) => readHuman(client, address, ADDRESSES.verifier),
    readHumanById: (human) => readHumanById(client, human, ADDRESSES.verifier),
    writeHuman: (input) => writer.human(input),
  })

  return async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {})
    const route = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`
    try {
      // Only public values. The signing key stays here.
      if (route === "GET /api/world-config") return send(res, 200, { appId, rpId, action: CONFIRM_ACTION, environment })
      if (route === "POST /api/rp-signature") return send(res, 200, verifier.rpSignature())
      if (route === "POST /api/login") {
        const body = await readBody(req)
        const done = await verifier.login({ address: body.address, signature: body.signature, at: body.at, result: body.result })
        log(`${done.already ? "logged in again" : "logged in"}: ${done.address}`)
        return send(res, 200, done)
      }
      if (route === "POST /api/confirm") {
        const body = await readBody(req)
        const done = await verifier.confirm({ recall: body.recall as Hex, stance: body.stance, address: body.address, signature: body.signature, at: body.at })
        log(`${body.stance} from ${done.human} on ${body.recall}: ${done.key}`)
        return send(res, 200, done)
      }
      if (route === "POST /api/report") {
        const body = await readBody(req)
        const done = await verifier.report({ target: body.target, reason: body.reason, address: body.address, signature: body.signature, at: body.at })
        log(`recall opened by ${body.address}: ${done.key}`)
        return send(res, 200, done)
      }
      return send(res, 404, { error: "not found" })
    } catch (e) {
      if (e instanceof AlreadyReported) return send(res, 409, { code: "already_reported", error: e.message, key: e.key })
      if (e instanceof Refused) {
        log(`refused ${route}: ${e.code}`)
        return send(res, 400, { code: e.code, error: e.message })
      }
      log("failed", route, (e as Error).message.split("\n")[0])
      return send(res, 500, { code: "server_error", error: "Something went wrong, and nothing was counted." })
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  })
  res.end(JSON.stringify(body))
}

const parse = (text: string): any => {
  if (text.length > MAX_BODY_BYTES) throw new Refused("too_large", "This request is too large.")
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new Refused("bad_request", "This request is not valid JSON.")
  }
}

async function readBody(req: IncomingMessage): Promise<any> {
  // A serverless platform may have read the body already.
  const given = (req as IncomingMessage & { body?: unknown }).body
  if (typeof given === "string") return parse(given)
  if (given instanceof Uint8Array) return parse(Buffer.from(given).toString("utf8"))
  if (given && typeof given === "object") return given
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Refused("too_large", "This request is too large.")
    chunks.push(c as Buffer)
  }
  return parse(Buffer.concat(chunks).toString("utf8"))
}
