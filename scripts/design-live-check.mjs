// Requires the web dev server in demo mode at port 5175. All APIs are mocked.
import { chromium } from "@playwright/test"
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"

const base = process.env.DESIGN_DEMO_URL || "http://127.0.0.1:5175"
const hash = `0x${"22".repeat(32)}`
const file = { kind: "tool", name: "mail-tool", version: "1.0.0", hash }
const data = {
  brainSource: "dev", model: "Browser fixture", timers: { checkIntervalMs: 2000 }, idle: false,
  stolenMail: [], tools: { bad: file, fixed: { ...file, version: "1.1.0" }, files: file },
  swarm: { on: false, evidenceReady: false }, worldIdApprovals: false,
  agents: ["Acme", "Northstar", "Meridian"].map((company, i) => ({
    id: `agent-${i}`, company, address: `0x${String(i + 1).repeat(40)}`, owner: `0x${"44".repeat(20)}`,
    status: "RUNNING", online: true, followsMaker: true, tools: [{ file, verdict: "ALLOW" }],
    jobs: 5, sent: 5, stolen: 2, drafts: 3,
    feed: [{ id: 1, at: Date.now(), kind: "allowed", text: "Mail tool call completed." }],
    fixAvailable: false, vanished: [], diary: { entries: 5, waiting: 0, parts: [] },
  })),
}
await mkdir(".design-review", { recursive: true })
const browser = await chromium.launch({ channel: process.env.DESIGN_BROWSER || "chrome" })
const page = await browser.newPage()
const errors = []
page.on("pageerror", e => errors.push(e.message))
await page.route("**/*", async route => {
  const req = route.request(), url = new URL(req.url())
  if (url.pathname === "/api/state") return route.fulfill({ json: data })
  if (url.origin === base) return route.continue()
  if (req.method() === "POST") {
    let rpc
    try { rpc = req.postDataJSON() } catch { return route.abort() }
    const reply = r => ({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_blockNumber" ? "0x64" : { data: [], blockNumber: "0x64" } })
    if (rpc?.method || Array.isArray(rpc)) return route.fulfill({ json: Array.isArray(rpc) ? rpc.map(reply) : reply(rpc) })
  }
  return route.abort()
})
try {
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 })
    await page.goto(`${base}/#/`)
    await page.locator(".live-agent-wrapper").first().waitFor()
    await page.waitForTimeout(700)
    assert.equal(await page.locator(".live-agent-wrapper").count(), 3)
    assert.equal(await page.locator(".war-map,.net-map").count(), 0)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow at ${width}px`)
    const clipped = await page.locator(".live-agent-wrapper,.phase,.rail,.inbox").evaluateAll(elements => elements.filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => el.className))
    assert.deepEqual(clipped, [], `Clipped demo sections at ${width}px`)
    await page.screenshot({ path: `.design-review/live-demo-${width}.png`, fullPage: true })
    console.log(`PASS Connected demo at ${width}px`)
  }
  assert.deepEqual(errors, [])
  console.log("PASS No connected-demo browser exceptions")
} finally { await browser.close() }
