import type { Context } from 'hono';

export interface Environment {
  HERE_API_KEY: string;
  SENTRY_DSN: string;
  APP_VERSION: string;
  COMMIT_SHA: string;
  /**
   * Apple Developer Team ID. Injected into the AASA response so iOS can
   * verify that the declared bundle IDs belong to this team.
   */
  APPLE_TEAM_ID: string;
  RATE_LIMITER: RateLimit;
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
}
