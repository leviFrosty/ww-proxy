# WW Proxy

A lightweight Cloudflare Workers proxy service for HERE API endpoints with Sentry monitoring. Protects your HERE API key from client-side exposure while providing global edge performance.

## Prerequisites

- [Bun](https://bun.sh/) installed
- [Cloudflare account](https://dash.cloudflare.com/sign-up/workers-and-pages)
- [HERE API key](https://developer.here.com/)
- [Sentry account](https://sentry.io/) (optional but recommended for error logging)

## Setup

### 1. Install dependencies

```bash
bun install
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
bun run dev
```

The service will be available at `http://localhost:8787`

### Test endpoints

```bash
# Autocomplete
curl "http://localhost:8787/autocomplete?q=Seattle&limit=5"

# Geocode
curl "http://localhost:8787/geocode?q=1600+Amphitheatre+Parkway,+Mountain+View,+CA"

# Health check
curl "http://localhost:8787/health"
```

## Deployment

### Manual deployment

Set secrets (one-time setup):

```bash
bunx wrangler secret put HERE_API_KEY
# Paste your HERE API key when prompted

bunx wrangler secret put SENTRY_DSN
# Paste your Sentry DSN when prompted
```

Verify secrets are set:

```bash
bunx wrangler secret list
```

Deploy to Cloudflare Workers:

```bash
bun run deploy
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
- **Package Manager**: Bun
- **Monitoring**: Sentry
- **Wrangler**: v4.42.2
