# Feedback on Arkiv

Built on `@arkiv-network/sdk` 1.0.1 against the Rabdi testnet, 6 November 2026.

To reproduce items 1, 3, 4, 5, 6 and 7 on the live testnet, run `npm run friction` ([scripts/friction.ts](../scripts/friction.ts)). Its output is labelled by item number, and the output below is copied from real runs. The checks behind our design are in `npm run smoke` ([scripts/smoke.ts](../scripts/smoke.ts)).

## Problems, most important first

### 1. A read-only entity can still be deleted, and there is no way to prevent it

**Why it matters to us:** a safety recall should be something its issuer cannot erase. A maker under pressure can issue a STOP, then delete it.

```
[item 1: the owner editing a read-only entity]
  refused: Transaction failed: entity 0x6e277255…babc28 was created readonly, so its contents can never change.
           Its expiry can still be extended, and it can be transferred or deleted
[item 1: the owner deleting that same read-only entity]
  allowed: gone
```

The error message states this clearly, so it is not a bug. But "read-only" reads as "permanent", and we designed around that assumption until our first live test.

**Ask:** a creation flag such as `undeletable`, which still lets the record expire. Failing that, a tombstone that keeps the key, creator, content hash and deletion block.

**What we did instead:** gates remember every STOP they have seen and keep obeying after it vanishes. Agents' receipts carry the recall's content hash and issuer, so a deleted STOP stays provable.

### 2. No reads at a past block

The query builder has no way to ask "what did this look like at block N?". Combined with item 1, once a record is deleted, nobody who did not already read it can prove it existed. Our proof depends entirely on someone having written a receipt while it was alive.

**Ask:** a query option for reading at a recent past block, even with a short retention window.

### 3. A batch's estimated gas can be too low, and the fee is lost

One patch plus one extension in a single batch fails with the client's own estimate. Sending the same batch again, as the error advises, can work and can fail again:

```
[item 3: one patch and one extension in a batch, with the gas the client estimates]
  refused: Transaction 0x3ab76d52…bd9 ran out of gas: it used all 62323 gas it was given, so nothing was applied
           and the fee was spent. The batch cost more when it ran than when it was estimated, because the state
           changed in between. Send it again.
[item 3: the same batch sent again, as the error advises]
  allowed
[item 3: and a third time]
  refused: Transaction 0x2cac18c8…300 ran out of gas: it used all 42547 gas it was given […]
```

Nothing else was writing to this entity between those sends, so "the state changed in between" does not fully explain it. Each failure costs a fee. An agent's heartbeat is exactly this batch, and for a STOP a failed first send means lost seconds.

**Ask:** have the SDK add a margin to its estimate for batches, or estimate each operation against the state the earlier ones leave.

**What we did instead:** an explicit `gas: 500_000n` on that batch, and one automatic resend after an out-of-gas error ([writer.ts](../packages/core/src/writer.ts)).

### 4. The default client polls too slowly for a 2-second chain

Time to confirm one write, measured three times each:

```
[item 4: confirming a write on a chain with 2 second blocks]
  default polling: 6148, 5758, 5953 ms
  polling every 500 ms: 3141, 4652, 3806 ms
```

For a recall, those seconds are emails leaking. `pollingInterval` is a standard viem option, but it takes a stopwatch to notice it matters.

**Ask:** set a shorter default in the `rabdi` chain config.

### 5. Batch deletes fail completely if one record is already gone

Records here expire on their own, so this happens during normal cleanup:

```
[item 5: deleting two entities in a batch when one is already gone]
  refused: Transaction failed: no entity 0x8eb9d1eb…fe0393 — it may have been deleted, or have expired
[item 5: was the one that still existed deleted?]
  allowed: no, the whole batch failed
```

**Ask:** an option to skip entities that no longer exist.

**What we did instead:** on failure, [scripts/reset.ts](../scripts/reset.ts) retries one record at a time.

### 6. `$createdAt` cannot be filtered

```
[item 6: filtering on $createdAt, which every row has]
  refused: "$createdAt" is returned in query results but carries no index, so it cannot be filtered on.
           Select it as `createdAt` and filter the results in JavaScript instead.
```

"Confirmations from the last 72 hours" and "recalls since my last check" are natural queries for us. Instead, a gate reads every recall from the keys it follows on each check. That read grows with the list.

**Ask:** an index on creation block, or a documented pattern for "new since block N".

### 7. Two writes at once from one key sometimes fail

```
[item 7: two writes at once from one key]
  run 1: rejected, fulfilled
  run 2: fulfilled, fulfilled
  run 3: rejected, fulfilled
```

The intermittent failure is the hard part: it passed in testing and could have failed during a STOP.

**Ask:** a built-in queue per account in the wallet client, or a clear warning in the docs.

**What we did instead:** every write from one key goes through a queue ([writer.ts](../packages/core/src/writer.ts)).

### 8. Schema names are not owned by anyone

Anyone can write an entity tagged `ceasenet.recall`. A newcomer who queries by schema alone would believe a fake STOP. Our demo includes one on purpose, and `$creator` filters it out. This is the right design for an open database, but `.from(Schema)` looks like it gives a guarantee that it does not.

**Ask:** a line in the `defineSchema` docs saying this, with `createdBy` in the first example.

### 9. A short page is not the end of the results

Entities that do not fit a schema are skipped, but still count towards the limit. `entities.length < limit` therefore does not mean the last page, and anyone can write misfit entities into your schema. The `QueryResult.skipped` doc comment explains this well, but it is easy to miss and easy to get wrong.

**Ask:** a `hasMore` field, or an async iterator that pages correctly.

### 10. Is the access key a secret?

It is called a key and issued from an account page, but the SDK puts it in the RPC URL, and any web app reading the chain has to ship it. We concluded it is not a secret and exposed it to the browser. We would like the docs to say so.

**Ask:** one sentence in the docs, and separate read-only keys if abuse is the concern.

## What worked well

- **Error messages.** The best we have met in any SDK at this event. Each one says what happened and what to do:
  ```
  Invalid str value "xxxx...": 129 UTF-8 bytes exceeds the 128-byte limit on a str. Store the long form in a bytes column and keep a short, query…
  A query needs at least one filter — the language has no spelling for 'match every entity'. Add a where(...) predicate, or narrow by ownedBy(...) / createdBy(...).
  Invalid expiry: a lifetime of 17280000 blocks is longer than the chain's maximum lifetime of 7884000 blocks (about 182 days). Use ExpirationTime.max() for the longest lifetime allowed.
  ```
- **`permissionlessExtension`.** Anyone can keep a STOP alive, while only the owner controls everything else. This single flag is the reason a recall cannot quietly lapse.
- **`$creator` that survives everything.** It is the foundation of our trust model.
- **Typed schemas.** `where` on an unindexed column is a compile error.
- **Cost.** About 0.00057 tGLM for a recall record, measured, cheap enough for receipts and heartbeats.
- **Extend-only updates `$updatedAt`.** This makes heartbeats cheap, because refreshing one needs no patch.
