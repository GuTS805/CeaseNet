# CeaseNet

**Recalls for AI agents.** Cease, as in cease and desist.

When a tool an AI agent uses turns out to be malicious, taking it off the marketplace doesn't stop agents that already have it. In September 2025, `postmark-mcp` 1.0.16 quietly copied every email to an attacker. It was pulled from npm, and installed copies kept running.

CeaseNet is a public recall list on [Arkiv](https://arkiv.network) that agents check for themselves. When a tool's maker issues a STOP, every agent following that maker blocks that one tool within seconds and posts a public receipt. Nobody can quietly edit the recall. If the maker deletes it, agents keep obeying, and their receipts prove it existed.

## How it works

| Level | Who issues it | What an agent does |
|---|---|---|
| **Warning** | The verifier, once a report passes its checks | Keeps working. The warning is shown publicly |
| **Needs a human** | Reached when 3 people, each proved unique by [World ID](https://world.org), confirm a warning within 72 hours, and confirmations outnumber disputes | Each call to that tool waits for a person to approve it |
| **STOP** | A key the agent's owner chose to trust, such as the tool's maker or a regulator | Refuses that tool. A recalled model or prompt stops the whole agent |
| **Lift** | The key that issued the recall, or a regulator | A published fix names an exact file. Agents move to that file and carry on |

Three things make it hold up:

- **The gate is in the code that runs the tools,** not in the model. A model can't talk its way past it. Tools run as separate processes with no keys.
- **It fails closed.** Without Arkiv, an agent keeps working for a grace period, then asks a human for each call, then refuses.
- **Owners choose whom to obey,** on a public trust list. There is no central authority, including us.

| Data | Where | Why |
|---|---|---|
| Recalls, confirmations, receipts, trust lists, passports | [Arkiv](arkiv/schema.md) | Public, can't be edited, readable with no account |
| The agent's diary: each call, and the model request behind it | 0G Storage, with its hash on Arkiv | Too big for Arkiv, and a changed copy fails the check |
| Fixed tools and evidence | [Swarm](arkiv/swarm.md), with references on Arkiv | Fixes must survive the maker's site. Evidence stays encrypted until disclosure |

## Try it

The public pages read Arkiv directly in your browser: **live site link goes here**. To run the live agents you need Node 22.10 or newer.

```bash
git clone https://github.com/GuTS805/CeaseNet.git && cd CeaseNet
npm install
npm test            # needs no keys or network
npm run query       # reads the live public records, with no key
```

To run the whole demo with your own wallets:

```bash
cp .env.example .env
npm run keys        # creates a test phrase in .env and writes your addresses to deployment.json
# Claim tGLM for the "treasury" address at https://hub.arkiv.network/faucet
# For the diary, also claim 0G testnet tokens for that same address
npm run fund
npm run seed        # publishes the demo's tools, passports and trust lists
npm run demo        # the agents. Needs ZG_API_KEY. Without one, npm run demo:dev uses built-in rules and says so on screen
npm run web         # the website, on http://localhost:5173
npm run verifier    # optional: real World ID confirmations
```

`npm run reset` clears rehearsals. `.env.example` explains every setting. Without Swarm or World settings the demo still runs, and those parts turn off or show a labelled stand-in.

### Protect a real agent

Point your MCP client at this command in place of the tool's own. Nothing else changes:

```bash
npx tsx packages/guard/src/proxy.ts --package ./path/to/tool --owner 0xYourOwnerAddress -- node ./path/to/tool/server.js
```

It measures the tool's real files, then answers `tools/call` only if the gate allows. Without `CEASENET_AGENT_KEY` it only reads the list, and writes nothing about you.

### Checks against live networks

| Command | What it proves |
|---|---|
| `npm run smoke` | Every Arkiv behaviour the design relies on: a read-only STOP, anyone can extend it, an outsider can't delete it, and an owner can |
| `npm run e2e` | The whole story on the live chain, against a running demo |
| `npm run proxy-check` | A standard MCP client is refused through the proxy, 0.5 s after the STOP appears on Arkiv |
| `npm run diary-check` | A diary part stores on 0G, reads back with no wallet, and a changed copy fails |
| `npm run swarm-check` | A fix and sealed evidence on a real Bee node. Needs a postage batch |
| `npm run agent-pass-check` | One real World ID Agent Pass attempt. Needs portal credentials |
| `npm run friction` | Reproduces each problem in our [Arkiv feedback](arkiv/friction.md) |

## For Arkiv judges

**Query you can run, with no key and no wallet:**

```bash
npm run query
```

Or with nothing installed, using [arkiv/query.json](arkiv/query.json):

```bash
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network/ -H 'content-type: application/json' -d @arkiv/query.json
```

It asks for every STOP created by the maker's key, on Rabdi (chain 7794095). A fake STOP from any other key is not in the results.

**Wallets that wrote entities:**

| Role | Address |
|---|---|
| Tool maker | `0xd33611D47a70192F31CBa3Ac161d7061F276485f` |
| Security council (regulator) | `0x6b135261aBF3707da627dc7494727176D64b0AD8` |
| Tool registry | `0x9A2088c25aDe29a50Dbc154924A823A90b4A8A91` |
| Verifier | `0x8ea3c7A2aa463B563892410589f01867DfAe7766` |
| Asha Exports (owner, agent) | `0x3f53e130327F0E594aFfCA9c7c30b56d276b93C6`, `0x8D2554bd95C650448dC58b0c9711773b9736ab10` |
| Bandra Freight (owner, agent) | `0x82c3072f28547c882C64F1e84B3f4562a0D5b153`, `0x48113119e0C59C6063Aa8dacB20851b3dB91eE1a` |
| Coastal Foods (owner, agent) | `0xa10db75Aa52ff086C68bbe86523F3Dd710306a32`, `0x36d030406493A524d84c39bfc2fdbAE6a955a962` |
| Outsider, for the fake STOP | `0xE16525DD63fF2Ff570e31762798b87199D23FB3f` |
| Live checks only (`npm run smoke`, `npm run friction`) | `0xc784d92e6B8AFAfBc0f042Db82F5841665e7dFa4`, `0x4cf240e7E978AE82100A81De4A206e38645E1750`, `0x90a21122Ba0cAe96bbA0A5a15DE2Bc6F7598685b`, `0x01203FfBa0Cb1Cb02F36Fa76a45846275bd22997` |

Documents: [schema](arkiv/schema.md), [feedback](arkiv/friction.md), [reach](arkiv/reach.md), [why Arkiv](arkiv/why-arkiv.md), [how we use Arkiv](arkiv/how-you-use-arkiv.md), [Swarm](arkiv/swarm.md).

## CROPS

**Censorship resistance.** We run the website, the demo server and the verifier that files World ID confirmations. If they fail or refuse, agents keep obeying, because each gate reads Arkiv itself, and anyone can host the static site. An owner can replace our verifier and any issuer by publishing a new trust list. Recalls need no approval from us.

**Open source.** MIT licence. `npm install && npm test && npm run build -w @ceasenet/web` works from this repository alone, with no keys. Running live agents needs third-party accounts: test tokens to write to Arkiv, and a 0G key for the model. Reading Arkiv needs neither.

**Privacy.** The Arkiv RPC learns your IP and which keys you follow, not which tools you run, because the gate downloads all their recalls and matches locally. The same goes for the "Check a tool" page. Publishing a loadout, heartbeat and receipts is optional. The model provider, through 0G's router, sees what the agent sends it. The public diary holds only a hash of each call's arguments. World learns only that someone proved for this app's action, and Arkiv gets a hash scoped to one warning, so one person's answers can't be linked across warnings. The site has no trackers.

**Security.** Each role has its own key, and tools run as separate processes that see none of them. Backend secrets never reach a browser or a model. A fix runs only if its hash matches the published one. We assume that:
- the keys on your trust list are honest. A stolen issuer key can stop your tool, but not run code on your machine, and removing it from your list ends that
- your own machine is not compromised. The gate protects you from a bad tool, not from a bad host
- Arkiv's testnet serves correct data. A node that hides records can delay a recall, which is why an unreachable list fails closed, but a node that serves a stale list is not detected
- someone saw a record before it was deleted. Arkiv has no historical reads, so a deleted STOP stays provable only through receipts, gate memory and independent watchers

## What this does not do

- It only binds agents that run the gate.
- A silent agent proves nothing: from outside, a lost connection and ignoring a recall look the same. The board reports "silent", not "disobeying".
- The demo's tools are made up, and nothing is really sent. The demo's timers are short and it says so: a 2-second check, against 30 seconds in the production settings.
- In the demo, people beyond the first are labelled "simulated", because World's simulator acts as one identity.
- It runs on testnets only and has no users yet.

## Sponsors

| Sponsor | How it's used | Details |
|---|---|---|
| **Arkiv** | The recall list itself: what every gate reads and every public page shows | [arkiv/](arkiv/) |
| **World** | IDKit: one person, one answer on a warning. Agent Pass: a real person approves a paused call | [docs/world.md](docs/world.md) |
| **Ethereum Foundation** | The CROPS section above, and the reason the design has no central party | |
| **Swarm** | Fixed tools and sealed evidence | [arkiv/swarm.md](arkiv/swarm.md) |
| **0G** | The demo agents' model, through 0G's router, and the diary on 0G Storage. Not entered for a 0G prize | [zeroG.ts](apps/demo/src/zeroG.ts) |

## Layout

```
packages/core    Records, the gate's decisions, Arkiv reads and writes
packages/guard   The guard, MCP proxy, diary, Swarm client and Agent Pass
apps/demo        Three companies' agents, running real MCP tools
apps/verifier    Checks World ID proofs on the server
apps/web         The website
tools            Made-up tools, one with a hidden copy
scripts          Setup and live checks
arkiv, docs      Sponsor documents, the plan and AI usage
```

The earlier robot version of this idea is kept on the [`robots`](https://github.com/GuTS805/CeaseNet/tree/robots) branch.

## How this was built

Built at ETHGlobal Mumbai 2026 with heavy use of AI. See [docs/ai-usage.md](docs/ai-usage.md) for what was done how, [docs/prompts.md](docs/prompts.md) for the prompts, [docs/plan.md](docs/plan.md) for the plan, and [docs/prior-work.md](docs/prior-work.md) for what existed before kickoff.

## Licence

[MIT](LICENSE)
