import { createServer } from "node:http"
import { hashBytes } from "@ceasenet/core"

// A stand-in for a Bee node, for rehearsing the Swarm path with no postage. Nothing leaves this machine, and nothing
// here is on Swarm: it only answers the two calls CeaseNet makes, following Bee's published API.
//
//   BEE_API_URL=http://localhost:1633
//   SWARM_GATEWAY_URL=http://localhost:1633
//   SWARM_POSTAGE_BATCH_ID=<any 64 hex characters>
const PORT = Number(process.env.LOCAL_BEE_PORT ?? 1633)
const stored = new Map<string, Buffer>()

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*")
  if (req.method === "OPTIONS") return void res.writeHead(204, { "access-control-allow-headers": "*" }).end()
  const path = new URL(req.url ?? "/", "http://x").pathname
  if (req.method === "POST" && path === "/bzz") {
    if (!/^[0-9a-fA-F]{64}$/.test(String(req.headers["swarm-postage-batch-id"]))) {
      return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ code: 400, message: "invalid batch" }))
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const ref = hashBytes(body).slice(2)
    const reference = req.headers["swarm-encrypt"] === "true" ? ref + hashBytes(ref).slice(2) : ref
    stored.set(reference, body)
    console.log(`stored ${body.length} bytes as ${reference.slice(0, 16)}…${req.headers["swarm-encrypt"] === "true" ? " (encrypted)" : ""}`)
    return void res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ reference }))
  }
  const found = path.match(/^\/bzz\/([0-9a-fA-F]+)$/)
  const file = found ? stored.get(found[1]!) : undefined
  if (req.method === "GET" && file) return void res.writeHead(200, { "content-type": "application/json" }).end(file)
  return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ code: 404, message: "not found" }))
})

server.listen(PORT, () => console.log(`stand-in for Bee on http://localhost:${PORT}. This is not Swarm.`))
