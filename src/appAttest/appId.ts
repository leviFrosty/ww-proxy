import { sha256Bytes } from '../crypto'

const encoder = new TextEncoder()

/** The App Attest "relying party" id: `<TeamID>.<BundleID>`. */
export const appAttestAppId = (teamId: string, bundleId: string): string =>
  `${teamId}.${bundleId}`

/** SHA-256 of the app id — the value authenticatorData's first 32 bytes must equal. */
export const appIdRpHash = async (
  teamId: string,
  bundleId: string
): Promise<Uint8Array> =>
  sha256Bytes(encoder.encode(appAttestAppId(teamId, bundleId)))

/** Byte-wise equality. */
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
