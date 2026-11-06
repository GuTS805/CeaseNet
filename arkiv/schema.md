# Records on Arkiv

Every record is an Arkiv entity written with `@arkiv-network/sdk` to the Rabdi testnet (chain 7794095). Definitions are in [packages/core/src/schema.ts](../packages/core/src/schema.ts), writes in [writer.ts](../packages/core/src/writer.ts) and reads in [reader.ts](../packages/core/src/reader.ts).

Anyone can write an entity with any attributes, so labels prove nothing. Every read filters on `$creator`, which the chain sets and nobody can fake.

## Entities

| Entity (`arkiv.schema`) | What it is | Created and owned by | Filtered on by our app | Editable? | Expires after |
|---|---|---|---|---|---|
| `ceasenet.recall`, level `STOP` | An order to stop using a tool, skill, model or prompt | A key on an owner's trust list: maker, registry or regulator | `$creator` | No. Read-only, and anyone can extend it | About 182 days (the maximum), and anyone can renew |
| `ceasenet.recall`, level `ADVISORY` | A warning that real people can confirm, or with severity `REPORT`, a report from a person that others vote on | The verifier | `$creator` | No. Read-only | 72 hours, renewed by the verifier while confirmations arrive |
| `ceasenet.endorse` | One person's vote on a report or warning. `human` is a hash scoped to that report, or starts `simulated-` for a stand-in in test mode | The verifier, after World ID checks the proof | `recall` and `$creator` together | No. Read-only | 72 hours |
| `ceasenet.lift` | Ends a recall: `FIX`, `WITHDRAWN` or `DISMISSED`. A fix names `fixedHash`, `fixedVersion` and `fixedRef` (a public Swarm reference) | The key that issued the recall, or a regulator. Readers check this | `recall` | No. Read-only | About 182 days |
| `ceasenet.ack` | An agent's receipt: `BLOCKED`, `SUPERVISED`, `CLEARED` or `UPDATED`, with the recall's content hash | The agent | `recall`, or `$creator` | No. Read-only | 180 days |
| `ceasenet.agent` | An agent's passport: who is responsible for it | Its owner | `$creator`, or `agent` | No. Read-only | 180 days |
| `ceasenet.loadout` | The exact files an agent loaded, one record per change, with its `fingerprint`: one searchable value for its tools, model and instructions | The agent. Optional | `$creator`, sorted by `seq`, newest first | No. Read-only | 180 days |
| `ceasenet.heartbeat` | The agent's current status. One per agent, updated in place | The agent. Optional | `$creator` | Yes, by its owner | 30 seconds in the demo, 10 minutes in production. Expired reads as "unknown" |
| `ceasenet.trust` | Whose STOPs an owner's agents obey. Each change is a new record | The owner | `$creator`, sorted by `seq`, newest first | No. Read-only, and the highest `seq` wins | 180 days |
| `ceasenet.diary` | Index of one part of an agent's diary: `root`, where it is stored, `head`, the hash at the end of the part's chain, and `storage`. `swarm-sealed` means `root` is a public Swarm reference to a file only the owner can open. With none, `root` is a readable file on 0G Storage | The agent, or its owner on its behalf | `agent` and `$creator` together | No. Read-only | 180 days |
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
