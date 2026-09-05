# Runtime announcements

Announcements are independent of Notes Import, App Attest, Supporter status, and
app releases. A private R2 bucket contains one saved draft, a current publication
pointer, immutable release JSON, and immutable uploaded images. Only explicit
Worker routes expose published JSON and images. Keep R2 public access disabled.

## Environments and setup

| Worker                     | Binding                | Private bucket         |
| -------------------------- | ---------------------- | ---------------------- |
| Production `ww-proxy`      | `ANNOUNCEMENTS_BUCKET` | `ww-announcements`     |
| Development `ww-proxy-dev` | `ANNOUNCEMENTS_BUCKET` | `ww-announcements-dev` |

Create the two buckets once before deploying this code:

```sh
pnpm exec wrangler r2 bucket create ww-announcements
pnpm exec wrangler r2 bucket create ww-announcements-dev
```

Each Worker uses its existing, environment-specific `ADMIN_API_TOKEN` secret for
maintainer requests. Generate a strong token with `openssl rand -base64 32` if
one is not already configured. Never reuse the development bypass token, put an
admin token in the app, or send it to a browser. The local admin server reads
`.env` credentials and proxies authenticated requests server-side; its browser
never needs a Worker credential. See `docs/announcements-admin.md` for the local
editor workflow.

Local `wrangler dev` uses local R2 storage and `.dev.vars`. Neither bucket data
nor secrets are inherited between the two deployed environments. Normal deploy
scripts still perform the project's Sentry release/source-map workflow.

## Public contract

`GET /announcements/current.json` (also `HEAD`) returns one full JSON document:

```json
{
  "schemaVersion": 1,
  "announcement": {
    "id": "september-update",
    "revision": "518d0dc7-3c83-4071-a5f1-b8b64dc053d1",
    "publishedAt": "2026-09-05T12:00:00.000Z",
    "startsAt": "2026-09-05T12:00:00.000Z",
    "expiresAt": "2026-10-01T00:00:00.000Z",
    "dismissible": true,
    "signature": true,
    "locales": {
      "en-us": {
        "bannerText": "An update from Levi",
        "title": "What's new",
        "markdown": "A short **announcement**."
      }
    }
  }
}
```

An unpublished feed is `{"schemaVersion":1,"announcement":null}`. Dates
`startsAt` and `expiresAt` are optional. The client applies their display window
and locale fallback; the Worker serves the same document to every client. An
announcement's stable `id` is the dismissal identity. Publishing generates a new
`revision` and `publishedAt`; changes to wording do not require a new `id`.

Locale keys are canonical app keys: `en-us`, `de-de`, `es-es`, `fr-fr`, `it-it`,
`ja-jp`, `ko-kr`, `nl-nl`, `pt-br`, `pt-pt`, `ru-ru`, `vi-vn`, `zh-hant-tw`,
`zh-hans-cn`, `sw-ke`, `uk-ua`, `bem-zm`, `rw-rw`. English is mandatory; the
server permits an English-only publication. The local editor requires all 18
languages to be current; translate and review missing or stale locales before
choosing Publish.

Content limits: 256 KiB UTF-8 for the complete JSON document; 180 characters for
banner text, 160 for the title, 12,000 for Markdown per locale. IDs contain
1–80 ASCII letters, digits, underscores, or hyphens and start with a letter or
digit. Unknown fields/locales are rejected. Markdown is parsed with markdown-it
before validation: raw HTML is rejected, link destinations must use `https:`
or `mailto:` without URL credentials, and images must use an uploaded relative
path `/announcements/images/<64-character-sha256>.(png|jpg|webp)`. Reference-style
Markdown links and images receive the same validation.

`GET /announcements/releases/<revision>.json` returns an immutable full feed
snapshot. `GET /announcements/images/<sha256>.<extension>` returns its immutable
image. These are the only public object namespaces; bucket keys and arbitrary
paths cannot be read through the Worker.

## Cache and availability

The Worker explicitly uses the Cache API for public reads, with a canonical
host/path cache key that excludes query parameters and request headers. Current
JSON is cached for one hour (`public, max-age=3600, s-maxage=3600`), including the
empty feed. Images/releases use one year plus `immutable`. Responses carry
quoted ETags; weak and comma-separated `If-None-Match` validators receive `304`.
Public requests never consume Notes Import rate limits or require authentication.
On cache misses, current JSON is validated and encoded once, then that exact
encoded feed is reused for the response. This preserves corruption/content
guards while avoiding a second Markdown parse across all locales. A local
18-locale, 262 KiB benchmark reduced validation/serialization from about 5.1 ms
to 2.6 ms median; this is a local measurement, not a Cloudflare CPU guarantee.

