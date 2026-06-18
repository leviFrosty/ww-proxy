import type { Context } from 'hono';

export interface Environment {
  HERE_API_KEY: string;
  SENTRY_DSN: string;
  APP_VERSION: string;
  COMMIT_SHA: string;
  /**
   * Apple Developer Team ID. Injected into the AASA response so iOS can
   * verify that the declared bundle IDs belong to this team. Also the App ID
   * prefix used to derive the App Attest relying-party id (`<team>.<bundle>`).
   */
  APPLE_TEAM_ID: string;
  RATE_LIMITER: RateLimit;

  // --- Notes Import ------------------------------------------------------

  /**
   * KV namespace backing Notes Import. Stores ONLY non-content metadata:
   * App Attest challenges + device keys, and per-identity usage counters
   * (`{hash → counter}`). Never notes text or model output (ADR 0008).
   */
  NOTES_KV: KVNamespace;

  /** Vercel AI Gateway API key (secret). Reaches the ZDR inference host. */
  AI_GATEWAY_API_KEY: string;

  /** RevenueCat REST v1 secret key (`sk_...`) for server-side supporter checks (secret). */
  REVENUECAT_API_KEY: string;

  /** iOS bundle id, e.g. `com.leviwilkerson.jwtime`. Part of the App Attest app id. */
  IOS_BUNDLE_ID: string;

  /** RevenueCat entitlement id that denotes a Supporter. Default `Supporter`. */
  REVENUECAT_ENTITLEMENT_ID?: string;

  /** Override the model slug. Default `deepseek/deepseek-v4-flash`. */
  NOTES_IMPORT_MODEL?: string;

  /**
   * Comma-separated Vercel AI Gateway provider allowlist (the `only` filter).
   * Pins inference to vetted Western ZDR hosts. Default
   * `fireworks,deepinfra,baseten,azure`.
   */
  NOTES_IMPORT_PROVIDERS?: string;

  /** Hard reject notes longer than this many characters. Default 100000. */
  NOTES_IMPORT_MAX_CHARS?: string;

  /** `maxOutputTokens` ceiling for the model call. Default 16000. */
  NOTES_IMPORT_MAX_OUTPUT_TOKENS?: string;

  /** Free distinct-content imports per non-Supporter identity. Default 5. */
  NOTES_IMPORT_FREE_CREDITS?: string;

  /** Max stateless follow-up refinements per content hash. Default 5. */
  NOTES_IMPORT_MAX_REFINEMENTS?: string;

  /**
   * When set, a request carrying header `x-ww-dev-bypass: <this value>` skips
   * App Attest verification. Set ONLY on a dev/staging worker so the iOS
   * simulator (no Secure Enclave) can exercise the flow. Unset in production.
   */
  NOTES_IMPORT_DEV_BYPASS_TOKEN?: string;
}

export type AppContext = Context<{ Bindings: Environment }>;

export interface HealthCheckResponse {
  status: 'ok';
  timestamp: string;
  version: string;
  commit: string;
}

export interface ErrorResponse {
  error: string;
  /** Stable machine-readable code so the app can branch (e.g. show the paywall). */
  code?: string;
}
