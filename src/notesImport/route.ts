import type { AppContext, ErrorResponse } from '../types'
import { HTTP_STATUS } from '../config'
import { Sentry } from '../sentry'
import { sha256Hex, timingSafeEqual, randomToken } from '../crypto'
import { getNotesImportConfig, type NotesImportConfig } from './config'
import { isSupporter, RevenueCatError } from '../revenuecat'
import {
  checkCredit,
  recordUsage,
  refinementUsageFor,
  kickoffCredits,
  type CreditDecision,
} from '../credits'
import { runNotesImportModel } from './llm'
import { getNotesImportStatus } from './status'
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
  code?: string,
  detail?: string
) => {
  const body: ErrorResponse = { error }
  if (code) body.code = code
  if (detail) body.detail = detail
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ctx.json(body, status as any)
}

/** Serialize a caught value to a useful single-string detail for dev debugging. */
const errorDetail = (e: unknown): string => {
  if (e instanceof Error) {
    const cause =
      e.cause != null && e.cause !== e
        ? `\nCaused by: ${errorDetail(e.cause)}`
        : ''
    return `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}${cause}`
  }
  try {
    return typeof e === 'string' ? e : JSON.stringify(e)
  } catch {
    return String(e)
  }
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null

const subKey = (token: string) => `notes-import:sub:${token}`

/**
 * GET /notes-import/status — cheap availability probe for the app's import
 * entry points. No App Attest (it's a public health check) and no inference:
 * a manual KV kill-switch plus OpenRouter's free provider-health metadata.
 */
export async function handleNotesImportStatusRequest(ctx: AppContext) {
  const config = getNotesImportConfig(ctx.env)
  const status = await getNotesImportStatus({
    kv: ctx.env.NOTES_KV,
    apiKey: ctx.env.OPENROUTER_API_KEY,
    config,
  })
  return ctx.json(status)
}

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

/** A request that passed authentication + the credit gate, ready to spend inference. */
interface GateOk {
  ok: true
  body: NotesImportBody
  uuid: string
  notesText: string
  contentHash: string
  supporter: boolean
  /** Supporter entitlement or authenticated dev bypass; skips credit charging. */
  unmetered: boolean
  decision: CreditDecision
  isRefinement: boolean
  /** True when the dev-bypass token was used (gates dev-only error detail). */
  devBypass: boolean
}
type GateResult = GateOk | { ok: false; response: Response }

/**
 * The shared security boundary for the metered model call: parse + validate the
 * body, recompute the authoritative content hash, verify App Attest (or the
 * dev bypass), resolve supporter status, and run the credit pre-flight. Both the
 * streaming kickoff and the legacy synchronous path go through this UNCHANGED —
 * App Attest still signs exactly the content hash being parsed. Returns either a
 * ready-to-spend `GateOk` or a fully-formed error `Response`.
 */
async function authenticateAndGate(
  ctx: AppContext,
  config: NotesImportConfig
): Promise<GateResult> {
  // Kill-switch / provider-health enforcement. `GET /notes-import/status`
  // advertises this so the app can disable its entry points BEFORE attesting,
  // but that's only advisory: a client already inside the composer, resuming a
  // run, or calling the API directly never re-checks it. So enforce the same
  // gate here — the single boundary both import paths pass through — before
  // spending an attestation round-trip or any inference. Cheap (KV kill-switch
  // first, then the cached provider probe) and fail-open by design.
  const status = await getNotesImportStatus({
    kv: ctx.env.NOTES_KV,
    apiKey: ctx.env.OPENROUTER_API_KEY,
    config,
  })
  if (!status.available) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        'Notes Import is temporarily unavailable',
        'unavailable',
        status.reason
      ),
    }
  }

  let body: NotesImportBody
  try {
    body = (await ctx.req.json()) as NotesImportBody
  } catch {
    return {
      ok: false,
      response: err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid JSON', 'bad_request'),
    }
  }

  const uuid = asString(body.uuid)
  const notesText = typeof body.notesText === 'string' ? body.notesText : null
  if (!uuid || notesText == null || !body.context) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.BAD_REQUEST,
        'Missing uuid, notesText, or context',
        'bad_request'
      ),
    }
  }

  if (notesText.length > config.maxChars) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.PAYLOAD_TOO_LARGE,
        `Notes exceed the ${config.maxChars}-character limit`,
        'too_large'
      ),
    }
  }

  // The content hash is authoritative: recompute it and require the client's
  // claimed hash to match, so the signed assertion provably covers exactly the
  // text being parsed (and the meter keys on real content).
  const contentHash = await sha256Hex(notesText)
  if (asString(body.contentHash) && body.contentHash !== contentHash) {
    return {
      ok: false,
      response: err(
        ctx,
        HTTP_STATUS.BAD_REQUEST,
        'contentHash does not match notesText',
        'bad_request'
      ),
    }
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
      return {
        ok: false,
        response: err(
          ctx,
          HTTP_STATUS.UNAUTHORIZED,
          'Missing App Attest credentials',
          'attestation_required'
        ),
      }
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
        return {
          ok: false,
          response: err(ctx, HTTP_STATUS.UNAUTHORIZED, e.message, 'attestation_failed'),
        }
      }
      Sentry.captureException(e)
      return {
        ok: false,
        response: err(ctx, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Auth error', 'server_error'),
      }
    }
  }

  // --- Supporter status + credit gate -----------------------------------
  // Keep the real entitlement distinct from the dev bypass: both are
  // unmetered, but only an actual Supporter should suppress Supporter CTAs.
  let supporter = false
  if (!devBypass) {
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
  }
  const unmetered = supporter || devBypass

  const isRefinement = !!body.refinement
  const decision = await checkCredit({
    kv: ctx.env.NOTES_KV,
    uuid,
    hash: contentHash,
    isSupporter: unmetered,
    isRefinement,
    freeCredits: config.freeCredits,
    maxRefinements: config.maxRefinements,
  })
  if (!decision.allowed) {
    const status =
      decision.reason === 'limit_reached'
        ? HTTP_STATUS.PAYMENT_REQUIRED
        : HTTP_STATUS.TOO_MANY_REQUESTS
    return {
      ok: false,
      response: err(
        ctx,
        status,
        decision.reason === 'limit_reached'
          ? 'Free import limit reached'
          : 'Refinement limit reached for this import',
        decision.reason
      ),
    }
  }

  return {
    ok: true,
    body,
    uuid,
    notesText,
    contentHash,
    supporter,
    unmetered,
    decision,
    isRefinement,
    devBypass,
  }
}

