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
