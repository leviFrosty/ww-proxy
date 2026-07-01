import { describe, expect, it } from 'vitest'
import {
  getUuidOwner,
  putUuidOwner,
  getKeyRecord,
  putKeyRecord,
  type AppAttestKv,
  type DeviceKeyRecord,
} from './keyStore'
import { AppAttestError } from './errors'
import { makeMemoryKv } from '../test/memoryKv'

const kvOf = () => makeMemoryKv() as unknown as AppAttestKv & { store: Map<string, string> }

const record = (uuid: string): DeviceKeyRecord => ({
  spki: 'c3BraQ',
  signCount: 0,
  uuid,
  environment: 'development',
  attestedAt: 0,
})

/**
 * The first-writer-wins decision that lives inline in `verifyAttestation`,
 * lifted here verbatim so the three branches are unit-testable without a real
 * attestation blob. Mirrors: unclaimed → claim; same keyId → idempotent allow;
 * different keyId → reject.
 */
const pinAndStore = async (kv: AppAttestKv, uuid: string, keyId: string) => {
  const owner = await getUuidOwner(kv, uuid)
  if (owner == null) {
    await putUuidOwner(kv, uuid, keyId)
  } else if (owner !== keyId) {
    throw new AppAttestError('identity already bound to another device')
  }
  await putKeyRecord(kv, keyId, record(uuid))
}

describe('uuid → keyId owner pin', () => {
  it('claims an unclaimed identity for the first keyId', async () => {
    const kv = kvOf()
    expect(await getUuidOwner(kv, 'uuid-1')).toBeNull()
    await pinAndStore(kv, 'uuid-1', 'key-A')
    expect(await getUuidOwner(kv, 'uuid-1')).toBe('key-A')
    expect(await getKeyRecord(kv, 'key-A')).not.toBeNull()
  })

  it('allows an idempotent re-attest of the SAME keyId', async () => {
    const kv = kvOf()
    await pinAndStore(kv, 'uuid-1', 'key-A')
    await expect(pinAndStore(kv, 'uuid-1', 'key-A')).resolves.toBeUndefined()
    expect(await getUuidOwner(kv, 'uuid-1')).toBe('key-A')
  })

  it('rejects a DIFFERENT keyId claiming an already-bound identity', async () => {
    const kv = kvOf()
    await pinAndStore(kv, 'uuid-1', 'key-A')
    await expect(pinAndStore(kv, 'uuid-1', 'key-B')).rejects.toThrow(
      /already bound to another device/
    )
    // The attacker's key was never stored; the victim's binding is intact.
    expect(await getUuidOwner(kv, 'uuid-1')).toBe('key-A')
    expect(await getKeyRecord(kv, 'key-B')).toBeNull()
  })

  it('is retry-safe when the owner pin landed but the key record write failed', async () => {
    // Simulate a prior partial failure: uuid pinned to key-A, but no key record.
    const kv = kvOf()
    await putUuidOwner(kv, 'uuid-1', 'key-A')
    expect(await getKeyRecord(kv, 'key-A')).toBeNull()
    // Same keyId retries → idempotent branch fills in the missing record.
    await expect(pinAndStore(kv, 'uuid-1', 'key-A')).resolves.toBeUndefined()
    expect(await getKeyRecord(kv, 'key-A')).not.toBeNull()
  })
})