/**
 * Stable, content-derived import id. Idempotent per (user, content) so a
 * reconnect lands on the same run DO; a refinement is a distinct run because its
 * instruction is part of the identity. `imp_` prefix keeps DO names readable.
 */
const deriveImportId = async (
  uuid: string,
  contentHash: string,
  refinement?: { instruction: string }
): Promise<string> => {
  const basis = refinement
    ? `${uuid}|${contentHash}|r|${refinement.instruction}`
    : `${uuid}|${contentHash}`
  return `imp_${(await sha256Hex(basis)).slice(0, 40)}`
}

/**
 * POST /notes-import/kickoff — attested, metered entry point for the STREAMING
 * import. Authenticates + gates exactly like the legacy path, enforces the
 * per-user concurrency cap, starts a background run in a per-import Durable
 * Object, and returns immediately with `{ importId, subscribeToken }`. The
 * client then opens the SSE stream at `/notes-import/:importId/events`.
 */
export async function handleNotesImportKickoffRequest(ctx: AppContext) {
  const config = getNotesImportConfig(ctx.env)
  const gate = await authenticateAndGate(ctx, config)
  if (!gate.ok) return gate.response
  const {
    uuid,
    notesText,
    contentHash,
    supporter,
    unmetered,
    decision,
    body,
    isRefinement,
  } = gate

  const importId = await deriveImportId(uuid, contentHash, body.refinement)

  // Per-user concurrency cap, enforced race-free in the single-threaded index DO.
  const cap = unmetered
    ? config.activeImportCapSupporter
    : config.activeImportCap
  const idxId = ctx.env.NOTES_IMPORT_INDEX.idFromName(uuid)
  const acquired = await ctx.env.NOTES_IMPORT_INDEX.get(idxId).acquire(
    importId,
    cap
  )
  if (!acquired.ok) {
    return err(
      ctx,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      `You already have ${acquired.active} imports running (max ${cap}).`,
      'active_cap'
    )
  }

  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(importId)
  let outcome
  try {
    outcome = await ctx.env.NOTES_IMPORT_RUN.get(runId).start({
      importId,
      uuid,
      contentHash,
      notesText,
      context: body.context,
      refinement: body.refinement,
      isSupporter: supporter,
      unmetered,
      decision,
    })
  } catch (e) {
    // Couldn't start → release the slot so it isn't leaked.
    await ctx.env.NOTES_IMPORT_INDEX.get(idxId).release(importId)
    Sentry.captureException(e)
    console.error('notes-import kickoff start failed', errorDetail(e))
    return err(
      ctx,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      'Could not start import',
      'server_error',
      gate.devBypass ? errorDetail(e) : undefined
    )
  }

  // A re-kick of an already-settled run (done/cancelled) does NOT consume the
  // slot we just acquired: start() no-ops for reconnect, but that run had
  // already released its slot when it first settled, so acquire() re-inserted an
  // ORPHAN row. Release it — the index DO has no TTL, so a leaked slot locks the
  // user out permanently once `cap` of them accumulate. A live/queued re-kick
  // ('running', slot still in use) and a fresh/error (re)start ('started', slot
  // legitimately consumed) both keep it. release() is idempotent (a DELETE).
  if (outcome === 'terminal') {
    await ctx.env.NOTES_IMPORT_INDEX.get(idxId).release(importId)
  }

  // Short-lived capability for the stream. App Attest can't sign a long-lived
  // SSE connection; it doesn't need to — the abusable operation (inference) was
  // already gated above, so the stream just reads an authorized resource.
  const subscribeToken = randomToken()
  await ctx.env.NOTES_KV.put(subKey(subscribeToken), importId, {
    expirationTtl: config.subscribeTokenTtlSeconds,
  })

  // Usage snapshot up front, so the client's meter populates at run start rather
  // than only when the `done` event lands. Read-only (no charge) and equal to
  // the eventual `done` snapshot — see kickoffCredits.
  const credits = await kickoffCredits({
    kv: ctx.env.NOTES_KV,
    uuid,
    hash: contentHash,
    decision,
    isSupporter: supporter,
    unmetered,
    freeCredits: config.freeCredits,
    maxRefinements: config.maxRefinements,
  })

  return ctx.json({ importId, subscribeToken, refinement: isRefinement, credits })
}

