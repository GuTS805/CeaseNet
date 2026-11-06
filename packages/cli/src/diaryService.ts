import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DIARY_WINDOW_MS, type DiaryRow, diaryWindowOf, hashBytes, type Hex, SEALED_ON_SWARM } from "@ceasenet/core"
import { decodePart, DIARY_START, type DiaryData, type DiaryEntry, type DiaryStore, encodePart, entryHash, openSealedBytes, openSealedRef, sealBytes, sealText, type SwarmClient, verifyPart, writeAtomic } from "@ceasenet/guard"
import { type JournalRecord, journalPath, readJournal } from "./journal"

/**
 * Turns what an agent did into a diary: parts chained together by hash, stored somewhere anyone can read, with an
 * index on the recall list that fixes each part's hash and when it was written. Changing or dropping anything afterwards
 * fails the check, and a whole missing part shows as a gap.
 */

/** public: anyone can read a call's contents. sealed: only the owner can. hashes: nobody can, but a copy can be proved. */
export type DiaryMode = "public" | "sealed" | "hashes"

export interface DiaryTarget {
  id: string
  name: string
  home: string
  address: Hex
  mode: DiaryMode
}

export interface PartInfo {
  root: string
  head: Hex
  firstSeq: number
  lastSeq: number
  entries: number
  at: number
  storage?: string
  /** When its first and last entries happened. */
  firstAt?: number
  lastAt?: number
}

interface DiaryState {
  /** How far through the journal has been stored. */
  offset: number
  head: Hex
  seq: number
  parts: PartInfo[]
  lastStoredAt?: number
  /** A part made and not yet recorded. It is kept so a failure partway does not pay for it twice or change its hash. */
  pending?: { head: Hex; firstSeq: number; lastSeq: number; entries: number; next: number; root?: string; storage?: string; firstAt?: number; lastAt?: number }
}

const MAX_RECORDS = 200

const emptyState = (): DiaryState => ({ offset: 0, head: DIARY_START, seq: 0, parts: [] })
const statePath = (home: string) => join(home, "diary-state.json")
const pendingPath = (home: string) => join(home, "diary-pending.part")

export function readDiaryState(home: string): DiaryState {
  try {
    return JSON.parse(readFileSync(statePath(home), "utf8")) as DiaryState
  } catch {
    return emptyState()
  }
}

const saveState = (home: string, state: DiaryState) => writeAtomic(statePath(home), JSON.stringify(state))

/** What a part holds about one record, depending on who may read it. */
export function dataFor(record: JournalRecord, mode: DiaryMode, ownerPublicKey?: Hex): DiaryData {
  if (record.type === "note") return { kind: "NOTE", note: record.note, text: record.text }
  const { type: _type, at: _at, args, result, ended: _ended, clipped, server, tool, version, hash, action, argsHash, resultHash, verdict, allowed, approval, message, ms } = record
  const shared: DiaryData = {
    kind: "CALL",
    server,
    tool,
    version,
    hash,
    action,
    argsHash,
    ...(resultHash ? { resultHash } : {}),
    verdict,
    allowed,
    ...(approval ? { approval } : {}),
    ...(message ? { message } : {}),
    ms,
    ...(clipped ? { clipped } : {}),
  }
  if (mode === "public") return { ...shared, args, ...(result === undefined ? {} : { result }) }
  // Without the owner's public key it cannot be sealed, and it must not fall back to being public.
  if (mode === "sealed" && ownerPublicKey) return { ...shared, sealed: sealText(JSON.stringify({ args, result }), ownerPublicKey) }
  return shared
}

/** Chains records onto what came before. */
export function buildEntries(records: readonly JournalRecord[], start: { head: Hex; seq: number }, mode: DiaryMode, ownerPublicKey?: Hex): { entries: DiaryEntry[]; head: Hex; seq: number } {
  let { head, seq } = start
  const entries: DiaryEntry[] = []
  for (const record of records) {
    const entry = { ...dataFor(record, mode, ownerPublicKey), seq, at: record.at, prev: head } as DiaryEntry
    head = entryHash(entry)
    seq += 1
    entries.push(entry)
  }
  return { entries, head, seq }
}

