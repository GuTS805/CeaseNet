import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { ADDRESSES, type Hex, type HumanRow, loginMessage, loginSignal, readHuman } from "@ceasenet/core"
import { IDKitRequestWidget, proofOfHuman, type RpContext } from "@worldcoin/idkit"
import { client, shortHash, VERIFIER_URL } from "./lib"
import { useWallet, walletMessage } from "./wallet"

export interface WorldConfig {
  appId: `app_${string}`
  rpId: string
  action: string
  environment: "production" | "staging" | "sandbox"
}

/** The verifier's public settings. Null when it cannot be reached. */
export function useWorldConfig(): WorldConfig | null | undefined {
  const [config, setConfig] = useState<WorldConfig | null>()
  useEffect(() => {
    if (!VERIFIER_URL) return setConfig(null)
    fetch(`${VERIFIER_URL}/api/world-config`)
      .then((r) => r.json() as Promise<WorldConfig>)
      .then(setConfig)
      .catch(() => setConfig(null))
  }, [])
  return config
}

export class VerifierError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly key?: Hex,
  ) {
    super(message)
  }
}

export async function postVerifier<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(VERIFIER_URL + path, { method: "POST", body: JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; key?: Hex }
  if (!res.ok) throw new VerifierError(json.error ?? "The verifier refused this.", json.code, json.key)
  return json
}

interface Login {
  /** The connected wallet's address. */
  address?: Hex
  /** The verifier's record that a real person logged in with this address. */
  human?: HumanRow
  /** Still reading Arkiv to find out. */
  checking: boolean
  /** Reads Arkiv again, and says whether this wallet is logged in. */
  refresh: () => Promise<boolean>
}

const LoginContext = createContext<Login>({ checking: false, refresh: async () => false })

export const useLogin = () => useContext(LoginContext)

/**
 * Who is logged in. Nothing is kept in this browser: being logged in means the verifier wrote, on Arkiv, that a real
 * person logged in with the wallet that is connected now. Anyone can check the same record.
 */
export function LoginProvider({ children }: { children: ReactNode }) {
  const { address } = useWallet()
  const [human, setHuman] = useState<HumanRow>()
  const [checking, setChecking] = useState(false)

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!address) {
      setHuman(undefined)
      return false
    }
    setChecking(true)
    try {
      const found = await readHuman(client, address, ADDRESSES.verifier)
      setHuman(found)
      return Boolean(found)
    } catch {
      // A failed read says nothing either way. What was known stays.
      return false
    } finally {
      setChecking(false)
    }
  }, [address])

  useEffect(() => {
    setHuman(undefined)
    void refresh()
  }, [refresh])

  const value = useMemo(() => ({ address, human: human && address && human.address.toLowerCase() === address.toLowerCase() ? human : undefined, checking, refresh }), [address, human, checking, refresh])
  return <LoginContext.Provider value={value}>{children}</LoginContext.Provider>
}

/** In the header: who is logged in, or the way to log in. */
export function LoginBadge({ route }: { route: string }) {
  const { human, address } = useLogin()
  const next = route.startsWith("login") ? "" : route
  if (human && address) {
    return (
      <a className="login-badge in" href="#/login" title="Logged in with World">
        <span aria-hidden="true">●</span> {shortHash(address)}
      </a>
    )
  }
  return (
    <a className="login-badge" href={`#/login${next ? `/${next}` : ""}`}>
      Log in with World
    </a>
  )
}

/** Shown where a page needs a logged-in person. */
export function NeedLogin({ to, next }: { to: string; next: string }) {
  const { checking, address } = useLogin()
  if (checking) return <p className="small muted">Checking whether this wallet is logged in…</p>
  return (
    <div className="notice">
      To {to}, first <a href={`#/login/${next}`}>log in with World</a>. World ID shows you are a real person, without saying who, and your wallet gives you an address.
      {address ? ` The wallet connected now, ${shortHash(address)}, is not logged in yet.` : ""}
    </div>
  )
}

/**
 * Logging in: the wallet gives an address and signs to show it is yours, then World ID shows a real person is behind
 * it. The verifier checks both and writes the link on Arkiv. One person can link only one address.
 */
