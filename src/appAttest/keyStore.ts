/** KV-backed store of attested device public keys, shared by attest + assert. */

export type AppAttestKv = Pick<KVNamespace, 'get' | 'put' | 'delete'>

export interface DeviceKeyRecord {
  /** Base64url SPKI of the device's attested P-256 public key. */
  spki: string
  /** Highest assertion sign-count seen; each assertion must exceed it. */
  signCount: number
  /** The identity (Keychain UUID) this device key is pinned to (ADR 0007). */
  uuid: string
  environment: 'development' | 'production'
  attestedAt: number
}

const keyStoreKey = (keyId: string) => `key:${keyId}`

/**
 * Reverse index pinning an identity (`uuid`) to the ONE `keyId` that first
 * attested it — the security boundary behind `verifyAttestation` (ADR 0007).
 * First-writer-wins: once written it is never rebound automatically, so an
 * attacker can't attest their own key to a victim's uuid. See `getUuidOwner` /
 * `putUuidOwner`.
 */
const uuidOwnerKey = (uuid: string) => `uuidOwner:${uuid}`

export const getKeyRecord = async (
  kv: AppAttestKv,
  keyId: string
): Promise<DeviceKeyRecord | null> => {
  const raw = await kv.get(keyStoreKey(keyId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as DeviceKeyRecord
  } catch {
    return null
  }
}

export const putKeyRecord = (
  kv: AppAttestKv,
  keyId: string,
  record: DeviceKeyRecord
): Promise<void> => kv.put(keyStoreKey(keyId), JSON.stringify(record))

/** The keyId that owns `uuid`, or null if the identity is still unclaimed. */
export const getUuidOwner = (
  kv: AppAttestKv,
  uuid: string
): Promise<string | null> => kv.get(uuidOwnerKey(uuid))

/**
 * Pin `uuid` to `keyId` (first-writer-wins). Caller must only invoke this when
 * the identity is unclaimed OR already owned by this same `keyId`; it never
 * checks — the ownership decision lives in `verifyAttestation`. To manually
 * release a binding (e.g. a legitimate Secure-Enclave key rotation), an operator
 * deletes both `uuidOwner:<uuid>` and `key:<oldKeyId>` from KV.
 */
export const putUuidOwner = (
  kv: AppAttestKv,
  uuid: string,
  keyId: string
): Promise<void> => kv.put(uuidOwnerKey(uuid), keyId)