export type DiaryIndexWriter = (
  agent: Hex,
  part: { root: string; head: string; entries: bigint; firstSeq: bigint; lastSeq: bigint; storage?: string; firstAt?: number; lastAt?: number },
) => Promise<unknown>

/** Records belong in one part only if they fall in the same time window. */
const sameWindow = (first: JournalRecord, record: JournalRecord) => diaryWindowOf(first.at) === diaryWindowOf(record.at)

/**
 * Whether the oldest record not yet stored is in a window that has ended, so its part can be written whole. A part
 * already made and not yet recorded is always ready.
 */
export function windowEnded(home: string, now = Date.now(), windowMs = DIARY_WINDOW_MS): boolean {
  const state = readDiaryState(home)
  if (state.pending) return true
  const oldest = readJournal(home, state.offset, 1).records[0]
  return oldest !== undefined && now >= diaryWindowOf(oldest.at, windowMs) + windowMs
}

/** Stores what is waiting in one agent's journal. Returns whether anything was stored. */
export async function storeWaiting(target: DiaryTarget, store: DiaryStore, index: DiaryIndexWriter, ownerPublicKey?: Hex, now = Date.now()): Promise<boolean> {
  const { home } = target
  const state = readDiaryState(home)
  let bytes: Uint8Array

  if (state.pending && existsSync(pendingPath(home))) {
    bytes = readFileSync(pendingPath(home))
  } else {
    // One part never crosses into the next time window, so the times on its index say which window it covers.
    const { records, next } = readJournal(home, state.offset, MAX_RECORDS, sameWindow)
    if (records.length === 0) return false
    const built = buildEntries(records, { head: state.head, seq: state.seq }, target.mode, ownerPublicKey)
    bytes = encodePart(built.entries)
    mkdirSync(home, { recursive: true })
    writeFileSync(pendingPath(home), bytes)
    const times = records.map((r) => r.at)
    state.pending = { head: built.head, firstSeq: state.seq, lastSeq: built.seq - 1, entries: built.entries.length, next, firstAt: Math.min(...times), lastAt: Math.max(...times) }
    saveState(home, state)
  }

  const pending = state.pending!
  if (!pending.root) {
    const stored = await store.put(bytes)
    pending.root = stored.root
    pending.storage = stored.storage
    saveState(home, state)
  }
  const times = pending.firstAt !== undefined && pending.lastAt !== undefined ? { firstAt: pending.firstAt, lastAt: pending.lastAt } : {}
  await index(target.address, { root: pending.root, head: pending.head, entries: BigInt(pending.entries), firstSeq: BigInt(pending.firstSeq), lastSeq: BigInt(pending.lastSeq), ...(pending.storage ? { storage: pending.storage } : {}), ...times })

  state.parts.push({ root: pending.root, head: pending.head, firstSeq: pending.firstSeq, lastSeq: pending.lastSeq, entries: pending.entries, at: now, ...(pending.storage ? { storage: pending.storage } : {}), ...times })
  state.offset = pending.next
  state.head = pending.head
  state.seq = pending.lastSeq + 1
  state.lastStoredAt = now
  state.pending = undefined
  saveState(home, state)
  rmSync(pendingPath(home), { force: true })
  return true
}

/** Whether there is anything not yet stored. */
export function hasWaiting(home: string): boolean {
  const state = readDiaryState(home)
  return Boolean(state.pending) || readJournal(home, state.offset, 1).records.length > 0
}

/** How much is waiting to be stored, without reading more of the file than it takes to count. */
export function waitingCount(home: string): number {
  const state = readDiaryState(home)
  if (!existsSync(journalPath(home))) return state.pending?.entries ?? 0
  let offset = state.pending ? state.pending.next : state.offset
  let count = state.pending?.entries ?? 0
  for (;;) {
    const { records, next } = readJournal(home, offset, 500)
    count += records.length
    if (records.length === 0 || next === offset) return count
    offset = next
  }
}

// ---- Keeping parts on this machine, while recalls are ----

/** Keeps parts in files, for an agent whose records are not public. Named by their hash, as a storage network would. */
export function localDiaryStore(dir: string): DiaryStore {
  return {
    put: async (bytes) => {
      mkdirSync(dir, { recursive: true })
      const root = hashBytes(bytes)
      writeFileSync(join(dir, root), bytes)
      return { root }
    },
    get: async (root) => {
      if (!/^0x[0-9a-f]{64}$/i.test(root)) throw new Error("that is not a diary part")
      return readFileSync(join(dir, root))
    },
  }
}

