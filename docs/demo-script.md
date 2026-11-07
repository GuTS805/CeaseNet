# Demo script

One video, **2:55**, for every prize. The Ethereum Foundation's prize needs 3 minutes or less, and ETHGlobal needs 2 to 4.

Rules: your own voice (no AI voice or text-to-speech), no speed-up, at least 720p, recorded from a screen (not a phone), and at most 4 bullets on any slide. Cutting between takes is fine, so cut the waits.

| Part | Time | What it does |
|---|---|---|
| Hook | 0:00 to 0:25 | The title, the problem and the answer, in one breath |
| How it works | 0:25 to 0:55 | The flowchart |
| Demo | 0:55 to 2:25 | Everything live: agents, Arkiv, Swarm, World, a recall that is ignored and one that is obeyed |
| Close | 2:25 to 2:55 | Why nobody, us included, sits in the middle |

## Before recording

1. **Slides:** [docs/video/01-title.png](video/01-title.png) and [docs/video/02-how-it-works.png](video/02-how-it-works.png), open full screen.
2. **Agents:** in your own terminal, `ceasenet agents start`. With `AGENT_TERMINALS="compact"` in `~/.ceasenet/.env`, three small windows open in a column on the right. Wait until each says it started a job. They run for 20 minutes, so start them just before recording.
3. **Console:** `ceasenet console`, at `http://127.0.0.1:7787`. Check the Agents page shows all three working, and nothing recalled.
4. **Browser:** snap Chrome to the left of the agent windows (`Win + ←`, then drag its right edge to them). Open these tabs:
   - `https://ceasenet.vercel.app/#/network`
   - `https://ceasenet.vercel.app/#/agent/0xF40a2b4d23007085E6C6AD5dfe1EcD2d0DE3acE6` (Momentum trader)
   - `https://ceasenet.vercel.app/#/login`
   - `https://ceasenet.vercel.app/#/recalls`
   - the console
5. **Wallet:** MetaMask on Account 2 (`0xA80f…3bE4`), which is not the agents' owner and has tGLM. World App open on your phone.
6. **Bee:** Nook running, for the last shot.

## The script

| Time | Show | Say |
|---|---|---|
| **0:00** | Slide 1, the title | "In September 2025, an email tool for AI agents on npm started quietly copying every email to an attacker. It was pulled from npm, but every agent that already had it kept running it. Nothing could tell them to stop. This is CeaseNet: recalls for AI agents. An owner signs one STOP, and every one of their agents obeys it, everywhere, in seconds." |
| **0:25** | Slide 2, the flowchart. Point at each box as you name it | "One command puts a gate between your agents and their tools. Before every call, the gate reads a recall list on Arkiv by itself, and obeys only a STOP signed by its owner's wallet. Not a crowd, not a registry, not us. If it can't read the list, it fails closed. Every call is logged to Swarm, sealed to the owner. And anyone can raise a recall, one real person at a time, with World ID." |
| **0:55** | The three agent windows on the right, then the Network tab | "These are three real AI agents, each its own process, trading live prices with paper money through real MCP tools." |
| **1:05** | Network page: the owner, 3 agents, live heartbeats | "Our site reads Arkiv straight from the browser, with no server of ours: three agents, one owner, live heartbeats." |
| **1:15** | Momentum trader's page: fingerprint, then scroll to the diary, "Encrypted on Swarm" | "Each agent's exact tools and model have a public fingerprint, and its diary sits on Swarm, encrypted to its owner, indexed on Arkiv." **Note this time for [arkiv/swarm.md](../arkiv/swarm.md).** |
| **1:27** | Login tab: **Log out**, then **Log in with World**, sign in MetaMask, scan with World App, "Logged in" | "Now I'm someone else. I log in with World: my wallet signs, and World ID proves I'm one real person, without saying who." Cut the wait for the scan. |
| **1:42** | Back on Momentum trader's page: **Open a recall on this agent**, a reason, sign. "Your recall is open", 1 of 3 votes. Then the agent windows, still trading | "I'm not its owner, so I open a recall. It needs three people, and then the owner decides. Until then, nothing happens. A crowd can't switch off someone else's agent." |
| **1:57** | Console, Agents page: **Recall** on the broker tool. Watch the two trader windows close themselves, and the risk watcher keep working. Point at "closed … after you pressed Stop" and "Its receipt is on the list" | "Now I'm the owner. I recall the broker tool. The STOP goes on Arkiv, and both traders close themselves. The risk watcher doesn't use that tool, so it keeps working." Cut the 5 seconds while the transaction confirms. |
| **2:15** | Recalls tab: the new STOP, "Binds … agents of its owner", and its receipts | "And each agent posted a public receipt proving it obeyed." |
| **2:25** | Close the site's tab. Open the Swarm copy through Nook: `http://localhost:1633/bzz/f9d69d548e95aa768add58b3bfdd94a9a7b68558ca309fe7aeb1aa462c7fd9ab/#/recalls` | "None of this needed us. Each gate read Arkiv itself, so if our site, our server and this repository disappeared, an owner's STOP would still land. The site lives on Swarm too." |
| **2:40** | The README's CROPS section, or the npm page | "It's MIT licensed, on npm with provenance, and a second gate in Python, sharing none of our code, passes the same 56 test cases. CeaseNet. Recalls for AI agents." |
| **2:55** | Slide 1 | End |

