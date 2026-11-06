## What this changes

## Checklist

- [ ] `npm run typecheck`, `npm test`, `npm run test:vectors` and `npm run build` pass
- [ ] No key but an agent's owner can stop it, or keep it from being stopped
- [ ] If the gate cannot tell, the call does not go through
- [ ] If what a gate decides has changed, `arkiv/vectors/gate.json` and `examples/ceasenet_gate.py` say so too
- [ ] If readers of `arkiv/schema.md` are affected, it says so, and old records still read correctly
- [ ] No new field can carry what a call sent, a key, or anything that identifies a person
- [ ] Nothing under `tools/` was edited, because a tool's hash covers its exact bytes
- [ ] If the verifier changed, `npm run build:verifier` was run. If a dependency changed, `npm run notices` was
