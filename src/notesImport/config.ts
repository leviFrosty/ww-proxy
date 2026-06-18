import type { Environment } from '../types'

/**
 * Resolved Notes Import configuration. Every knob is env-overridable so the
 * model/host can be swapped (ADR 0008) and the abuse ceilings tuned without a
 * code change. Defaults are deliberately generous — the goal today is to stop a
 * nefarious actor from racking up the inference bill and to keep a user from
 * blowing past the model's context window, NOT to ration normal use.
 */
export interface NotesImportConfig {
  model: string
  /** Provider `only` allowlist for the gateway — vetted Western ZDR hosts. */
  providers: string[]
  maxChars: number
  maxOutputTokens: number
  freeCredits: number
  maxRefinements: number
  entitlementId: string
  devBypassToken: string | null
}

const DEFAULTS = {
  model: 'deepseek/deepseek-v4-flash',
  providers: ['fireworks', 'deepinfra', 'baseten', 'azure'],
  maxChars: 100_000,
  maxOutputTokens: 16_000,
  freeCredits: 5,
  maxRefinements: 5,
  entitlementId: 'Supporter',
} as const

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
})
