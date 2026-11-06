import { mnemonicToAccount } from "viem/accounts"

/** Every wallet used by the demo, derived from one secret phrase kept in .env. */
export const ROLES = [
  "treasury",
  "maker",
  "regulator",
  "publisher",
  "verifier",
  "lab",
  "robot1",
  "robot2",
  "robot3",
  "officeAgent",
  "operatorA",
  "operatorB",
  "outsider",
  // Live checks only. New wallets go at the end, so existing ones keep their addresses.
  "testMaker",
  "testVerifier",
  "testRobot",
  "testOutsider",
] as const

export type Role = (typeof ROLES)[number]

export function accountFor(role: Role, mnemonic = process.env.DEMO_MNEMONIC) {
  if (!mnemonic) throw new Error("DEMO_MNEMONIC is missing. Run: npm run keys")
  return mnemonicToAccount(mnemonic, { addressIndex: ROLES.indexOf(role) })
}
