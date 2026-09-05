# Runtime announcements

Announcements are published independently of an App Store release. The Worker
serves one JSON feed from R2 at `GET /announcements/current.json`. The iOS app
downloads all localized copy once, caches it, and opens the matching language
without making a translation request. A feed is at most **256 KiB**, including
all languages. Uploaded image bytes live in separate immutable R2 objects.

## Start the local editor

Install the repository dependencies with `pnpm install`. Copy `.env.example` to
the gitignored `.env` and configure the existing admin token for each environment:

```dotenv
ADMIN_API_TOKEN=your_production_admin_token
ADMIN_API_TOKEN_DEV=your_different_development_admin_token
WW_API_DEV_URL=https://ww-proxy-dev.your-subdomain.workers.dev
```

These must match the corresponding Worker's `ADMIN_API_TOKEN` secrets. The
editor uses the same local configuration as `admin:reset-usage`, but only exposes
announcement operations. Production defaults to
`https://ww-proxy.leviwilkerson.com`; `WW_API_PROD_URL` can override that origin.

```bash
pnpm admin:announcements --dev  # development Worker
pnpm admin:announcements        # production Worker
```

Open **http://127.0.0.1:4317** in your browser. Use the exact printed address;
`localhost` is deliberately a different, rejected Host. The page shows the
selected environment and Worker URL. Set `ANNOUNCEMENT_ADMIN_PORT` in `.env` if
4317 is occupied. Stop with Ctrl+C. Node 22.9+ is required for
`--env-file-if-exists`; Node 24 is recommended.

The local server holds the Worker token. Browser requests use a temporary
HttpOnly, SameSite session cookie and a separate CSRF token. The server binds
only to loopback, checks the exact Host and Origin, rejects cross-site requests,
and proxies a fixed set of routes. Credentials are never included in browser
assets, URLs, image links, translation prompts, or subprocess environments.
Editor assets are bundled from installed Milkdown packages at startup; no CDN
scripts, remote fonts, or remote editor services are loaded.

## Write, translate, and publish

1. Choose **New announcement**, **Edit current**, or a history revision's
   **Restore as draft**. The saved draft and current publication are separate.
2. Write English banner text, title, and body. Use the rich text toolbar or the
   Markdown tab. Markdown can be imported/exported as `.md`; this transfers the
   body only. Complete `.json` exports also keep the ID, options, dates, all
   translations, and translation provenance.
3. Upload PNG, JPEG, or WebP images (maximum 5 MiB each) using **Upload image**
   or the image toolbar. Add descriptive alt text. Image links are immutable
   same-Worker paths. External image URLs, raw HTML, and embedded video are not
   supported. Links may use HTTPS or mailto.
4. Set optional start/expiration times (shown in your computer's local time,
   stored as ISO UTC). Choose whether readers may dismiss the announcement and
   whether the app shows its author signature.
5. **Save draft** stores work without changing the public feed. Nothing is
   automatically saved while typing; export a backup before replacing unsaved
   edits. Concurrent admin sessions use ETags so an older editor cannot silently
   overwrite a newer draft or publication.
6. Choose **Codex** or **Claude**. **Translate missing / stale** prepares all app
   languages for review without publishing. Select a language to inspect/edit
   its banner, title, and body, then choose **Publish**. Publication uses the
   current draft and requires complete, current translations; it never invokes
   a translator. The final dialog names the environment and announcement.
   Translation failures preserve the saved draft/publication and existing
   translations; fix the error and retry.
7. **Unpublish** replaces the feed with an explicit empty announcement. The draft,
   images, and release history remain available. Clients receive the change on
   their next successful refresh; offline devices retain their cached state.

Use the **same announcement ID** for corrections: users who already dismissed
it keep their dismissal. A **new ID** announces something new and resurfaces it.
Every publication gets a fresh revision and publication timestamp; revisions
are not dismissal identities. Restoring history saves an editable draft with
the original ID, and does not publish it until you choose Publish.

## Local translation authentication

Install and sign into either the Codex CLI (`codex login`) or Claude Code
(`claude` and its normal sign-in flow) on the same computer. The admin reuses that
local login; no provider API key needs to be added to the app or Worker.
Generated copy is sent to your selected CLI's model service and is subject to
that account's access, usage limits, and billing. Nothing translates on devices.

