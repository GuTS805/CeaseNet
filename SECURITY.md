# Security policy

CeaseNet decides whether an AI agent may act, and it stands between that agent and its tools. A way past it, or a way to misuse it, is a security problem. So is a way to learn something private from it.

## Reporting

Please report privately through a [GitHub security advisory](https://github.com/GuTS805/CeaseNet/security/advisories/new). Do not open a public issue. Say what you found, how to reproduce it, and what an attacker could do or learn. Never include a real key.

We aim to answer within a week. Once a fix is out, the advisory is published with credit to you, unless you prefer otherwise.

## In scope

- **Getting past the gate:** a call reaching a tool that a STOP covers, or a tool that was never measured.
- **Stopping someone else's agent:** any key but its owner's making it stop, or a crowd doing so without the owner's approval.
- **Blocking an owner's STOP:** anything that keeps a valid STOP from reaching their agent without the gate failing closed.
- **Faking the record:** a receipt, a vote or a diary that passes its check but is not real, or a login that was not one person's.
- **Keys and secrets:** a tool seeing CeaseNet's settings, or a key or access key reaching a record, a log or the site.
- **Privacy:** a private agent's tools reaching the public list, or anything else that [who learns what](README.md#who-learns-what) says stays private.
- **The console:** a web page you visit being able to press Stop or approve a call.

## Out of scope

- What the README lists under [what this does not do](README.md#what-this-does-not-do), such as a tool that has already taken over your machine.
- Arkiv itself or its rate limits. Please report those to the Arkiv team.
- "Skip World ID" allowing several wallets per person on the hackathon site. It is on purpose, labelled, and listed as a tradeoff.
- Test tokens, which have no value.

[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) sets out what we defend against, how, and what we don't.

## What runs automatically

On every push: type checks, all tests, the conformance vectors in a second language, CodeQL, and `npm audit` at critical level. GitHub Actions are pinned to commit hashes, so a moved tag can't change what runs. CI rebuilds the verifier and fails if the hosted file differs from the source. Dependabot proposes updates, and `npm run check:secrets` compares this machine's real secrets with every tracked file, as a commit hook if you set it up, and with `-- --history` over the whole past.

## Known advisories

`npm audit` reports these, all reached only through the 0G Storage SDK, and none in the site or the verifier:

| Package | Comes from | Why it stands |
|---|---|---|
| `axios` 0.27.2 (high) | `@0gfoundation/0g-storage-ts-sdk`, through `open-jsonrpc-provider` | The SDK has no fixed release. It is loaded only when a diary part goes to 0G. Set up Swarm and that never happens |
| `ws` 8.17.1 (high) | `ethers` 6.13.1, which the 0G SDK requires | Only for WebSocket connections, which we don't open. We talk to 0G over HTTP |

CeaseNet runs on test networks. Do not use it to protect anything you can't afford to lose yet.
