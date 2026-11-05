import { randomBytes } from "node:crypto"
import {
  ADDRESSES,
  arkivPublicClient,
  arkivWalletClient,
  ArkivWriter,
  readRobots,
} from "@ceasenet/core"
import { loadSoftware } from "../apps/fleet/src/software"
import { writeRun } from "../apps/fleet/src/store"
import { accountFor, type Role } from "./roles"

// Starts a fresh demo run: registers any robot not registered yet and publishes this run's software.
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const model = process.env.ZG_MODEL || "glm-5.2"
const client = arkivPublicClient(accessKey)
const writer = (role: Role) => new ArkivWriter(arkivWalletClient(accountFor(role), accessKey))

const maker = writer("maker")
const publisher = writer("publisher")

const salt = randomBytes(4).toString("hex")

const robots = [
  { role: "robot1" as const, serial: "ACME-X1-0001", city: "Mumbai", operator: "Bandra Logistics" },
  { role: "robot2" as const, serial: "ACME-X1-0002", city: "Mumbai", operator: "Bandra Logistics" },
  { role: "robot3" as const, serial: "ACME-X1-0003", city: "Pune", operator: "Deccan Warehousing" },
]

const existing = new Set((await readRobots(client, [ADDRESSES.maker])).map((r) => r.robot.toLowerCase()))
for (const r of robots) {
  const address = ADDRESSES[r.role]
  if (existing.has(address.toLowerCase())) {
    console.log(r.role, "already registered")
    continue
  }
  await maker.robot({ robot: address, model: "Acme Arm X1", serial: r.serial, city: r.city })
  const custody = await maker.custody({ robot: address, operator: r.operator, contact: "ops@example.com" })
  await maker.transfer(custody.entityKey, r.role === "robot3" ? ADDRESSES.operatorB : ADDRESSES.operatorA)
  console.log(r.role, "registered")
}

for (const version of ["1.5.2", "1.5.3"] as const) {
  const software = loadSoftware(version, salt, model)
  for (const f of software.files) {
    if (version === "1.5.3" && f.kind !== "policy") continue
    await publisher.artifact({ hash: f.hash, kind: f.kind, name: f.name, version: f.version })
  }
  console.log("published software", version, software.policyHash)
}

writeRun({ salt, createdAt: new Date().toISOString() })
console.log("demo run", salt)
