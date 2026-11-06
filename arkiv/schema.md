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

## Build your own gate

Nothing here needs our code. A gate is a few rules applied to the public list, and [examples/ceasenet_gate.py](../examples/ceasenet_gate.py) does it in Python with only the standard library.

**Reading.** Ask any Arkiv node on Rabdi with `arkiv_query`, over plain JSON-RPC. To learn what an agent must obey, read every recall its owner signed, and the lifts of those recalls:

```
arkiv.schema = str('ceasenet.recall') AND $creator = addr(<owner>) ORDER BY $key:key ASC
arkiv.schema = str('ceasenet.lift') AND (recall = key(<a>) OR recall = key(<b>)) ORDER BY $key:key ASC
```

Page with `AND $key > key(<the last key you got>)`. Match on your own machine, so the node learns which owner you asked about and never which tools you are checking.

**Deciding.** Compare addresses and hashes in lowercase.

1. **Whose word counts.** A STOP binds an agent only if `$creator` is that agent's owner. Ignore what any label says.
2. **What it covers.** A recall covers a file if its `artifact` equals the file's hash, or if it has both `pkg` and `versions`, `pkg` is the file's name, and the file's version is in that npm range. A range that can't be read covers nothing.
3. **Which files.** An agent carries `agent:<its address>`, `fleet:<its owner>` and, in a team, `team:<its owner>`, as well as its model and prompt. A STOP on any of these stops the agent. A STOP on a tool or skill stops only that.
4. **What ends it.** A lift of kind `WITHDRAWN` from the STOP's own creator ends it. A lift from anyone else does nothing. A `FIX` says what to move to, and does not unblock the old version.
5. **What a normal recall does.** Nothing, however many votes it has, because it is written by the verifier and not the owner. It binds when the owner signs a STOP.
6. **When you can't tell.** Refuse. Treat a node whose newest block is more than 2 minutes old as out of reach. Ours keeps an agent working for 5 minutes with the list out of reach, then asks a person for each call for 5 more, then refuses.
7. **Remember.** Keep each STOP you have seen, and keep obeying it if it disappears from the list. Only a proper lift ends it.
8. **Any call you don't know.** A tool you were not told about doesn't go through.

**Checking.** [vectors/gate.json](vectors/gate.json) states what must be decided, as 56 cases with no dependence on our code: `decide` holds a whole input with the agent's mode and one call's verdict, and `covers` holds one recall and one file. Pass them all, as [check_gate_vectors.py](../examples/check_gate_vectors.py) does, and your gate decides as ours does. If you think a case is wrong, please [open an issue](https://github.com/GuTS805/CeaseNet/issues).

The older `trust` records and the `regulators` and `verifier` inputs in the vectors come from when an owner could follow other keys. An agent now obeys only its owner, which means `stopKeys` and `verifier` both hold the owner and `regulators` is empty.

## Reading long text

A `str` column holds 128 bytes. Reasons, advice, descriptions, loadouts and trust lists are `bytes` columns holding UTF-8, and come back as hex.
