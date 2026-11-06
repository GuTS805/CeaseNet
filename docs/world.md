# World ID in CeaseNet

CeaseNet uses World ID in two places, for two different trust moments.

## IDKit: one person, one answer on a warning

**Status: working.** A real proof from World's simulator was accepted by World's real verify API, and the confirmation appeared on Arkiv and on the page.

### The trust event

A warning about a tool can move every agent using it to "a human must approve each call". That threshold is 3 people. If one person could count three times, anyone could slow down a competitor's tool. So the question at this moment is exactly: **is this a different real human from the others who answered this warning?**

### Why Proof of Human is the minimum that works

| Credential | Decision | Why |
|---|---|---|
| **Proof of Human** | **Chosen** | It answers the question, and nothing more. We don't learn who the person is |
| Selfie Check | Not enough | World describes it as having greater duplicate-account risk than Orb. With a threshold of only 3, a few duplicates would be enough to cross it |
| Passport / NFC | Too much | It would prove facts about a document, and nothing about a tool warning needs a name or nationality. Asking for it would also stop people from speaking up, which is the opposite of what a warning system needs |

The harm is capped too: confirmations can only make agents ask a human. Only keys an owner chose can STOP a tool.

### How it works

1. The browser shows the warning, and the person picks confirm or dispute. The signal is `recall:stance`, so a proof can't be replayed on another warning or flipped to the other answer.
2. The verifier signs the request on the server. The signing key never reaches the browser.
3. The server checks, in this order: stance, single-use nonce, environment, action, credential, signal hash, that the warning exists, then World's verify API, then that this person hasn't already answered this warning, and only then writes to Arkiv. Code: [apps/verifier/src/verifier.ts](../apps/verifier/src/verifier.ts).
4. Arkiv stores `human = hash(nullifier, recall)`, never the nullifier, so one person's answers can't be linked across warnings.

### The other paths

| Path | What happens | Tested |
|---|---|---|
| Person cancels | "Cancelled. Nothing was counted." | In Chrome, against the real widget |
| Same person answers the same warning twice | Refused, and nothing is written | In Chrome, against the real verify API |
| Proof made for another warning | Refused | Unit test |
| World says no, or can't be reached | Nothing is counted | Unit test |

### Debrief

- **Time to first success:** about 40 minutes of build, from an empty verifier to an accepted proof.
- **Friction:**
  - The docs say the action is defined in code, while the skill file says to create it in the portal.
  - The portal's Verification wizard looks like required setup. It is only for the ecosystem listing, and we lost time on it.
  - The simulator's banner says it will change, which makes it hard to know what to rely on.
- **Missing docs or capabilities:** the plain simulator link is one fixed identity, even across browsers. `/id/<value>` selects another identity, but a new one has no credentials, and we found no way to add them. A team demonstrating "3 different people" can't do it in the simulator. Our demo uses one real proof and labels the other two as simulated.
- **Top improvement:** a documented way to give simulator identities a credential, so uniqueness can be tested and demonstrated.

## Reports: anyone can raise a problem

**Status: built, and tested against a stand-in for World's verify API.** It uses the same action, credential and server checks as the confirmations above, which have been accepted by World itself. Run the real path with `npm run verifier` and the simulator on the site's Report page.

A person with no connection to an agent can report it. The trust event is the same one: is this a different real human? Filing uses the same action as voting, so World gives one person the same nullifier for both, and filing counts as their vote. Voting on their own report is refused as a second answer. The signal is the hash of what is reported and why, so a proof cannot be replayed to file something else.

Votes never stop anything by themselves. At enough votes the owner is told, and decides.

World's simulator can only ever be one identity, so `npm run verifier:test` adds simulated people, for showing the whole flow. Each one is marked `simulated-` on the public record and shown as simulated on every page, and the verifier refuses them in production.

## Agent Pass: a real person approves a paused call

**Status: built, and tested against a local stand-in for World's service. Not yet run against World, because we couldn't register a client.** See the debrief below. Without credentials, the demo shows stand-in buttons labelled as such.

### The moment it matters

A tool has reached 3 confirmed warnings. An agent wants to send an email with it. The model can't approve its own call, and an owner clicking a button on a page proves nothing about who clicked. So the call pauses until a real person approves it from their World ID app, and our backend has checked the signed result.

### The journey

1. **Request.** The agent's call stops at the gate. The page shows the exact tool, version and action, and "Approve with World ID". The backend starts the Device Authorization Grant, because an agent has no browser to redirect. It asks for an essential `acr` of Orb class.
2. **Completion.** The person opens the link, enters the code, and approves in the World ID app. The device code stays on the backend, and the page only ever sees the user code and link.
3. **Validated result.** The backend polls, following World's rules for each response, then validates the ID token: RS256 signature against the discovered JWKS, issuer, audience, expiry, an `acr` of exactly Orb class, `amr` present, and `auth_time` inside this attempt. The first validated person is linked to the company as `(iss, sub)`, and only they can approve from then on. Code: [packages/guard/src/agentPass.ts](../packages/guard/src/agentPass.ts), [apps/demo/src/approvals.ts](../apps/demo/src/approvals.ts).
4. **Protected action.** The gate reads the list once more, since the answer may have taken a while, and only then does the tool run.

The same flow works in the proxy for real agents, printing the link and code to stderr.

### When the answer is not yes

| Path | Protected action |
|---|---|
| Person refuses in the app (`access_denied`) | Does not run |
| Attempt expires, or the time for this call runs out | Does not run |
| A STOP arrives during the wait | Attempt cancelled, does not run. A late approval changes nothing |
| A different person from the one linked | Does not run |
| Token with a bad signature, wrong issuer or audience, lower class, or an old `auth_time` | Does not run |
| World answers 429 or 503, or can't be reached | Does not run, and is never read as approval |
| Pressing the plain approve route while World ID is connected | Refused by the server |

Unit tests cover each row, using real RS256 tokens from a local server. A browser run covers approve, refuse, a different person and a STOP mid-wait through the real page and server.

To run it against World once credentials exist: set `WORLD_IDP_CLIENT_ID` and `WORLD_IDP_CLIENT_SECRET`, then run `npm run agent-pass-check`.

### Why Orb class, and why fresh

This person is letting a tool that real people have warned about touch customer data. Orb class gives high assurance that this is one real person, and device authentication is always fresh on this grant. A passkey on an Orb-verified account also satisfies this class. That is acceptable here: `(iss, sub)` still has to match the linked approver, and the page shows the exact action they are approving.

### Debrief

- **Time to first success:** not reached against World. Building our side from the docs took under an hour. The blocker was registration.
- **Friction:**
  - `auth.world.org/portal` answers a personal Google account with a bare JSON page: `{"error":"invalid_login"}`. Nothing says why or what to do. The public features endpoint shows `portalAllowGoogleDomains: false`, and the page mentions an enterprise Google account.
  - The docs say to check eligibility, but the error we got is not the documented `account_not_eligible`.
  - Dynamic client registration isn't supported, and metadata-document clients can't use `openid`, so without the portal there is no way to get a client for a real test.
- **Missing docs or capabilities:**
  - The prize page calls this "Agent Pass", while the docs call it World IdP, OIDC and human checkpoints. It took reading several guides to confirm they are the same thing.
  - The device grant shows no action text (`binding_message` is unsupported), so the approval screen can't tell the person what they are approving. Our page has to do that, on a different screen from the approval.
- **Top improvement:** let any hackathon team register a sandbox client with a personal Google account, or publish a shared sandbox client. We could have built and tested everything else in an afternoon.
