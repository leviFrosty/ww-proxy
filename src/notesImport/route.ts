import type { AppContext, ErrorResponse } from '../types'
import { HTTP_STATUS } from '../config'
import { Sentry } from '../sentry'
import { sha256Hex, timingSafeEqual } from '../crypto'
import { getNotesImportConfig } from './config'
import { isSupporter, RevenueCatError } from '../revenuecat'
import { checkCredit, recordUsage } from '../credits'
import { runNotesImportModel } from './llm'
import {
  issueChallenge,
  verifyAssertion,
  verifyAttestation,
  AppAttestError,
} from '../appAttest'
import type { NotesImportContext } from './schema'

const err = (
  ctx: AppContext,
  status: number,
  error: string,
  code?: string
) => {
  const body: ErrorResponse = code ? { error, code } : { error }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ctx.json(body, status as any)
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null

/** POST /notes-import/challenge — issue a one-time App Attest challenge. */
export async function handleChallengeRequest(ctx: AppContext) {
  const challenge = await issueChallenge(ctx.env.NOTES_KV)
  return ctx.json({ challenge })
}

/** POST /notes-import/attest — initial App Attest handshake; stores the device key. */
export async function handleAttestRequest(ctx: AppContext) {
  let body: Record<string, unknown>
  try {
    body = (await ctx.req.json()) as Record<string, unknown>
  } catch {
    return err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid JSON', 'bad_request')
  }

  const keyId = asString(body.keyId)
  const attestation = asString(body.attestation)
  const challenge = asString(body.challenge)
  const uuid = asString(body.uuid)
  if (!keyId || !attestation || !challenge || !uuid) {
    return err(
      ctx,
      HTTP_STATUS.BAD_REQUEST,
      'Missing keyId, attestation, challenge, or uuid',
      'bad_request'
    )
  }

  try {
    await verifyAttestation({
      kv: ctx.env.NOTES_KV,
      attestation,
      keyId,
      challenge,
      uuid,
      teamId: ctx.env.APPLE_TEAM_ID,
      bundleId: ctx.env.IOS_BUNDLE_ID,
    })
  } catch (e) {
    if (e instanceof AppAttestError) {
      return err(ctx, HTTP_STATUS.UNAUTHORIZED, e.message, 'attestation_failed')
    }
    Sentry.captureException(e)
    return err(
      ctx,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      'Attestation error',
      'server_error'
    )
  }
  return ctx.json({ ok: true })
}

interface NotesImportBody {
  uuid: string
  notesText: string
  contentHash: string
  context: NotesImportContext
  keyId?: string
  challenge?: string
  assertion?: string
  refinement?: { previousResultJSON: string; instruction: string }
}

/** POST /notes-import — the metered, attested model call. */
export async function handleNotesImportRequest(ctx: AppContext) {
  const config = getNotesImportConfig(ctx.env)

  let body: NotesImportBody
  try {
    body = (await ctx.req.json()) as NotesImportBody
  } catch {
    return err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid JSON', 'bad_request')
  }

  const uuid = asString(body.uuid)
  const notesText = typeof body.notesText === 'string' ? body.notesText : null
  if (!uuid || notesText == null || !body.context) {
    return err(
      ctx,
      HTTP_STATUS.BAD_REQUEST,
      'Missing uuid, notesText, or context',
      'bad_request'
    )
  }

  if (notesText.length > config.maxChars) {
    return err(
      ctx,
      HTTP_STATUS.PAYLOAD_TOO_LARGE,
      `Notes exceed the ${config.maxChars}-character limit`,
      'too_large'
    )
  }

  // The content hash is authoritative: recompute it and require the client's
  // claimed hash to match the notes, so the signed assertion provably covers
  // exactly the text being parsed (and the meter keys on real content).
  const contentHash = await sha256Hex(notesText)
  if (asString(body.contentHash) && body.contentHash !== contentHash) {
    return err(
      ctx,
      HTTP_STATUS.BAD_REQUEST,
      'contentHash does not match notesText',
      'bad_request'
    )
  }

  // --- Request authentication (the security boundary) -------------------
  const bypassHeader = ctx.req.header('x-ww-dev-bypass') ?? ''
  const devBypass =
    config.devBypassToken != null &&
    timingSafeEqual(bypassHeader, config.devBypassToken)

  if (!devBypass) {
    const keyId = asString(body.keyId)
    const challenge = asString(body.challenge)
    const assertion = asString(body.assertion)
    if (!keyId || !challenge || !assertion) {
      return err(
        ctx,
        HTTP_STATUS.UNAUTHORIZED,
        'Missing App Attest credentials',
        'attestation_required'
      )
    }
    try {
      await verifyAssertion({
        kv: ctx.env.NOTES_KV,
        assertion,
        keyId,
        challenge,
        uuid,
        contentHash,
        teamId: ctx.env.APPLE_TEAM_ID,
        bundleId: ctx.env.IOS_BUNDLE_ID,
      })
    } catch (e) {
      if (e instanceof AppAttestError) {
        return err(
          ctx,
          HTTP_STATUS.UNAUTHORIZED,
          e.message,
          'attestation_failed'
        )
      }
      Sentry.captureException(e)
      return err(
        ctx,
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        'Auth error',
        'server_error'
      )
    }
  }

  // --- Supporter status + credit gate -----------------------------------
  let supporter = false
  try {
    supporter = await isSupporter({
      apiKey: ctx.env.REVENUECAT_API_KEY,
      appUserId: uuid,
      entitlementId: config.entitlementId,
    })
  } catch (e) {
    if (!(e instanceof RevenueCatError)) Sentry.captureException(e)
    // Fail closed to non-Supporter — the free meter still lets them import.
    supporter = false
  }

  const isRefinement = !!body.refinement
  const decision = await checkCredit({
    kv: ctx.env.NOTES_KV,
    uuid,
    hash: contentHash,
    isSupporter: supporter,
    isRefinement,
    freeCredits: config.freeCredits,
    maxRefinements: config.maxRefinements,
  })
  if (!decision.allowed) {
    const status =
      decision.reason === 'limit_reached'
        ? HTTP_STATUS.PAYMENT_REQUIRED
        : HTTP_STATUS.TOO_MANY_REQUESTS
    return err(
      ctx,
      status,
      decision.reason === 'limit_reached'
        ? 'Free import limit reached'
        : 'Refinement limit reached for this import',
      decision.reason
    )
  }

  // --- Model call (only now do we spend inference) ----------------------
  let output
  try {
    output = await runNotesImportModel({
      apiKey: ctx.env.AI_GATEWAY_API_KEY,
      config,
      notesText,
      context: body.context,
      refinement: body.refinement,
    })
  } catch (e) {
    Sentry.captureException(e)
    return err(
      ctx,
      HTTP_STATUS.BAD_GATEWAY,
      'The import model could not process these notes',
      'model_error'
    )
  }

  const remaining = await recordUsage({
    kv: ctx.env.NOTES_KV,
    uuid,
    hash: contentHash,
    isSupporter: supporter,
    decision,
    freeCredits: config.freeCredits,
  })

  return ctx.json({
    result: output.result,
    contentHash,
    refinement: isRefinement,
    credits: { remaining, isSupporter: supporter },
  })
}