/** Resolve + authorize a stream request to its run DO, or return an error Response. */
async function authorizeStream(
  ctx: AppContext
): Promise<{ importId: string } | { response: Response }> {
  const importId = ctx.req.param('importId')
  const token = ctx.req.query('token') ?? ''
  if (!importId || !token) {
    return {
      response: err(
        ctx,
        HTTP_STATUS.BAD_REQUEST,
        'Missing importId or token',
        'bad_request'
      ),
    }
  }
  const mapped = await ctx.env.NOTES_KV.get(subKey(token))
  if (!mapped || mapped !== importId) {
    return {
      response: err(
        ctx,
        HTTP_STATUS.UNAUTHORIZED,
        'Invalid or expired subscribe token',
        'attestation_required'
      ),
    }
  }
  return { importId }
}

/**
 * GET /notes-import/:importId/events — the SSE progress stream. Authorized by
 * the kickoff's `?token=` capability. Forwards to the run DO, which replays the
 * event log since `Last-Event-ID` then tails live (lossless resume).
 */
export async function handleNotesImportEventsRequest(ctx: AppContext) {
  const authed = await authorizeStream(ctx)
  if ('response' in authed) return authed.response

  const lastEventId =
    ctx.req.header('Last-Event-ID') ?? ctx.req.query('lastEventId') ?? ''
  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(authed.importId)
  const doReq = new Request(
    `https://do/events?lastEventId=${encodeURIComponent(lastEventId)}`,
    { headers: lastEventId ? { 'Last-Event-ID': lastEventId } : undefined }
  )
  return ctx.env.NOTES_IMPORT_RUN.get(runId).fetch(doReq)
}

