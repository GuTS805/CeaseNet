import { execSync, spawnSync } from "node:child_process"

// Starts the demo over from nothing: stops a demo that is already running, clears the record, seeds it, and starts again.
const PORT = process.env.DEMO_PORT ?? "8787"

function stopRunningDemo(): void {
  if (process.platform === "win32") {
    const listening = execSync("netstat -ano -p tcp", { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((f) => f[1]?.endsWith(`:${PORT}`) && f[3] === "LISTENING")
    // /T also ends the tool processes the demo started.
    for (const pid of new Set(listening.map((f) => f[4]))) execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" })
    if (listening.length > 0) console.log("stopped the demo that was running")
    return
  }
  spawnSync("sh", ["-c", `lsof -ti tcp:${PORT} -s tcp:LISTEN | xargs kill`], { stdio: "ignore" })
}

function run(script: string): void {
  const { status } = spawnSync("npm", ["run", script], { stdio: "inherit", shell: true })
  if (status !== 0) {
    console.error(`npm run ${script} failed, so the demo was not started`)
    process.exit(status ?? 1)
  }
}

stopRunningDemo()
run("reset")
run("seed")
run("demo")
