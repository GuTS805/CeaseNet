# Contributing to CeaseNet

Thanks for helping. CeaseNet decides whether an AI agent may act, so changes are judged first on whether they keep that decision correct and keep it in the owner's hands.

## Set up

You need Node 22.10 or newer.

```bash
git clone https://github.com/GuTS805/CeaseNet.git && cd CeaseNet
npm ci
git config core.hooksPath .githooks   # refuses a commit that contains a real secret from this machine
npm test
```

You need no wallet, no key and no account with us to work on the gate, the program or the site. `npm test` uses no network. To write to the public list, get free tGLM from the [faucet](https://hub.arkiv.network/faucet).

```bash
npm run web                  # the public site, on http://localhost:5173, reading the live list
npm run install-cli          # installs the ceasenet program from this copy
ceasenet init --local        # no wallet and nothing public, so you can try everything on this machine
```

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run test:vectors         # the Python gate, against the same rules
npm run build
npm run build -w @ceasenet/web
npm run check:secrets
```

CI runs these on every pull request. It also installs the packed program in an empty project and runs it, and rebuilds two generated files to check they are current:

| You changed | Then run | Because |
|---|---|---|
| Anything the verifier uses | `npm run build:verifier` | [api/verifier.mjs](api/verifier.mjs) is what the hosted site runs, and CI fails if it differs from the source |
| A dependency | `npm run notices` | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists every licence we ship. Merging a Dependabot update needs this too |
| What a gate decides | [arkiv/vectors/gate.json](arkiv/vectors/gate.json) and [examples/ceasenet_gate.py](examples/ceasenet_gate.py) | Both implementations are held to the vectors. A rule with no vector is a rule nobody else can follow |

**Do not edit anything under [tools/](tools).** A recall names a tool by the hash of its exact bytes, so a changed file, even its `package.json`, is a different tool.

## Where things live

| Path | What it holds |
|---|---|
| [packages/core/src/gate.ts](packages/core/src/gate.ts) | The rules: what a recall covers, whose STOP counts, what an agent may do. Pure, so each rule can be tested |
| [packages/core/src/reader.ts](packages/core/src/reader.ts), [writer.ts](packages/core/src/writer.ts), [schema.ts](packages/core/src/schema.ts) | Arkiv reads, writes and record definitions |
| [packages/guard/src](packages/guard/src) | The gate in front of an MCP server, the diary format and the Swarm client |
| [packages/cli/src](packages/cli/src) | The `ceasenet` program, the three trading agents and the console's backend |
| [apps/web](apps/web), [apps/console](apps/console) | The public site and the console's pages |
| [apps/verifier](apps/verifier) | Checks logins and signed requests, and writes logins, normal recalls and votes |
| [arkiv/schema.md](arkiv/schema.md), [arkiv/vectors](arkiv/vectors) | The public contract: what each record means, and what any gate must decide |
| [examples](examples) | Readers and a whole gate that use none of our code |

## Good first contributions

- **A gate in your language.** Follow [the rules](arkiv/schema.md#build-your-own-gate) and pass [the vectors](arkiv/vectors/gate.json). [The Python one](examples/ceasenet_gate.py) shows the way, and we will list yours.
- **Another MCP client.** `protect` finds the settings of six clients. Yours may be one small addition in [packages/cli/src/protect.ts](packages/cli/src/protect.ts).
- **A watcher.** Anything built only on [arkiv/schema.md](arkiv/schema.md), such as one that keeps copies of STOPs so a deleted one stays provable, is welcome in `examples/`.

## Rules that keep it trustworthy

1. **An agent obeys only its owner.** No change may let any other key, ours included, stop an agent or keep it from being stopped.
2. **Authorship comes from `$creator`.** The chain sets it and nobody can fake it. Any label in a record proves nothing, and a read that decides anything must filter on `$creator`.
3. **It fails closed.** If the gate cannot tell, the call does not go through. A list out of reach is never permission.
4. **Nothing of ours in the path.** A gate decides alone, on its own machine. Nothing may make a STOP depend on a server we run, and the site stays static.
5. **Published records keep their meaning.** Old records must still read correctly, because they are on a public chain and can't be changed. If a change breaks readers of [arkiv/schema.md](arkiv/schema.md), say so there.
6. **Nothing private by accident.** Records are public and hard to remove. A new field must not carry what a call sent, a key, or anything that identifies a person, and a tool must never see CeaseNet's settings. See [who learns what](docs/privacy.md#who-learns-what), and update it if this changes.
7. **Say what is true.** The README and the screens state only what has been seen working. If something is simulated or untested, it says so.

## Reporting bugs and security problems

Open an issue for a bug, with steps to reproduce. Please report a security or privacy problem privately, as [SECURITY.md](SECURITY.md) explains.

By contributing, you agree that your work is released under the [MIT Licence](LICENSE), and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
