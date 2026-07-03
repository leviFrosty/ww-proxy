import * as Sentry from '@sentry/cloudflare';
import type { Environment } from './types';

export function createSentryConfig(environment: Environment) {
  return {
    dsn: environment.SENTRY_DSN,
    // Must match the release name used when uploading source maps
    // (`pnpm run sentry:sourcemaps` — the git commit sha). Sentry resolves
    // minified stack frames against the artifacts uploaded for this release.
    release: environment.SENTRY_RELEASE,
    tracesSampleRate: 1.0,
    sendDefaultPii: true,
  };
}

export { Sentry };
