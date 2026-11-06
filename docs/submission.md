# Submission text

Ready to paste into the ETHGlobal form. Choose "Finalist and Partner Prizes".

## Project name

CeaseNet

## Short description

A public recall list on Arkiv that stops a bad tool in every AI agent using it, within seconds, with public proof.

## Description

When a tool an AI agent uses turns malicious, removing it from the marketplace doesn't reach the copies already installed. In September 2025, postmark-mcp 1.0.16 quietly copied every email to an attacker, and installed copies kept running after it was pulled.

CeaseNet is a shared recall list that agents check for themselves. A guard sits in front of every tool call. When a key the agent's owner trusts issues a STOP, every agent following that key blocks that one tool within seconds, while the rest of its work continues, and posts a public receipt. A published fix names an exact file, and agents move to it automatically.

Anyone can raise a warning. When three people, each proved unique by World ID, confirm it, each call to that tool waits for a human to approve it. Fake STOPs from other keys are ignored. If a maker deletes its own STOP, agents keep obeying, and their receipts prove it existed. If the list can't be reached, agents fail closed.

It works with any MCP server through a proxy, with no change to the agent or the tool. Owners choose whom they obey, on a public list, so there is no central authority, including us.

## How it's made

TypeScript, in an npm workspace. The gate's decisions are pure functions with unit tests, and live checks run each behaviour against the real networks.

Arkiv is the core: recalls, confirmations, receipts, trust lists and passports are all entities, and the gate decides from what it reads. Every read filters on $creator, because anyone can write any attributes. STOPs are read-only and permissionlessly extendable. Arkiv lets an owner delete a read-only record and has no historical reads, so gates remember what they've seen, and receipts carry the recall's content hash.

Agents use the real Model Context Protocol SDK, with each tool as a separate process that holds no keys. The agents' model can be any service that speaks the OpenAI chat API. Each agent keeps a hash-chained diary on 0G Storage, with its head pinned on Arkiv so that a changed copy fails the check.

Fixed tools live on Swarm, with the reference on Arkiv, and agents check the hash before anything reaches the disk. Evidence goes on Swarm encrypted, and its reference is sealed to the security council's key before it goes near a public record, because an encrypted Swarm reference contains its own key.

World ID: IDKit proves one person, one answer per warning, verified on the server, with a nullifier hash scoped to that warning. Agent Pass pauses a call until a real person approves through the device flow and the backend validates the signed token.

The site is React and Vite, and reads Arkiv directly in the browser with no server of ours.

AI use is disclosed in docs/ai-usage.md.

## Links

- Code: https://github.com/GuTS805/CeaseNet
- Live pages: **ADD THE LINK**
- Demo video: **ADD THE LINK**

## Partner prizes

### Arkiv: Build on Arkiv, from scratch

**How we use it:** Arkiv is the recall list itself. Every gate decides from what it reads, and every public page reads it directly. Filters, edit permissions and expirations are each tied to something a user sees: [arkiv/how-you-use-arkiv.md](../arkiv/how-you-use-arkiv.md). Records: [arkiv/schema.md](../arkiv/schema.md). Run `npm run query` to read them with no key.

**Feedback:** the SDK's error messages are the best we met at this event. Our main request is a way to make a record undeletable, because "read-only" records can still be deleted by their owner, which matters for a safety recall. Batch gas estimates also run short, and the fee is lost. Full list, with reproductions: [arkiv/friction.md](../arkiv/friction.md).

### Arkiv + Swarm bonus

Ready to select. `npm run swarm-check` passed on a real batch on 6 Nov, and [arkiv/swarm.md](../arkiv/swarm.md) is filled in, apart from the video timestamp.

**How we use it:** each agent's diary is encrypted to its owner and kept on Swarm, with its index and hash on Arkiv. Fixed tools live on Swarm, so a fix survives the maker's site going away. Agents and browsers check the hash, so nobody has to trust the host. Evidence stays encrypted until disclosure.

### World

Enter **IDKit** now. Enter **Agent Pass** only after `npm run agent-pass-check` has passed against World itself.

**How we use it:** IDKit: one person, one answer on a warning. Agent Pass: a real person approves a paused call. Details and debriefs for both: [docs/world.md](world.md).

**Feedback:** let any hackathon team register a sandbox client with a personal Google account, and give simulator identities a way to get credentials. The rest is in the debriefs.

### Ethereum Foundation: Best CROPS App

**How we use it:** censorship resistance is the reason this exists. Each agent's gate reads Arkiv itself and obeys only its owner's signed STOP, so nobody else, us included, can stop it, and nothing of ours can keep the owner from stopping it. No single node can quietly hold a STOP back either: a gate fails closed on a list more than 2 minutes behind the chain, and `ceasenet rpc <url>` moves an owner's agents to a node they run. CI rebuilds the hosted verifier from source on every push and fails if it differs by a byte. Privacy is structural too: a gate matches locally, so no node learns which tools it checks, `ceasenet privacy private` keeps them off the public list as well, an agent you never fund publishes nothing and still obeys, and the README has a table of who learns what. Open source goes past the licence: a second gate in Python, with only the standard library and none of our code, passes the same 56 conformance vectors as ours and agreed with it on the live list, and the README says what happens if each part we run disappears and how to replace it. The site is static and also lives on Swarm (`06c04c335ccf229650ff3ce9b571cb1d8bf068439b4cf395b09e9bcdd2e5b071`), and the client loads no trackers. The CROPS section, with one or two lines per letter and the tradeoffs we accept, is in the [README](../README.md#crops). The CROPS video (under 3 minutes, script in [demo-script.md](demo-script.md)) shows an outsider's STOP changing nothing, then the owner's STOP closing all three agents with no site or server of ours involved. **Add the video link.**

**Feedback:** **ADD YOUR OWN**, if the team has any.
