# Swarm and Arkiv

> **Status: not yet run on the Swarm network.** The code is complete and tested against a local stand-in written from Bee's published OpenAPI, including the full story on live Arkiv. The items marked **TO FILL** need a real postage batch. Run `npm run swarm-check`, and it prints most of them.

## What lives where

| Data | Swarm | Arkiv |
|---|---|---|
| What each agent did: its jobs, tool calls, what the gate decided and what the model said | One encrypted file per part of its diary, sealed to the owner's key before it leaves the machine | `ceasenet.diary`: `root`, the public reference, plus `head`, `entries`, `firstSeq`, `lastSeq` and `storage` set to `swarm-sealed` |
| A fixed tool | The whole package, as one public file | `ceasenet.lift`: `fixedHash`, `fixedVersion`, and `fixedRef`, the public reference |
| Evidence behind a recall | The file, encrypted by Bee (`swarm-encrypt: true`) | `ceasenet.recall.sealedEvidence`: the reference, sealed to the security council's key |
| Evidence after disclosure | The same file, public | `ceasenet.disclose.reproductionRef`: the public reference |

## The problems this solves

**What an agent did can hold anything, and it has to outlive the agent.** So each part is encrypted to the agent's owner on the machine that made it, then stored on Swarm. Because we encrypt it ourselves, the reference holds no key and can go on Arkiv as it is, and whoever runs the Bee node only ever handles the encrypted file. Anyone can see on Arkiv that a part exists, how many entries it holds and when it was written. Only the owner's key can read it, and the console then checks it against the hash on Arkiv.

**A fix has to reach agents even if the maker's site or registry account is gone.** That is a likely state of affairs for a tool that has just been recalled. So the fix lives on Swarm, the reference lives on Arkiv, and anyone can serve the file, because agents check its hash before it reaches their disk. Anyone can also check it in a browser, on the recall page, with no server of ours: "Download from Swarm and check".

**Evidence has to reach the right people before the public.** Publishing how an attack works while people are still exposed helps attackers. So evidence goes on Swarm encrypted, and only the security council can read it until disclosure.

## Keeping encrypted references out of public records

An encrypted Swarm reference is 64 bytes, and its second half is the key to the file. Entities are public, so one must never be stored as it is. We enforce this in code:

- `ArkivWriter.lift` and `ArkivWriter.disclose` throw on anything except a 32-byte public reference ([swarmRef.ts](../packages/core/src/swarmRef.ts)).
- `sealedEvidence` holds the output of `sealRef`: ECDH on secp256k1 with a fresh key, HKDF-SHA256, then AES-256-GCM, to the recipient's public key ([swarm.ts](../packages/guard/src/swarm.ts)).
- At disclosure the file is uploaded again without encryption, so the public reference gives away no key.

## Entity field and example

- Entity fields holding a reference: `ceasenet.diary.root`, and `ceasenet.lift.fixedRef` in the scripted demo
- Example entity key: **TO FILL** (the `ceasenet.diary` that `npm run swarm-check` prints)
- Its Swarm reference: **TO FILL**
- Postage batch ID: **TO FILL**
- Batch buyer: **TO FILL**
- Bee node or service: **TO FILL**
- Demo video timestamp showing Swarm: **TO FILL**

## Upload and read code

- Upload and read through Bee's HTTP API: `SwarmClient` in [packages/guard/src/swarm.ts](../packages/guard/src/swarm.ts)
- Fetch a fix and check its hash before writing to disk: `fetchPackage`, same file
- Encrypt a diary part and store it: `sealedSwarmStore` in [packages/cli/src/diaryService.ts](../packages/cli/src/diaryService.ts), using `sealBytes` and `openSealedBytes` in swarm.ts
- What the demo uploads: [apps/demo/src/swarmFiles.ts](../apps/demo/src/swarmFiles.ts)
- Check a fix in the browser: `FixOnSwarm` in [apps/web/src/RecallPages.tsx](../apps/web/src/RecallPages.tsx)

The upload is a plain `POST /bzz?name=…` with the `swarm-postage-batch-id` header, plus `swarm-encrypt: true` for evidence. The read is `GET /bzz/{reference}`.

## Steps to reproduce

1. Set `BEE_API_URL` and `SWARM_POSTAGE_BATCH_ID` in `.env`.
2. Run `npm run swarm-check`. It stores a fix and sealed evidence, reads both back, and checks the hash and the seal.
3. Run `npm run reset`, `npm run seed`, `npm run demo`, and `npm run web:demo`.
4. Press **STOP**, then **Publish fix**. Agents report "downloaded from Swarm, hash checked".
5. Open the recall and press **Download from Swarm and check**.
6. Press **Open sealed evidence as the council**, then **Disclose publicly**.

To rehearse with no postage, `npm run local-bee` starts a stand-in on this machine. It is not Swarm, and it says so.

## Pain points

- **Getting a batch was the main blocker for us.** Buying one needs a funded node. A hackathon team has to find a booth or fund a wallet before writing a single byte.
- **We built before we could test for real.** Without a batch our tests follow Bee's OpenAPI, not a running node.
- **The encrypted-reference rule is easy to break by accident.** A 64-byte reference fits in a 128-byte Arkiv `str` column, and nothing warns you. We added our own check.
