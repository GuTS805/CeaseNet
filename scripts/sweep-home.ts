import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { ADDRESSES, arkivPublicClient, arkivWalletClient, type Hex } from "@ceasenet/core"
import { ethers } from "ethers"
import { formatEther, parseEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"

/** Sends what is left in a throwaway CeaseNet home's wallets back to the treasury, on both networks. */
export async function sweepHome(home: string, log: (line: string) => void = console.log): Promise<void> {
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { accessKey: string }
  const client = arkivPublicClient(config.accessKey)
  const zeroG = new ethers.JsonRpcProvider("https://evmrpc-testnet.0g.ai")
  const team = join(home, "team")
  const homes = [home, ...(existsSync(team) ? readdirSync(team).map((id) => join(team, id)) : [])]
  for (const dir of homes) {
    const keys = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8")) as { agent: Hex; owner?: Hex }
    for (const key of [keys.owner, keys.agent].filter(Boolean) as Hex[]) {
      const wallet = arkivWalletClient(privateKeyToAccount(key), config.accessKey)
      const balance = await client.getBalance({ address: wallet.account!.address })
      const fee = parseEther("0.001")
      if (balance > fee) {
        await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: ADDRESSES.treasury, value: balance - fee }) })
        log(`     returned ${formatEther(balance - fee)} tGLM from ${wallet.account!.address}`)
      }
      const signer = new ethers.Wallet(key, zeroG)
      const held = await zeroG.getBalance(signer.address)
      const reserve = ethers.parseEther("0.0005")
      if (held > reserve) {
        await (await signer.sendTransaction({ to: ADDRESSES.treasury, value: held - reserve })).wait()
        log(`     returned ${ethers.formatEther(held - reserve)} 0G from ${signer.address}`)
      }
    }
  }
  log(`     the treasury holds ${formatEther(await client.getBalance({ address: ADDRESSES.treasury }))} tGLM and ${ethers.formatEther(await zeroG.getBalance(ADDRESSES.treasury))} 0G`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await sweepHome(resolve(process.argv[2]!))
  process.exit(0)
}
