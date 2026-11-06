import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { arkivPublicClient, arkivWalletClient, type Hex } from "@ceasenet/core"
import { formatEther, parseEther, toHex } from "viem"
import { accountFor } from "./roles"

// Sends test tokens from the treasury in .env to a ceasenet owner wallet, for anyone who has a funded treasury rather
// than a browser wallet for the faucet. Nothing but this script reads the phrase, and it is never copied anywhere.
//
//   npm run fund-owner                    0.5 tGLM to the owner in ~/.ceasenet
//   npm run fund-owner -- 0.2 0xabc...    that much, to that address
//   npm run fund-owner -- --0g 0.1        0G test tokens instead, which pay for storing diaries
const useZeroG = process.argv.includes("--0g")
const [amount = "0.5", to] = process.argv.slice(2).filter((a) => a !== "--0g")
const home = process.env.CEASENET_HOME ?? join(homedir(), ".ceasenet")
const target = (to ?? (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { owner: { address: string } }).owner.address) as Hex

if (useZeroG) {
  const { ethers } = await import("ethers")
  const provider = new ethers.JsonRpcProvider("https://evmrpc-testnet.0g.ai")
  const wallet = new ethers.Wallet(toHex(accountFor("treasury").getHdKey().privateKey!), provider)
  const sent = await wallet.sendTransaction({ to: target, value: ethers.parseEther(amount) })
  await sent.wait()
  console.log(`Sent ${amount} 0G from the treasury to ${target}`)
  console.log(`Transaction ${sent.hash}`)
  console.log(`It now holds ${ethers.formatEther(await provider.getBalance(target))} 0G, and the treasury ${ethers.formatEther(await provider.getBalance(wallet.address))} 0G.`)
  process.exit(0)
}

const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const client = arkivPublicClient(accessKey)
const treasury = arkivWalletClient(accountFor("treasury"), accessKey)
const from = treasury.account!.address
const value = parseEther(amount)
const available = await client.getBalance({ address: from })
if (available < value) throw new Error(`The treasury ${from} has only ${formatEther(available)} tGLM.`)

const hash = await treasury.sendTransaction({ to: target, value })
await client.waitForTransactionReceipt({ hash })
console.log(`Sent ${amount} tGLM from the treasury to ${target}`)
console.log(`Transaction ${hash}`)
console.log(`It now holds ${formatEther(await client.getBalance({ address: target }))} tGLM, and the treasury ${formatEther(await client.getBalance({ address: from }))} tGLM.`)
