import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { type Account, http } from "viem"

/** The access key is not a secret: the SDK sends it in the RPC URL, so it ships with any app that reads the chain. */
export function arkivChain(accessKey: string) {
  return rabdi({ accessKey })
}

export function arkivPublicClient(accessKey: string) {
  return createPublicClient({ chain: arkivChain(accessKey), transport: http() })
}

export function arkivWalletClient(account: Account, accessKey: string) {
  return createWalletClient({ chain: arkivChain(accessKey), transport: http(), account })
}

export type ArkivPublic = ReturnType<typeof arkivPublicClient>
export type ArkivWallet = ReturnType<typeof arkivWalletClient>

export const ARKIV_EXPLORER = "https://rabdi.explorer.arkiv.network"
