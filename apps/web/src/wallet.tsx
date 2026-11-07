import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { arkivBrowserWallet, arkivChain, ArkivWriter, type Eip1193Provider, type Hex } from "@ceasenet/core"
import { formatEther, numberToHex, toHex } from "viem"
import { ACCESS_KEY, client, shortHash, usePoll } from "./lib"

export const FAUCET = "https://hub.arkiv.network/faucet"

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { on?: (event: string, listener: (value: unknown) => void) => void }
  }
}

interface Wallet {
  /** No wallet extension in this browser. */
  missing: boolean
  address?: Hex
  /** Connected, but on a network where these records would not land. */
  wrongNetwork: boolean
  /** Only present when signing would work. */
  writer?: ArkivWriter
  connect: () => Promise<void>
  /** Signs a plain message. It costs nothing, sends nothing, and works on any network. */
  sign: (message: string) => Promise<Hex>
  /**
   * Logs out: this site forgets the wallet, and asks the wallet to disconnect it. Says whether the wallet agreed. One
   * that can't be asked connects again when the page next loads, until it is disconnected in the wallet.
   */
  disconnect: () => Promise<boolean>
  problem?: string
}

const noWallet = async (): Promise<never> => {
  throw new Error("There is no wallet in this browser.")
}

const WalletContext = createContext<Wallet>({ missing: true, wrongNetwork: false, connect: async () => undefined, sign: noWallet, disconnect: async () => false })
const ARKIV_CHAIN_ID = arkivChain("").id

export const useWallet = () => useContext(WalletContext)

/** A wallet's error, in plain words. Someone saying no is not a failure. */
export function walletMessage(e: unknown): string {
  type Layered = { code?: number; message?: string; shortMessage?: string; cause?: Layered }
  const error = e as Layered
  // A refusal can be several layers down, depending on what was wrapped around the wallet's answer.
  for (let layer: Layered | undefined = error; layer; layer = layer.cause) {
    if (layer.code === 4001) return "You declined in your wallet, so nothing was sent."
  }
  return (error.shortMessage ?? error.message ?? "The wallet reported a problem.").split("\n")[0]!
}

async function switchToArkiv(provider: Eip1193Provider): Promise<void> {
  const chain = arkivChain("")
  const chainId = numberToHex(chain.id)
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] })
  } catch (e) {
    // 4902 means the wallet has not heard of this network yet.
    if ((e as { code?: number }).code !== 4902) throw e
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: "Arkiv Rabdi testnet",
          nativeCurrency: { name: "tGLM", symbol: "tGLM", decimals: 18 },
          rpcUrls: [chain.rpcUrls.default.http[0]],
          blockExplorerUrls: ["https://rabdi.explorer.arkiv.network"],
        },
      ],
    })
  }
}

type BrowserWallet = NonNullable<Window["ethereum"]> & { isMetaMask?: boolean; isPhantom?: boolean; providers?: BrowserWallet[] }

/**
 * The wallet to use. With several extensions installed, each may claim window.ethereum, and one that is not MetaMask
 * can refuse what this site asks. Wallets announce themselves (EIP-6963), so MetaMask is chosen when it is there.
 */
function useBrowserWallet(): BrowserWallet | undefined {
  const fallback = typeof window === "undefined" ? undefined : (window.ethereum as BrowserWallet | undefined)
  const [announced, setAnnounced] = useState<BrowserWallet>()
  useEffect(() => {
    const take = (event: Event) => {
      const { info, provider } = (event as CustomEvent<{ info: { rdns?: string }; provider: BrowserWallet }>).detail ?? {}
      if (info?.rdns === "io.metamask") setAnnounced(provider)
    }
    window.addEventListener("eip6963:announceProvider", take)
    window.dispatchEvent(new Event("eip6963:requestProvider"))
    return () => window.removeEventListener("eip6963:announceProvider", take)
  }, [])
  const legacy = fallback?.providers?.find((p) => p.isMetaMask && !p.isPhantom)
  return announced ?? legacy ?? fallback
}

