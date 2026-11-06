import { useEffect, useRef, useState } from "react"
import { arkivPublicClient, ARKIV_EXPLORER, type FleetView, type Mode, type PlateColour, readFleetView } from "@ceasenet/core"

declare const __ARKIV_ACCESS_KEY__: string
declare const __FLEET_URL__: string
declare const __VERIFIER_URL__: string

export const client = arkivPublicClient(__ARKIV_ACCESS_KEY__)
export const FLEET_URL = __FLEET_URL__
export const VERIFIER_URL = __VERIFIER_URL__

export const shortHash = (h: string) => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h)

export const explorerAddress = (a: string) => `${ARKIV_EXPLORER}/address/${a}`
export const explorerEntity = (k: string) => `${ARKIV_EXPLORER}/entity/${k}`

export const statusColour = (status: Mode | "PAUSED" | undefined): PlateColour =>
  status === "RUNNING" ? "green" : status === "STOPPED" ? "red" : status ? "amber" : "grey"

export const statusLabel = (status: Mode | "PAUSED" | undefined): string =>
  status === "RUNNING"
    ? "Running"
    : status === "SUPERVISED"
      ? "Slow mode"
      : status === "STOPPED"
        ? "Stopped"
        : status === "PAUSED"
          ? "Paused safely"
          : "Unknown"

/** Polls while the page is open and keeps the last good result if a read fails. */
export function usePoll<T>(read: () => Promise<T>, everyMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const next = await latest.current()
        if (live) {
          setData(next)
          setError(undefined)
        }
      } catch (e) {
        if (live) setError((e as Error).message.split("\n")[0])
      }
      if (live) timer = setTimeout(tick, everyMs)
    }
    void tick()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [everyMs, ...deps])
  return { data, error }
}

export const useFleetView = (everyMs = 2500) => usePoll<FleetView>(() => readFleetView(client), everyMs)

export async function fleetGet<T>(path: string): Promise<T> {
  const res = await fetch(FLEET_URL + path)
  if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
  return (await res.json()) as T
}

export async function fleetPost<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(FLEET_URL + path, { method: "POST", body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error((json as { error: string }).error)
  return json as T
}

export interface FleetRobot {
  id: number
  address: `0x${string}`
  status: Mode | "PAUSED"
  online: boolean
  plannerUp: boolean
  version: string
  decisions: number
  lastDecision?: { requestId: string; model: string; source: string; move: { box: number; slot: number } }
  lastError?: string
}

export interface FleetState {
  salt: string
  plannerSource: "0g" | "dev"
  model: string
  recalledHash: string
  fixedHash: string
  robots: FleetRobot[]
}

export interface LiveFrame {
  robots: { id: number; tick: number; status: Mode | "PAUSED"; online: boolean; q: number[] }[]
}
