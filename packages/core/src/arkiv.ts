import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { type Account, http } from "viem"

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

export const ARKIV_EXPLORER = "https://rabdi.explorer.arkiv.network"