// ---- Keeping parts on Swarm, encrypted ----

/**
 * Keeps parts on Swarm, encrypted to the owner before they leave this machine. The index on Arkiv is public, and shows
 * only that a part exists, where it is, how many entries it holds and when. Only the owner's key can read what is in it.
 */
export function sealedSwarmStore(swarm: SwarmClient, ownerPublicKey: Hex): DiaryStore {
  return {
    put: async (bytes) => ({
      root: await swarm.upload(`diary-${hashBytes(bytes).slice(2, 14)}.sealed`, sealBytes(bytes, ownerPublicKey)),
      storage: SEALED_ON_SWARM,
    }),
    get: (root) => swarm.read(root),
  }
}

// ---- Reading a diary back ----

export interface DiaryPartView {
  root: string
  head: string
  firstSeq: number
  lastSeq: number
  entries: number
  /** The block its index was recorded at. */
  block: string
  indexKey: string
  storage?: string
  /** When its first and last entries happened, as its index on the list says. */
  firstAt?: number
  lastAt?: number
  /** It is encrypted, and this machine does not hold the key that opens it. Nothing can be said about its contents. */
  locked?: boolean
  /** Whether what storage returned ends on the hash the index recorded. */
  check: { ok: boolean; problem?: string }
  /** Whether it follows on from the part before it, so nothing between them is missing. */
  followsOn?: boolean
  items: DiaryItem[]
}

export type DiaryItem = DiaryEntry & {
  /** Sealed contents, opened because this machine holds the owner's key. */
  opened?: { args: unknown; result?: unknown }
}

/** Reads the newest parts of a diary, and checks each against what the index recorded. */
export async function readBack(index: readonly DiaryRow[], get: (root: string, row: DiaryRow) => Promise<Uint8Array>, ownerKey?: Hex, limit = 8): Promise<DiaryPartView[]> {
  const newest = [...index].sort((a, b) => Number(b.lastSeq - a.lastSeq)).slice(0, limit)
  const views: DiaryPartView[] = []
  for (const row of newest) {
    const base = {
      root: row.root,
      head: row.head,
      firstSeq: Number(row.firstSeq),
      lastSeq: Number(row.lastSeq),
      entries: Number(row.entries),
      block: String(row.createdAt),
      indexKey: row.key,
      ...(row.storage ? { storage: row.storage } : {}),
      ...(row.firstAt !== undefined && row.lastAt !== undefined ? { firstAt: row.firstAt, lastAt: row.lastAt } : {}),
    }
    const sealed = row.storage === SEALED_ON_SWARM
    if (sealed && !ownerKey) {
      views.push({ ...base, locked: true, check: { ok: true }, items: [] })
      continue
    }
    let entries: DiaryEntry[]
    try {
      const stored = await get(row.root, row)
      entries = decodePart(sealed ? openSealedBytes(stored, ownerKey!) : stored)
    } catch (e) {
      views.push({ ...base, check: { ok: false, problem: `Could not read it: ${(e as Error).message.split("\n")[0]}` }, items: [] })
      continue
    }
    const check = verifyPart(entries, row.head)
    views.push({
      ...base,
      check: check.ok ? { ok: true } : { ok: false, problem: check.problem },
      items: entries.map((entry) => openItem(entry, ownerKey)),
    })
  }
  // A part follows on if it starts on the hash the one before it ended on, and at the next number.
  for (let i = 0; i < views.length - 1; i++) {
    const later = views[i]!
    const earlier = views[i + 1]!
    later.followsOn = later.firstSeq === earlier.lastSeq + 1 && (later.locked || later.items[0]?.prev === earlier.head)
  }
  return views
}

function openItem(entry: DiaryEntry, ownerKey?: Hex): DiaryItem {
  if (entry.kind !== "CALL" || !entry.sealed || !ownerKey) return entry
  try {
    return { ...entry, opened: JSON.parse(openSealedRef(entry.sealed, ownerKey)) as { args: unknown; result?: unknown } }
  } catch {
    return entry
  }
}
