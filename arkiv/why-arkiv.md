# Why Arkiv

## What users would lose on another database

A recall list has one job: to reach agents even when someone would prefer that it didn't. The maker of a bad tool has reasons to play a problem down. A registry has reasons to protect a big publisher. So the list can't live with any one of them.

Suppose CeaseNet ran on Postgres, with the same code on top. Here is what each user loses:

| Who | With Arkiv | With Postgres |
|---|---|---|
| A company running agents | Its gate reads the records directly. Nobody can show it a different list from the one everyone else sees | It reads whatever the operator's API returns, and the operator can hide a recall from one customer |
| A company running agents | The issuer of a record is `$creator`, set by the chain, so its gate needs no account or permission from us | Trust in an issuer becomes trust in our `created_by` column |
| A tool maker | A STOP takes effect with no approval from us. If we disappear or refuse, it still works | We can block or delay it, and a government or large customer can make us |
| The public | Anyone can read every recall and receipt with no account, including what they obeyed and when | They read what we choose to publish, and an `UPDATE` leaves no trace |
| A security researcher | A STOP can't be edited after the fact, and anyone can keep it from lapsing | A row can be rewritten, or left to expire, without anyone knowing |
| Anyone checking a maker's honesty | If a maker deletes its STOP, receipts from other companies' agents still prove it existed. Nobody can remove them | The operator can delete the STOP and the receipts together |

## What this looks like in the demo

The website can go down and agents keep obeying, because no server of ours sits between Arkiv and the gate. A fake STOP from an outsider changes nothing, because its `$creator` is wrong. When the maker deletes its own STOP, agents keep refusing the tool, and the page shows the proof.

## What we kept off Arkiv, and why

| Data | Where it lives | Why not Arkiv |
|---|---|---|
| The agent's full diary | 0G Storage. Arkiv holds only each part's root and head hash, so a changed part fails the check | Too large to keep on a shared database, and most readers never need it |
| Fixed tool files | Swarm. Arkiv holds the public reference and the hash | Files are big, and the hash makes the host irrelevant |
| Evidence | Swarm, encrypted. Arkiv holds a sealed copy of the reference | An encrypted Swarm reference contains its own key, and entities are public |
| What an agent sent to a tool | Only a hash, in the diary | It can hold private customer content |
| Which tools an agent runs, when its owner doesn't publish a loadout | Stays on the owner's machine. The gate downloads all recalls and matches locally | Asking "is my tool recalled?" would tell the RPC what you run |
| World ID nullifiers | Never written. `human` is a hash of the nullifier and the warning | A public nullifier would link one person's answers across warnings |
| Gate memory | A local file on the agent's machine | It exists to protect against Arkiv records vanishing |
| API keys and signing keys | The backend's environment | They are secrets |
