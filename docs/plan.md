# Design and build plan

## The problem

Malicious tools for AI agents are already a real attack. Removing one from a marketplace doesn't reach the copies already installed, and nothing tells a running agent to stop.

Existing products leave a gap. Runtime gateways are run per company, with no shared list. Public malware datasets have no enforcement or receipts. Spending-policy tools don't deal with bad software at all. CeaseNet aims at the gap: a shared public list, a runtime block, and public receipts.

## Decisions

| Decision | Why |
|---|---|
| The record lives on Arkiv, and the gate reads it directly | Nobody in the middle can hide or change a recall, including us |
| Every read checks `$creator` | Anyone can write any entity, so labels prove nothing |
| Owners publish their own trust list | No central authority, and an owner can drop an issuer at any time |
| Block one tool, not the whole agent | The bad tool stops and the rest of the work continues. A recalled model or prompt stops everything |
| Three levels: warning, needs a human, STOP | Anyone can raise a warning through the verifier, but only chosen keys can stop a tool |
| The gate reads all recalls and matches locally | The RPC doesn't learn which tools you run |
| Fail closed: grace, then human, then refuse | An attacker who blocks the list can't keep a bad tool running |
| Gates remember STOPs, and receipts carry the content hash | Arkiv lets an owner delete a read-only record, and has no historical reads |
| Real MCP, with tools as separate processes | It works with existing tools, and a tool holds no keys |
| A proxy that needs no code change | Otherwise nobody would adopt it |
| Diary on 0G, fixes and evidence on Swarm, hashes on Arkiv | Each store does what it's good at, and a hash on Arkiv catches any change |
| Everything on the live screen moves only when a real reading changes | A demo that animates made-up events proves nothing. The screen compares readings of the demo server and of Arkiv, and tests cover that comparison |
| The model is any OpenAI-compatible service | Nobody should have to trust one model provider. We first used 0G's router, and moved when its credits and request limit got in the way of the demo |

## Build order

1. Records, gate decisions and Arkiv reads, with unit tests
2. Live check of every Arkiv behaviour the design relies on (`npm run smoke`)
3. Robot version with fleet, board and replay (kept on the `robots` branch)
4. Move to AI agents: per-tool gate, owner trust lists, receipts
5. Guard, diary, real MCP tools, agent loop and proxy
6. Website: live page, recall pages, agent pages, "Check a tool"
7. World ID: IDKit confirmations, then Agent Pass
8. 0G diary, live
9. Swarm: fixes and sealed evidence
10. Documents, demo and submission
11. The live screen: the map, the stranger's inbox, the strip of blocks, the erase moment and sound

## What we cut

- Robots and physical AI: on the `robots` branch.
- ENS and Uniswap: the team decided against both.
- A 0G prize entry: 0G's rules exclude using it for logs only, and that is our only use.
- Chasing a real postage batch before the code worked: the Swarm path was built against Bee's published API.

## Known gaps

See [What this does not do](../README.md#what-this-does-not-do) and the assumptions under [CROPS](../README.md#crops).
