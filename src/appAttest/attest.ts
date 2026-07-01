// reflect-metadata must load before @peculiar/x509 (its tsyringe DI needs it).
import 'reflect-metadata'
import { X509Certificate, cryptoProvider } from '@peculiar/x509'
import { base64ToBytes, bytesToBase64Url, sha256Bytes } from '../crypto'
import { APPLE_APP_ATTEST_ROOT_CA_PEM } from './appleRootCa'
import { decodeAttestation, parseAuthData } from './decode'
import { extractAttestationNonce } from './der'
import { appIdRpHash, bytesEqual } from './appId'
import { consumeChallenge } from './challenge'
import { AppAttestError } from './errors'
import {
  getUuidOwner,
  putKeyRecord,
  putUuidOwner,
  type AppAttestKv,
} from './keyStore'

// @peculiar/x509 needs a WebCrypto implementation; the Workers global works.
cryptoProvider.set(crypto as Crypto)

const APPLE_APP_ATTEST_OID = '1.2.840.113635.100.8.2'
const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

const decodeEnvironment = (
  aaguid: Uint8Array | undefined
): 'development' | 'production' => {
  if (!aaguid) return 'production'
  const text = new TextDecoder().decode(aaguid)
  return text.startsWith('appattestdevelop') ? 'development' : 'production'
}

export interface VerifyAttestationArgs {
  kv: AppAttestKv
  /** Base64 of the CBOR attestation object from `DCAppAttestService.attestKey`. */
  attestation: string
  /** The key identifier (base64) returned by `generateKey`. */
  keyId: string
  /** The challenge string this device was issued (consumed here). */
  challenge: string
  /** Keychain UUID to pin this device key to. */
  uuid: string
  teamId: string
  bundleId: string
  /** When true, reject development-environment ('appattestdevelop') attestations. */
  requireProduction?: boolean
}

/**
 * Verifies an App Attest attestation per Apple's spec and, on success, stores
 * the device's public key (pinned to `uuid`) so future assertions can be
 * checked. Throws {@link AppAttestError} on any failure. This is the one-time
 * handshake path; the per-request path is {@link verifyAssertion}.
 */
export const verifyAttestation = async ({
  kv,
  attestation,
  keyId,
  challenge,
  uuid,
  teamId,
  bundleId,
  requireProduction = false,
}: VerifyAttestationArgs): Promise<void> => {
  if (!(await consumeChallenge(kv, challenge))) {
    throw new AppAttestError('challenge invalid or expired')
  }

  let att
  try {
    att = decodeAttestation(base64ToBytes(attestation))
  } catch (e) {
    throw new AppAttestError(`malformed attestation: ${(e as Error).message}`)
  }
  if (att.fmt !== 'apple-appattest') {
    throw new AppAttestError(`unexpected attestation format: ${att.fmt}`)
  }
  if (att.attStmt.x5c.length < 2) {
    throw new AppAttestError('attestation chain too short')
  }

  // 1. clientDataHash = SHA256(challenge); nonce = SHA256(authData || clientDataHash).
  const clientDataHash = await sha256Bytes(new TextEncoder().encode(challenge))
  const nonce = await sha256Bytes(concat(att.authData, clientDataHash))

  // 2. Validate the certificate chain leaf → intermediate → Apple root.
  const leaf = new X509Certificate(att.attStmt.x5c[0])
  const intermediate = new X509Certificate(att.attStmt.x5c[1])
  const root = new X509Certificate(APPLE_APP_ATTEST_ROOT_CA_PEM)
  const now = new Date()
  const leafOk = await leaf.verify({ publicKey: intermediate, date: now })
  const intOk = await intermediate.verify({ publicKey: root, date: now })
  if (!leafOk || !intOk) {
    throw new AppAttestError('certificate chain does not validate to Apple root')
  }

  // 3. The leaf's Apple extension must carry our computed nonce.
  const ext = leaf.getExtension(APPLE_APP_ATTEST_OID)
  if (!ext) throw new AppAttestError('leaf missing App Attest nonce extension')
  const certNonce = extractAttestationNonce(new Uint8Array(ext.value))
  if (!bytesEqual(certNonce, nonce)) {
    throw new AppAttestError('attestation nonce mismatch')
  }

  // 4. credentialId in authData must equal SHA256(public key) and the keyId.
  const spki = new Uint8Array(leaf.publicKey.rawData)
  const verifyKey = await crypto.subtle.importKey('spki', spki, ECDSA_P256, true, [
    'verify',
  ])
  const rawPoint = new Uint8Array(
    (await crypto.subtle.exportKey('raw', verifyKey)) as ArrayBuffer
  )
  const publicKeyHash = await sha256Bytes(rawPoint)

  const parsed = parseAuthData(att.authData)
  if (!parsed.credentialId || !bytesEqual(parsed.credentialId, publicKeyHash)) {
    throw new AppAttestError('credentialId != SHA256(publicKey)')
  }
  if (!bytesEqual(base64ToBytes(keyId), publicKeyHash)) {
    throw new AppAttestError('keyId != SHA256(publicKey)')
  }

  // 5. rpIdHash must hash our app id; attestation sign-count must be 0.
  const expectedRpId = await appIdRpHash(teamId, bundleId)
  if (!bytesEqual(parsed.rpIdHash, expectedRpId)) {
    throw new AppAttestError('rpIdHash mismatch (wrong app id)')
  }
  if (parsed.signCount !== 0) {
    throw new AppAttestError('attestation signCount must be 0')
  }

  const environment = decodeEnvironment(parsed.aaguid)
  if (requireProduction && environment !== 'production') {
    throw new AppAttestError('development attestation rejected')
  }

  // First-writer-wins uuid→keyId pinning (ADR 0007). The crypto above only
  // proves the caller controls THIS Secure-Enclave key; it says nothing about
  // whether they may claim `uuid`. Without this, an attacker who knows a
  // Supporter's uuid (the RevenueCat App User ID — an identifier, not a secret)
  // could attest their own fresh key to it and ride the victim's entitlement,
  // and anyone could mint unlimited fresh uuids for fresh free-credit buckets.
  // So bind each identity to the FIRST key that attests it:
  //   - unclaimed        → claim it, then proceed;
  //   - owned by keyId    → idempotent re-attest of the same device, allow;
  //   - owned by another  → reject (the impersonation boundary).
  // TRADEOFF: strict first-writer-wins means a legitimate rotation to a NEW
  // keyId under an existing uuid (e.g. the Enclave key was lost but the Keychain
  // uuid survived a reinstall) is locked out and needs manual unbinding — an
  // operator deletes `uuidOwner:<uuid>` and `key:<oldKeyId>` from KV. We accept
  // that: protecting existing Supporters is the priority, and silent rebinding
  // would defeat the fix. Write the owner pin BEFORE the key record so a partial
  // failure is retry-safe: if the pin lands but the record write fails, the same
  // keyId retries down the idempotent branch; the reverse ordering would leave
  // `uuid` unclaimed while a key record exists, reopening the race.
  const owner = await getUuidOwner(kv, uuid)
  if (owner == null) {
    await putUuidOwner(kv, uuid, keyId)
  } else if (owner !== keyId) {
    throw new AppAttestError('identity already bound to another device')
  }

  await putKeyRecord(kv, keyId, {
    spki: bytesToBase64Url(spki),
    signCount: 0,
    uuid,
    environment,
    attestedAt: Date.now(),
  })
}
