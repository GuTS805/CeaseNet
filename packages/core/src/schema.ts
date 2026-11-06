import { addr, bytes, defineSchema, key, str, u64 } from "@arkiv-network/sdk/schema"

/**
 * Every record CeaseNet keeps on Arkiv.
 *
 * Anyone can write an entity with any attributes, so a record's labels prove nothing. Readers always
 * check `$creator` against the key that is allowed to create that record.
 *
 * A `str` holds at most 128 bytes, so anything that can be longer is a `bytes` column holding UTF-8.
 */

const ns = (name: string) => `ceasenet.${name}`

/** A piece of software an agent can load: tool, skill, model or prompt. */
export const Artifact = defineSchema(ns("artifact"), {
  hash: str().indexed(),
  kind: str().indexed(),
  name: str().indexed(),
  version: str().indexed(),
  publisher: addr().indexed(),
  source: str().optional(),
  derivedFrom: str().optional(),
})

/** An agent's passport. Its owner creates it, which is what ties the agent to a responsible party. */
export const Agent = defineSchema(ns("agent"), {
  agent: addr().indexed(),
  owner: addr().indexed(),
  name: str().indexed(),
  framework: str(),
  purpose: bytes(),
})

/** Exactly what an agent loaded. One read-only record per change. Publishing it is the owner's choice. */
export const Loadout = defineSchema(ns("loadout"), {
  agent: addr().indexed(),
  seq: u64().indexed(),
  /** UTF-8 JSON array of {@link LoadedFile}. */
  files: bytes(),
  /** What the agent is made of, in one searchable value. Records from before this was added do not have one. */
  fingerprint: str().indexed().optional(),
})

/** One per agent, updated in place. Expired means "unknown". */
export const Heartbeat = defineSchema(ns("heartbeat"), {
  agent: addr().indexed(),
  mode: str().indexed(),
  loadoutSeq: u64(),
})

/** A warning (ADVISORY, created by the verifier) or an order to stop (STOP, created by an accountable key). */
export const Recall = defineSchema(ns("recall"), {
  artifact: str().indexed(),
  level: str().indexed(),
  severity: str().indexed(),
  reason: bytes(),
  contentHash: str().indexed(),
  /** Never a readable Swarm link: an encrypted reference carries its own key, and entities are public. */
  sealedEvidence: bytes().optional(),
  /** Steps owners should take, such as "change your email password". */
  advice: bytes().optional(),
  /** Package name, for recalls that cover a range of versions. */
  pkg: str().indexed().optional(),
  /** Version range, checked locally because queries cannot compare ranges. */
  versions: str().optional(),
})

/** One human's confirmation or dispute of a warning. Created and kept by the verifier. */
export const Endorse = defineSchema(ns("endorse"), {
  recall: key().indexed(),
  stance: str().indexed(),
  human: str().indexed(),
})

/** An agent's receipt: "I applied recall R, here is what I did". */
export const Ack = defineSchema(ns("ack"), {
  recall: key().indexed(),
  recallHash: str().indexed(),
  agent: addr().indexed(),
  artifact: str().indexed(),
  action: str().indexed(),
  issuer: addr().indexed(),
  newHash: str().optional(),
})

/** Ends a recall. Trusted only from the key that issued the STOP, or from a regulator. */
export const Lift = defineSchema(ns("lift"), {
  recall: key().indexed(),
  artifact: str().indexed(),
  kind: str().indexed(),
  fixedHash: str().optional(),
  fixedVersion: str().optional(),
  fixedRef: str().optional(),
  note: bytes().optional(),
})

/** Whose STOPs an owner's agents obey. Each change is a new read-only record with a higher number. */
export const TrustList = defineSchema(ns("trust"), {
  owner: addr().indexed(),
  seq: u64().indexed(),
  /** UTF-8 JSON of {@link TrustPolicy}. */
  policy: bytes(),
})

/** Index of a part of an agent's diary. The diary itself is too big for Arkiv, and lives on Swarm or 0G Storage. */
export const Diary = defineSchema(ns("diary"), {
  agent: addr().indexed(),
  root: str().indexed(),
  /** Hash at the end of the entries' chain, so a replaced part is caught. */
  head: str(),
  entries: u64(),
  firstSeq: u64().indexed(),
  lastSeq: u64().indexed(),
  /** How the part is kept. Without one it is a readable file on 0G Storage, as parts were before this was added. */
  storage: str().indexed().optional(),
  /**
   * When its first and last entries happened, in milliseconds since 1970. A part never spans two time windows (see
   * DIARY_WINDOW_MS), so anyone can ask Arkiv for what an agent did between two times. Older parts have neither.
   */
  firstAt: u64().indexed().optional(),
  lastAt: u64().indexed().optional(),
})

/** Public description of a problem, released at the disclosure deadline. */
export const Disclose = defineSchema(ns("disclose"), {
  recall: key().indexed(),
  description: bytes(),
  reproductionRef: str().optional(),
})
