import type { ApprovalResult, Approver, ApproverLinks, PassAttempt, PassResult } from "@ceasenet/guard"
import { matchesLink } from "@ceasenet/guard"

/** How long a person has to answer before a call is refused. */
export const APPROVAL_MS = 45_000
/** Once someone has started approving through World ID, they get time to find their phone. */
export const APPROVAL_WITH_PASS_MS = 180_000

export interface PassView {
  userCode: string
  url: string
}

export interface ApprovalView {
  tool: string
  version: string
  action: string
  reason: string
  since: number
  expiresAt: number
  /** What the person needs in order to approve through World ID, once they have started. */
  pass?: PassView
}

interface Pending extends ApprovalView {
  attempt?: PassAttempt
  answer: (result: ApprovalResult) => void
  extendTo: (expiresAt: number) => void
}

export interface ApprovalDeskOptions {
  /** World ID Agent Pass. Without it the page offers labelled stand-in buttons. */
  pass?: { start(): Promise<PassAttempt> }
  links: ApproverLinks
  approvalMs?: number
  passMs?: number
  now?: () => number
}

/**
 * Calls waiting on a person. A call goes ahead only when this desk says APPROVED, and with Agent Pass connected
 * it says so only after the backend has validated a signed result from World.
 */
export class ApprovalDesk {
  private readonly pending = new Map<string, Pending>()
  private readonly notes = new Map<string, string>()
  private readonly now: () => number

  constructor(private readonly opts: ApprovalDeskOptions) {
    this.now = opts.now ?? Date.now
  }

  get usesWorldId(): boolean {
    return Boolean(this.opts.pass)
  }

  approverFor(id: string): Approver {
    return (request, signal) =>
      new Promise((resolve) => {
        const limit = this.opts.approvalMs ?? APPROVAL_MS
        let timer: ReturnType<typeof setTimeout>
        const answer = (result: ApprovalResult) => {
          if (this.pending.get(id) !== entry) return
          clearTimeout(timer)
          entry.attempt?.cancel()
          this.pending.delete(id)
          resolve(result)
        }
        const entry: Pending = {
          tool: request.file.name,
          version: request.file.version,
          action: request.action,
          reason: request.reason,
          since: this.now(),
          expiresAt: this.now() + limit,
          answer,
          extendTo: (expiresAt) => {
            clearTimeout(timer)
            entry.expiresAt = expiresAt
            timer = setTimeout(() => answer("EXPIRED"), Math.max(0, expiresAt - this.now()))
          },
        }
        this.pending.set(id, entry)
        this.notes.delete(id)
        timer = setTimeout(() => answer("EXPIRED"), limit)
        signal.addEventListener("abort", () => answer("EXPIRED"))
      })
  }

  /** What the page shows. It holds nothing secret: the device code stays inside the attempt. */
  view(id: string): ApprovalView | undefined {
    const p = this.pending.get(id)
    return p && { tool: p.tool, version: p.version, action: p.action, reason: p.reason, since: p.since, expiresAt: p.expiresAt, pass: p.pass }
  }

  /** The last thing World ID decided for this agent. */
  note(id: string): string | undefined {
    return this.notes.get(id)
  }

  /** A person pressing a button on the page. With World ID connected, that button can only refuse. */
  answer(id: string, approve: boolean): void {
    const p = this.pending.get(id)
    if (!p) throw new Error("nothing is waiting for approval")
    if (approve && this.opts.pass) throw new Error("this call can only be approved through World ID")
    p.answer(approve ? "APPROVED" : "DENIED")
  }

  /** Starts one World ID attempt for the waiting call. Pressing again returns the same one. */
  async startPass(id: string, account: string): Promise<PassView> {
    const { pass } = this.opts
    if (!pass) throw new Error("World ID Agent Pass is not connected")
    const p = this.pending.get(id)
    if (!p) throw new Error("nothing is waiting for approval")
    if (p.pass) return p.pass
    const attempt = await pass.start()
    // The STOP may have arrived, or the time run out, while World was answering.
    if (this.pending.get(id) !== p) {
      attempt.cancel()
      throw new Error("that call is no longer waiting")
    }
    p.attempt = attempt
    p.pass = { userCode: attempt.userCode, url: attempt.verificationUriComplete ?? attempt.verificationUri }
    p.extendTo(Math.min(this.now() + (this.opts.passMs ?? APPROVAL_WITH_PASS_MS), attempt.expiresAt))
    void attempt.result.then((result) => this.settle(id, p, account, result))
    return p.pass
  }

  private settle(id: string, p: Pending, account: string, result: PassResult): void {
    if (this.pending.get(id) !== p) return
    if (!result.ok) {
      this.notes.set(id, `${result.message} The call did not go ahead.`)
      p.answer(result.reason === "denied" ? "DENIED" : "EXPIRED")
      return
    }
    if (!matchesLink(this.opts.links, account, result)) {
      this.notes.set(id, "A different person answered from the one linked to this company. The call did not go ahead.")
      p.answer("DENIED")
      return
    }
    this.notes.set(id, "A real person approved this call through World ID.")
    p.answer("APPROVED")
  }
}
