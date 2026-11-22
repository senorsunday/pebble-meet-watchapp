# PebbleMeet Bridge Relay & Optional Self-Hosted OAuth Setup

PebbleMeet's Cloudflare Worker (`oauth-worker/`) serves two roles:
1. **Phone ↔ Chrome WebSocket Bridge (Required, Zero Secrets, Free Tier)** — Uses Cloudflare **SQLite-backed Durable Objects** with the **WebSocket Hibernation API** (`BridgeRoom`) so your watch and Chrome extension pair via a 6-character code without any local desktop daemon.
2. **Optional Self-Hosted Google Contacts OAuth (Off by Default)** — Patched OAuth endpoints for developers deploying on their own verified custom domain.

---

## Part 1: Deploy the Phone ↔ Chrome Bridge (No Secrets Required)

The bridge works out of the box on Cloudflare's **Workers Free plan** with zero Google Cloud configuration:

```bash
cd oauth-worker
npm install
npx wrangler login
npm run deploy
```

Verify the deployment:
```bash
curl https://pebble-meet-watchapp-oauth.apalson.workers.dev/health
# Expected: {"ok":true,"service":"pebble-meet-bridge","version":"0.2.0","bridgeEnabled":true,"oauthConfigured":false}
```

> If Cloudflare assigns a different `workers.dev` subdomain, update `DEFAULT_RELAY_URL` in `src/pkjs/index.js`, `docs/config/index.html`, and `chrome-bridge/background.js`.

### Enable GitHub Pages for Hosted Settings (`/docs`)
1. Open **https://github.com/senorsunday/pebble-meet-watchapp/settings/pages**.
2. Set **Source** to `Deploy from a branch` → Branch `main`, Folder `/docs`.
3. Verify:
   - Settings Page: `https://senorsunday.github.io/pebble-meet-watchapp/config/`
   - Privacy Policy: `https://senorsunday.github.io/pebble-meet-watchapp/privacy.html`

---

## Part 2 (Optional): Self-Hosted Google Contacts OAuth

> **Why is this optional?** See the README. Google blocks OAuth in embedded Pebble WebViews (`403: disallowed_useragent`) and rejects `github.io` / `workers.dev` during public Sensitive Scope verification. Most users should simply use the **Chrome Bridge + Quick Contacts + optional `.ics` Calendar URL**.

If you own a custom domain and want optional Google Contacts import (`contacts.readonly`):

### Security Fixes Included in This Worker
- **Minimal scopes**: Drops `meetings.space.created` (Chrome opens `meet.google.com/new` directly) and omits `calendar.events.readonly` by default (can be opted in via `OAUTH_EXTRA_SCOPES` on a verified custom domain).
- **No tokens in URLs**: `/oauth/callback` stores tokens in a 90-second single-use Durable Object ticket (`oauth_ticket`) redeemed via `POST /oauth/exchange`—tokens never enter browser history or `pebblejs://close#`.
- **Real-browser sign-in (bypasses Pebble WebView)**: Clicking **Sign in with Google** inside the Chrome Extension popup launches `/oauth/start?mode=browser&room=<CODE>` in a normal Chrome tab and delivers the single-use ticket over your paired `BridgeRoom` WebSocket.
- **Authenticated refresh & real revocation**: `/oauth/exchange` returns an HMAC-signed `session_proof` required by `/oauth/refresh` and `/oauth/revoke` (plus per-IP rate limiting). Disconnecting in Pebble Settings revokes the stored token directly from PebbleKit JS.

### Setup Steps (Self-Hosted Custom Domain)
1. Attach your own custom domain (e.g. `pebblemeet.yourdomain.com`) to the Cloudflare Worker and verify it in Google Search Console.
2. In [Google Cloud Console](https://console.cloud.google.com/):
   - Enable **Google People API**.
   - Configure **Google Auth Platform** with your custom domain's homepage, privacy policy, and scope `https://www.googleapis.com/auth/contacts.readonly`.
   - Create a **Web application** OAuth client with Redirect URI:
     `https://pebblemeet.yourdomain.com/oauth/callback`
3. Set Worker secrets and deploy:
   ```bash
   cd oauth-worker
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   openssl rand -hex 32 | npx wrangler secret put STATE_SIGNING_SECRET
   npm run deploy
   ```
4. Pair your watch with the Chrome Extension, then click **Advanced → Sign in with Google** inside the Chrome Extension popup.
