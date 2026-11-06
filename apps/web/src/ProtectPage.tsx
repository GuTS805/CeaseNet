import { useMemo, useState } from "react"
import { ADDRESSES, CONFIRMATION_THRESHOLD, followersOf, type Hex, readTrustPolicy, type TrustPolicy } from "@ceasenet/core"
import { client, forgetView, nameOf, shortHash, statusColour, statusLabel, useNetworkView, usePoll } from "./lib"
import { useWallet, WalletCard, walletMessage } from "./wallet"

const REPOSITORY = "https://github.com/GuTS805/CeaseNet"
const isAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Choose whom your agents obey, register an agent, and get the command that runs a tool behind the gate. */
export function ProtectPage({ suggested }: { suggested?: string }) {
  const { address, writer } = useWallet()
  const { data: view } = useNetworkView()
  const { data: record, error: readProblem } = usePoll<{ owner: string; policy: TrustPolicy | null } | null>(
    async () => (address ? { owner: address, policy: (await readTrustPolicy(client, address)) ?? null } : null),
    5000,
    [address],
  )
  // A reading or an edit counts only for the wallet it was made for, so switching wallets can never mix two lists.
  const published = record?.owner === address ? record?.policy : undefined
  const [edit, setEdit] = useState<{ owner: string; issuers: string[] }>()
  const issuers = edit && edit.owner === address ? edit.issuers : published === undefined ? undefined : (published?.issuers ?? [])
  const setIssuers = (next: string[]) => setEdit({ owner: address!, issuers: next })

  const [add, setAdd] = useState(suggested && isAddress(suggested) ? suggested : "")
  const [busy, setBusy] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const [done, setDone] = useState<string>()
  const [agent, setAgent] = useState("")
  const [name, setName] = useState("")

  const seen = useMemo(() => {
    const byKey = new Map<string, number>()
    for (const r of view?.recalls ?? []) byKey.set(r.creator.toLowerCase(), followersOf(r, view?.agents ?? []))
    return [...byKey].filter(([key]) => !issuers?.some((i) => same(i, key))).slice(0, 8)
  }, [view, issuers])

  const myAgents = view?.agents.filter((a) => address && same(a.agent.owner, address)) ?? []
  const addIsGood = isAddress(add.trim())
  const changed = issuers !== undefined && JSON.stringify([...issuers].map((i) => i.toLowerCase()).sort()) !== JSON.stringify([...(published?.issuers ?? [])].map((i) => i.toLowerCase()).sort())

  const signed = async (label: string, success: string, write: () => Promise<unknown>) => {
    setBusy(label)
    setProblem(undefined)
    setDone(undefined)
    try {
      await write()
      forgetView()
      setDone(success)
    } catch (e) {
      setProblem(walletMessage(e))
    } finally {
      setBusy(undefined)
    }
  }

  const publish = () =>
    signed("Publishing your list", "Your list is on Arkiv. Your agents obey it from their next check.", async () => {
      await writer!.trustList({
        seq: BigInt(Date.now()),
        policy: {
          issuers: issuers ?? [],
          regulators: published?.regulators ?? [],
          verifier: published?.verifier ?? ADDRESSES.verifier,
          threshold: published?.threshold ?? CONFIRMATION_THRESHOLD,
        },
      })
    })

  const register = () =>
    signed("Registering your agent", "Your agent's passport is on Arkiv.", async () => {
      await writer!.agent({ agent: agent.trim() as Hex, name: name.trim(), framework: "MCP", purpose: "Runs tools behind the CeaseNet gate." })
      setAgent("")
      setName("")
    })

  return (
    <div className="page" style={{ display: "grid", gap: 12 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Protect an agent</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          You decide whose recalls your agents obey. Nobody else can stop a tool on your machine, including us.
        </p>
      </div>

      <WalletCard action="publish your choices" />
      {readProblem && <div className="notice">Cannot read Arkiv right now: {readProblem}</div>}

      <div className="card form">
        <h2>1. Whom do your agents obey?</h2>
        {issuers === undefined ? (
          <p className="small muted">{address ? "Reading your list…" : "Connect a wallet to see your list."}</p>
        ) : issuers.length === 0 ? (
          <p className="small muted">Nobody yet, so nothing can stop your tools. Add the keys of makers or researchers you trust.</p>
        ) : (
          <table>
            <tbody>
              {issuers.map((i) => (
                <tr key={i}>
                  <td>
                    {nameOf(i)} <span className="mono muted">{shortHash(i)}</span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button onClick={() => setIssuers(issuers.filter((x) => !same(x, i)))}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {issuers !== undefined && (
          <>
            <div className="measure">
              <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="0x… a key to follow" spellCheck={false} aria-label="A key to follow" />
              <button
                disabled={!addIsGood}
                onClick={() => {
                  setIssuers([...issuers.filter((i) => !same(i, add.trim())), add.trim()])
                  setAdd("")
                }}
              >
                Add
              </button>
            </div>
            {seen.length > 0 && (
              <div className="small muted">
                Keys that have issued recalls:{" "}
                {seen.map(([key, count]) => (
                  <button className="link" key={key} onClick={() => setIssuers([...issuers, key])}>
                    {nameOf(key)} ({count} following)
                  </button>
                ))}
              </div>
            )}
            <div className="buttons">
              <button className="primary" disabled={!changed || !writer || Boolean(busy)} onClick={() => void publish()}>
                {busy === "Publishing your list" ? "Waiting for your wallet and the chain…" : "Sign and publish this list"}
              </button>
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>
              The list is public, and each change is a new record, so anyone can see whom an owner obeys and when that changed.
            </p>
          </>
        )}
      </div>

      <div className="card form">
        <h2>2. Run a tool behind the gate</h2>
        <p className="small" style={{ marginTop: 0 }}>
          Needs <a href={REPOSITORY} target="_blank" rel="noreferrer">this repository</a> and Node 22. On Windows PowerShell, type <code>npm.cmd</code> instead of <code>npm</code>.
        </p>
        <pre className="commands">
          {`npm install
npm run install-cli
ceasenet init --name "My agent"${address ? ` --owner ${address}` : ""}
ceasenet protect`}
        </pre>
        <p className="small muted" style={{ marginBottom: 0 }}>
          <code>init</code> prints your agent's address: paste it below. <code>protect</code> puts the gate in front of every MCP server in Claude Code, Claude Desktop, Cursor, VS Code, Windsurf and Gemini CLI,
          and keeps a copy of each settings file it changes. Restart the client and use it as usual. Nothing about the tools changes.
        </p>
      </div>

      <div className="card form">
        <h2>3. Register your agent</h2>
        <div className="form-row">
          <label>
            Agent address
            <input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="0x…" spellCheck={false} />
          </label>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Support agent" />
          </label>
        </div>
        <div className="buttons">
          <button className="primary" disabled={!writer || !isAddress(agent.trim()) || !name.trim() || Boolean(busy)} onClick={() => void register()}>
            {busy === "Registering your agent" ? "Waiting for your wallet and the chain…" : "Sign and register"}
          </button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Optional, but it makes your agent's receipts count on the public board. It also needs a little tGLM of its own to post them. Without any, it still obeys the list and publishes nothing.
        </p>
      </div>

      {done && <div className="notice good">{done}</div>}
      {problem && <div className="notice bad">{problem}</div>}

      {myAgents.length > 0 && (
        <div className="card">
          <h2>Your agents</h2>
          <table>
            <tbody>
              {myAgents.map((a) => (
                <tr key={a.agent.key}>
                  <td>
                    <a href={`#/agent/${a.agent.agent}`}>{a.agent.name}</a>
                  </td>
                  <td>
                    <span className={`status ${statusColour(a.heartbeat?.mode)}`}>{statusLabel(a.heartbeat?.mode)}</span>
                  </td>
                  <td>{a.loadout?.files.map((f) => `${f.name} ${f.version}`).join(", ") ?? "Nothing published yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
