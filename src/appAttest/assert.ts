import { base64ToBytes, sha256Bytes } from '../crypto'
import {
  decodeAssertion,
  parseAssertionAuthData,
  type ParsedAuthData,
} from './decode'
import { derEcdsaSignatureToRaw } from './der'
import { appIdRpHash, bytesEqual } from './appId'
import { buildAssertionClientData } from './clientData'
import { consumeChallenge } from './challenge'
import { AppAttestError } from './errors'
import { getKeyRecord, putKeyRecord, type AppAttestKv } from './keyStore'

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export interface VerifyAssertionArgs {
  kv: AppAttestKv
  /** Base64 of the CBOR assertion from `DCAppAttestService.generateAssertion`. */
  assertion: string
  keyId: string
  challenge: string
  uuid: string
  /**
   * Shared account id (witness-work ADR 0011), when the client sent one. Not
   * part of the key pinning — that stays on the per-device `uuid` — but it is
   * folded into the signed client data so a proxying user can't swap in
   * someone else's account id post-signature.
   */
  accountId?: string
  /** The notes content hash this request is bound to. */
  contentHash: string
  teamId: string
  bundleId: string
}

/**
 * Verifies a per-request App Attest assertion — the hot path on every
 * `/notes-import` call. Pure WebCrypto (no X.509), so it stays cheap. Checks:
 * the device key is known and pinned to `uuid`; the challenge is fresh; the
 * ES256 signature covers `authenticatorData || SHA256(clientData)` for our exact
 * bound client data; the rpIdHash matches our app id; and the sign-count
 * strictly increases. Throws {@link AppAttestError} otherwise.
 */
export const verifyAssertion = async ({
  kv,
  assertion,
  keyId,
  challenge,
  uuid,
  accountId,
  contentHash,
  teamId,
  bundleId,
}: VerifyAssertionArgs): Promise<void> => {
  const record = await getKeyRecord(kv, keyId)
  if (!record) throw new AppAttestError('unknown device key — attest first')
  if (record.uuid !== uuid) {
    throw new AppAttestError('device key not bound to this identity')
  }
  if (!(await consumeChallenge(kv, challenge))) {
    throw new AppAttestError('challenge invalid or expired')
  }

  let asn
  let parsed: ParsedAuthData
  try {
    asn = decodeAssertion(base64ToBytes(assertion))
    parsed = parseAssertionAuthData(asn.authenticatorData)
  } catch (e) {
    throw new AppAttestError(`malformed assertion: ${(e as Error).message}`)
  }

  const expectedRpId = await appIdRpHash(teamId, bundleId)
  if (!bytesEqual(parsed.rpIdHash, expectedRpId)) {
    throw new AppAttestError('rpIdHash mismatch (wrong app id)')
  }
  if (parsed.signCount <= record.signCount) {
    throw new AppAttestError('assertion sign-count did not increase (replay?)')
  }

  const clientData = buildAssertionClientData({
    challenge,
    uuid,
    accountId,
    contentHash,
  })
  const clientDataHash = await sha256Bytes(new TextEncoder().encode(clientData))
  const message = concat(asn.authenticatorData, clientDataHash)

  const verifyKey = await crypto.subtle.importKey(
    'spki',
    base64ToBytes(record.spki),
    ECDSA_P256,
    false,
    ['verify']
  )
  const rawSig = derEcdsaSignatureToRaw(asn.signature)
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    rawSig,
    message
  )
  if (!ok) throw new AppAttestError('assertion signature invalid')

  await putKeyRecord(kv, keyId, { ...record, signCount: parsed.signCount })
}