/**
 * POST /notes-import/:importId/cancel — interrupt a running import. Authorized by
 * the kickoff's `?token=` capability (same as the stream/result reads — cancel
 * only STOPS work, it can't spend inference, so it needs no App Attest). Aborts
 * the in-flight model call in the run DO and marks it cancelled; because the
 * credit is only spent on success, an interrupted run is never charged. Used by
 * the client's "edit & resend" flow before kicking off the edited import.
 */
export async function handleNotesImportCancelRequest(ctx: AppContext) {
  const authed = await authorizeStream(ctx)
  if ('response' in authed) return authed.response

  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(authed.importId)
  const snapshot = await ctx.env.NOTES_IMPORT_RUN.get(runId).cancel()
  return ctx.json(snapshot)
}

/**
 * POST /notes-import/:importId/destroy — forget a run entirely, on demand. Same
 * subscribe-token capability as cancel/stream/result (destroy can't spend
 * inference, so it needs no App Attest). Aborts any in-flight model call, frees
 * the user's concurrency slot, and wipes all DO state immediately instead of
 * waiting for the retention alarm. Backs the history view's per-row delete.
 */
export async function handleNotesImportDestroyRequest(ctx: AppContext) {
  const authed = await authorizeStream(ctx)
  if ('response' in authed) return authed.response

  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(authed.importId)
  await ctx.env.NOTES_IMPORT_RUN.get(runId).destroy()
  return ctx.json({ ok: true })
}

/**
 * GET /notes-import/:importId/result — final-result snapshot for a client that
 * reconnects after the stream closed (or missed the terminal event). Same
 * capability auth as the stream.
 */
export async function handleNotesImportResultRequest(ctx: AppContext) {
  const authed = await authorizeStream(ctx)
  if ('response' in authed) return authed.response

  const runId = ctx.env.NOTES_IMPORT_RUN.idFromName(authed.importId)
  const snapshot = await ctx.env.NOTES_IMPORT_RUN.get(runId).getResult()
  return ctx.json(snapshot)
}

/**
 * POST /notes-import — LEGACY synchronous path. Held open for the full model run
 * and returns the result in one response. Kept as a fallback during the
 * streaming cutover (gate behind the KV kill-switch on the client). Identical
 * auth/credit/ZDR semantics as kickoff via the shared gate.
 */
export async function handleNotesImportRequest(ctx: AppContext) {
  const config = getNotesImportConfig(ctx.env)
  const gate = await authenticateAndGate(ctx, config)
  if (!gate.ok) return gate.response
  const {
    uuid,
    notesText,
    contentHash,
    supporter,
    unmetered,
    decision,
    body,
    isRefinement,
  } = gate

  let output
  try {
    output = await runNotesImportModel({
      apiKey: ctx.env.OPENROUTER_API_KEY,
      config,
      notesText,
      context: body.context,
      refinement: body.refinement,
    })
  } catch (e) {
    Sentry.captureException(e)
    console.error('notes-import model_error', errorDetail(e))
    return err(
      ctx,
      HTTP_STATUS.BAD_GATEWAY,
      'The import model could not process these notes',
      'model_error',
      gate.devBypass ? errorDetail(e) : undefined
    )
  }

  const remaining = await recordUsage({
    kv: ctx.env.NOTES_KV,
    uuid,
    hash: contentHash,
    isSupporter: unmetered,
    decision,
    freeCredits: config.freeCredits,
  })
  const refinements = await refinementUsageFor(
    ctx.env.NOTES_KV,
    uuid,
    contentHash,
    config.maxRefinements
  )

  return ctx.json({
    result: output.result,
    contentHash,
    refinement: isRefinement,
    credits: {
      remaining,
      limit: unmetered ? null : config.freeCredits,
      isSupporter: supporter,
      refinements,
    },
  })
}
