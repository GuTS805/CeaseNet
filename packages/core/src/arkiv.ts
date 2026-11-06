import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { type Account, custom, http } from "viem"

/** Blocks take 2 seconds. Without this the client looks for a confirmation only every 4 seconds. */
const POLLING_MS = 500

/** The access key is not a secret: the SDK sends it in the RPC URL, so it ships with any app that reads the chain. */
export function arkivChain(accessKey: string) {
  return rabdi({ accessKey })
}

export function arkivPublicClient(accessKey: string) {
  return createPublicClient({ chain: arkivChain(accessKey), transport: http(), pollingInterval: POLLING_MS })
}

export function arkivWalletClient(account: Account, accessKey: string) {
  return createWalletClient({ chain: arkivChain(accessKey), transport: http(), account, pollingInterval: POLLING_MS })
}

export type ArkivPublic = ReturnType<typeof arkivPublicClient>
export type ArkivWallet = ReturnType<typeof arkivWalletClient>

/** The standard interface browser wallets offer. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<any>
}

/** Writes through a browser wallet, which holds the key and asks its owner to sign each record. */
export function arkivBrowserWallet(provider: Eip1193Provider, address: `0x${string}`, accessKey: string): ArkivWallet {
  return createWalletClient({ chain: arkivChain(accessKey), transport: custom(provider as never), account: address, pollingInterval: POLLING_MS }) as unknown as ArkivWallet
}

export const ARKIV_EXPLORER = "https://rabdi.explorer.arkiv.network"
