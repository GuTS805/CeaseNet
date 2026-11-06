/** A public Swarm reference: 32 bytes, and anyone holding it can read the file. */
export const isPublicSwarmRef = (ref: string): boolean => /^[0-9a-fA-F]{64}$/.test(ref)

/**
 * An encrypted Swarm reference: 64 bytes, of which the second half is the key to the file.
 * Writing one into a public entity would hand everyone the key, so it must be sealed first.
 */
export const isEncryptedSwarmRef = (ref: string): boolean => /^[0-9a-fA-F]{128}$/.test(ref)

/**
 * How a diary part is kept when it is on Swarm: encrypted to its owner's key before it leaves the machine, then uploaded
 * as an ordinary public file. Its reference holds no key, so it can sit on Arkiv as it is, and whoever runs the Bee node
 * only ever handles the encrypted file.
 */
export const SEALED_ON_SWARM = "swarm-sealed"

/** Entities are public. This stops an encrypted reference, which carries its own key, from ever being written to one. */
export function assertPublicRef(ref: string | undefined): void {
  if (ref === undefined) return
  if (!isPublicSwarmRef(ref)) throw new Error("only a public Swarm reference can go in a public record")
}
