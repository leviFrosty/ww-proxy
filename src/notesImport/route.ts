import type { AppContext, ErrorResponse } from '../types'
import { HTTP_STATUS } from '../config'
import { Sentry } from '../sentry'
import { sha256Hex, timingSafeEqual, randomToken } from '../crypto'
import {
  getNotesImportConfig,
  limitsWindowDurationMs,
  resolveNotesImportLimits,
  selectEffectiveAllowances,
  type NotesImportConfig,
} from './config'
import { isSupporter, RevenueCatError } from '../revenuecat'
import type { CreditDecision, CreditsSnapshot } from '../credits'
import { runNotesImportModel } from './llm'
import { getNotesImportStatus } from './status'
import {
  issueChallenge,
  verifyAssertion,
  verifyAttestation,
  AppAttestError,
} from '../appAttest'
import { isEmptyImportResult, type NotesImportContext } from './schema'
import { handleAdminResetRequest, isValidMeterId } from './admin'
import {
  buildAllowanceDenial,
  type NotesImportKickoffResponse,
} from './contracts'
import type { NotesImportSuccess } from './events'
import { resolveTerminalSupporter } from './settlement'

const err = (
  ctx: AppContext,
  status: number,
  error: string,
  code?: string,
  detail?: string,
  credits?: CreditsSnapshot
) => {
  const body: ErrorResponse = { error }
  if (code) body.code = code
  if (detail) body.detail = detail
  if (credits) body.credits = credits
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

/**
 * Shape gate for the client-supplied shared account id (witness-work ADR
 * 0011). It becomes a Durable Object name, a RevenueCat app-user-id path
 * segment, and a `|`-delimited clientData field, so keep it to a bounded
 * uuid-ish alphabet. Install ids (the value it defaults to on-device) are
 * `Crypto.randomUUID()` strings, which this accepts with room to spare.
 */
const isValidAccountId = isValidMeterId

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
    env: ctx.env,
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

  const config = getNotesImportConfig(ctx.env)
  try {
    await verifyAttestation({
      kv: ctx.env.NOTES_KV,
      attestation,
      keyId,
      challenge,
      uuid,
      teamId: ctx.env.APPLE_TEAM_ID,
      bundleId: ctx.env.IOS_BUNDLE_ID,
      // Reject dev-environment attestations on prod (dev worker still accepts
      // them for real-device testing). Heuristic: prod has no dev-bypass token.
      requireProduction: config.requireProduction,
    })
  } catch (e) {
    if (e instanceof AppAttestError) {
      // The message is otherwise only in the response body, which no log
      // store captures — surface it in Workers Logs for field debugging.
      console.warn('notes-import attest rejected:', e.message)
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

/**
 * POST /notes-import/verify — attested no-op for the app's dev-tools
 * diagnostics. Runs the exact verifyAssertion path the metered endpoints use
 * (challenge consumption and sign-count advance included) but touches no
 * credits and no inference, so the Tools screen can prove the full App Attest
 * boundary server-side. The probe `contentHash` is client-chosen; it's bound
 * into the signed clientData like any real import's hash.
 */
export async function handleNotesImportVerifyRequest(ctx: AppContext) {
  let body: Record<string, unknown>
  try {
    body = (await ctx.req.json()) as Record<string, unknown>
  } catch {
    return err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid JSON', 'bad_request')
  }

  const uuid = asString(body.uuid)
  const keyId = asString(body.keyId)
  const challenge = asString(body.challenge)
  const assertion = asString(body.assertion)
  const contentHash = asString(body.contentHash)
  if (!uuid || !keyId || !challenge || !assertion || !contentHash) {
    return err(
      ctx,
      HTTP_STATUS.BAD_REQUEST,
      'Missing uuid, keyId, challenge, assertion, or contentHash',
      'bad_request'
    )
  }
  // Same shape gates as kickoff: both values end up in the `|`-delimited
  // signed clientData, so keep them to their bounded alphabets.
  const accountId = body.accountId != null ? asString(body.accountId) : null
  if (body.accountId != null && (!accountId || !isValidAccountId(accountId))) {
    return err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid accountId', 'bad_request')
  }
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    return err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid contentHash', 'bad_request')
  }

  try {
    await verifyAssertion({
      kv: ctx.env.NOTES_KV,
      assertion,
      keyId,
      challenge,
      uuid,
      accountId: accountId ?? undefined,
      contentHash,
      teamId: ctx.env.APPLE_TEAM_ID,
      bundleId: ctx.env.IOS_BUNDLE_ID,
    })
  } catch (e) {
    if (e instanceof AppAttestError) {
      console.warn('notes-import verify rejected:', e.message)
      return err(ctx, HTTP_STATUS.UNAUTHORIZED, e.message, 'attestation_failed')
    }
    Sentry.captureException(e)
    return err(ctx, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Verify error', 'server_error')
  }
  return ctx.json({ ok: true })
}

interface NotesImportBody {
  uuid: string
  /** Shared account id (ADR 0011); absent on pre-account clients. */
  accountId?: string
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
  /**
   * The identity everything per-user keys on: the shared account id when the
   * client sent one, else the per-device install uuid (old clients). Names
   * the per-user index DO (credits + concurrency cap) and the RevenueCat
   * subscriber — so a Supporter's second device, which adopted the purchasing
   * device's account id, is recognized as that same RevenueCat customer
   * instead of being metered as a free user. App Attest key pinning stays on
   * `uuid`.
   */
  meterId: string
  notesText: string
  contentHash: string
  supporter: boolean
  /** Existing concurrency behavior: Supporters and dev bypass use the higher cap. */
  supporterConcurrency: boolean
  importLimit: number
  refinementLimit: number
  windowDurationMs: number
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
  // first, then the cached provider probe) and fail-open by design. Internal
  // enforcement needs availability only; allowance resolution happens once
  // below after the real entitlement is known.
  const status = await getNotesImportStatus({
    kv: ctx.env.NOTES_KV,
    env: ctx.env,
    apiKey: ctx.env.OPENROUTER_API_KEY,
    config,
    includeLimits: false,
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

  // Optional shared account id. Reject a malformed one outright rather than
  // silently falling back to the uuid — a well-behaved client never sends one,
  // and letting garbage through would put it in a DO name and a signed field.
  const accountId = body.accountId != null ? asString(body.accountId) : null
  if (body.accountId != null && (!accountId || !isValidAccountId(accountId))) {
    return {
      ok: false,
      response: err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid accountId', 'bad_request'),
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
        accountId: accountId ?? undefined,
        contentHash,
        teamId: ctx.env.APPLE_TEAM_ID,
        bundleId: ctx.env.IOS_BUNDLE_ID,
      })
    } catch (e) {
      if (e instanceof AppAttestError) {
        // The message is otherwise only in the response body, which no log
        // store captures — surface it in Workers Logs for field debugging.
        console.warn('notes-import assertion rejected:', e.message)
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
  // Everything below keys on the account id when the client sent one (per-
  // person Supporter check, credits, caps — ADR 0011), else the install uuid.
  const meterId = accountId ?? uuid

  // Keep real entitlement distinct from dev bypass: bypass overrides allowance
  // values only, while only an actual Supporter suppresses Supporter CTAs.
  let supporter = false
  if (!devBypass) {
    try {
      supporter = await isSupporter({
        apiKey: ctx.env.REVENUECAT_API_KEY,
        appUserId: meterId,
        entitlementId: config.entitlementId,
      })
    } catch (e) {
      if (!(e instanceof RevenueCatError)) Sentry.captureException(e)
      // Fail closed to non-Supporter — the free meter still lets them import.
      supporter = false
    }
  }
  const supporterConcurrency = supporter || devBypass
  const limits = await resolveNotesImportLimits(ctx.env, ctx.env.NOTES_KV)
  const allowances = selectEffectiveAllowances(limits, supporter, devBypass)
  const windowDurationMs = limitsWindowDurationMs(limits)

  const isRefinement = !!body.refinement
  // Pre-flight the credit gate in the per-user index DO (single-threaded →
  // strongly consistent, unlike the old KV read). The commit after a successful
  // run goes through the same DO, so check and charge can't race.
  const idxId = ctx.env.NOTES_IMPORT_INDEX.idFromName(meterId)
  const checked = await ctx.env.NOTES_IMPORT_INDEX.get(idxId).checkCredit({
    hash: contentHash,
    isSupporter: supporter,
    isRefinement,
    importLimit: allowances.imports,
    refinementLimit: allowances.refinements,
    windowDurationMs,
  })
  if (!checked.decision.allowed) {
    const denial = buildAllowanceDenial(
      checked.decision.reason!,
      checked.credits
    )
    return {
      ok: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: ctx.json(denial.body, denial.status as any),
    }
  }

  return {
    ok: true,
    body,
    uuid,
    meterId,
    notesText,
    contentHash,
    supporter,
    supporterConcurrency,
    importLimit: allowances.imports,
    refinementLimit: allowances.refinements,
    windowDurationMs,
    decision: checked.decision,
    isRefinement,
    devBypass,
  }
}

/**
 * Stable, content-derived import id. Idempotent per (user, content) so a
 * reconnect lands on the same run DO; a refinement is a distinct run because its
 * instruction is part of the identity. `imp_` prefix keeps DO names readable.
 * Keyed on the meter identity (account id when present) so a person's devices
 * share replay idempotency, and so an import's slot always lives in the same
 * index DO that acquired it.
 */
const deriveImportId = async (
  meterId: string,
  contentHash: string,
  refinement?: { instruction: string }
): Promise<string> => {
  const basis = refinement
    ? `${meterId}|${contentHash}|r|${refinement.instruction}`
    : `${meterId}|${contentHash}`
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
    meterId,
    notesText,
    contentHash,
    supporter,
    supporterConcurrency,
    importLimit,
    refinementLimit,
    windowDurationMs,
    decision,
    body,
    isRefinement,
  } = gate

  const importId = await deriveImportId(meterId, contentHash, body.refinement)

  // Per-user concurrency cap, enforced race-free in the single-threaded index DO.
  const cap = supporterConcurrency
    ? config.activeImportCapSupporter
    : config.activeImportCap
  const idxId = ctx.env.NOTES_IMPORT_INDEX.idFromName(meterId)
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
      uuid: meterId,
      contentHash,
      notesText,
      context: body.context,
      refinement: body.refinement,
      isSupporter: supporter,
      devBypass: gate.devBypass,
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

  // Point-in-time usage preview. It writes nothing and can differ from terminal
  // state after success, time/config/entitlement changes, or another commit.
  const credits = await ctx.env.NOTES_IMPORT_INDEX.get(idxId).kickoffCredits({
    hash: contentHash,
    decision,
    isSupporter: supporter,
    importLimit,
    refinementLimit,
    windowDurationMs,
  })

  const response = {
    importId,
    subscribeToken,
    refinement: isRefinement,
    credits,
  } satisfies NotesImportKickoffResponse
  return ctx.json(response)
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

/** Secret-protected maintainer reset; registered under the shared rate limiter. */
export function handleNotesImportAdminResetRequest(ctx: AppContext) {
  return handleAdminResetRequest(ctx.req.raw, {
    adminToken: ctx.env.ADMIN_API_TOKEN,
    indexFor: (meterId) => {
      const id = ctx.env.NOTES_IMPORT_INDEX.idFromName(meterId)
      const stub = ctx.env.NOTES_IMPORT_INDEX.get(id)
      return {
        objectId: id.toString(),
        resetUsage: () => stub.resetUsage(),
      }
    },
  })
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
    meterId,
    notesText,
    contentHash,
    supporter,
    supporterConcurrency,
    decision,
    body,
    isRefinement,
  } = gate

  // The legacy path has no run DO, so it must enforce the same per-user
  // concurrency cap itself — without it a single-second burst of DISTINCT-hash
  // requests races the meter (the very bypass this fix closes). Namespace the
  // slot key ('legacy:') so it can NEVER collide with a streaming run's
  // importId: a run DO releases by the bare importId, so a shared key would let
  // this path's finally-release drop a live streaming run's slot. Distinct keys
  // keep the two paths independent; a duplicate-content legacy burst still
  // collapses to one slot (acquire is idempotent for a held id), while the
  // distinct-hash attack takes one slot each and is capped. Synchronous path →
  // a plain try/finally release (no run DO to hand the slot off to).
  const cap = supporterConcurrency
    ? config.activeImportCapSupporter
    : config.activeImportCap
  const idxId = ctx.env.NOTES_IMPORT_INDEX.idFromName(meterId)
  const idx = ctx.env.NOTES_IMPORT_INDEX.get(idxId)
  const slotKey = `legacy:${await deriveImportId(meterId, contentHash, body.refinement)}`
  const acquired = await idx.acquire(slotKey, cap)
  if (!acquired.ok) {
    return err(
      ctx,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      `You already have ${acquired.active} imports running (max ${cap}).`,
      'active_cap'
    )
  }

  try {
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

    // Resolve terminal policy again: the success snapshot is authoritative and
    // may differ from kickoff after runtime policy or entitlement changes.
    const terminalSupporter = await resolveTerminalSupporter({
      kickoffSupporter: supporter,
      devBypass: gate.devBypass,
      apiKey: ctx.env.REVENUECAT_API_KEY,
      appUserId: meterId,
      entitlementId: config.entitlementId,
    })
    const terminalLimits = await resolveNotesImportLimits(
      ctx.env,
      ctx.env.NOTES_KV
    )
    const terminalAllowances = selectEffectiveAllowances(
      terminalLimits,
      terminalSupporter,
      gate.devBypass
    )
    const { credits, emptyCharged } = await idx.recordUsage({
      hash: contentHash,
      isSupporter: terminalSupporter,
      decision,
      importLimit: terminalAllowances.imports,
      refinementLimit: terminalAllowances.refinements,
      windowDurationMs: limitsWindowDurationMs(terminalLimits),
      isEmpty: isEmptyImportResult(output.result),
      emptyWindowSeconds: config.emptyWindowSeconds,
      emptyWindowLimit: config.emptyWindowLimit,
    })

    const response = {
      result: output.result,
      contentHash,
      refinement: isRefinement,
      emptyCharged,
      credits,
    } satisfies NotesImportSuccess
    return ctx.json(response)
  } finally {
    await idx.release(slotKey)
  }
}
