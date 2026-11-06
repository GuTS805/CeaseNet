import { canonicalJson, hashBytes, type Hex } from "@ceasenet/core"

/**
 * What the diary keeps about one moment.
 *
 * The hashes are always there, so a copy of a call can be proved against the diary. Whether the call's contents are
 * there too is the owner's choice, because a diary is public and permanent: in the open, sealed so only the owner can
 * read them, or left out.
 */
export type DiaryData =
  | {
      kind: "CALL"
      tool: string
      version: string
      hash: string
      action: string
      argsHash: Hex
      verdict: string
      allowed: boolean
      approval?: string
      /** The model request that asked for this call. */
      requestId?: string
      model?: string
      /** Which of the agent's servers it went to. */
      server?: string
      resultHash?: Hex
      /** Why it was refused. */
      message?: string
      ms?: number
      /** The call's contents, in the open. */
      args?: unknown
      result?: unknown
      /** The call's contents, sealed to the owner's key. */
      sealed?: string
      /** The contents were too long to keep whole. The hashes are of the whole thing. */
      clipped?: boolean
    }
  | { kind: "NOTE"; note: string; text: string }
  | { kind: "STATUS"; from: string; to: string }
  | { kind: "RECEIPT"; recall: string; action: string }
  | { kind: "UPDATE"; from: string; to: string; fromHash: string; toHash: string }
  | { kind: "NETWORK"; up: boolean }

export type DiaryEntry = DiaryData & {
  seq: number
  at: number
  /** The hash of the entry before this one. Changing or dropping any entry breaks everything after it. */
  prev: Hex
}

export const DIARY_START: Hex = `0x${"0".repeat(64)}`

export const entryHash = (entry: DiaryEntry): Hex => hashBytes(canonicalJson(entry))

/** One part of the diary, ready to be stored. */
export interface DiaryPart {
  entries: DiaryEntry[]
  head: Hex
  firstSeq: number
  lastSeq: number
}

export const encodePart = (entries: readonly DiaryEntry[]): Uint8Array =>
  new TextEncoder().encode(entries.map((e) => canonicalJson(e)).join("\n"))

export const decodePart = (bytes: Uint8Array): DiaryEntry[] =>
  new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DiaryEntry)

export type DiaryCheck = { ok: true; head: Hex; entries: number } | { ok: false; problem: string; atSeq?: number }

/**
 * Checks a stored part against the head recorded on Arkiv.
 * Anyone can run this: it needs only the bytes from storage and the public index record.
 */
export function verifyPart(entries: readonly DiaryEntry[], expectedHead: string, expectedPrev?: string): DiaryCheck {
  if (entries.length === 0) return { ok: false, problem: "this part has no entries" }
  const first = entries[0]!
  if (expectedPrev !== undefined && first.prev !== expectedPrev) {
    return { ok: false, problem: "this part does not follow on from the one before it", atSeq: first.seq }
  }
  let head: Hex = first.prev
  let seq = first.seq
  for (const entry of entries) {
    if (entry.prev !== head) return { ok: false, problem: "an entry was changed or removed", atSeq: entry.seq }
    if (entry.seq !== seq) return { ok: false, problem: "an entry is missing or out of order", atSeq: entry.seq }
    head = entryHash(entry)
    seq += 1
  }
  if (head.toLowerCase() !== expectedHead.toLowerCase()) {
    return { ok: false, problem: "the entries do not end on the hash recorded on Arkiv" }
  }
  return { ok: true, head, entries: entries.length }
}

/** Where diary parts live. */
export interface DiaryStore {
  /** `storage` says how the part is kept, when a reader needs to know that to open it. */
  put(bytes: Uint8Array): Promise<{ root: string; storage?: string }>
  get(root: string): Promise<Uint8Array>
}

export interface DiaryIndex {
  diary(input: { root: string; head: string; entries: bigint; firstSeq: bigint; lastSeq: bigint }): Promise<unknown>
}

/**
 * An agent's diary: a chain of what it did and what the gate decided.
 *
 * The owner holds the file, so a chain alone would not stop them rewriting it. Each stored part is pinned by
 * a read-only record on Arkiv, which fixes the head hash and the time it was written.
 */
export class Diary {
  private pending: DiaryEntry[] = []
  private head: Hex
  private seq: number
  private flushing: Promise<void> | undefined
  /** Parts stored so far, oldest first. */
  readonly parts: { root: string; head: Hex; firstSeq: number; lastSeq: number; entries: number }[] = []
  lastError: string | undefined

  constructor(
    private readonly store: DiaryStore,
    private readonly index: DiaryIndex,
    private readonly now: () => number = Date.now,
    start: { head: Hex; seq: number } = { head: DIARY_START, seq: 0 },
  ) {
    this.head = start.head
    this.seq = start.seq
  }

  get size(): number {
    return this.seq
  }

  get waiting(): number {
    return this.pending.length
  }

  append(data: DiaryData): DiaryEntry {
    const entry = { ...data, seq: this.seq, at: this.now(), prev: this.head } as DiaryEntry
    this.head = entryHash(entry)
    this.seq += 1
    this.pending.push(entry)
    return entry
  }

  /** Stores what is waiting. On failure nothing is lost: the entries wait for the next try. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    if (this.pending.length === 0) return Promise.resolve()
    const run = this.write().finally(() => {
      this.flushing = undefined
    })
    this.flushing = run
    return run
  }

  private async write(): Promise<void> {
    // A copy: entries appended during the write must not join this part.
    const entries = [...this.pending]
    const last = entries[entries.length - 1]!
    const head = entryHash(last)
    try {
      const { root } = await this.store.put(encodePart(entries))
      await this.index.diary({
        root,
        head,
        entries: BigInt(entries.length),
        firstSeq: BigInt(entries[0]!.seq),
        lastSeq: BigInt(last.seq),
      })
      // Entries appended while this was being written stay waiting.
      this.pending = this.pending.slice(entries.length)
      this.parts.push({ root, head, firstSeq: entries[0]!.seq, lastSeq: last.seq, entries: entries.length })
      this.lastError = undefined
    } catch (e) {
      // Library errors can run to pages. The first clause says what went wrong.
      this.lastError = (e instanceof Error ? e.message : String(e)).split(/\n| \(/)[0]
    }
  }
}
