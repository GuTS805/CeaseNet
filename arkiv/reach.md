# Reach

## Who it is for

- **Companies running AI agents with third-party tools.** MCP servers and skills run with an agent's access to email, files and customer data. When one turns bad, these companies need it to stop running, not just to disappear from a marketplace.
- **Tool makers and registries.** Today a maker can publish a fixed version or pull a package. Neither reaches copies that are already installed. CeaseNet gives them a way to reach those copies, with a public record that it worked.
- **Security researchers and councils.** They can raise a warning that real people confirm, and hold evidence sealed until disclosure.

## The problem is real

- **postmark-mcp, September 2025.** Version 1.0.16 of an email tool for AI agents quietly copied every email to an attacker. It was removed from npm, but installed copies kept running, and users had to be told to remove it themselves. ([The Hacker News](https://thehackernews.com/2025/09/first-malicious-mcp-server-found.html), [The Register](https://www.theregister.com/2025/09/29/postmark_mcp_server_code_hijacked/))
- **ClawHub, early 2026.** OpenClaw's skill marketplace was flooded with malicious skills: 341 in the first audit, at least 1,184 by a later count. ([Antiy](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/), [Unit 42](https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/))

Our demo's made-up `demo-mail-tool 1.0.16` copies that first attack, inside a sandbox folder. Nothing is really sent.

## Can they try it today?

**Yes, without changing their agent or their tool.** From a clone of this repository, the guard wraps any MCP server that runs over stdio. Point your MCP client at this command in place of the tool's own:

```bash
npx tsx packages/guard/src/proxy.ts --package ./path/to/some-tool --owner 0xYourOwnerAddress -- node ./path/to/some-tool/server.js
```

Without an agent key it only reads the list, so it publishes nothing about what you run. `npm run proxy-check` runs a standard MCP client through it on the live chain: the client was refused 0.5 seconds after the STOP appeared on Arkiv.

The public pages need no account or wallet. The Arkiv query in the [README](../README.md#for-arkiv-judges) needs no key.

## Honest limits

- **We have no users yet.** This was built at ETHGlobal Mumbai and has run only on Arkiv's testnet.
- **Nobody is issuing real recalls yet.** A list only protects people when makers and registries publish to it, and that is the hardest part to get going.
- **The list only binds agents that run the gate.** It can't stop an agent that doesn't check.
- **A demo keeps its timers short.** The checks are every 2 seconds in the demo and every 30 seconds in the production settings.

## After Mumbai

The first useful step needs only one party. A security researcher or registry can publish STOPs for tools that are already known to be malicious, using public reports like the two above. Any company that follows that key is then protected from day one, with no cooperation from the makers.

After that:

1. Publish `ceasenet-guard` as an npm package, so wrapping a tool takes one line in an MCP config.
2. Add a backfill of known-bad tools from public advisories.
3. Move to Arkiv mainnet when it is available, and to a real postage batch for fixes and evidence.
