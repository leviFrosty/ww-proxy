import { describe, expect, it } from 'bun:test'
import { encode } from 'cbor2'
import { verifyAssertion } from './assert'
import { AppAttestError } from './errors'
import { issueChallenge, type ChallengeKv } from './challenge'
import { appIdRpHash } from './appId'
import { buildAssertionClientData } from './clientData'
import { bytesToBase64Url, sha256Bytes } from '../crypto'
import { makeMemoryKv } from '../test/memoryKv'

const TEAM = 'ABCDE12345'
const BUNDLE = 'com.example.app'
const KEY_ID = 'test-key-id'

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** Encode a WebCrypto raw (r||s) ECDSA signature as DER, like Apple does. */
const rawEcdsaToDer = (raw: Uint8Array): Uint8Array => {
  const derInt = (b: Uint8Array): Uint8Array => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.subarray(i)
    if (v[0] & 0x80) {
      const t = new Uint8Array(v.length + 1)
      t.set(v, 1)
      v = t
    }
    return new Uint8Array([0x02, v.length, ...v])
  }
  const body = concat(derInt(raw.subarray(0, 32)), derInt(raw.subarray(32, 64)))
  return new Uint8Array([0x30, body.length, ...body])
}

const setup = async () => {
  const kv = makeMemoryKv()
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer
  )
  const storeKey = async (uuid: string, signCount = 0) =>
    kv.put(
      `key:${KEY_ID}`,
      JSON.stringify({
        spki: bytesToBase64Url(spki),
        signCount,
        uuid,
        environment: 'development',
        attestedAt: 0,
      })
    )

  const buildAuthData = async (signCount: number) => {
    const rp = await appIdRpHash(TEAM, BUNDLE)
    const ad = new Uint8Array(37)
    ad.set(rp, 0)
    ad[32] = 0
    new DataView(ad.buffer).setUint32(33, signCount, false)
    return ad
  }

  const makeAssertion = async (opts: {
    uuid: string
    contentHash: string
    challenge: string
    signCount: number
    /** Sign over a DIFFERENT content hash than the one we'll verify against. */
    signContentHash?: string
  }) => {
    const authData = await buildAuthData(opts.signCount)
    const clientData = buildAssertionClientData({
      challenge: opts.challenge,
      uuid: opts.uuid,
      contentHash: opts.signContentHash ?? opts.contentHash,
    })
    const clientDataHash = await sha256Bytes(new TextEncoder().encode(clientData))
    const message = concat(authData, clientDataHash)
    const rawSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        message
      )
    )
    const cbor = encode({
      signature: rawEcdsaToDer(rawSig),
      authenticatorData: authData,
    })
    return bytesToBase64Url(cbor)
  }

  const verify = (assertion: string, challenge: string, uuid = 'uuid-1', contentHash = 'hash-1') =>
    verifyAssertion({
      kv: kv as unknown as ChallengeKv,
      assertion,
      keyId: KEY_ID,
      challenge,
      uuid,
      contentHash,
      teamId: TEAM,
      bundleId: BUNDLE,
    })

  return { kv, storeKey, makeAssertion, verify }
}

describe('verifyAssertion (end-to-end with a synthetic Secure-Enclave key)', () => {
  it('accepts a well-formed, freshly-challenged assertion', async () => {
    const { kv, storeKey, makeAssertion, verify } = await setup()
    await storeKey('uuid-1')
    const challenge = await issueChallenge(kv as unknown as ChallengeKv)
    const assertion = await makeAssertion({
      uuid: 'uuid-1',
      contentHash: 'hash-1',
      challenge,
      signCount: 1,
    })
    await expect(verify(assertion, challenge)).resolves.toBeUndefined()
    // Sign-count advanced in the stored record.
    expect(JSON.parse(kv.store.get(`key:${KEY_ID}`)!).signCount).toBe(1)
  })

  it('rejects a replayed challenge (one-time use)', async () => {
    const { kv, storeKey, makeAssertion, verify } = await setup()
    await storeKey('uuid-1')
    const challenge = await issueChallenge(kv as unknown as ChallengeKv)
    const assertion = await makeAssertion({
      uuid: 'uuid-1',
      contentHash: 'hash-1',
      challenge,
      signCount: 1,
    })
    await verify(assertion, challenge)
    await expect(verify(assertion, challenge)).rejects.toBeInstanceOf(
      AppAttestError
    )
  })

  it('rejects a tampered content hash (signature no longer covers it)', async () => {
    const { kv, storeKey, makeAssertion, verify } = await setup()
    await storeKey('uuid-1')
    const challenge = await issueChallenge(kv as unknown as ChallengeKv)
    const assertion = await makeAssertion({
      uuid: 'uuid-1',
      contentHash: 'hash-1',
      challenge,
      signCount: 1,
      signContentHash: 'a-different-hash',
    })
    await expect(verify(assertion, challenge, 'uuid-1', 'hash-1')).rejects.toThrow(
      'assertion signature invalid'
    )
  })

  it('rejects a non-increasing sign-count (assertion replay)', async () => {
    const { kv, storeKey, makeAssertion, verify } = await setup()
    await storeKey('uuid-1', 5) // stored count already at 5
    const challenge = await issueChallenge(kv as unknown as ChallengeKv)
    const assertion = await makeAssertion({
      uuid: 'uuid-1',
      contentHash: 'hash-1',
      challenge,
      signCount: 5,
    })
    await expect(verify(assertion, challenge)).rejects.toThrow(/sign-count/)
  })

  it('rejects an assertion for a key bound to a different identity', async () => {
    const { kv, storeKey, makeAssertion, verify } = await setup()
    await storeKey('uuid-1')
    const challenge = await issueChallenge(kv as unknown as ChallengeKv)
    const assertion = await makeAssertion({
      uuid: 'uuid-2',
      contentHash: 'hash-1',
      challenge,
      signCount: 1,
    })
    await expect(
      verify(assertion, challenge, 'uuid-2')
    ).rejects.toThrow(/not bound/)
  })

  it('rejects an unknown device key', async () => {
    const { kv, makeAssertion, verify } = await setup()
    const challenge = await issueChallenge(kv as unknown as ChallengeKv)
    const assertion = await makeAssertion({
      uuid: 'uuid-1',
      contentHash: 'hash-1',
      challenge,
      signCount: 1,
    })
    await expect(verify(assertion, challenge)).rejects.toThrow(/unknown device key/)
  })
})
