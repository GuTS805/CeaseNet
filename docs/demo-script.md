# Demo script

Target: **2:45**. The Ethereum Foundation's prize needs 3 minutes or less, and ETHGlobal needs 2 to 4.

Rules for the video: your own voice (no AI voice or text-to-speech), no speed-up, at least 720p, recorded from a screen (not a phone), and at most 4 bullets on any slide. Cutting between takes is fine.

## Before recording

```bash
npm run reset && npm run seed
npm run demo        # the real model. Check the page does NOT say "built-in rules"
npm run web:demo
npm run verifier
```

`npm run fresh` does the first two lines in one go, and also stops a demo that is already running. If PowerShell says running scripts is disabled, type `npm.cmd` instead of `npm`.

Open `http://localhost:5173` and press F11, so the screen fills the recording. Sound starts after your first click: use the **sound on** button if it competes with your voice. Wait until each company has sent a few emails, and check that the stranger's inbox is filling up. Say out loud that the timers are shortened: the page checks every 2 seconds, where production settings use 30.

## The script

| Time | Do this | Say this |
|---|---|---|
| 0:00 | Title slide, or the Live page | "In September 2025, an email tool for AI agents started copying every email to an attacker. It was pulled from npm. Every agent that already had it kept running it. Nothing tells a running agent to stop." |
| 0:20 | Live page, pointing at the agents, the red lines and the stranger's inbox | "These are three companies' agents, using a real model and real MCP tools. This mail tool is made up and nothing is really sent, but it does what the real one did. Each red line carries a copy to a stranger, and this inbox is what that tool really wrote. Watch the counter." |
| 0:35 | Press **File a warning** | "A researcher notices first. They have no power to stop anything. But real people can confirm the warning." |
| 0:42 | Press **Confirm with World ID** and complete it in the simulator. Then press **Add a simulated person** twice | "World ID proves each one is a different human, without saying who. That one was a real proof. The next two are simulated, and labelled so, because World's simulator is one person." |
| 1:05 | Mail tool flips to **Needs a human**. Point at the amber card beside the agent, and approve or refuse | "At three, every call to this tool waits for a person. The model can't approve itself." |
| 1:15 | Press **STOP**. Say nothing for a moment and let the timer run | "Now the maker issues a STOP. It goes on Arkiv. No server of ours is in between." |
| 1:22 | Point at the timer, the CEASED stamps, the files tool still **Allowed**, and the receipts landing in the blocks at the bottom | "Blocked, in seconds. We shortened the timers for this demo: it checks every 2 seconds, and production settings use 30. Only that tool stops. The rest of the agent keeps working. And each agent posts a public receipt." When the model's words appear beside an agent, read them out: they are its own reply. That takes 15 to 35 seconds, so cut to it if you need to. |
| 1:32 | Press **Fake STOP from an outsider**. It lands in the blocks at the bottom, and no line moves | "Anyone can write to Arkiv, so here's a fake STOP from a competitor. Nothing happens, because the chain records who created it, and nobody follows that key." |
| 1:42 | In a terminal, run `npm run query` | "This website could vanish. Here's the same record from a terminal, with no key and no server of ours. Each agent reads Arkiv the same way. There's no company in the middle, including us." |
| 1:52 | Press **Publish fix**. Open the recall in a second tab, then press **Download from Swarm and check** | "The fix is on Swarm, so it survives the maker's site going away. Agents check its hash before running it, and so can you, right here in the browser." **Note this timestamp for `arkiv/swarm.md`.** |
| 2:12 | On the Live tab, press **Maker deletes its STOP**. The STOP breaks up on screen, and each receipt arrives marked **Still proven** | "This is the moment the design is for. The maker changes its mind and deletes the STOP. Arkiv lets an owner do that. But agents remember, and they keep refusing. And their receipts prove the STOP existed. You can't erase this quietly." |
| 2:35 | Show the proxy command from the README | "And it works today, with no code change: one command in front of any MCP server." |
| 2:42 | Live page | "CeaseNet. Recalls for AI agents." |

If Agent Pass is connected, approve at 1:05 with **Approve with World ID**, and refuse one too. World's prize needs the full journey and a path where the action does not happen.

## If something goes wrong

