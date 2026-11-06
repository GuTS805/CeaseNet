import { useState } from "react"
import { type DiaryAgent, type DiaryItem, type DiaryList, type DiaryRead, post, usePoll } from "./api"
import { ago, Copyable, type Run, short, Status, Tile, type Tone, useNow } from "./ui"

const MODE: Record<DiaryAgent["mode"], string> = {
  public: "Everything is readable by anyone",
  sealed: "Sealed: anyone can see what happened and when, and only you can read the contents",
  hashes: "Only what happened and when, plus hashes. The owner's key is on another machine, so contents cannot be sealed",
}

/** A datetime-local input's value, in this machine's time zone, as milliseconds since 1970. */
const fromInput = (value: string): number | undefined => {
  const ms = value ? new Date(value).getTime() : Number.NaN
  return Number.isFinite(ms) ? ms : undefined
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
const day = (ms: number) => new Date(ms).toLocaleDateString()
/** When a part's entries happened, as one short line. */
const span = (firstAt?: number, lastAt?: number) =>
  firstAt === undefined || lastAt === undefined ? "Not recorded" : day(firstAt) === day(lastAt) ? `${day(firstAt)}, ${clock(firstAt)} to ${clock(lastAt)}` : `${new Date(firstAt).toLocaleString()} to ${new Date(lastAt).toLocaleString()}`

const pretty = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2))

function outcome(item: DiaryItem): { tone: Tone; label: string } {
  if (item.kind === "NOTE") {
    if (item.note === "closed") return { tone: "red", label: "Closed" }
    if (item.note === "problem" || item.note === "paused") return { tone: "amber", label: item.note === "paused" ? "Paused" : "Problem" }
    if (item.note === "said") return { tone: "green", label: "Model said" }
    return { tone: "grey", label: item.note === "job" ? "Job" : item.note === "started" ? "Started" : item.note }
  }
  if (item.kind !== "CALL") return { tone: "grey", label: item.kind }
  if (!item.allowed) return { tone: "red", label: item.approval === "DENIED" ? "You refused" : item.approval === "EXPIRED" ? "Nobody approved" : "Refused" }
  return { tone: "green", label: item.approval === "APPROVED" ? "Approved" : "Allowed" }
}

function Contents({ item, canOpen }: { item: DiaryItem; canOpen: boolean }) {
  if (item.kind !== "CALL") return null
  const open = item.opened ?? (item.args !== undefined ? { args: item.args, result: item.result } : undefined)
  if (open) {
    return (
      <details className="result">
        <summary>
          See what it sent and got back{item.opened ? ", unsealed with your key" : ""}
          {item.clipped ? ", shortened" : ""}
        </summary>
        <div className="muted small">Sent</div>
        <pre>{pretty(open.args)}</pre>
        {open.result !== undefined && (
          <>
            <div className="muted small">Got back</div>
            <pre>{pretty(open.result)}</pre>
          </>
        )}
      </details>
    )
  }
  return <div className="muted small">{item.sealed ? (canOpen ? "Sealed, and this key cannot open it" : "Sealed to the owner's key") : "Contents not kept"}. Hash {short(item.argsHash)}</div>
}

