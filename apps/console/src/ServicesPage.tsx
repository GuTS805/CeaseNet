import { type ServiceCard, usePoll } from "./api"
import { Status, type Tone } from "./ui"

const STATUS: Record<ServiceCard["status"], { label: string; tone: Tone }> = {
  working: { label: "Working", tone: "green" },
  ready: { label: "Reachable", tone: "amber" },
  limited: { label: "Limit reached", tone: "amber" },
  "not-set-up": { label: "Not set up", tone: "grey" },
  unreachable: { label: "Out of reach", tone: "red" },
}

export function ServicesPage() {
  const { data: cards, error } = usePoll<ServiceCard[]>("/api/services", 20_000)
  if (!cards) return <div className="loading">{error ?? "Asking each service…"}</div>
  return (
    <div className="page-body">
      <div className="page-title">
        <div>
          <h1>Services</h1>
          <p className="muted">Everything CeaseNet can work with, and where each stands right now. Each was just asked, and keys are only ever shown as set or missing.</p>
        </div>
      </div>
      <div className="services">
        {cards.map((c) => {
          const status = STATUS[c.status]
          return (
            <article className="service" key={c.id}>
              <header>
                <h2>{c.name}</h2>
                <Status tone={status.tone}>{status.label}</Status>
              </header>
              <p className="small">{c.purpose}</p>
              <ul className="found small">
                {c.found.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {c.todo && <p className="small todo">{c.todo}</p>}
              <div className="service-foot muted small">
                <span>Used by: {c.usedBy}</span>
                {c.link && (
                  <a href={c.link} target="_blank" rel="noreferrer">
                    Open
                  </a>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
