# Records on Arkiv

Every record is an Arkiv entity written with `@arkiv-network/sdk` to the Rabdi testnet (chain 7794095). Definitions are in [packages/core/src/schema.ts](../packages/core/src/schema.ts), writes in [writer.ts](../packages/core/src/writer.ts) and reads in [reader.ts](../packages/core/src/reader.ts).

Anyone can write an entity with any attributes, so labels prove nothing. Every read filters on `$creator`, which the chain sets and nobody can fake.

## Entities

| Entity (`arkiv.schema`) | What it is | Created and owned by | Filtered on by our app | Editable? | Expires after |
|---|---|---|---|---|---|
| `ceasenet.recall`, level `STOP` | An order to stop an agent, or a tool, skill, model or prompt. It binds only the agents of the owner who signed it. `approves`, when set, is the normal recall it approves after people voted | The owner of the agents it binds | `$creator`, and `approves` | No. Read-only, and anyone can extend it | About 182 days (the maximum), and anyone can renew |
| `ceasenet.recall`, level `ADVISORY`, severity `REPORT` | A normal recall: opened by a person logged in with World, and voted on. `opener` is that person's address. It binds nobody until an owner approves it with a STOP | The verifier, after checking the opener's login and wallet signature | `$creator`, `artifact` and `opener` | No. Read-only | 72 hours |
| `ceasenet.human` | A wallet address that one real person logged in with. `human` is the same for that person every time, and says nothing else about them. One person links one address | The verifier, after World ID checks the proof and the wallet has signed | `address` or `human`, with `$creator` | No. Read-only | 180 days |
| `ceasenet.endorse` | One person's vote on a normal recall. `human` is the logged-in voter's address. Older votes hold a hash scoped to that recall | The verifier, after checking the voter's login and wallet signature | `recall` and `$creator` together | No. Read-only | 72 hours |
| `ceasenet.lift` | Ends a recall: `FIX`, `WITHDRAWN` or `DISMISSED`. A fix names `fixedHash`, `fixedVersion` and `fixedRef` (a public Swarm reference) | The key that issued the recall, or a regulator. Readers check this | `recall` | No. Read-only | About 182 days |
| `ceasenet.ack` | An agent's receipt: `BLOCKED`, `SUPERVISED`, `CLEARED` or `UPDATED`, with the recall's content hash | The agent | `recall`, or `$creator` | No. Read-only | 180 days |
| `ceasenet.agent` | An agent's passport: who is responsible for it | Its owner | `$creator`, or `agent` | No. Read-only | 180 days |
| `ceasenet.loadout` | The exact files an agent loaded, one record per change, with its `fingerprint`: one searchable value for its tools, model and instructions. With `ceasenet privacy private` it holds only who the agent is | The agent. Optional | `$creator`, sorted by `seq`, newest first | No. Read-only | 180 days |
| `ceasenet.heartbeat` | The agent's current status. One per agent, updated in place | The agent. Optional | `$creator` | Yes, by its owner | 30 seconds in the demo, 10 minutes in production. Expired reads as "unknown" |
| `ceasenet.trust` | Whose STOPs an owner's agents obeyed, from before an agent obeyed only its owner. Readers now ignore other keys on it | The owner | `$creator`, sorted by `seq`, newest first | No. Read-only, and the highest `seq` wins | 180 days |
| `ceasenet.diary` | Index of one part of an agent's diary: `root`, where it is stored, `head`, the hash at the end of the part's chain, `storage`, and `firstAt` and `lastAt`, when its first and last entries happened in milliseconds. `swarm-sealed` means `root` is a public Swarm reference to a file only the owner can open. With none, `root` is a readable file on 0G Storage. Each part covers at most one 5-minute window of the clock, so a span of time is one query: `lastAt >= u64(from) AND firstAt <= u64(to)`. Parts written before times were added have none, and a span leaves them out | The agent, or its owner on its behalf | `agent` and `$creator` together, and `lastAt` and `firstAt` for a span of time | No. Read-only | 180 days |
| `ceasenet.artifact` | A published file: hash, kind, name, version | Its maker or a registry | `$creator` | No. Read-only | 180 days |
| `ceasenet.disclose` | The public description of a recall, with `reproductionRef` (a public Swarm reference) | The key that issued the recall, or a regulator. Readers check this | `recall` | No. Read-only | 180 days |

Long lists are read in pages, sorted and filtered on `$key`, so nothing repeats or goes missing while others write.

Other fields are indexed so that anyone can search the public record without our code, for example every recall of one `artifact` or `pkg`, every receipt with a given `action`, or every file with a given `name`. The columns are declared in [schema.ts](../packages/core/src/schema.ts).

## Why each owner and lifetime

- **STOP.** Nobody can change what it says, not even its issuer. Anyone can keep it alive, so it cannot quietly lapse. Its issuer can still delete it. See [friction.md](friction.md), item 1, and the section on deleted STOPs in [how-you-use-arkiv.md](how-you-use-arkiv.md).
- **Warning, 72 hours.** A warning that real people do not confirm should fade. The gate also enforces the 72-hour window itself, whatever the expiry says.
- **Heartbeat, seconds.** Expiry is the signal. An agent that stops refreshing disappears, which the board shows as unknown.
- **Receipts, 180 days.** They need to outlast the STOP they answer, because they are what proves a deleted STOP existed.

## Reading long text

A `str` column holds 128 bytes. Reasons, advice, descriptions, loadouts and trust lists are `bytes` columns holding UTF-8, and come back as hex.
