import { formatEther } from "viem"
import { arkivPublicClient, arkivWalletClient } from "@ceasenet/core"
import { accountFor, ROLES, type Role } from "./roles"

// Shares the treasury's testnet funds between the wallets that write to Arkiv.
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const client = arkivPublicClient(accessKey)
const treasury = arkivWalletClient(accountFor("treasury"), accessKey)

const balance = await client.getBalance({ address: treasury.account!.address })
console.log("treasury", treasury.account!.address, formatEther(balance), "tGLM")
if (balance === 0n) {
  console.log("Treasury is empty. Claim from https://hub.arkiv.network/faucet first.")
  process.exitCode = 1
} else {

  const writers: Role[] = ROLES.filter((r) => r !== "treasury")
  // Robots write the most, because of heartbeats.
  const weights: Partial<Record<Role, bigint>> = { robot1: 4n, robot2: 4n, robot3: 4n, verifier: 3n, officeAgent: 2n }
  const total = writers.reduce((sum, r) => sum + (weights[r] ?? 1n), 0n)
  const spendable = (balance * 80n) / 100n
  const unit = spendable / total

  for (const role of writers) {
    const to = accountFor(role).address
    const have = await client.getBalance({ address: to })
    const want = unit * (weights[role] ?? 1n)
    if (have >= want) {
      console.log(role.padEnd(12), "has", formatEther(have))
      continue
    }
    const hash = await treasury.sendTransaction({ to, value: want - have })
    await client.waitForTransactionReceipt({ hash })
    console.log(role.padEnd(12), "now", formatEther(await client.getBalance({ address: to })))
  }
}
