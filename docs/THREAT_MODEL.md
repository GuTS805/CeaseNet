# Threat model

CeaseNet is a gate in front of an agent's tools that obeys a public list anyone can write to. This lists who might attack it, how it holds up, and where it doesn't. Each answer points to the code that gives it.

## What we protect

| What | Why it matters |
|---|---|
| An owner's control of their agent | Nobody else may stop it, and nobody may keep the owner from stopping it |
| A STOP reaching the gate | An agent that keeps running after a STOP is the failure this exists to prevent |
| The record of what happened | Receipts and diaries are worth nothing if they can be changed afterwards |
| Keys and settings | A tool must not get what it needs to act as the agent or its owner |
| What an owner keeps private | Which tools they run, and what those calls contained |

## Who might attack, and what happens

### A stranger writes a fake STOP

Anyone can write any record on Arkiv, with any labels, aimed at any agent.

A gate reads only recalls whose `$creator` is its owner, which the chain sets and nobody can fake, and checks the creator again before obeying ([`isTrustedStop`](../packages/core/src/gate.ts)). Lifts get the same check ([`isWithdrawn`](../packages/core/src/gate.ts)). Vectors: `stranger-stops-the-agent`, `stranger-cannot-withdraw`.

### A crowd tries to switch off someone's agent

Votes stop nothing. A normal recall binds nobody until the owner approves it with a STOP signed by their own wallet (`normal-recall-with-votes`). Only the verifier's records count as votes, one per person, inside a 72-hour window ([`countConfirmations`](../packages/core/src/gate.ts)).

**Not covered:** with "Skip World ID" on, one person can vote from several wallets. It is off on the hosted verifier. A verifier that turns it on marks those logins `unverified-`, and the owner still decides.

### A dishonest verifier

The verifier decides who counts as a person, so it could invent logins and votes. It can't stop an agent, because its key isn't an owner's. Owners choose whose recalls to hear with `REPORT_VERIFIER`, and anyone can run their own.

### An Arkiv node hides or delays a STOP

An unreachable list fails closed: 5 minutes of work, 5 more asking a person for each call, then refusal, and a restart doesn't reset that ([`evaluate`](../packages/core/src/gate.ts)). A node that stops following the chain counts as unreachable ([`checkListFresh`](../packages/core/src/reader.ts)). An owner can move to a node they run with `ceasenet rpc`.

**Not covered:** a node that keeps up with the chain while leaving out one record can delay a recall without being noticed. It needs a second node to catch, and a gate reads one. Nodes have no proof of a query's completeness today.

### An issuer deletes a STOP to deny it

Arkiv lets an owner delete even a read-only record. A gate keeps obeying a STOP it has seen ([`runner.ts`](../packages/core/src/runner.ts)), and the receipts of agents that obeyed it stay on the list.

**Not covered:** a STOP deleted before any gate or watcher saw it leaves nothing. Arkiv has no historical reads.

### A tool turns malicious after you installed it

An `npx` server is pinned to one exact version, installed with its install scripts turned off, and measured. If its files change, it is blocked ([`resolve.ts`](../packages/cli/src/resolve.ts)). A tool gets none of CeaseNet's settings or keys ([`toolEnv.ts`](../packages/guard/src/toolEnv.ts)).

**Not covered:** a tool runs as you. While running, it could read `~/.ceasenet` or edit your settings, because nothing else on the machine stops it. Keep the owner's key elsewhere with `ceasenet init --owner`, so a stolen agent key can't sign a STOP. A tool's dependencies aren't measured, and a tool run through Docker or a Python runner is known only by its name and command.

### A model is talked into ignoring the gate

The gate is in the code that runs the tools, not in the model, so there is nothing to talk to. It only binds agents that run it, though, and a client's built-in tools are covered in Claude Code only.

### A web page tries to press Stop

The console listens on this machine only, and refuses any request that names another host or lacks its token, which stops DNS rebinding and cross-site requests alike ([`daemon.ts`](../packages/cli/src/daemon.ts)). The site holds no key: every record is signed in your wallet.

### We turn hostile, or disappear

Nothing we run stands between an owner and their agent. The site is static and has copies, the verifier can be replaced, the gate is on your machine, and [the Python gate](../examples/ceasenet_gate.py) shows the rules can be followed with none of our code. CI fails if the hosted verifier differs from this source, but that shows what is in the repository, not what a host is really serving. Read the site from a copy you built if that matters to you.

### The dependencies turn hostile

Everything is pinned by a lockfile and GitHub Actions by commit hash. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) lists what ships. A hostile update of a package we depend on would still reach anyone who updated. Known advisories are in [SECURITY.md](../SECURITY.md).

## What can be learned about you

See [who learns what](privacy.md#who-learns-what) and [how much the public list sees](privacy.md#how-much-the-public-list-sees).