Publishing/unpublishing invalidates the handling POP's current-feed cache. Cache
API deletion is local to that POP: other locations and device caches may show
the preceding feed for up to an hour. This is a deliberate freshness/cost
tradeoff, not a global instant kill switch. No unbounded `stale-if-error` is
advertised. Storage failures return `503` with `Cache-Control: no-store`; clients
should preserve only their bounded stale copy and otherwise hide announcements.
Admin responses and all error responses are `no-store`.

## Admin API

All routes below require `Authorization: Bearer <ADMIN_API_TOKEN>`. Missing
configuration or failed authentication returns `404`, without accessing R2.
These routes use the existing maintainer rate limit. There are no browser CORS
permissions or public write endpoints.

| Method/path                           | Request                                                            | Response                                                          |
| ------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `GET /admin/announcements/status`     | —                                                                  | `{current: Feed, currentEtag: string, draftEtag: string \| null}` |
| `GET /admin/announcements/draft`      | —                                                                  | Draft JSON, `ETag` header; `404` if absent                        |
| `PUT /admin/announcements/draft`      | Draft JSON; `If-Match: <draftEtag>`, or initial `If-None-Match: *` | Saved Draft JSON, new `ETag`                                      |
| `POST /admin/announcements/publish`   | `{draftEtag: string}`; `If-Match: <currentEtag>`                   | `{current: Feed, currentEtag: string}`                            |
| `POST /admin/announcements/unpublish` | No body; `If-Match: <currentEtag>`                                 | `{current: Feed, currentEtag: string}`                            |
| `GET /admin/announcements/history`    | —                                                                  | `{items: [{revision, id, publishedAt, url}]}`                     |
| `POST /admin/announcements/images`    | Raw image bytes, matching `Content-Type`                           | `201 {url: relativeImagePath}`                                    |

A Draft is `{schemaVersion: 1, announcement: ...}` using the public announcement
fields without `revision` or `publishedAt`. Optional private fields are
`translationStatus: {[locale]: "machine" | "reviewed"}` and
`translationSourceHash` (64 lowercase hexadecimal characters, the local editor's
English-source hash). For any publication containing a non-English locale, the
Worker requires this hash to match SHA-256 of
`JSON.stringify({bannerText, title, markdown})` from the current English copy, in
that field order. This prevents direct API callers from publishing known stale
translations. Draft saves still permit stale/missing provenance so work can be
resumed; English-only publication needs no hash. Copy whitespace is preserved
exactly. Neither private field appears in public JSON.

Missing write preconditions return `428`. A stale draft/current ETag returns
`412`, including simultaneous publication races. The editor must reload and let
the maintainer inspect newer state; it must not silently retry a conflicting
write. Invalid input returns `400`, oversized bodies `413`, and invalid images
`415`. Request streams are bounded even without a Content-Length header.

Uploads accept only PNG/JPEG/WebP, require matching header-byte signatures and
Content-Type, and are limited to 5 MiB. SVG, HTML, and arbitrary files are
rejected. SHA-256 filenames deduplicate identical uploads; conditional writes
prevent overwriting an existing immutable image. Image responses include
`nosniff` and a restrictive CSP.

To restore a historical publication, load its `url`, remove `revision` and
`publishedAt`, and conditionally save it as the draft. Review and explicitly
publish it. Restoring does not immediately alter the public feed.

## Atomicity and storage

`private/current.json` wraps `{generation, feed, history}`. A new random
generation is written even for an empty/unpublished tombstone so an old ETag
cannot become valid again after an unpublish cycle. The pointer is never
deleted. R2 conditional `put` swaps the pointer only if the reviewed ETag still
matches; concurrent changes have exactly one winner.

Publishing reads and verifies the supplied saved-draft ETag, builds an immutable
release, then performs that conditional pointer swap. It publishes the reviewed
snapshot; another editor can independently save a later draft while publication
runs. A failed pointer swap can leave an unreferenced immutable release, but it
never changes the current feed or the successful publication history. History
is stored inside the atomic pointer and exposes the most recent 100 successful
publications, newest first. Older immutable releases remain accessible by their
known URL; image/release garbage collection is intentionally not automated.

R2's Workers API documents conditional writes returning null on precondition
failure and strong read-after-write consistency:
[Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
Cloudflare documents the POP-local cache behavior:
[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/).

## Verification

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler deploy --env dev --dry-run
```

Announcement tests cover auth isolation, private-path denial, conditional draft
writes, stale review rejection, concurrent publish winners, tombstone ETags,
private metadata exclusion, immutable release/image reads, feed edge caching,
conditional GETs, non-cacheable failures, Markdown destination validation,
canonical locale/date/content limits, and bounded image/JSON uploads.
