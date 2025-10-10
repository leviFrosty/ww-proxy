# WW Proxy

A Cloudflare Workers proxy service for HERE API endpoints with IP-based rate limiting and Sentry monitoring.

## Features

- **API Key Protection**: Hides HERE API key from client-side requests
- 📊 **Monitoring**: Sentry integration for error tracking and analytics
- ⚡ **Global Edge**: Deployed on Cloudflare Workers for low latency worldwide
- 🎯 **Autocomplete & Geocoding**: Proxies HERE Geocode and Autocomplete APIs

## Prerequisites

- [Bun](https://bun.sh/) installed
- [Cloudflare account](https://dash.cloudflare.com/sign-up/workers-and-pages)
- [HERE API key](https://developer.here.com/)
- [Upstash Redis database](https://upstash.com/)
- [Sentry account](https://sentry.io/) (optional but recommended)

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
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_token
```

### 3. Configure rate limits (optional)

Edit `wrangler.toml` to adjust rate limiting:

```toml
[vars]
RATE_LIMIT_REQUESTS = "100"          # Number of requests allowed
RATE_LIMIT_WINDOW_SECONDS = "3600"   # Time window in seconds (1 hour)
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

```bash
# Set secrets (one-time setup)
bunx wrangler secret put HERE_API_KEY
bunx wrangler secret put SENTRY_DSN
bunx wrangler secret put UPSTASH_REDIS_REST_URL
bunx wrangler secret put UPSTASH_REDIS_REST_TOKEN

# Deploy
bun run deploy
```

### Automatic deployment via GitHub Actions

The project includes CI/CD that deploys automatically on git tags:

1. **Add GitHub secrets** (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN`
   - `HERE_API_KEY`
   - `SENTRY_DSN`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

2. **Create and push a tag**:

```bash
git tag v1.0.0
git push origin v1.0.0
```

3. **Monitor deployment** in the Actions tab on GitHub

### Get Cloudflare API Token

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click "Create Token"
3. Use "Edit Cloudflare Workers" template
4. Copy the token and add it to GitHub secrets

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
- All other [HERE Autocomplete API parameters](https://developer.here.com/documentation/geocoding-search-api/dev_guide/topics/endpoint-autocomplete-brief.html)

### `/geocode`

Proxies to HERE Geocode API.

**Example request:**

```bash
curl "https://your-worker.workers.dev/geocode?q=1600+Amphitheatre+Parkway"
```

**Query parameters:**

- `q`: Address to geocode (required)
- All other [HERE Geocode API parameters](https://developer.here.com/documentation/geocoding-search-api/dev_guide/topics/endpoint-geocode-brief.html)

### `/health`

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-11-27T12:34:56.789Z"
}
```

## Rate Limiting

- Limits are applied per client IP address
- Uses token bucket algorithm via Upstash Redis
- Default: 100 requests per hour
- Rate limit info included in response headers:
  - `X-RateLimit-Limit`: Total requests allowed
  - `X-RateLimit-Remaining`: Requests remaining
  - `X-RateLimit-Reset`: Unix timestamp when limit resets

**Rate limit exceeded response (429):**

```json
{
  "error": "Rate limit exceeded",
  "limit": 100,
  "remaining": 0,
  "resetAt": "2024-11-27T13:00:00.000Z"
}
```

## Architecture

```
Client Request
    ↓
Cloudflare Workers (Global Edge)
    ↓
Rate Limiter (Upstash Redis)
    ↓
Hono Router
    ↓
HERE API Proxy
    ↓
Response to Client
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Language**: TypeScript
- **Package Manager**: Bun
- **Rate Limiting**: Upstash Redis
- **Monitoring**: Sentry
- **CI/CD**: GitHub Actions

## License

MIT
