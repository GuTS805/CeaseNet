import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { arkivBrowserWallet, arkivChain, ArkivWriter, type Eip1193Provider, type Hex } from "@ceasenet/core"
import { formatEther, numberToHex } from "viem"
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
  problem?: string
}

const WalletContext = createContext<Wallet>({ missing: true, wrongNetwork: false, connect: async () => undefined })
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

/** Keeps the browser wallet for every page. All signing happens in the wallet: this site never holds a key. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const provider = typeof window === "undefined" ? undefined : window.ethereum
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
    try {
      await switchToArkiv(provider)
      setChainId(Number(await provider.request({ method: "eth_chainId" })))
      takeAccount(await provider.request({ method: "eth_requestAccounts" }))
    } catch (e) {
      setProblem(walletMessage(e))
    }
  }, [provider, takeAccount])

  const wrongNetwork = Boolean(address) && chainId !== undefined && chainId !== ARKIV_CHAIN_ID
  const writer = useMemo(
    () => (provider && address && !wrongNetwork ? new ArkivWriter(arkivBrowserWallet(provider, address, ACCESS_KEY)) : undefined),
    [provider, address, wrongNetwork],
  )
  const value = useMemo(() => ({ missing: !provider, address, wrongNetwork, writer, connect, problem }), [provider, address, wrongNetwork, writer, connect, problem])
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