- **The site says "built-in rules".** You started `demo:dev`. Use `npm run demo`.
- **The model is slow.** It takes a few seconds per step. Wait, or cut.
- **The World simulator link isn't there.** Check that `npm run verifier` is running.
- **Nothing moves after STOP.** Check you're online. If an agent shows "Asks a human", it lost Arkiv and is failing closed, which is worth showing.

## For the finalist round: 4 minutes, then 3 minutes of questions

**Show it isn't only a demo.** Open **Network**: every agent and line on it is read from Arkiv, with no list of keys. Then **Log in with World**, open a recall on an agent, and show its votes. With the owner's wallet, approve it at 3 votes, or stop it directly as the owner, and show an MCP client refused by `ceasenet`. Practise this first with a wallet that has tGLM.

Add this with the extra time: press **Cut off** on one company before the STOP. It keeps working for the grace period, then asks a human, then refuses. The public board shows it as silent, not disobeying.

| Likely question | Answer |
|---|---|
| Why not just remove it from npm? | That was done. It doesn't reach what's already installed. |
| Why a chain? Why not a shared database? | Whoever runs the database can hide a recall from one customer or delete it. Here nobody can, including us. |
| Can't the maker delete the STOP? | Yes, and we show it. Agents keep obeying, and receipts prove it. That is a limit of Arkiv we designed around. We've asked for an undeletable flag in our feedback. |
| What stops someone from STOPping a competitor's tool? | Agents obey only keys their owner chose, on a public list. A stranger's STOP is never read. |
| What if the issuer's key is stolen? | The attacker can stop your tool but can't run code on your machine. Remove that key from your list. |
| What if an agent just doesn't check? | Then this doesn't bind it. The board reports it as silent. We protect agents that aren't already compromised. |
| What if Arkiv is down? | Grace period, then a human for each call, then refuse. |
| Who issues recalls on day one? | A researcher or registry can publish STOPs for tools already known to be bad, with no help from makers. |
| How is this different from Gravitee or Lasso? | Those are per-company gateways. This is a shared public list with public receipts. |
| What did you actually build, and what did AI do? | Answer honestly from `docs/ai-usage.md`. Each person should be able to explain their part. |
| What isn't real here? | The tools are made up, the timers are short, it's on testnet, two of the three people are simulated. |

## For the EF CROPS prize: under 3 minutes, on censorship resistance

The lead property is censorship resistance: nobody but an agent's owner can stop it, and nobody, us included, can keep the owner from stopping it. The moment it matters is when CeaseNet itself is out of the picture and the owner's STOP still lands.

Before recording: the three trading agents on the public list (`ceasenet network arkiv`, with the owner funded), their terminals open, a browser wallet that is not the owner's (for the outsider), and Nook running.

| Time | Show | Say |
|---|---|---|
| 0:00 | The three trading agents trading in their terminals | "Three AI agents, trading with real models through MCP tools. Each one's gate reads Arkiv itself." |
| 0:20 | The site, signed in with a wallet that is not the owner's. **Stop it as the owner**, choose "a tool", paste the market tool's hash from a terminal, sign | "I'm not their owner. Here is a STOP on the tool they all use, signed and on Arkiv." |
| 0:50 | The terminals: still trading. The STOP's page: "No agent owned by this key is covered" | "Nothing happens. An agent obeys only a STOP its owner signed. No crowd, registry or company can switch it off." |
| 1:15 | Close the site. Show Vercel's domain blocked, or just no browser | "Now take us away: no website, no verifier, no server of ours." |
| 1:30 | In a terminal: `ceasenet kill --all --reason "Owner stopped them"` | "The owner signs one STOP, straight to Arkiv, from their own machine." |
| 1:45 | The three terminals close themselves, each with the reason and how long it took | "Every agent read it itself and stopped. Nothing of ours was in the path." |
| 2:15 | Open the copy of the site on Swarm through Nook: `http://localhost:1633/bzz/e0554a8e179b71d76e8102b1889af262fe15e0b699ee207830c4ce2ca654dd4b/#/recalls`. Open the STOP: receipts from all three | "Even the site survives losing its domain: this copy lives on Swarm and reads Arkiv directly. And the receipts prove each agent obeyed." |
| 2:45 | The README's CROPS section | "MIT, builds with no keys, no trackers, every record signed in your own wallet. The tradeoffs are written down in the README." |

To restart them afterwards: `ceasenet lift <key>`, with the key `kill` printed.
