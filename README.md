# WW API

A lightweight Cloudflare Workers api and proxy service for HERE API endpoints, iOS universal links, etc. with Sentry monitoring.

## Prerequisites

- [pnpm](https://pnpm.io/) installed
- [Cloudflare account](https://dash.cloudflare.com/sign-up/workers-and-pages)
- [HERE API key](https://developer.here.com/)
- [Sentry account](https://sentry.io/) (optional but recommended for error logging)

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Copy the example file and fill in your credentials:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your actual values:

```bash
HERE_API_KEY=your_here_api_key
SENTRY_DSN=https://your-sentry-dsn@sentry.io/project-id
```

## Development

Run the development server:

```bash
pnpm run dev
```

The service will be available at `http://localhost:8787`

### Test endpoints

```bash
# Autocomplete
curl "http://localhost:8787/autocomplete?q=cincinnati&limit=5"

# Geocode
curl "http://localhost:8787/geocode?q=48 Muir+Rd,+Rogers,+KY+41365"

# Health check
curl "http://localhost:8787/health"
```

## Deployment

### Manual deployment

Set secrets (one-time setup):

```bash
pnpm exec wrangler secret put HERE_API_KEY
# Paste your HERE API key when prompted

pnpm exec wrangler secret put SENTRY_DSN
# Paste your Sentry DSN when prompted
```

Verify secrets are set:

```bash
pnpm exec wrangler secret list
```

Deploy to Cloudflare Workers:

```bash
pnpm run deploy
```

### Automatic deployment via GitHub Actions

The project includes CI/CD that deploys automatically on git tags.

#### 1. Add GitHub secrets

Go to your repo → Settings → Secrets and variables → Actions

Add these secrets:

- `CLOUDFLARE_API_TOKEN` - [Get from Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
- `HERE_API_KEY` - Your HERE API key
- `SENTRY_DSN` - Your Sentry DSN

#### 2. Get Cloudflare API Token

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click "Create Token"
3. Use "Edit Cloudflare Workers" template
4. Copy the token and add it to GitHub secrets as `CLOUDFLARE_API_TOKEN`

#### 3. Deploy by pushing a tag

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions will automatically deploy to Cloudflare Workers. Monitor deployment in the Actions tab.

## API Endpoints

### `/autocomplete`

Proxies to HERE Autocomplete API.

**Example request:**

```bash
curl "https://your-worker.workers.dev/autocomplete?q=Seattle&limit=5"
```

**Query parameters:**

- `q`: Search query (required)
- `limit`: Max number of suggestions
- `in`: Geographic filter (e.g., `circle:47.6,-122.3;r=50000`)
- All other [HERE Autocomplete API parameters and docs](https://www.here.com/docs/bundle/geocoding-and-search-api-developer-guide/page/topics/endpoint-autocomplete-brief.html)

**Note:** The `apiKey` parameter is automatically injected by the proxy. Any `apiKey` sent by the client will be removed.

### `/geocode`

Proxies to HERE Geocode API.

**Example request:**

```bash
curl "https://your-worker.workers.dev/geocode?q=1600+Amphitheatre+Parkway"
```

**Query parameters:**

- `q`: Address to geocode (required)
- All other [HERE Geocode API parameters and docs](https://www.here.com/docs/bundle/geocoding-and-search-api-developer-guide/page/topics-api/code-geocode-address.html)

**Note:** The `apiKey` parameter is automatically injected by the proxy. Any `apiKey` sent by the client will be removed.

### `/.well-known/apple-app-site-association`

Serves the AASA JSON used by iOS to validate universal links for contact
sharing. Lists both dev (`com.leviwilkerson.jwtimedev`) and prod
(`com.leviwilkerson.jwtime`) bundle IDs, prefixed with `APPLE_TEAM_ID`.

Matches any URL under `/c/*`.

### `/c/:payload`

Universal-link landing page for shared WitnessWork contacts. iOS hands the
request off to the WitnessWork app when installed; otherwise this endpoint
serves a fallback HTML page with an App Store CTA.

The `payload` segment is an opaque gzip + base64url–encoded contact export
produced by the app — the worker never decodes it.

### Notes Import (`/notes-import*`)

LLM-backed parsing of free-form ministry notes into structured WitnessWork
records. The proxy owns the prompt + JSON schema, calls the model through the
Vercel AI Gateway pinned to a Western zero-data-retention host (ADR 0008), and
meters free usage. It persists **only** counters and device keys in KV — never
notes text or model output.

Three routes (all rate-limited, all `POST`):

- **`/notes-import/challenge`** → `{ challenge }`. One-time App Attest nonce.
- **`/notes-import/attest`** `{ keyId, attestation, challenge, uuid }` → `{ ok }`.
  The App Attest handshake; verifies the attestation and stores the device's
  public key pinned to the Keychain `uuid` (ADR 0007).
- **`/notes-import`** `{ uuid, notesText, contentHash, context, keyId, challenge,
  assertion, refinement? }` → `{ result, contentHash, refinement, credits }`.
  Verifies the per-request App Attest assertion (the security boundary), checks
  Supporter status via RevenueCat + the free-credit cap, then runs the model.

Auth is enforced by Apple **App Attest** on every call. A dev/staging worker may
set `NOTES_IMPORT_DEV_BYPASS_TOKEN` so the iOS simulator can send
`x-ww-dev-bypass: <token>` to skip attestation. **Never set it in production.**

**One-time setup** (beyond HERE/Sentry):

```bash
# KV namespace for challenges, device keys, and usage counters
pnpm exec wrangler kv namespace create NOTES_KV
# → paste the printed id into wrangler.toml [[kv_namespaces]] id

pnpm exec wrangler secret put AI_GATEWAY_API_KEY   # Vercel AI Gateway key
pnpm exec wrangler secret put REVENUECAT_API_KEY   # RevenueCat REST v1 secret (sk_...)
```

All Notes Import limits (model, provider allowlist, char ceiling, free credits,
refinement cap) are env-overridable — see `src/notesImport/config.ts`.

### `/health`

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-11-27T12:34:56.789Z"
}
```

## Error Responses

All errors return JSON with an `error` field:

```json
{
  "error": "Error message"
}
```

All errors are automatically reported to Sentry with full context.

## Architecture

```
Client Request
    ↓
Cloudflare Workers (Global Edge)
    ↓
Hono Router
    ↓
API Key Injection & Sanitization
    ↓
HERE API
    ↓
Response to Client

(Sentry monitors all errors)
```

## Stack

- **Runtime**: Cloudflare Workers with `nodejs_compat`
- **Framework**: [Hono](https://hono.dev/)
- **Language**: TypeScript
- **Package Manager**: pnpm
- **Monitoring**: Sentry
- **Wrangler**: v4.42.2
