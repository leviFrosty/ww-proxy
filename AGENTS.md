# Agent guide — ww-proxy

This codebase is the backend API that powers the WitnessWork expo (react native) application found at ~/dev/witness-work.

A Cloudflare Workers API/proxy (HERE API, iOS universal links, Notes Import). See
`README.md` for general setup; this file documents agent-relevant operational
details, primarily the **environments**.

## Environments

There are two deployed Workers, defined in `wrangler.toml`:

| Env  | Worker name    | URL                                          | Deploy command              |
| ---- | -------------- | -------------------------------------------- | --------------------------- |
| prod | `ww-proxy`     | `https://ww-proxy.leviwilkerson.com`         | `wrangler deploy`           |
| dev  | `ww-proxy-dev` | `https://ww-proxy-dev.<subdomain>.workers.dev` | `wrangler deploy --env dev` |

`dev` is a **fully separate Worker** — its own name, KV namespace, rate-limit
namespace, secrets, and `workers.dev` URL. `wrangler deploy --env dev` can never
overwrite prod. Plain `wrangler deploy` always targets prod, so the `--env dev`
flag is the isolation boundary.

The dev worker exists for **real-device App Attest end-to-end testing**: it pins
to the dev iOS bundle id `com.leviwilkerson.jwtimedev` (from witness-work
`app.config.ts`, `IS_DEV` branch) and is the only place
`NOTES_IMPORT_DEV_BYPASS_TOKEN` should ever be set — **never on prod.**

Note: in Wrangler, `vars`, `kv_namespaces`, and `ratelimits` are **not inherited**
by a named env, so they are repeated under `[env.dev]` in `wrangler.toml`. Keep
them in sync with the top-level prod config when adding new bindings.

## Deploying to dev (one-time setup)

```bash
# 1. Create a dedicated dev KV namespace, then paste the printed id into
#    wrangler.toml under [[env.dev.kv_namespaces]] (replacing REPLACE_WITH_DEV_NOTES_KV_ID).
wrangler kv namespace create NOTES_KV --env dev

# 2. Set the dev worker's secrets (the --env dev flag keeps them off prod).
wrangler secret put OPENROUTER_API_KEY --env dev
wrangler secret put REVENUECAT_API_KEY --env dev
wrangler secret put NOTES_IMPORT_DEV_BYPASS_TOKEN --env dev   # dev only
# Plus any other secrets prod uses that dev needs (HERE_API_KEY, SENTRY_DSN, ...).

# 3. Deploy.
wrangler deploy --env dev
```

After setup, redeploying dev is just:

```bash
wrangler deploy --env dev
```

## Local iteration (no deploy)

```bash
wrangler dev                 # local runtime
wrangler dev --remote --env dev   # Cloudflare edge with dev bindings
```

Neither gives a stable public URL for an iOS device — use the deployed
`--env dev` worker (or a `cloudflared` tunnel) for real-device App Attest tests.

## Checks before deploy

```bash
pnpm test
pnpm exec tsc --noEmit
wrangler deploy --dry-run            # prod build
wrangler deploy --env dev --dry-run  # dev build
```

## Backlog

- **Notes Import streaming / Durable Objects migration** — DONE (2026-06-23).
  The model run now streams from two SQLite Durable Objects (`NotesImportRun`
  per import, `NotesImportIndex` per user for the concurrency cap), via AI SDK
  v6 `streamText` + `Output.object`. Attested kickoff (`POST
  /notes-import/kickoff`) → SSE progress stream (`GET /notes-import/:id/events`)
  → result snapshot (`/result`); the legacy `POST /notes-import` remains as a
  fallback. First deploy applies the `v1` DO migration automatically (prod +
  `--env dev`). Reasoning is ON by default at `xhigh`
  (`NOTES_IMPORT_REASONING_EFFORT`) — on OpenRouter `deepseek-v4-flash` accepts
  only `high`/`xhigh`, and `xhigh` IS its max ("Think Max"); `max` is invalid
  there and coerced to `xhigh`. The model co-emits reasoning and strict
  structured output. A buggy ZDR-host parser can misroute the JSON into the
  reasoning channel (blank completion); the run DO recovers it, so reasoning
  stays on. `usage.reasoningTokens` is logged per run. Architecture + resolved
  decisions:
  [`docs/notes-import-streaming-durable-objects.md`](docs/notes-import-streaming-durable-objects.md).
