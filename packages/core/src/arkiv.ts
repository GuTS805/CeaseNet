import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { type Account, custom, http } from "viem"

/** Blocks take 2 seconds. Without this the client looks for a confirmation only every 4 seconds. */
const POLLING_MS = 500

/** The same network with no key. Anyone can use it, with a lower rate limit. */
export const PUBLIC_RPC = "https://rpc.rabdi.db-chain.testnet.arkiv.network/"
/** How long to leave a used-up key alone before seeing whether its quota has come back. */
const TRY_KEY_AGAIN_MS = 10 * 60_000

export interface AccessKeyStatus {
  /** How much of its quota the service says this key has used. */
  usedPercent?: number
  /** It has run out, so requests are going through the public endpoint. */
  exhausted: boolean
  /** The network no longer accepts it at all, for example because it was revoked, so requests go through the public endpoint. */
  rejected?: boolean
}

/**
 * An access key has a quota, and when it runs out the network refuses every request made with it. It also refuses
 * every request once the key is revoked or deleted.
 *
 * Neither must look like the list being out of reach: a gate would start refusing its agent's calls over a billing
 * limit or a key setting, and a verifier could not count a vote. The list is public and needs no key, so a key that
 * is used up or refused just means carrying on without one.
 */
export function quotaAwareFetch(fetchImpl: typeof fetch = (...args) => fetch(...args), now: () => number = Date.now) {
  const status: AccessKeyStatus = { exhausted: false }
  let keyResumesAt = 0
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const usesKey = url.startsWith(PUBLIC_RPC) && url.length > PUBLIC_RPC.length
    if (!usesKey) return fetchImpl(input, init)
    if (now() < keyResumesAt) return fetchImpl(PUBLIC_RPC, init)

    const response = await fetchImpl(input, init)
    const used = Number(response.headers.get("arkiv-quota-used-percent") ?? Number.NaN)
    if (Number.isFinite(used)) status.usedPercent = used
    if (response.status === 429 && (await response.clone().text()).includes("QUOTA_EXCEEDED")) {
      status.exhausted = true
      keyResumesAt = now() + TRY_KEY_AGAIN_MS
      return fetchImpl(PUBLIC_RPC, init)
    }
    // Only the key is refused here: the public endpoint never answers 401, because it asks for nothing.
    if (response.status === 401) {
      status.rejected = true
      keyResumesAt = now() + TRY_KEY_AGAIN_MS
      return fetchImpl(PUBLIC_RPC, init)
    }
    status.exhausted = false
    if (status.rejected) status.rejected = false
    return response
  }
  return { fetchFn, status }
}

const shared = quotaAwareFetch()

/** Where this process's access key stands. */
export const accessKeyStatus = (): AccessKeyStatus => ({ ...shared.status })

/** The access key is not a secret: the SDK sends it in the RPC URL, so it ships with any app that reads the chain. */
export function arkivChain(accessKey: string) {
  return rabdi({ accessKey })
}

const transport = () => http(undefined, { fetchFn: shared.fetchFn })

export function arkivPublicClient(accessKey: string) {
  return createPublicClient({ chain: arkivChain(accessKey), transport: transport(), pollingInterval: POLLING_MS })
}

export function arkivWalletClient(account: Account, accessKey: string) {
  return createWalletClient({ chain: arkivChain(accessKey), transport: transport(), account, pollingInterval: POLLING_MS })
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
