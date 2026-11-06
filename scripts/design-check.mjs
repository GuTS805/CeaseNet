// Browser regression checks. Every API is intercepted; no real agent is mutated.
import { chromium } from "@playwright/test"
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"

const publicURL = process.env.DESIGN_WEB_URL || "http://127.0.0.1:5173"
const consoleURL = process.env.DESIGN_CONSOLE_URL || "http://127.0.0.1:5174"
const address = `0x${"11".repeat(20)}`
const hash = `0x${"22".repeat(32)}`
const now = Date.now()
const errors = [], failures = [], mutations = [], checks = []
const members = ["Momentum trader", "Mean reversion", "Risk watcher"].map((name, i) => ({
  id: `agent-${i}`, name, does: ["Follows market momentum with paper money.", "Looks for prices returning to their mean.", "Watches market risk without placing orders."][i],
  tools: i === 2 ? ["market"] : ["market", "broker"], address, alive: i !== 2,
  state: { id: `agent-${i}`, name, pid: 1234 + i, phase: i === 2 ? "off" : "working", jobs: 12 + i, checks: 30, lastSaid: "Market observation complete.", lastCheck: { at: now, block: "100", online: true, tookMs: 80, stopsRead: 0 } },
  calls: [], guards: [], results: [], resultCount: 0, events: [], receiptPosted: false,
}))
const tools = ["market", "broker"].map(id => ({ id, label: `${id === "market" ? "Market data" : "Paper broker"} tool`, spec: `trade-${id}-tool@1.0.0`, file: { kind: "tool", name: `trade-${id}-tool`, version: "1.0.0", hash }, usedBy: members.filter(m => m.tools.includes(id)).map(m => m.name) }))
const state = { network: "local", agent: { name: "This machine", address, status: "ALLOW" }, owner: { address, canSign: true }, tools: [], guardsRunning: 0, calls: [], approvals: [], problems: [], notes: [], clients: [], reportsWaiting: [], claudeCode: { present: true, covered: true }, trust: { issuers: [address], regulators: [], verifier: address, threshold: 3 }, fleet: [], recalls: [] }
const fixtures = {
  "/api/state": state,
  "/api/team": { network: "local", choices: [], thinking: { kind: "api", model: "Test model", host: "Test provider", requestsPerMinute: 10 }, members, tools, canSign: true },
  "/api/reports": { reports: [{ key: hash, artifact: hash, reason: "Review this sample tool behavior.", about: [{ agent: "Momentum trader", address, through: "broker tool" }], target: "trade-broker-tool", kind: "tool", votes: 3, disputes: 0, simulated: 3, votesNeeded: 3, state: "waiting", versions: "1.0.0" }], votesNeeded: 3, verifier: address },
  "/api/diary": { where: "local", faucet: "https://example.com", agents: [{ id: "main", name: "Momentum trader", address, mode: "public", entries: 2, parts: 1, waiting: 0 }] },
  "/api/diary/main": { id: "main", name: "Momentum trader", address, mode: "public", where: "local", totalParts: 1, canOpenSealed: false, parts: [{ root: hash, head: hash, firstSeq: 1, lastSeq: 2, entries: 2, block: "100", check: { ok: true }, followsOn: true, items: [{ seq: 1, at: now, prev: hash, kind: "CALL", tool: "trade-market-tool", version: "1.0.0", action: "get_market_data", argsHash: hash, verdict: "ALLOW", allowed: true, args: { market: "BTC-USD" } }, { seq: 2, at: now, prev: hash, kind: "CALL", tool: "trade-broker-tool", version: "1.0.0", action: "place_order", argsHash: hash, verdict: "BLOCK", allowed: false, message: "Owner recall" }] }] },
  "/api/arkiv": { mode: "local", chain: { name: "Arkiv testnet", chainId: 60138453025, rpc: "https://example.com", explorer: "https://example.com", reachable: true, block: "100", latencyMs: 80, accessKey: false, keyExhausted: false }, publicList: { recalls: 1, stops: 1, warnings: 0, agents: 3, receipts: 1, lifts: 0, files: 2 }, wallets: [], agents: [], records: { Recalls: [{ type: "STOP", key: hash, creator: address, block: "100", summary: "Broker tool recalled" }] }, gateQuery: { issuers: [address], verifier: address, text: "Test query" }, canGoPublic: false, goPublicBlockedBy: "Test environment" },
  "/api/services": ["Model provider", "Arkiv", "World ID", "Swarm"].map((name, i) => ({ id: String(i), name, status: i === 2 ? "not-set-up" : "working", purpose: "Sample service status for layout verification.", found: ["Test configuration"], usedBy: "Your agents", ...(i === 2 ? { todo: "Set up World ID to verify reports." } : {}) })),
}