The adapters were verified against **Codex CLI 0.153.3** and **Claude Code
2.1.261** help interfaces. Older versions that lack the isolation or structured
output flags fail rather than silently falling back to a less restricted mode.
Codex uses ephemeral noninteractive execution, an empty temporary working
directory, read-only sandbox, ignored user config/rules, disabled shell/browser/
plugin/hook tools, and a JSON schema. Claude uses safe mode, no built-in tools,
an empty MCP configuration, no session persistence, and a JSON schema. Both
receive an environment allowlist without admin tokens and a prompt explicitly
prohibiting tools or command execution. Temporary output/schema files are
removed after each run. Each run has a six-minute timeout and a 1 MiB combined
output limit.

The model can return only localized copy, never identity, dates, or display
options. Validation requires the requested language set, nonempty fields,
length limits, exactly preserved link/image destinations, and the WitnessWork
product name. All translations are accepted together or rejected together.
Generated translations are marked `machine`; manually edited ones are marked
`reviewed`. These labels describe provenance, not a guarantee of linguistic
accuracy. Changing English marks translations stale through a SHA-256 source
hash, and the publication path requires complete, current translations.

Supported locales: `en-us`, `de-de`, `es-es`, `fr-fr`, `it-it`, `ja-jp`, `ko-kr`,
`nl-nl`, `pt-br`, `pt-pt`, `ru-ru`, `vi-vn`, `zh-hant-tw`, `zh-hans-cn`, `sw-ke`,
`uk-ua`, `bem-zm`, `rw-rw`. English is mandatory. The Worker can accept partial
language sets for low-level operations; the local editor publishes all 18.

## R2 setup and operations

Create distinct environment buckets using Wrangler and match the `ANNOUNCEMENTS_BUCKET`
bindings in `wrangler.toml`. Buckets must remain private; the Worker serves the
validated public paths.

```bash
pnpm exec wrangler r2 bucket create ww-announcements
pnpm exec wrangler r2 bucket create ww-announcements-dev
pnpm exec wrangler secret put ADMIN_API_TOKEN
pnpm exec wrangler secret put ADMIN_API_TOKEN --env dev
```

Deploy using this repository's normal release process only after the bindings
and matching secrets are configured. The local editor does not deploy anything.
For local-only testing, run `pnpm dev` or
`pnpm exec wrangler dev --env dev`, set `WW_API_DEV_URL=http://127.0.0.1:8787` and
`ADMIN_API_TOKEN_DEV` to the token supplied in the local `.dev.vars`, then start
the admin with `--dev`. Local R2 uses Wrangler's persisted development storage.

Worker management endpoints require `Authorization: Bearer <ADMIN_API_TOKEN>`
and return `Cache-Control: no-store`:

| Route                                 | Operation                                           |
| ------------------------------------- | --------------------------------------------------- |
| `GET /admin/announcements/status`     | Current feed, current ETag, draft ETag              |
| `GET /admin/announcements/draft`      | Saved draft and ETag, or 404                        |
| `PUT /admin/announcements/draft`      | Save with `If-Match`, or initial `If-None-Match: *` |
| `POST /admin/announcements/publish`   | `{draftEtag}` and `If-Match` current ETag           |
| `POST /admin/announcements/unpublish` | `If-Match` current ETag                             |
| `GET /admin/announcements/history`    | Latest 100 published revisions                      |
| `POST /admin/announcements/images`    | Raw PNG/JPEG/WebP body with matching Content-Type   |

Public immutable releases are at
`/announcements/releases/<revision>.json`; images are at
`/announcements/images/<sha256>.<extension>`. Old immutable URLs remain public
after unpublishing, so announcements must contain public information only.
History restores a release into a draft. Missing/stale write preconditions
return 428/412. On 412, export current edits, reload saved state, reconcile the
changes, and save again. Missing configuration/bad authorization returns 404.

Examples are in `examples/announcements/`. Run `pnpm test:announcement-admin`
for the local proxy/translation/publication safety tests and `pnpm test` for
the Worker tests.

Implementation references:
[Milkdown Crepe](https://milkdown.dev/docs/guide/using-crepe),
[Milkdown image uploads](https://milkdown.dev/docs/api/component-image-block),
[official OpenAI noninteractive execution](https://developers.openai.com/codex/noninteractive/),
[Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).