## After recording

1. In the console, **Lift this recall** on a trader card, so the agents can run again.
2. Optional: on the recall you opened as the stranger, withdraw it, or leave it as a record.
3. Put the video's link in [docs/submission.md](submission.md), and the Swarm timestamp in [arkiv/swarm.md](../arkiv/swarm.md).

## If something goes wrong

- **An agent window says a recall covers it and won't start.** Something is still recalled. Lift it in the console and start them again.
- **A trader stops on its own with "model limit".** The free model's daily allowance ran out. Choose another model at the top of the console's Agents page.
- **World App can't finish.** Retry once. If it still fails, cut the login, and say the wallet is already logged in with World: its record is on Arkiv.
- **Nothing happens after Recall.** Check you're online. If an agent shows "asks a human", it lost Arkiv and is failing closed, which is also worth showing.
- **Don't run `ceasenet kill --all`.** It also stops this machine's own agent, including Claude Code's tools. Use **Stop all three** in the console.

## Likely questions

| Question | Answer |
|---|---|
| Why not just remove it from npm? | That was done. It doesn't reach what's already installed and running. |
| Why a chain? Why not a shared database? | Whoever runs the database can hide a recall from one customer, or delete it. Here nobody can, including us, and a gate reads it with no server of ours in between. |
| Can't the owner delete the STOP? | Yes, Arkiv allows it. A gate keeps obeying a STOP it has seen, and its receipt proves the STOP existed. |
| What stops someone from stopping a competitor's agent? | An agent obeys only its owner's wallet, which the chain records and nobody can fake. Anyone else can only open a recall, which needs 3 real people and then the owner's approval. |
| What if the owner's key is stolen? | The thief can stop your agents, not run code on your machine. Keep the owner's key in a wallet on another machine, with `ceasenet init --owner`. |
| What if an agent just doesn't run the gate? | Then this doesn't bind it, and the public board shows it as silent, not obeying. We protect agents that aren't already compromised. |
| What if Arkiv is down? | Five minutes of work, then a person approves each call for five more, then it refuses. A node more than 2 minutes behind counts as down. |
| What isn't real here? | The money is paper, it runs on test networks, and the three trading tools are our own samples. The model, the prices, the MCP calls, Arkiv, Swarm and World ID are real. |
| What did AI do? | Answer honestly from [docs/ai-usage.md](ai-usage.md). Each of us should be able to explain our part. |