/** Keeps the browser wallet for every page. All signing happens in the wallet: this site never holds a key. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const provider = useBrowserWallet()
  const [address, setAddress] = useState<Hex>()
  const [problem, setProblem] = useState<string>()
  const [chainId, setChainId] = useState<number>()

  const takeAccount = useCallback((accounts: unknown) => {
    const first = (accounts as string[] | undefined)?.[0]
    setAddress(first as Hex | undefined)
  }, [])

  useEffect(() => {
    if (!provider) return
    // Already connected from an earlier visit. This asks the person nothing.
    void provider.request({ method: "eth_accounts" }).then(takeAccount, () => undefined)
    provider.on?.("accountsChanged", takeAccount)
    const takeChain = (id: unknown) => setChainId(Number(id))
    void provider.request({ method: "eth_chainId" }).then(takeChain, () => undefined)
    provider.on?.("chainChanged", takeChain)
  }, [provider, takeAccount])

  const connect = useCallback(async () => {
    if (!provider) return
    setProblem(undefined)
    // The address first: some wallets refuse anything else from a site that is not connected yet. Logging in needs
    // only the address and a signature, so a wallet that will not move to Arkiv can still log in.
    try {
      takeAccount(await provider.request({ method: "eth_requestAccounts" }))
    } catch (e) {
      setProblem(walletMessage(e))
      return
    }
    try {
      await switchToArkiv(provider)
    } catch (e) {
      setProblem(`Connected, but your wallet did not move to the Arkiv testnet, which signing records needs: ${walletMessage(e)}`)
    }
    const id = await provider.request({ method: "eth_chainId" }).catch(() => undefined)
    if (id !== undefined) setChainId(Number(id))
  }, [provider, takeAccount])

  const sign = useCallback(
    async (message: string): Promise<Hex> => {
      if (!provider || !address) throw new Error("Connect your wallet first.")
      return (await provider.request({ method: "personal_sign", params: [toHex(message), address] })) as Hex
    },
    [provider, address],
  )

  const disconnect = useCallback(async (): Promise<boolean> => {
    setProblem(undefined)
    setAddress(undefined)
    if (!provider) return false
    try {
      // EIP-2255. MetaMask and most current wallets let a site give up its own access.
      await provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] })
      return true
    } catch {
      return false
    }
  }, [provider])

  const wrongNetwork = Boolean(address) && chainId !== undefined && chainId !== ARKIV_CHAIN_ID
  const writer = useMemo(
    () => (provider && address && !wrongNetwork ? new ArkivWriter(arkivBrowserWallet(provider, address, ACCESS_KEY)) : undefined),
    [provider, address, wrongNetwork],
  )
  const value = useMemo(() => ({ missing: !provider, address, wrongNetwork, writer, connect, sign, disconnect, problem }), [provider, address, wrongNetwork, writer, connect, sign, disconnect, problem])
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

/** Who is signing, and whether they can pay for it. */
export function WalletCard({ action }: { action: string }) {
  const { missing, address, wrongNetwork, connect, problem } = useWallet()
  const { data: balance } = usePoll(() => (address ? client.getBalance({ address }) : Promise.resolve(undefined)), 6000, [address])
  if (missing) {
    return (
      <div className="notice">
        To {action} you need a browser wallet, such as MetaMask. Everything else on this site works without one.
      </div>
    )
  }
  if (!address) {
    return (
      <div className="card wallet-card">
        <button className="primary" onClick={() => void connect()}>
          Connect wallet
        </button>
        <span className="small muted">To {action}. Your wallet signs each record. This site never sees a key.</span>
        {problem && <div className="error">{problem}</div>}
      </div>
    )
  }
  if (wrongNetwork) {
    return (
      <div className="card wallet-card">
        <button className="primary" onClick={() => void connect()}>
          Switch to Arkiv
        </button>
        <span className="small muted">Your wallet is on another network, so these records would not land on Arkiv.</span>
        {problem && <div className="error">{problem}</div>}
      </div>
    )
  }
  return (
    <div className="card wallet-card">
      <span>
        Signing as <b className="mono">{shortHash(address)}</b>
      </span>
      <span className="small muted">{balance === undefined ? "" : `${Number(formatEther(balance)).toFixed(4)} tGLM`}</span>
      {balance === 0n && (
        <a className="small" href={FAUCET} target="_blank" rel="noreferrer">
          This wallet has no tGLM. Claim some, free.
        </a>
      )}
      {problem && <div className="error">{problem}</div>}
    </div>
  )
}