fixtures["/api/arkiv"].wallets = [{ role: "Owner", address, balance: "1.0", empty: false, link: "https://example.com" }]
await mkdir(".design-review", { recursive: true })
const browser = await chromium.launch({ channel: process.env.DESIGN_BROWSER || "chrome", headless: true })
async function contextFor(base, consoleMode = false, reducedMotion = "no-preference") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion })
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url())
    if (consoleMode && url.pathname.startsWith("/api/")) {
      if (request.method() === "POST") { mutations.push({ path: url.pathname, body: request.postDataJSON() }); return route.fulfill({ json: { ok: true } }) }
      return route.fulfill({ json: fixtures[url.pathname] ?? {} })
    }
    if (url.origin === base) return route.continue()
    if (request.method() === "POST") {
      let rpc
      try { rpc = request.postDataJSON() } catch { return route.abort() }
      const reply = item => ({ jsonrpc: "2.0", id: item.id, result: item.method === "eth_blockNumber" ? "0x64" : item.method === "eth_chainId" ? "0xe00" : { data: [], blockNumber: "0x64" } })
      if (rpc?.method || Array.isArray(rpc)) return route.fulfill({ json: Array.isArray(rpc) ? rpc.map(reply) : reply(rpc) })
    }
    return route.abort()
  })
  const page = await context.newPage()
  page.on("pageerror", e => errors.push({ page: page.url().split("#")[1] || "/", message: e.message }))
  return { context, page }
}
async function check(name, action) {
  try { await action(); checks.push(name); console.log(`PASS ${name}`) }
  catch (error) { failures.push({ name, error: error.message }); console.log(`FAIL ${name}: ${error.message}`) }
}
async function overflow(page) {
  return page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
}
async function revealAll(page) {
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo({ top: y, behavior: "instant" }); await new Promise(r => setTimeout(r, 100)) } window.scrollTo({ top: 0, behavior: "instant" }) })
  await page.waitForTimeout(700)
}

