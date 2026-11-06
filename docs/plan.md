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
| The public pages read every record, not a list of known keys | A stranger's agent and recall have to show up with nobody's permission, labelled with who follows them |
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
12. The public site beyond the demo: browser wallets, recalling a real npm tool measured in the browser, and the live network map

## From a demo to a product

After the event's build, the project moved from a scripted demo to something people can put in front of their own agents. The gate did not change, and these were added around it:

| Decision | Why |
|---|---|
| One program, `ceasenet`, installed in one step | Everything else assumed a clone of this repository and the demo's keys |
| `protect` rewrites a client's settings, and `unprotect` undoes it exactly | Nobody adopts something that needs code changes, or that they can't take back out |
| You obey only yourself until you say otherwise | The demo's keys had no business being trusted on anyone's machine |
| A STOP ends the tool's process, and a recalled tool is never started | Refusing calls left a recalled tool running, free to do what it liked in the background |
| Stopping an agent is a STOP aimed at the agent itself | It needed no new path through the gate, so every existing rule applies to it, including lifts, receipts and deleted STOPs |
| A hook covers Claude Code's own tools | Its Bash tool never passes through MCP, so a stop that missed it was not a stop |
| Gates decide alone, and one background process does all the writing | Writes from one key must go out one at a time, and nothing about reporting should be able to let a call through |
| Local mode, on a file | So it works in the first minute, and can be tested end to end with no wallet |

## Keeping a record, and letting people report

| Decision | Why |
|---|---|
| Every call goes in the diary, with its contents | The question after something goes wrong is what exactly did it do, and a hash alone cannot answer that |
| Contents are sealed to the owner's key on real agents | Storage is public and permanent, and a call can hold a customer's details. The three trading agents stay in the open, because they trade paper money on public prices |
| A guard only writes to a local file, and one service stores it | A guard holds no keys and must not depend on a network, and uploads from one wallet have to go one at a time |
| One part per agent every 2 minutes, and at once on closing | A part costs real tokens, and what an agent did just before closing is what people will want to see |
| The owner's wallet pays, and the index may be written by the owner | So an owner funds one wallet. Readers accept the agent's key or its owner's, and nobody else's |
| Votes tell the owner, and stop nothing | A crowd must not be able to switch off someone's agent, so the old rule that confirmations make every call wait for a person is not used here. An owner can still follow a verifier for that, in the gate's trust list |
| Reports are read from the chain whatever the owner's mode | A person with no connection to the owner has to be able to reach them |
| Filing counts as the filer's vote, using the same World ID action | So the same person cannot file a report and then vote on it as well |

## What we cut

- Robots and physical AI: on the `robots` branch.
- ENS and Uniswap: the team decided against both.
- A 0G prize entry: 0G's rules exclude using it for logs only, and that is our only use.
- Chasing a real postage batch before the code worked: the Swarm path was built against Bee's published API.

## Known gaps

See [What this does not do](../README.md#what-this-does-not-do) and the assumptions under [CROPS](../README.md#crops).
