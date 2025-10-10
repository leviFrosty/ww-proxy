import * as Sentry from '@sentry/cloudflare';
import type { Environment } from './types';

export function createSentryConfig(environment: Environment) {
  return {
    dsn: environment.SENTRY_DSN,
    tracesSampleRate: 1.0,
    sendDefaultPii: true,
  };
}

export { Sentry };
