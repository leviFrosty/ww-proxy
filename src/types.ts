import type { Context } from 'hono';

export interface Environment {
  HERE_API_KEY: string;
  SENTRY_DSN: string;
}

export type AppContext = Context<{ Bindings: Environment }>;

export interface HealthCheckResponse {
  status: 'ok';
  timestamp: string;
}

export interface ErrorResponse {
  error: string;
}