try {
  const { context, page } = await contextFor(publicURL)
  const routes = ["", "network", "recalls", "check", "report", "issue", "register", "login", `agent/${address}`, `recall/${hash}`, "missing-page"]
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 })
    for (const route of routes) await check(`Public /${route || "home"} at ${width}px`, async () => {
      await page.goto(`${publicURL}/#/${route}`)
      await page.waitForTimeout(500)
      assert.ok((await page.locator("main").innerText()).trim().length > 15, "Page has no meaningful content")
      const size = await overflow(page)
      assert.ok(size.content <= size.width + 1, `Horizontal overflow: ${size.content} > ${size.width}`)
      assert.equal(await page.locator(".net-map,.map svg").count(), 0, "A flowchart remains")
      if (width === 1440 && ["", "network", "register", "check"].includes(route)) {
        await revealAll(page)
        await page.screenshot({ path: `.design-review/public-${route || "home"}.png`, fullPage: route !== "" })
      }
    })
  }
  // The pages, in order, as the header lists them. Every one is reachable from every page.
  const pages = [["Home", ""], ["Network", "network"], ["Recalls", "recalls"], ["Check a tool", "check"], ["Open a recall", "report"], ["Register an agent", "register"]]
  await check("The header lists every page, in order, and each link opens it", async () => {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto(`${publicURL}/#/network`)
    const nav = page.locator(".desktop-nav")
    assert.deepEqual((await nav.locator("a").allInnerTexts()).map(t => t.trim()), pages.map(([label]) => label))
    for (const [label, path] of pages) {
      await nav.getByRole("link", { name: label, exact: true }).click()
      await page.waitForURL(`**/#/${path}`)
      assert.equal(await nav.getByRole("link", { name: label, exact: true }).getAttribute("aria-current"), "page")
    }
  })
  await check("An unknown address shows the home page", async () => {
    await page.goto(`${publicURL}/#/no-such-page`)
    await page.waitForTimeout(300)
    assert.equal(await page.locator(".desktop-nav").getByRole("link", { name: "Home", exact: true }).getAttribute("aria-current"), null)
    assert.ok((await page.locator("main").innerText()).trim().length > 15)
  })
  await check("Mobile navigation lists the same pages, navigates, and closes", async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(publicURL)
    await page.getByRole("button", { name: "Open navigation" }).click()
    assert.deepEqual((await page.locator("#mobile-nav a").allInnerTexts()).map(t => t.trim()), [...pages.map(([label]) => label), "Log in with World"])
    await page.locator("#mobile-nav").getByRole("link", { name: "Check a tool", exact: true }).click()
    await page.waitForURL("**/#/check")
    await page.locator("#mobile-nav").waitFor({ state: "hidden" })
    assert.equal(await page.getByRole("button", { name: "Open navigation" }).getAttribute("aria-expanded"), "false")
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(publicURL)
  await revealAll(page)
  await page.screenshot({ path: ".design-review/home-mobile.png", fullPage: true })
  await context.close()

  const consoleSession = await contextFor(consoleURL, true)
  const cp = consoleSession.page
  for (const width of [1440, 768, 390, 320]) {
    await cp.setViewportSize({ width, height: 960 })
    for (const route of ["", "machine", "reports", "diary", "arkiv", "services"]) await check(`Console /${route || "agents"} at ${width}px`, async () => {
      await cp.goto(`${consoleURL}/#/${route}`)
      await cp.locator("h1").waitFor()
      await cp.waitForTimeout(450)
      const size = await overflow(cp)
      assert.ok(size.content <= size.width + 1, `Horizontal overflow: ${size.content} > ${size.width}`)
      assert.ok((await cp.locator("h1").innerText()).length > 0)
      if (route === "diary" && width <= 390) {
        const details = await cp.locator(".diary-calls td.why").first().boundingBox()
        assert.ok(details && details.width >= 200 && details.height < 500, "Diary content is compressed on mobile")
      }
      if (width === 1440 || width === 390) await cp.screenshot({ path: `.design-review/console-${route || "agents"}-${width}.png`, fullPage: true })
    })
  }
  await check("Console stop requires a reason and sends the correct request", async () => {
    await cp.setViewportSize({ width: 1440, height: 960 })
    await cp.goto(consoleURL)
    await cp.getByRole("button", { name: "Stop all three", exact: true }).click()
    const dialog = cp.getByRole("dialog")
    await dialog.waitFor()
    assert.equal(await dialog.getByRole("button", { name: "Stop all three", exact: true }).isDisabled(), true)
    await dialog.getByPlaceholder("Something is wrong, and I want them all to stop").fill("Browser regression test")
    await dialog.getByRole("button", { name: "Stop all three", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.deepEqual(mutations.at(-1), { path: "/api/team/stop", body: { reason: "Browser regression test" } })
  })
  await check("Console confirmation cancels with Escape", async () => {
    await cp.getByRole("button", { name: "Stop all three", exact: true }).click()
    await cp.getByRole("dialog").waitFor()
    await cp.keyboard.press("Escape")
    await cp.getByRole("dialog").waitFor({ state: "hidden" })
    assert.equal(mutations.length, 1)
  })
  await check("Diary filter keeps only blocked calls", async () => {
    await cp.goto(`${consoleURL}/#/diary`)
    await cp.getByText("get_market_data", { exact: false }).waitFor()
    await cp.getByLabel("Only refusals and closing").check()
    assert.equal(await cp.getByText("get_market_data", { exact: false }).count(), 0)
    assert.equal(await cp.getByText("place_order", { exact: false }).count(), 1)
  })
  await check("Empty diaries have an actionable empty state", async () => {
    const previous = fixtures["/api/diary"]
    fixtures["/api/diary"] = { ...previous, agents: [] }
    try { await cp.goto(`${consoleURL}/#/diary`); await cp.getByText("Your first entry starts with an agent.").waitFor() }
    finally { fixtures["/api/diary"] = previous }
  })
  await consoleSession.context.close()

  await check("Reduced motion disables page entrance transforms", async () => {
    const reduced = await contextFor(publicURL, false, "reduce")
    try {
      await reduced.page.goto(`${publicURL}/#/network`)
      await reduced.page.waitForTimeout(500)
      assert.equal(await reduced.page.locator(".route-content").evaluate(el => getComputedStyle(el).transform), "none")
    } finally { await reduced.context.close() }
  })
  await check("No uncaught browser exceptions", async () => assert.deepEqual(errors, []))
} finally {
  await browser.close()
  await writeFile(".design-review/results.json", JSON.stringify({ passed: checks.length, failures, errors }, null, 2))
}
console.log(`\n${checks.length} passed; ${failures.length} failed.`)
if (failures.length) process.exitCode = 1
