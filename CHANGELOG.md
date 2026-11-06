# Changelog

Changes to the `ceasenet` program and to the public contract in [arkiv/schema.md](arkiv/schema.md). Records on Arkiv can't be changed, so anything that affects readers of old records is called out.

## 0.1.0 (unreleased)

The first version, built at ETHGlobal Mumbai 2026. It runs on test networks.

**The program**

- `ceasenet protect` puts a gate in front of the MCP servers of Claude Code, Claude Desktop, Cursor, VS Code, Windsurf and Gemini CLI. Claude Code's own tools are covered too.
- Stop one agent, all your agents, or one tool, from the console or the terminal, and from another machine.
- An agent obeys only its owner's wallet. Anyone else opens a normal recall, others vote, and the owner decides.
- Three real AI trading agents, on live prices and paper money, show it working.
- Every call goes in a diary, stored on Swarm encrypted to the owner, or on 0G Storage, with its index on Arkiv.
- `ceasenet privacy private` keeps what your agents run off the public list.
- `ceasenet rpc <url>` reads and writes through an Arkiv node you choose. A gate treats a node more than 2 minutes behind as out of reach.

**The contract**

- Conformance vectors in [arkiv/vectors/gate.json](arkiv/vectors/gate.json) state what any gate must decide.
- `ceasenet.recall` gained `opener` and `approves`, both optional, and `ceasenet.human` is new. Older records still read correctly.
- `ceasenet.diary` `storage` may hold `kept-by-owner`: the part stayed on the owner's machine, and only its hash and times are public.
- `ceasenet.trust` is no longer obeyed. An agent obeys only its owner, whatever list has been published.
