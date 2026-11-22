# PebbleMeet — Native Pebble Watchapp for Google Meet

[![Build Pebble .pbw](https://github.com/senorsunday/pebble-meet-watchapp/actions/workflows/build-pbw.yml/badge.svg)](https://github.com/senorsunday/pebble-meet-watchapp/actions/workflows/build-pbw.yml)

PebbleMeet turns your Pebble smartwatch into a tactile Google Meet hardware controller—with **zero Google OAuth setup required**, supporting **phone-only Android / GrapheneOS (Vanadium & Google Meet app)** as well as **desktop Chrome and Firefox**.

## Features
- **Three Companion Options (Use Whichever Fits Your Setup)**:
  1. **Android Companion App (`android-companion/`) — Phone-Only, No Computer Needed**: Controls Google Meet directly inside **Vanadium (GrapheneOS)**, **Firefox/Chrome Android**, or the **Google Meet Android app** via an Accessibility Service. Works over your Cloudflare Durable Object relay **or 100% offline on-device via `ws://127.0.0.1:8765` (zero cloud)**.
  2. **Chrome Extension (`chrome-bridge/`)**: Pairs desktop Google Chrome with your watch using a 6-character code over the Cloudflare Durable Object relay.
  3. **Firefox Extension (`firefox-bridge/`)**: Works on both **Firefox Desktop** and **Firefox for Android / IronFox** (`gecko_android`).
- **One-Press New Meet & Open Tab Sync**: Launch a fresh Google Meet room (`meet.google.com/new`) or jump back into any open Meet tab directly from your wrist.
- **Actually Invite & Ring Contacts**: Save Quick Contacts in the Android Companion app, Chrome/Firefox Extension popup, or Pebble Settings. Selecting a contact while idle opens a new Google Meet room and automatically invites/rings them via Meet's *Add people* dialog; selecting a contact during an active call lets you invite them straight into your current call.
- **Physical ActionBar Controls (Conflict-Free Defaults)**:
  - `UP` (short): Toggle Microphone Mute (instant single-tap; switches to zero-latency raw press-and-hold when Push-to-Talk mode is on)
  - `UP` (long): Raise or Lower Hand
  - `SELECT` (short): Toggle Push-to-Talk (PTT) Mode (or **Admit** waiting guest when a Lobby banner is active)
  - `SELECT` (double): Quick Reaction (`Thumbs up`)
  - `SELECT` (long): End Call (remapping End Call to Short Press adds a confirmation screen to prevent accidental hang-ups)
  - `DOWN` (short): Toggle Camera On/Off
  - `DOWN` (long): Dictate & send Google Meet chat message (Pebble Mic Dictation)
  - `BACK`: Dismiss active watch banner first, or return to the menu while staying on the call
- **Live Watch Alerts & Captions**: Lobby knocks, incoming chat previews, recording notices, optional Live Captions (CC) ticker, and optional `.ics` meeting wrap-up reminders.
- **Native Multi-Platform Layouts**: Pebble Classic (Aplite), Pebble Time (Basalt), Pebble Time Round (Chalk), Pebble 2 (Diorite), and Pebble Time 2 (Emery).

---

## Quick Setup (Pick Your Companion)

### Option 1: Phone-Only Android / GrapheneOS (`android-companion/`) — Works with Vanadium & Google Meet App
1. Install `pebble-meet-watchapp.pbw` on your Pebble and sideload `pebble-meet-android-companion.apk` from [GitHub Releases](https://github.com/senorsunday/pebble-meet-watchapp/releases) (or build locally with `cd android-companion && ./gradlew assembleDebug`).
2. Open **PebbleMeet Companion** on your phone:
   - Tap **Accessibility** and enable **PebbleMeet Call Controller**.
   - *(GrapheneOS tip: If the toggle is greyed out after sideloading, open Android **Settings → Apps → PebbleMeet Companion → ⋮ (top-right) → Allow restricted settings** first, then return to Accessibility.)*
   - Tap **Start Bridge**.
3. Choose your transport mode:
   - **Offline Local-Only Mode (zero cloud, recommended for GrapheneOS)**: Turn ON **Local-Only Offline Mode (`ws://127.0.0.1:8765`)** in the Android Companion app, then open **PebbleMeet → Settings** in the Pebble app, tap **Use Android Local Mode**, and tap **Save to Pebble Watch**.
   - **Cloudflare Relay Mode**: Leave Local-Only Mode OFF, copy the 6-character pairing code, enter it in **PebbleMeet → Settings**, and tap **Save to Pebble Watch**.

### Option 2: Desktop Chrome (`chrome-bridge/`)
1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `chrome-bridge/`.
2. Click the **PebbleMeet Bridge** icon in Chrome's toolbar to view your **6-character pairing code** and manage Quick Contacts.
3. Open **PebbleMeet → Settings** in the Pebble mobile app, enter the 6-character code, and tap **Save to Pebble Watch**.

### Option 3: Firefox Desktop & Firefox for Android / IronFox (`firefox-bridge/`)
- **Firefox Desktop**: Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → select `firefox-bridge/manifest.json` (or install the packaged `.zip` / `.xpi` from Releases).
- **Firefox for Android / IronFox**: Install the extension via custom add-on collection or debug install, and enable **Desktop site** on `meet.google.com` so Meet stays in the browser.
- Enter the 6-character pairing code from the popup into **PebbleMeet → Settings** on your phone.

### Optional: Upcoming Scheduled Meetings (Zero OAuth)
Under *Advanced* in PebbleMeet Settings, paste your Google Calendar **Secret address in iCal format (`.ics`)** to display upcoming Meet links and wrap-up reminders on your watch—no Google login required.

---

## Why Automatic Google OAuth Was Removed from the Default Flow

An earlier prototype attempted to embed a one-tap **Sign in with Google** OAuth flow directly inside the Pebble Settings page for Google Calendar, Contacts, and Meet APIs. We intentionally removed automatic Google OAuth from the default consumer experience for three practical reasons:

1. **Google blocks OAuth inside embedded mobile WebViews (`Error 403: disallowed_useragent`)**: Classic Pebble/Rebble mobile apps open watchapp settings inside an in-app WebView, where Google refuses OAuth sign-in outright.
2. **Sensitive Scope Verification & Custom Domain Overhead**: Google classifies Calendar (`calendar.events.readonly`) and Contacts (`contacts.readonly`) as **Sensitive** scopes. Without full Google App Verification, OAuth apps are stuck in Testing mode (max 100 manually added emails and **refresh tokens that expire every 7 days**) or hit a permanent 100-user unverified cap. Passing Google's verification requires buying and verifying a **first-party custom domain** in Google Search Console (Google rejects `github.io` and `workers.dev`), plus ongoing policy review.
3. **Unnecessary Scopes**:
   - Creating a new Google Meet room does not need the Meet REST API (`meetings.space.created`)—the companion opens `https://meet.google.com/new` directly using your signed-in browser/app session.
   - Open Meet tabs sync automatically from Chrome/Firefox, Pebble's native Timeline already handles phone calendar notifications, and power users who want scheduled Meet links in-app can paste a private `.ics` feed URL with zero OAuth.
   - Quick Contacts live in the Android Companion app, Chrome/Firefox popup, and Pebble Settings and directly drive Meet's invite/call flow.

> **Self-Hosters**: If you own a custom domain and still want optional Google Contacts OAuth on your own deployment, the patched Worker endpoints remain documented in **[OAUTH_SETUP.md](./OAUTH_SETUP.md)**.

---

## Architecture

```
Pebble Watch (C) <--AppMessage--> PebbleKit JS (Phone)
                                      |
          +---------------------------+---------------------------+
          | (Phone-only offline mode)                             | (Relay mode: 6-char code)
          v                                                       v
  ws://127.0.0.1:8765                             Cloudflare Worker + Durable Object (BridgeRoom)
          |                                                       ^
          v                                                       | wss://
  Android Companion App                               Chrome / Firefox Bridge Extension
  (AccessibilityService)                              (background.js <-> content.js)
          |                                                       |
          v                                                       v
  Vanadium / Google Meet App                          meet.google.com (Desktop / Firefox Android)
```

---

## Local Builds
- **Watchapp (`.pbw`)**: `pebble build`
- **Android Companion (`.apk`)**: `cd android-companion && ./gradlew testDebugUnitTest assembleDebug`
- **Bridge Worker (Cloudflare Free Tier)**: `cd oauth-worker && npm install && npm run deploy` (see **[OAUTH_SETUP.md](./OAUTH_SETUP.md)**)
- **Appstore Publishing**: See **[PUBLISHING.md](./PUBLISHING.md)**
