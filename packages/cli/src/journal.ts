import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs"
import { join } from "node:path"
import { canonicalJson, hashBytes, type Hex } from "@ceasenet/core"
import type { FinishedCall } from "@ceasenet/guard"
import { homeDir } from "./home"

/**
 * Everything an agent does, as it happens, in a plain file on its own machine.
 *
 * A guard writes here and never needs a network or a key to do it, so nothing is lost if the storage network is out of
 * reach or the wallet is empty. The diary service later turns this into parts and stores them.
 */
export interface JournalCall {
  type: "call"
  at: number
  server: string
  tool: string
  version: string
  hash: string
  action: string
  verdict: string
  allowed: boolean
  approval?: string
  message?: string
  ms: number
  argsHash: Hex
  resultHash?: Hex
  args: unknown
  result?: unknown
  ended?: boolean
  clipped?: boolean
}

export interface JournalNote {
  type: "note"
  at: number
  note: string
  text: string
}

export type JournalRecord = JournalCall | JournalNote

const FILE = "diary-journal.jsonl"
/** Longer than this and only the start is kept. The hashes always cover the whole thing. */
export const KEEP_CHARS = 8_000
const READ_LIMIT_BYTES = 1024 * 1024

export const journalPath = (home = homeDir()): string => join(home, FILE)

function append(record: JournalRecord, home: string): void {
  mkdirSync(home, { recursive: true })
  appendFileSync(journalPath(home), `${JSON.stringify(record)}\n`)
}

export const hashOf = (value: unknown): Hex => hashBytes(canonicalJson(value ?? null))

/** Keeps something whole if it is short enough, and says so if it did not. */
export function keep(value: unknown): { kept: unknown; clipped: boolean } {
  const text = JSON.stringify(value ?? null)
  return text.length <= KEEP_CHARS ? { kept: value, clipped: false } : { kept: `${text.slice(0, KEEP_CHARS)}…`, clipped: true }
}

export function recordFinishedCall(call: FinishedCall, tool: { server: string; name: string; version: string; hash: string }, home = homeDir(), at = Date.now()): void {
  const args = keep(call.args)
  const result = call.result === undefined ? undefined : keep(call.result)
  append(
    {
      type: "call",
      at,
      server: tool.server,
      tool: tool.name,
      version: tool.version,
      hash: tool.hash,
      action: call.action,
      verdict: call.decision.verdict,
      allowed: call.decision.allowed,
      ...(call.decision.approval ? { approval: call.decision.approval } : {}),
      ...(call.decision.allowed ? {} : { message: call.decision.message }),
      ms: call.ms,
      argsHash: hashOf(call.args),
      ...(call.result === undefined ? {} : { resultHash: hashOf(call.result) }),
      args: args.kept,
      ...(result ? { result: result.kept } : {}),
      ...(call.ended ? { ended: true } : {}),
      ...(args.clipped || result?.clipped ? { clipped: true } : {}),
    },
    home,
  )
}

export const recordNote = (note: string, text: string, home = homeDir(), at = Date.now()): void => append({ type: "note", at, note, text }, home)

/**
 * Complete records from this point in the file, and where to carry on from. A line still being written waits.
 * With belongsWith, it stops at the first record that does not belong with the first one read, and leaves it for next time.
 */
export function readJournal(
  home: string,
  offset: number,
  maxRecords: number,
  belongsWith?: (first: JournalRecord, record: JournalRecord) => boolean,
): { records: JournalRecord[]; next: number } {
  const path = journalPath(home)
  if (!existsSync(path)) return { records: [], next: offset }
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    if (size <= offset) return { records: [], next: offset }
    const length = Math.min(size - offset, READ_LIMIT_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, offset)
    const records: JournalRecord[] = []
    let next = offset
    let start = 0
    for (let i = 0; i < length && records.length < maxRecords; i++) {
      if (buffer[i] !== 0x0a) continue
      try {
        const record = JSON.parse(buffer.subarray(start, i).toString("utf8")) as JournalRecord
        if (belongsWith && records.length > 0 && !belongsWith(records[0]!, record)) break
        records.push(record)
      } catch {
        // A damaged line says nothing it can be trusted for, and the rest of the file is still good.
      }
      start = i + 1
      next = offset + start
    }
    return { records, next }
  } finally {
    closeSync(fd)
  }
}