export function DiaryPage({ run }: { run: Run }) {
  const { data: list, error: listError, refresh: refreshList } = usePoll<DiaryList>("/api/diary", 5000)
  const [chosen, setChosen] = useState<string>()
  const [onlyRefused, setOnlyRefused] = useState(false)
  const [storing, setStoring] = useState(false)
  const [fromText, setFromText] = useState("")
  const [toText, setToText] = useState("")
  const now = useNow()
  const agent = list?.agents.find((a) => a.id === chosen) ?? list?.agents[1] ?? list?.agents[0]
  // A span of time is looked up on the list itself: the index is asked only for parts inside it.
  const from = fromInput(fromText)
  const to = fromInput(toText)
  const query = new URLSearchParams({ ...(from !== undefined ? { from: String(from) } : {}), ...(to !== undefined ? { to: String(to) } : {}) }).toString()
  const { data: read, error, refresh } = usePoll<DiaryRead>(`${agent ? `/api/diary/${agent.id}` : "/api/diary/main"}${query ? `?${query}` : ""}`, 10_000)
  if (!list) return <div className="page-body"><div className="page-title"><h1>Diary</h1></div><div className={listError ? "notice bad" : "loading"} role="status">{listError ?? "Reading the diaries…"}</div></div>
  if (!agent) return <div className="page-body"><div className="page-title"><div><h1>Diary</h1><p className="muted">A record of what your agents do, call by call.</p></div></div><div className="empty-state"><h2>Your first entry starts with an agent.</h2><p>No agent diaries are available yet. Start an agent to begin recording its activity.</p><a className="button-link" href="#/">View agents</a></div></div>

  const ranged = from !== undefined || to !== undefined
  const minutes = Math.round((list.windowMs ?? 300_000) / 60_000)
  // An answer for another agent or another span is not shown as this one's.
  const current = read?.id === agent.id && read.range?.from === from && read.range?.to === to ? read : undefined
  const parts = current?.parts ?? []
  const bad = parts.filter((p) => !p.check.ok)
  const locked = parts.filter((p) => p.locked)
  const gaps = parts.filter((p) => p.followsOn === false)
  const items = parts
    .flatMap((p) => p.items)
    .filter((i) => !onlyRefused || (i.kind === "CALL" && !i.allowed) || (i.kind === "NOTE" && i.note === "closed"))
    .sort((a, b) => b.seq - a.seq)

  const storeNow = async () => {
    setStoring(true)
    await run(() => post("/api/diary/store"))
    await Promise.all([refreshList(), refresh()])
    setStoring(false)
  }

  return (
    <div className="page-body">
      <div className="page-title">
        <div>
          <h1>Diary</h1>
          <p className="muted">
            What each agent really did, call by call. Each part is stored {list.where === "swarm" ? "on Swarm, encrypted so only you can read it, with its index and hash on Arkiv" : list.where === "0g" ? "on 0G Storage, with its index and hash on Arkiv" : "on this machine for now"}, so if an agent turns out to be faulty you can go back and check, and nobody can quietly change the record afterwards.
          </p>
        </div>
        <div className="page-actions">
          <button onClick={() => void storeNow()} disabled={agent.waiting === 0 || storing}>
            {storing ? "Storing, which takes about 16 seconds…" : agent.waiting === 0 ? "Nothing is waiting to be stored" : "Store what is waiting"}
          </button>
        </div>
      </div>

      {list.where === "local" && <div className="notice">Diaries stay on this machine in local mode, because nothing here is public yet. They go to 0G and Arkiv once you move to the public list, on the Arkiv page.</div>}
      {list.problem && <div className="notice">{list.problem}</div>}
      {agent.problem && <div className="notice bad">{agent.problem}</div>}

      <div className="tabs tabs-loose" role="tablist" aria-label="Agents">
        {list.agents.map((a) => (
          <button key={a.id} role="tab" aria-selected={a.id === agent.id} className={a.id === agent.id ? "tab on" : "tab"} onClick={() => setChosen(a.id)}>
            {a.name} <span className="tab-count">{a.entries}</span>
          </button>
        ))}
      </div>

      <div className="tiles">
        <Tile label="Entries stored" value={agent.entries} note={agent.lastStoredAt ? `Last stored ${ago(agent.lastStoredAt, now)}` : "Nothing stored yet"} />
        <Tile label="Stored parts" value={agent.parts} />
        <Tile label="Waiting to be stored" value={agent.waiting} note="Safe on this machine until then" />
        {list.wallet && <Tile label="Storage wallet" value={`${list.wallet.balance} 0G`} note={<Copyable value={list.wallet.address} />} />}
      </div>

      <p className="small muted">{list.where === "swarm" ? "Encrypted before it leaves this machine: anyone can see on Arkiv that a part exists, how many entries it holds and when, and only your owner key can read what is in it" : MODE[agent.mode]}.</p>
      {locked.length > 0 && <div className="notice">{locked.length} {locked.length === 1 ? "part is" : "parts are"} encrypted to the owner's key, which is on another machine, so {locked.length === 1 ? "it" : "they"} can only be read there.</div>}

      {parts.length > locked.length &&
        (bad.length || gaps.length ? (
          <div className="notice bad">
            {bad.length ? `${bad.length} of ${parts.length} parts do not match what the index recorded: ${bad[0]!.check.problem}. ` : ""}
            {gaps.length ? `${gaps.length} parts do not follow on from the one before, so something is missing.` : ""}
          </div>
        ) : (
          <div className="check-ok">
            <Status tone="green">Checked</Status> The {parts.length} newest {parts.length === 1 ? "part" : "parts"} read back from storage match the {list.where === "local" ? "recorded hashes" : "hashes on Arkiv"} and follow on from each other. Nothing has been changed.
          </div>
        ))}

      <section className="panel">
        <header>
          <h2>{agent.name}</h2>
          <label className="toggle">
            <input type="checkbox" checked={onlyRefused} onChange={(e) => setOnlyRefused(e.target.checked)} />
            Only refusals and closing
          </label>
        </header>
        <div className="diary-range" role="group" aria-label="Time range">
          <label>
            From
            <input type="datetime-local" step="1" value={fromText} onChange={(e) => setFromText(e.target.value)} />
          </label>
          <label>
            To
            <input type="datetime-local" step="1" value={toText} onChange={(e) => setToText(e.target.value)} />
          </label>
          {ranged && (
            <button
              type="button"
              onClick={() => {
                setFromText("")
                setToText("")
              }}
            >
              Show the newest
            </button>
          )}
          <span className="muted small">
            {ranged
              ? `Only the parts with something ${from !== undefined && to !== undefined ? "in that span" : from !== undefined ? "after that time" : "before that time"}, asked of the ${list.where === "local" ? "list on this machine" : "index on Arkiv"} directly. Parts stored before times were recorded are left out.`
              : `Each part covers one ${minutes}-minute window of the clock, so you can look up what an agent did at any time.`}
          </span>
        </div>
        {error && !current ? (
          <div className="empty notice bad">{error}</div>
        ) : !current ? (
          <div className="empty muted">Reading it back from storage…</div>
        ) : items.length === 0 ? (
          <div className="empty">
            <p>{ranged ? "Nothing stored for this agent in that span of time." : "Nothing stored for this agent yet."}</p>
            {agent.waiting > 0 && <p className="muted small">{agent.waiting} entries are waiting. Each agent stores one part for each {minutes}-minute window once it is over, and straight away when it closes.</p>}
          </div>
        ) : (
          <table className="calls diary-calls">
            <tbody>
              {items.map((item) => {
                const result = outcome(item)
                return (
                  <tr key={item.seq}>
                    <td className="muted small nowrap tabular">#{item.seq}</td>
                    <td className="muted small nowrap">{new Date(item.at).toLocaleString()}</td>
                    <td className="nowrap">
                      <Status tone={result.tone} small>
                        {result.label}
                      </Status>
                    </td>
                    <td className="why">
                      {item.kind === "CALL" ? (
                        <>
                          <span className="mono">{item.action}</span> <span className="muted small">{item.tool} {item.version}</span>
                          {item.message && <div className="small">{item.message}</div>}
                          <Contents item={item} canOpen={current.canOpenSealed} />
                        </>
                      ) : item.kind === "NOTE" ? (
                        <span className="small">{item.text}</span>
                      ) : (
                        <span className="small">{item.kind}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {parts.length > 0 && (
        <section className="panel">
          <header>
            <h2>Where it is stored</h2>
            <span className="muted small">
              The newest {parts.length} of {current?.totalParts} parts
            </span>
          </header>
          <table>
            <thead>
              <tr>
                <th>Entries</th>
                <th>When</th>
                <th>Stored as</th>
                <th>Index block</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => (
                <tr key={p.root}>
                  <td className="small tabular">
                    {p.firstSeq} to {p.lastSeq}
                  </td>
                  <td className="small">{span(p.firstAt, p.lastAt)}</td>
                  <td>
                    <Copyable value={p.root} />
                  </td>
                  <td className="small tabular">{p.block}</td>
                  <td>{p.locked ? <Status tone="grey" small>Encrypted</Status> : p.check.ok ? <Status tone="green" small>{p.storage ? "Opened, and matches" : "Matches"}</Status> : <Status tone="red" small>Does not match</Status>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
