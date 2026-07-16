# Research: admin reset mechanism for a user's Scribe usage

Wayfinder ticket: witness-work [#422](https://github.com/leviFrosty/witness-work/issues/422) (part of map [#417](https://github.com/leviFrosty/witness-work/issues/417)).
Researched 2026-07-15 against the ww-api code and current Cloudflare documentation.

## Question

Per-user Scribe usage lives in Durable Object SQLite (`NotesImportIndex`,
`src/notesImport/indexDO.ts`), one instance per meter id (RevenueCat account id
or install uuid, via `NOTES_IMPORT_INDEX.idFromName(meterId)`). The maintainer
needs an infrequent, script-driven way to reset one user's usage
window/counters from their machine. Can that reach DO storage out-of-band, or
does it need a worker route?

## 1. Out-of-band access to DO storage (2026 state)

**Reads/writes without going through your worker exist, but only as a manual
dashboard UI — nothing scriptable.**

- **Data Studio** (dashboard → Workers → Durable Objects → namespace →
  Data Studio; shipped Oct 2025): can **read and write** SQLite-backed DO
  storage — run arbitrary SQL, edit rows — targeting an object **by its
  user-provided name** (exactly our `meterId`) or by hex id. Requires the
  Workers Platform Admin role. It is **dashboard-only**: the docs describe no
  REST or wrangler equivalent, so it can't back a script. Queries are sent as
  requests to the deployed object (they bill and serialize like normal DO
  requests). Useful as a one-off manual fallback:
  `DELETE FROM credit_meta WHERE k = 'count'` against the object named
  `<meterId>` in the `NotesImportIndex` namespace.
  ([Data Studio docs](https://developers.cloudflare.com/durable-objects/observability/data-studio/),
  [changelog](https://developers.cloudflare.com/changelog/post/2025-10-16-durable-objects-data-studio/))
- **Cloudflare REST API**: the Durable Objects resource only exposes
  `GET .../workers/durable_objects/namespaces` and
  `GET .../namespaces/:id/objects` — **listing namespaces and object ids,
  read-only metadata. No storage read or write endpoints.**
  ([API reference](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/))
- **wrangler**: no `wrangler durable-objects` storage commands. Local dev
  state under `.wrangler/state` is inspectable, but that is the local
  simulator's data, not production.
- The platform docs are explicit that Durable Objects are accessed via
  Workers; the Storage/SQL API lives on `ctx.storage` inside the DO
  ([access docs](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)).

Conclusion: **a scripted reset must go through the worker.** Data Studio is a
fine manual escape hatch but not the mechanism.

## 2. Recommended approach: secret-protected admin route + DO RPC

Add one admin endpoint to ww-proxy (and ww-proxy-dev), authenticated by a
dedicated `wrangler secret`, that calls a new `resetUsage()` RPC on the user's
`NotesImportIndex` DO. This mirrors two existing patterns:

- **Dev-bypass auth** (`src/notesImport/route.ts`): compare a request header
  against a secret with `timingSafeEqual` (`src/crypto.ts`), where the secret
  being *unset* disables the path entirely.
- **KV kill-switch ops** (`notes-import:enabled`): infrequent maintainer
  actions run from the dev machine against the deployed worker.

### Server sketch

```ts
// src/notesImport/route.ts (or a new src/admin/route.ts)
export async function handleAdminResetUsageRequest(ctx: AppContext) {
  const token = ctx.env.ADMIN_API_TOKEN?.trim()
  // Fail closed AND blend in: if the secret isn't provisioned, or auth fails,
  // answer exactly like an unknown route (404) — don't advertise the endpoint.
  if (!token || !timingSafeEqual(ctx.req.header('x-ww-admin-token') ?? '', token)) {
    return ctx.notFound()
  }
  const body = await ctx.req.json().catch(() => null)
  const meterId = typeof body?.meterId === 'string' ? body.meterId : null
  if (!meterId || !isValidAccountId(meterId)) {
    return err(ctx, HTTP_STATUS.BAD_REQUEST, 'Invalid meterId', 'bad_request')
  }
  const idxId = ctx.env.NOTES_IMPORT_INDEX.idFromName(meterId)
  const result = await ctx.env.NOTES_IMPORT_INDEX.get(idxId).resetUsage()
  console.log('admin reset usage', meterId) // Workers Logs audit trail
  return ctx.json({ ok: true, meterId, ...result })
}
```

```ts
// src/notesImport/indexDO.ts — new RPC, serialized with checkCredit/recordUsage
// so a reset can't interleave with a commit.
resetUsage(): { before: number } {
  const before = this.#creditCount()
  this.ctx.storage.sql.exec("DELETE FROM credit_meta WHERE k = 'count'")
  this.ctx.storage.sql.exec('DELETE FROM empty_run')
  // hash_record stays: replays of already-charged hashes remain free (settled
  // in #417), and refinement counts are per-import, not part of the window.
  return { before }
}
```

```ts
// src/index.ts
app.post('/admin/notes-import/reset', handleAdminResetUsageRequest)
```

When the windowed model (#417) lands, `resetUsage()` also clears the window
anchor row(s) in `credit_meta`, so the user's next import starts a fresh
window — the method is the single place that knows what "reset" means.

### Secret handling

- New secret `ADMIN_API_TOKEN` (add to `Environment` in `src/types.ts` as
  optional, and to the secrets comment block in `wrangler.toml`). Provision
  per environment — secrets are per-worker, never in `[vars]`:
  - `wrangler secret put ADMIN_API_TOKEN` (prod, ww-proxy)
  - `wrangler secret put ADMIN_API_TOKEN --env dev` (ww-proxy-dev) — use a
    **different value** than prod.
- Generate with `openssl rand -base64 32`. Keep the local copies in ww-api's
  gitignored `.env` (script use) as `ADMIN_API_TOKEN` /
  `ADMIN_API_TOKEN_DEV`; document in `.dev.vars.example` without a real value.
- Do **not** reuse `NOTES_IMPORT_DEV_BYPASS_TOKEN`: it deliberately never
  exists on prod (its absence *derives* `requireProduction`), while the admin
  reset is needed on prod. Separate secret, separate blast radius — the
  admin token can spend zero inference, only reset a meter.

### Route-exposure notes

- The route exists on both workers, but with no secret set it 404s — safe
  default if a fresh environment forgets provisioning.
- 404 (not 401) on bad auth keeps the endpoint indistinguishable from a
  missing route to a prober; `timingSafeEqual` already guards the comparison.
- Register it under the existing rate-limit middleware
  (`app.use('/admin/*', rateLimitMiddleware)`) to blunt token brute-forcing.
- No App Attest on this route by design: it's maintainer-to-worker, not
  device-to-worker; App Attest can't sign a curl from a laptop.
- The handler validates `meterId` with the same `isValidAccountId` gate the
  import paths use, since the value becomes a DO name.
- Note: `idFromName` + a DO request will happily *create* an empty DO for a
  typo'd meterId; harmless (empty storage, negligible cost) but worth knowing.

### Script invocation

`package.json`:

```json
"admin:reset-usage": "./scripts/reset-usage.sh"
```

`scripts/reset-usage.sh` (reads the token from `.env`, defaults to prod,
`--dev` targets ww-proxy-dev):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
BASE="https://ww-proxy.leviwilkerson.com"; TOKEN="${ADMIN_API_TOKEN:?set in .env}"
if [[ "${1:-}" == "--dev" ]]; then
  shift; BASE="https://ww-proxy-dev.<subdomain>.workers.dev"; TOKEN="${ADMIN_API_TOKEN_DEV:?set in .env}"
fi
METER_ID="${1:?usage: pnpm run admin:reset-usage [--dev] <meterId>}"
curl -fsS -X POST "$BASE/admin/notes-import/reset" \
  -H "x-ww-admin-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"meterId\":\"$METER_ID\"}"
echo
```

Usage: `pnpm run admin:reset-usage <meterId>` /
`pnpm run admin:reset-usage --dev <meterId>`.

## Alternatives considered

- **Data Studio (manual)** — works today for a true one-off, but not
  script-driven, needs dashboard login + the right table knowledge each time,
  and won't encode the "what does reset mean" invariant once windows land.
- **REST API / wrangler direct storage access** — does not exist for writes
  (or reads) as of mid-2026.
- **Reusing the dev-bypass token** — wrong scope (dev-only by invariant) and
  wrong power (it unmeters inference; the admin token should only reset).
