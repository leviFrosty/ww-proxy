/**
 * Canonical client-data the iOS app hashes into each App Attest assertion. The
 * Secure Enclave signs `SHA256(authenticatorData || SHA256(clientData))`, so
 * binding the challenge + identity + content hash here makes every request's
 * signature cover exactly those values — a stolen assertion can't be replayed
 * for a different identity, a different import, or after the challenge expires.
 *
 * MUST stay byte-for-byte identical to the witness-work client's builder.
 */
export const buildAssertionClientData = (args: {
  challenge: string
  uuid: string
  contentHash: string
}): string => `${args.challenge}|${args.uuid}|${args.contentHash}`
