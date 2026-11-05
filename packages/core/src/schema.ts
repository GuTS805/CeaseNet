import { addr, defineSchema, key, str, u64 } from "@arkiv-network/sdk/schema"

/**
 * Every record CeaseNet keeps on Arkiv.
 *
 * Anyone can write an entity with any attributes, so a record's labels prove nothing. Readers always
 * check `$creator` against the key that is allowed to create that record (see trust.ts).
 */

const ns = (name: string) => `ceasenet.${name}`

/** A piece of software: model, policy, firmware, planner prompt, tool or skill. */
export const Artifact = defineSchema(ns("artifact"), {
  hash: str().indexed(),
  kind: str().indexed(),
  name: str().indexed(),
  version: str().indexed(),
  publisher: addr().indexed(),
  source: str().optional(),
  derivedFrom: str().optional(),
})

/** A robot's passport. Trusted only if a known maker created it. */
export const Robot = defineSchema(ns("robot"), {
  robot: addr().indexed(),
  maker: addr().indexed(),
  model: str(),
  serial: str().indexed(),
  city: str(),
})

/** Exactly what a robot loaded. One read-only record per change. */
export const Loadout = defineSchema(ns("loadout"), {
  robot: addr().indexed(),
  seq: u64().indexed(),
  /** JSON array of {@link LoadedFile}. */
  files: str(),
})

/** One per robot, updated in place. Expired means "unknown". */
export const Heartbeat = defineSchema(ns("heartbeat"), {
  robot: addr().indexed(),
  mode: str().indexed(),
  loadoutSeq: u64(),
})

/** A warning (ADVISORY, created by the verifier) or an order to stop (STOP, created by an accountable key). */
export const Recall = defineSchema(ns("recall"), {
  artifact: str().indexed(),
  level: str().indexed(),
  severity: str().indexed(),
  reason: str(),
  contentHash: str().indexed(),
  /** Never a readable Swarm link: an encrypted reference carries its own key, and entities are public. */
  sealedEvidence: str().optional(),
  /** Steps owners should take, such as "change your email password". */
  advice: str().optional(),
  /** Package name for name-wide recalls of agent tools. */
  pkg: str().indexed().optional(),
  /** Version range for name-wide recalls, checked locally because queries cannot compare ranges. */
  versions: str().optional(),
})

/** One human's confirmation or dispute of an advisory. Created and kept by the verifier. */
export const Endorse = defineSchema(ns("endorse"), {
  recall: key().indexed(),
  stance: str().indexed(),
  human: str().indexed(),
})

/** A robot's receipt: "I applied recall R, here is what I did". */
export const Ack = defineSchema(ns("ack"), {
  recall: key().indexed(),
  recallHash: str().indexed(),
  robot: addr().indexed(),
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
  fixedRef: str().optional(),
  note: str().optional(),
})

/** Who is responsible for a robot today. Created by the maker, then owned by the operator. */
export const Custody = defineSchema(ns("custody"), {
  robot: addr().indexed(),
  operator: str(),
  contact: str(),
  insurance: str().optional(),
})

/** Index of a robot's decision log, which lives on 0G Storage. */
export const Episode = defineSchema(ns("episode"), {
  robot: addr().indexed(),
  softwareHash: str().indexed(),
  root: str().indexed(),
  decisions: u64(),
  firstRequestId: str(),
  lastRequestId: str(),
})

/** Public description of a problem, released at the disclosure deadline. */
export const Disclose = defineSchema(ns("disclose"), {
  recall: key().indexed(),
  description: str(),
  reproductionRef: str().optional(),
})

/** Passport of an ordinary AI agent. */
export const Agent = defineSchema(ns("agent"), {
  agent: addr().indexed(),
  owner: addr().indexed(),
  framework: str(),
  purpose: str(),
})

/** Whose STOPs an owner's agents obey. Each change is a new read-only record with a higher number. */
export const TrustList = defineSchema(ns("trust"), {
  owner: addr().indexed(),
  seq: u64().indexed(),
  /** JSON array of issuer addresses. */
  issuers: str(),
})
