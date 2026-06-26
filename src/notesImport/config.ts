import type { Environment } from '../types'

/**
 * Resolved Notes Import configuration. Every knob is env-overridable so the
 * model/host can be swapped (ADR 0008) and the abuse ceilings tuned without a
 * code change. Defaults are deliberately generous — the goal today is to stop a
 * nefarious actor from racking up the inference bill and to keep a user from
 * blowing past the model's context window, NOT to ration normal use.
 */
/** OpenRouter reasoning effort levels, or null to leave reasoning off. */
export type ReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | null

export interface NotesImportConfig {
  model: string
  /**
   * OpenRouter provider allowlist — vetted **Western** ZDR hosts (ADR 0008),
   * IN ROUTING-PRIORITY ORDER (used for both `only` and `order`): the first is
   * preferred, the rest are fallbacks tried in turn when it errors (e.g. a 429).
   * This list controls *jurisdiction*; `zdr: true` + `data_collection: 'deny'`
   * enforce *retention* separately. Keep it Western-only: ZDR means the data
   * isn't stored, but the host still processes it in-flight, and a Western host
   * means enforceable recourse if that policy is ever broken. DeepInfra is
   * deliberately excluded — its reasoning parser misroutes the structured JSON
   * into the reasoning channel (no genuine reasoning; see llm.ts recovery path).
   */
  providers: string[]
  maxChars: number
  maxOutputTokens: number
  freeCredits: number
  maxRefinements: number
  entitlementId: string
  devBypassToken: string | null
  /** Max concurrent in-flight imports per identity (non-Supporter). */
  activeImportCap: number
  /** Max concurrent in-flight imports per identity (Supporter). */
  activeImportCapSupporter: number
  /** How long a finished import's DO retains its result for reconnect (seconds). */
  resultRetentionSeconds: number
  /** TTL of a subscribe capability token in KV (seconds). */
  subscribeTokenTtlSeconds: number
  /**
   * OpenRouter reasoning effort, or null to disable. DEFAULT `xhigh` — on
   * `deepseek-v4-flash` OpenRouter accepts only `high` and `xhigh`, and `xhigh`
   * IS the model's max ("Think Max", ~4.2× the reasoning tokens of `high`). NOTE:
   * `max` is DeepSeek's *native*-API token, NOT valid on OpenRouter — sending it
   * silently degrades to default effort, so we coerce `max → xhigh`. The notes
   * task (date-math + dedup + role inference over messy text) is exactly where
   * reasoning lifts accuracy.
   *
   * `deepseek-v4-flash` co-emits reasoning AND strict structured output (via
   * `response_format: json_schema`, which is what `Output.object` maps to — NOT
   * tool calling, which V4 rejects in thinking mode). The earlier "reasoning
   * breaks structured output" symptom was a provider-side reasoning-parser bug
   * (cf. vLLM deepseek-parser issue): a buggy ZDR host misroutes the final JSON
   * into the reasoning channel and leaves the completion blank. `runNotesImportModel`
   * recovers that JSON from the reasoning buffer, so reasoning stays on.
   */
  reasoningEffort: ReasoningEffort
}

const DEFAULTS = {
  model: 'deepseek/deepseek-v4-flash',
  // Western ZDR hosts, in routing-priority order (ADR 0008). Fireworks first —
  // the verified genuine-reasoning host; DigitalOcean is the large, reliable
  // fallback when Fireworks' shared pool is rate-limited (429). DeepInfra stays
  // excluded (mislabels reasoning). `zdr: true` gates each endpoint's retention.
  providers: ['fireworks', 'digitalocean'],
  maxChars: 100_000,
  maxOutputTokens: 16_000,
  freeCredits: 5,
  maxRefinements: 5,
  entitlementId: 'Supporter',
  activeImportCap: 2,
  activeImportCapSupporter: 5,
  resultRetentionSeconds: 3_600,
  subscribeTokenTtlSeconds: 3_600,
  // `xhigh` = the model's max ("Think Max") on OpenRouter. See the
  // NotesImportConfig.reasoningEffort doc above (and why `max` is NOT used).
  reasoningEffort: 'xhigh' as ReasoningEffort,
} as const

const REASONING_EFFORTS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
])

/**
 * Parse the reasoning-effort env override; empty / `off` / `none` disables.
 * `max` is coerced to `xhigh`: on OpenRouter's normalized API `max` is invalid
 * for `deepseek-v4-flash` (it silently degrades to default effort), and `xhigh`
 * is the model's true maximum ("Think Max").
 */
const reasoningOr = (
  raw: string | undefined,
  fallback: ReasoningEffort
): ReasoningEffort => {
  if (raw == null) return fallback
  const v = raw.trim().toLowerCase()
  if (v === '' || v === 'off' || v === 'none') return null
  if (v === 'max') return 'xhigh'
  return REASONING_EFFORTS.has(v) ? (v as ReasoningEffort) : fallback
}

const intOr = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const listOr = (raw: string | undefined, fallback: readonly string[]): string[] => {
  if (!raw) return [...fallback]
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length ? items : [...fallback]
}

export const getNotesImportConfig = (env: Environment): NotesImportConfig => ({
  model: env.NOTES_IMPORT_MODEL?.trim() || DEFAULTS.model,
  providers: listOr(env.NOTES_IMPORT_PROVIDERS, DEFAULTS.providers),
  maxChars: intOr(env.NOTES_IMPORT_MAX_CHARS, DEFAULTS.maxChars),
  maxOutputTokens: intOr(
    env.NOTES_IMPORT_MAX_OUTPUT_TOKENS,
    DEFAULTS.maxOutputTokens
  ),
  freeCredits: intOr(env.NOTES_IMPORT_FREE_CREDITS, DEFAULTS.freeCredits),
  maxRefinements: intOr(
    env.NOTES_IMPORT_MAX_REFINEMENTS,
    DEFAULTS.maxRefinements
  ),
  entitlementId:
    env.REVENUECAT_ENTITLEMENT_ID?.trim() || DEFAULTS.entitlementId,
  devBypassToken: env.NOTES_IMPORT_DEV_BYPASS_TOKEN?.trim() || null,
  activeImportCap: intOr(env.NOTES_IMPORT_ACTIVE_CAP, DEFAULTS.activeImportCap),
  activeImportCapSupporter: intOr(
    env.NOTES_IMPORT_ACTIVE_CAP_SUPPORTER,
    DEFAULTS.activeImportCapSupporter
  ),
  resultRetentionSeconds: intOr(
    env.NOTES_IMPORT_RESULT_RETENTION_SECONDS,
    DEFAULTS.resultRetentionSeconds
  ),
  subscribeTokenTtlSeconds: intOr(
    env.NOTES_IMPORT_SUBSCRIBE_TOKEN_TTL_SECONDS,
    DEFAULTS.subscribeTokenTtlSeconds
  ),
  reasoningEffort: reasoningOr(
    env.NOTES_IMPORT_REASONING_EFFORT,
    DEFAULTS.reasoningEffort
  ),
})
