# Full Appstore Google OAuth Setup (PebbleMeet)

This PR adds a production-ready **Sign in with Google** flow with automatic 1-hour token refresh for Pebble / Rebble Appstore users—without exposing your `GOOGLE_CLIENT_SECRET` inside the `.pbw` bundle.

## Architecture

1. **`docs/config/index.html` (GitHub Pages)** — Hosted HTTPS Pebble settings page opened by `showConfiguration`. Displays all watch controls (9 button gestures, 5 banner toggles, Chrome Bridge URL) plus a one-tap **Sign in with Google** button.
2. **`docs/privacy.html` (GitHub Pages)** — Hosted Privacy Policy required for Google OAuth App Verification.
3. **`oauth-worker/` (Cloudflare Worker, free tier)** — Stateless OAuth 2.0 relay that signs CSRF `state` with HMAC-SHA256, exchanges auth codes for `access_token` + `refresh_token`, and serves `POST /oauth/refresh` and `POST /oauth/revoke`.
4. **`src/pkjs/index.js` (PebbleKit JS)** — Opens the hosted HTTPS settings page, stores tokens locally on the phone, and silently refreshes expired access tokens before Calendar, Contacts, or Meet API calls (with automatic `401` retry).

---

## Step 1: Enable GitHub Pages for `/docs`

1. Merge this PR into `main` (or test on your branch).
2. In GitHub, open **https://github.com/senorsunday/pebble-meet-watchapp/settings/pages**.
3. Under **Build and deployment**:
   - **Source**: `Deploy from a branch`
   - **Branch**: `main` · **Folder**: `/docs`
4. Wait ~1 minute and verify these two URLs load:
   - Config Page: `https://senorsunday.github.io/pebble-meet-watchapp/config/`
   - Privacy Policy: `https://senorsunday.github.io/pebble-meet-watchapp/privacy.html`

---

## Step 2: Configure Google Cloud OAuth Client

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Library** and enable:
   - **Google Calendar API**
   - **Google People API**
   - **Google Meet REST API**
2. Open **Google Auth Platform → Branding / Audience**:
   - **User type**: External (leave in **Testing** while you gather early users—up to 100 test users require no review).
   - **Application home page**: `https://senorsunday.github.io/pebble-meet-watchapp/config/`
   - **Privacy policy link**: `https://senorsunday.github.io/pebble-meet-watchapp/privacy.html`
   - **Authorized domains**: `github.io` and `workers.dev` (or your custom domain)
3. Under **Data Access (Scopes)**, add:
   - `https://www.googleapis.com/auth/calendar.events.readonly`
   - `https://www.googleapis.com/auth/contacts.readonly`
   - `https://www.googleapis.com/auth/meetings.space.created`
4. Under **Clients → Create Client → Web application**:
   - **Authorized redirect URIs**: `https://pebble-meet-watchapp-oauth.apalson.workers.dev/oauth/callback`
   - Copy your **Client ID** and **Client Secret**.

---

## Step 3: Deploy the Cloudflare Worker Relay

```bash
cd oauth-worker
npm install
npx wrangler login

# Store secrets securely in Cloudflare (never commit them to git)
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -hex 32 | npx wrangler secret put STATE_SIGNING_SECRET

# Deploy to https://pebble-meet-watchapp-oauth.apalson.workers.dev
npm run deploy
```

Verify health check:
```bash
curl https://pebble-meet-watchapp-oauth.apalson.workers.dev/health
```

> If Cloudflare assigns a different `workers.dev` subdomain, update `DEFAULT_OAUTH_RELAY_URL` in `src/pkjs/index.js` and `docs/config/index.html`, plus the Redirect URI in Google Cloud Console.

---

## Step 4: Public Appstore Verification (When Ready for >100 Users)

1. Switch Google Auth Platform **Audience** from **Testing** to **In Production**.
2. Click **Prepare for verification** and submit:
   - Your Privacy Policy URL (`https://senorsunday.github.io/pebble-meet-watchapp/privacy.html`)
   - A 1–2 minute screen recording showing a user tapping **Sign in with Google** in PebbleMeet Settings, granting the 3 scopes, and viewing their Calendar meetings / Contacts / Meet link on the watch.
