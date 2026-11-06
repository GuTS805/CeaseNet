# How CeaseNet uses Arkiv

Arkiv is not a log here. The gate decides from what it reads, and every public page is read straight from Arkiv in the browser.

## Filters

| Query | Who runs it | What the user sees because of it |
|---|---|---|
| `ceasenet.recall` where `$creator` is any key on the owner's trust list | Each agent's gate, before every task and every 2 seconds in the demo | A tool turns from "Allowed" to "Blocked". A record from any other key is never even read, so a fake STOP changes nothing |
| `ceasenet.trust` where `$creator` is the owner, newest `seq` first | Each gate | An owner changes whom they obey, and it takes effect at the next check. In the demo, the Bandra Freight card keeps sending after a STOP until its owner follows the maker |
| `ceasenet.endorse` where `recall` is one of these warnings and `$creator` is the verifier | Each gate, and the recall page | "2 of 3 people confirmed" on the page. At 3, the tool moves to "Needs a human" |
| `ceasenet.lift` where `recall` is one of these | Each gate, and the recall page | "Fix published", then agents move to the fixed version |
| `ceasenet.ack` where `recall` is this one, or `$creator` is one of these agents | The recall page | The public board: "3 of 3 obeyed", or who is silent or not following |
| `ceasenet.agent` where `$creator` is an owner | The live and agent pages | Which company answers for which agent |
| `ceasenet.loadout` where `$creator` is the agent, newest `seq` first | The board and agent page | Exactly which files the agent runs, and so whether a recall affects it |
| `ceasenet.heartbeat` where `$creator` is the agent | The board and agent page | "Running" or "Stopped". When it has expired, "Unknown" |
| `ceasenet.diary` where `$creator` is the agent | The agent page | A list of diary parts, and "Read from 0G and check", which compares a part with its hash here |

The "Check a tool" page downloads all recalls and matches in the browser, so nobody learns what you looked up. We chose that over a per-tool query on purpose, and we paid for it: see [friction.md](friction.md), item 6.

## Edit permissions

| Choice | What it changes for users |
|---|---|
| Recalls, lifts, confirmations, receipts and trust lists are read-only | What a page shows is what was issued. A maker can't soften a STOP after the fact |
| Anyone can extend a STOP (`permissionlessExtension`), and only the owner controls everything else | A STOP can't quietly lapse. `npm run smoke` confirms an outsider can extend a STOP but can't extend a confirmation or delete anything |
| The heartbeat is the one editable record, updated in place | Each agent shows one live status, not a growing pile of records |
| A trust-list change is a new record, not an edit | An owner's history of whom they followed stays public |
| The agent's owner creates its passport, not the agent | The page can name who is responsible, and an agent can't claim another company's name |

## Expirations

| Record | Lifetime | What it changes for users |
|---|---|---|
| Heartbeat | 30 s in the demo, 10 min in production | Expiry is the signal: an agent that stops reporting turns to "Unknown" with no timeout logic on the page |
| Warning and confirmations | 72 hours | A warning nobody confirms fades away and stops bothering anyone |
| STOP | The maximum, about 182 days, and anyone can renew | A STOP stays in force until someone ends it |
| Receipts | 180 days | They outlast the STOP they answer, which is what proves a deleted one existed |

## When a STOP gets deleted

Arkiv lets the owner delete even a read-only record, so we designed for it. `npm run e2e` runs this on the live chain:

1. The maker issues a STOP. Agents block the tool and post receipts holding the recall's key, content hash and issuer.
2. The maker deletes the STOP. It's gone from Arkiv.
3. Agents keep blocking, because the gate remembers what it saw, in a file that survives restarts. The agent's page says it obeyed a STOP that its issuer has since deleted.
4. The recall page says: "This recall is no longer on Arkiv, but agents posted receipts for it, which proves it existed."

## Other uses

- **Fail closed.** If a gate can't read Arkiv, it keeps working for a grace period, then asks a human for each call, then refuses. The demo's "Cut off" button shows this.
- **Receipts prove behaviour, not just reading.** The board separates "blocked it", "fixed", "silent" and "not following". "Silent" is reported as unknown, because nobody can tell from outside whether a silent agent lost its connection or is ignoring the recall.
