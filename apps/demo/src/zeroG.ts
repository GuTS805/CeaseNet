import { Indexer, MemData } from "@0gfoundation/0g-storage-ts-sdk"
import type { DiaryStore } from "@ceasenet/guard"
import { ethers } from "ethers"

const RPC = "https://evmrpc-testnet.0g.ai"
const INDEXER = "https://indexer-storage-testnet-turbo.0g.ai"

/** Reads a diary part back by its root. Needs no wallet and no special software, so anyone can do it. */
export async function fetchFromZeroG(root: string): Promise<Uint8Array> {
  const res = await fetch(`${INDEXER}/file?root=${encodeURIComponent(root)}`)
  if (!res.ok) throw new Error(`0G Storage returned ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  // A missing file comes back as a JSON error with status 200.
  if (bytes[0] === 0x7b) {
    const text = new TextDecoder().decode(bytes)
    if (text.includes('"code"') && text.includes('"message"')) throw new Error(`0G Storage: ${JSON.parse(text).message}`)
  }
  return bytes
}

/**
 * Keeps diary parts on 0G Storage.
 *
 * One wallet pays for every upload, and transactions from one key must go out one at a time, so they queue.
 */
export class ZeroGStore implements DiaryStore {
  private readonly signer: ethers.Wallet
  private readonly indexer = new Indexer(INDEXER)
  private queue: Promise<unknown> = Promise.resolve()

  constructor(privateKey: string) {
    this.signer = new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(RPC))
  }

  get address(): string {
    return this.signer.address
  }

  put(bytes: Uint8Array): Promise<{ root: string }> {
    const run = this.queue.then(() => this.upload(bytes))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async upload(bytes: Uint8Array): Promise<{ root: string }> {
    const [result, error] = await this.indexer.upload(new MemData(bytes), RPC, this.signer)
    if (error) throw error
    if (!("rootHash" in result)) throw new Error("0G Storage split a small diary part, which is not expected")
    return { root: result.rootHash }
  }

  get(root: string): Promise<Uint8Array> {
    return fetchFromZeroG(root)
  }
}
