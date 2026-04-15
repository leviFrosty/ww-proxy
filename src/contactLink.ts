import type { AppContext } from './types'
import { HTTP_STATUS } from './config'

/**
 * Contact-share universal link handlers.
 *
 * Flow: the WitnessWork app encodes a contact (gzip + base64url) into a path
 * segment and shares a URL like:
 *
 *   https://ww-proxy.leviwilkerson.com/c/<payload>
 *
 * - iOS with the app installed: the OS intercepts the tap via the AASA file
 *   this worker serves and hands the URL to the app, which decodes and imports.
 * - iOS without the app / other platforms: the fallback HTML renders with a
 *   "Get WitnessWork" CTA linking to the App Store.
 *
 * The AASA lists BOTH the dev and prod bundle IDs so development builds also
 * intercept these links on devices where they're installed.
 */

const PROD_BUNDLE_ID = 'com.leviwilkerson.jwtime'
const DEV_BUNDLE_ID = 'com.leviwilkerson.jwtimedev'
const APP_STORE_URL = 'https://apps.apple.com/us/app/jw-time/id6469723047'
const CONTACT_LINK_PATH_PREFIX = '/c/'
const SITE_ORIGIN = 'https://ww-proxy.leviwilkerson.com'
const OG_IMAGE_URL = `${SITE_ORIGIN}/assets/og-image.png`
const APPLE_TOUCH_ICON_URL = `${SITE_ORIGIN}/assets/apple-touch-icon.png`

/**
 * WitnessWork brand palette — mirrors `lightModeColors` in
 * `witness-work/src/constants/theme.ts`. Keep in sync if the app theme
 * changes.
 */
const BRAND = {
  accent: '#08cc50',
  accentBackground: '#4BD27C',
  accent3: '#003D46',
  text: '#373737',
  textInverse: '#FFFFFF',
  backgroundLightest: '#F0F0F0',
  card: '#FFFFFF',
  border: '#dbdbdb',
} as const

const OG_TITLE = 'Open this contact in WitnessWork'
const OG_DESCRIPTION =
  'A contact was shared with you from WitnessWork — the service time and contact management app for Jehovah\u2019s Witnesses.'

/**
 * Apple strongly recommends `components` over the legacy `paths` array. Both
 * still work, but `components` supports per-pattern exclusions and query
 * matchers. We match any URL whose path begins with `/c/`.
 */
function buildAasaPayload(teamId: string): object {
  const appIDs = [
    `${teamId}.${PROD_BUNDLE_ID}`,
    `${teamId}.${DEV_BUNDLE_ID}`,
  ]
  return {
    applinks: {
      details: [
        {
          appIDs,
          components: [{ '/': `${CONTACT_LINK_PATH_PREFIX}*` }],
        },
      ],
    },
  }
}

export function handleAasaRequest(context: AppContext) {
  const teamId = context.env.APPLE_TEAM_ID
  if (!teamId) {
    // Fail loud so misconfigured deploys show up immediately instead of
    // silently breaking universal links.
    return context.json(
      { error: 'APPLE_TEAM_ID not configured' },
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    )
  }
  // Apple requires Content-Type: application/json and no redirects. Hono's
  // c.json() sets the right header.
  return context.json(buildAasaPayload(teamId))
}

/**
 * Fallback HTML for taps that reach the worker (app not installed, non-iOS,
 * or Safari address-bar hit). Kept self-contained — no external fonts, no
 * JS — so iMessage's rich-link sniffer can render a fast preview.
 */
export function handleContactLinkRequest(context: AppContext) {
  const payload = context.req.param('payload')
  const safePayload = payload ? encodeURIComponent(payload) : ''
  const deepLink = `witnesswork://import-contact/${safePayload}`
  const pageUrl = `${SITE_ORIGIN}${CONTACT_LINK_PATH_PREFIX}${safePayload}`

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${OG_TITLE}</title>
  <meta name="description" content="${OG_DESCRIPTION}">
  <meta name="theme-color" content="${BRAND.accentBackground}">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="WitnessWork">
  <meta property="og:title" content="${OG_TITLE}">
  <meta property="og:description" content="${OG_DESCRIPTION}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:image" content="${OG_IMAGE_URL}">
  <meta property="og:image:width" content="1024">
  <meta property="og:image:height" content="1024">
  <meta property="og:image:alt" content="WitnessWork app icon">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${OG_TITLE}">
  <meta name="twitter:description" content="${OG_DESCRIPTION}">
  <meta name="twitter:image" content="${OG_IMAGE_URL}">

  <link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_URL}">
  <link rel="icon" type="image/png" href="${APPLE_TOUCH_ICON_URL}">

  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: ${BRAND.accentBackground};
      color: ${BRAND.text};
      margin: 0;
      padding: 2rem;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: ${BRAND.card};
      border: 1px solid ${BRAND.border};
      border-radius: 20px;
      padding: 2rem 1.75rem;
      max-width: 24rem;
      width: 100%;
      text-align: center;
      box-shadow: 0 10px 30px rgba(0, 61, 70, 0.15);
    }
    .icon {
      width: 88px;
      height: 88px;
      margin: 0 auto 1.25rem;
      display: block;
      /* drop-shadow follows the PNG alpha channel, so the shadow hugs the
         icon's rounded corners instead of sitting behind its transparent
         bounding box like box-shadow would. */
      filter: drop-shadow(0 4px 14px rgba(0, 61, 70, 0.2));
    }
    h1 {
      margin: 0 0 0.5rem;
      font-size: 1.35rem;
      color: ${BRAND.accent3};
    }
    p {
      margin: 0 0 1.5rem;
      color: ${BRAND.text};
      line-height: 1.45;
      font-size: 0.95rem;
    }
    a.btn {
      display: inline-block;
      background: ${BRAND.accent};
      color: ${BRAND.textInverse};
      text-decoration: none;
      padding: 0.85rem 1.75rem;
      border-radius: 999px;
      font-weight: 600;
      font-size: 1rem;
    }
    a.btn:hover { filter: brightness(1.05); }
    a.secondary {
      display: block;
      margin-top: 1rem;
      color: ${BRAND.accent3};
      text-decoration: none;
      font-size: 0.85rem;
      opacity: 0.75;
    }
    a.secondary:hover { opacity: 1; }
  </style>
</head>
<body>
  <div class="card">
    <img class="icon" src="${APPLE_TOUCH_ICON_URL}" alt="WitnessWork" width="88" height="88">
    <h1>${OG_TITLE}</h1>
    <p>Install WitnessWork to import the shared contact. If you already have the app, it should have opened automatically.</p>
    <a class="btn" href="${APP_STORE_URL}">Get WitnessWork</a>
    <a class="secondary" href="${deepLink}">Open app (already installed)</a>
  </div>
</body>
</html>`

  return context.html(html)
}

export { CONTACT_LINK_PATH_PREFIX }
