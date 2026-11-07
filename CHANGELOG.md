# Changelog

Changes to the `ceasenet` program and to the public contract in [arkiv/schema.md](arkiv/schema.md). Records on Arkiv can't be changed, so anything that affects readers of old records is called out.

## Unreleased

- The site has a **Log out** button. It disconnects the site from your wallet, and the login record on Arkiv stays.
- A verifier with "Skip World ID" turned off no longer accepts an earlier `unverified-` login for a vote or a recall. The hosted verifier has it off.
- On Windows, `AGENT_TERMINALS="compact"` opens the three trading agents' windows small, in a column on the right of the screen.

## 0.1.0 (7 November 2026)

The first version, built at ETHGlobal Mumbai 2026. It runs on test networks.

**The program**

- `ceasenet protect` puts a gate in front of the MCP servers of Claude Code, Claude Desktop, Cursor, VS Code, Windsurf and Gemini CLI. Claude Code's own tools are covered too.
- Stop one agent, all your agents, or one tool, from the console or the terminal, and from another machine.
- An agent obeys only its owner's wallet. Anyone else opens a normal recall, others vote, and the owner decides.
- Three real AI trading agents, on live prices and paper money, show it working.
- Every call goes in a diary, stored on Swarm encrypted to the owner, or on 0G Storage, with its index on Arkiv.
- `ceasenet privacy private` keeps what your agents run off the public list.
- `ceasenet rpc <url>` reads and writes through an Arkiv node you choose. A gate treats a node more than 2 minutes behind as out of reach.
- The console and the public site carry the CeaseNet logo, the CN monogram, in their headers and tab icons.

**The contract**

- Conformance vectors in [arkiv/vectors/gate.json](arkiv/vectors/gate.json) state what any gate must decide.
- `ceasenet.recall` gained `opener` and `approves`, both optional, and `ceasenet.human` is new. Older records still read correctly.
- `ceasenet.diary` `storage` may hold `kept-by-owner`: the part stayed on the owner's machine, and only its hash and times are public.
- `ceasenet.trust` is no longer obeyed. An agent obeys only its owner, whatever list has been published.