export function LoginPage({ next }: { next: string }) {
  const { missing, address, connect, sign, problem: walletProblem } = useWallet()
  const { human, checking, refresh } = useLogin()
  const config = useWorldConfig()
  const [rpContext, setRpContext] = useState<RpContext>()
  const [signed, setSigned] = useState<{ signature: Hex; at: number }>()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [done, setDone] = useState(false)

  const back = next ? `#/${next}` : "#/"

  const start = async () => {
    if (!address || !config) return
    setProblem(undefined)
    setBusy(true)
    try {
      const at = Date.now()
      const signature = await sign(loginMessage(address, at))
      setSigned({ signature, at })
      const sig = await postVerifier<{ sig: string; nonce: string; created_at: number; expires_at: number }>("/api/rp-signature")
      setRpContext({ rp_id: config.rpId, nonce: sig.nonce, created_at: sig.created_at, expires_at: sig.expires_at, signature: sig.sig })
      setOpen(true)
    } catch (e) {
      setProblem(e instanceof VerifierError ? e.message : walletMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page" style={{ display: "grid", gap: 12, maxWidth: 760 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Log in with World</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Your wallet gives you an address. World ID shows a real, unique person is behind it, without saying who. Then you can open a recall, vote on others' and register your agents. One person logs in with one wallet, so nobody can vote twice.
        </p>
      </div>

      {human && address ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>{done ? "You are logged in" : "Logged in"}</h2>
          <p style={{ marginTop: 0 }}>
            <b className="mono">{address}</b> is linked to a real person checked by World ID. The record is public on Arkiv, written by the CeaseNet verifier.
          </p>
          <div className="buttons">
            <a className="button primary" href={back}>
              {next ? "Carry on" : "Go to the home page"}
            </a>
            <a className="button" href="#/report">
              Open a recall
            </a>
            <a className="button" href="#/register">
              Register an agent
            </a>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            To log out, disconnect this site in your wallet, or switch to another account.
          </p>
        </div>
      ) : (
        <div className="card form">
          <h2>1. Your wallet</h2>
          {missing ? (
            <div className="notice">You need a browser wallet, such as MetaMask. Its address is the one you log in with.</div>
          ) : address ? (
            <p style={{ margin: 0 }}>
              Connected: <b className="mono">{address}</b>
            </p>
          ) : (
            <div className="buttons">
              <button className="primary" onClick={() => void connect()}>
                Connect wallet
              </button>
            </div>
          )}
          {walletProblem && <div className="error">{walletProblem}</div>}

          <h2>2. Show you are a real person</h2>
          {config === undefined && <p className="small muted">Connecting to the World ID service…</p>}
          {config === null && <div className="notice bad">The World ID service is not reachable from here, so nobody can log in right now. It runs with: npm run verifier</div>}
          {config && (
            <>
              <p className="small muted" style={{ marginTop: 0 }}>
                Your wallet first signs a message to show the address is yours. It costs nothing and sends nothing. Then World ID asks you to scan a code with World App.
              </p>
              <div className="buttons">
                <button className="primary" disabled={!address || busy || checking} onClick={() => void start()}>
                  {busy ? "Waiting for your wallet…" : "Log in with World ID"}
                </button>
              </div>
              {config.environment !== "production" && (
                <p className="small muted" style={{ marginBottom: 0 }}>
                  Test mode: use the{" "}
                  <a href="https://simulator.worldcoin.org/" target="_blank" rel="noreferrer">
                    World ID simulator
                  </a>{" "}
                  instead of a phone.
                </p>
              )}
            </>
          )}
          {problem && <div className="error">{problem}</div>}
        </div>
      )}

      {rpContext && config && address && signed && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) setRpContext(undefined)
          }}
          app_id={config.appId}
          action={config.action}
          rp_context={rpContext}
          environment={config.environment}
          // Most people's World App still holds its Orb credential in the older format. Without this it has nothing to
          // answer with, and opens its home screen instead.
          allow_legacy_proofs={true}
          preset={proofOfHuman({ signal: loginSignal(address) })}
          handleVerify={async (result) => {
            // Throwing here makes the widget show the failure instead of a success.
            try {
              await postVerifier("/api/login", { address, signature: signed.signature, at: signed.at, result })
            } catch (e) {
              setProblem((e as Error).message)
              throw e
            }
          }}
          onSuccess={() => {
            setDone(true)
            // The record is written. The network can take a few seconds to show it.
            void (async () => {
              for (let i = 0; i < 10 && !(await refresh()); i++) await new Promise((r) => setTimeout(r, 2000))
            })()
          }}
          onError={(code) => setProblem((current) => current ?? `Not logged in: World ID reported ${code}.`)}
        />
      )}
    </div>
  )
}
