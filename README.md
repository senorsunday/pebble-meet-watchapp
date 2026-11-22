# PebbleMeet — Native Pebble Watchapp for Google Meet

[![Build Pebble .pbw](https://github.com/senorsunday/pebble-meet-watchapp/actions/workflows/build-pbw.yml/badge.svg)](https://github.com/senorsunday/pebble-meet-watchapp/actions/workflows/build-pbw.yml)

PebbleMeet turns your Pebble smartwatch into a tactile Google Meet hardware controller—with **zero local daemon** and **zero Google OAuth setup required**.

## Features
- **Instant Cloudflare Durable Object Bridge**: Pairs your Pebble phone app directly with the Chrome Extension using a 6-character code (works across Wi-Fi, VPN, and cellular—no local Node/Python server or LAN IP setup).
- **One-Press New Meet & Open Tab Sync**: Launch a fresh Google Meet room (`meet.google.com/new`) or jump back into any open Meet tab in Chrome directly from your wrist.
- **Actually Invite & Ring Contacts**: Save Quick Contacts in the Chrome Extension popup or Pebble Settings. Selecting a contact while idle opens a new Google Meet room and automatically invites/rings them via Meet's *Add people* dialog; selecting a contact during an active call lets you invite them straight into your current call.
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

## Quick Setup (Consumer)

1. **Install the Watchapp**: Download `pebble-meet-watchapp.pbw` from [GitHub Releases](https://github.com/senorsunday/pebble-meet-watchapp/releases) (or the Rebble Appstore).
2. **Load the Chrome Extension** (`chrome-bridge/`):
   - Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `chrome-bridge/` folder.
   - Click the **PebbleMeet Bridge** icon in Chrome to view your **6-character pairing code** (e.g., `K7M-4NP`) and add any Quick Contacts.
3. **Pair on Your Phone**:
   - Open **PebbleMeet → Settings** in the Pebble mobile app, enter your 6-character pairing code, and tap **Save to Pebble Watch**.
4. *(Optional)* **Upcoming Scheduled Meetings (Zero OAuth)**:
   - Under *Advanced* in Settings, paste your Google Calendar **Secret address in iCal format (`.ics`)** to display upcoming Meet links and wrap-up reminders on your watch—no Google login required.

---

## Why Automatic Google OAuth Was Removed from the Default Flow

An earlier prototype attempted to embed a one-tap **Sign in with Google** OAuth flow directly inside the Pebble Settings page for Google Calendar, Contacts, and Meet APIs. We intentionally removed automatic Google OAuth from the default consumer experience for three practical reasons:

1. **Google blocks OAuth inside embedded mobile WebViews (`Error 403: disallowed_useragent`)**: Classic Pebble/Rebble mobile apps open watchapp settings inside an in-app WebView, where Google refuses OAuth sign-in outright.
2. **Sensitive Scope Verification & Custom Domain Overhead**: Google classifies Calendar (`calendar.events.readonly`) and Contacts (`contacts.readonly`) as **Sensitive** scopes. Without full Google App Verification, OAuth apps are stuck in Testing mode (max 100 manually added emails and **refresh tokens that expire every 7 days**) or hit a permanent 100-user unverified cap. Passing Google's verification requires buying and verifying a **first-party custom domain** in Google Search Console (Google rejects `github.io` and `workers.dev`), plus ongoing policy review.
3. **Unnecessary Scopes**:
   - Creating a new Google Meet room does not need the Meet REST API (`meetings.space.created`)—the Chrome Extension simply opens `https://meet.google.com/new` using your existing signed-in Chrome session.
   - Open Meet tabs sync automatically from Chrome, Pebble's native Timeline already handles phone calendar notifications, and power users who want scheduled Meet links in-app can paste a private `.ics` feed URL with zero OAuth.
   - Quick Contacts live right in the Chrome Extension popup and Pebble Settings and directly drive Meet's invite/call flow.

> **Self-Hosters**: If you own a custom domain and still want optional Google Contacts OAuth on your own deployment, the patched Worker endpoints (using single-use 90s exchange tickets, browser-initiated Chrome sign-in to bypass WebView blocks, HMAC session proofs, and real token revocation) remain documented in **[OAUTH_SETUP.md](./OAUTH_SETUP.md)**.

---

## Architecture

```
Pebble Watch (C) <--AppMessage--> PebbleKit JS (Phone)
                                        |
                                   wss:// (room=CODE&role=pebble)
                                        v
                        Cloudflare Worker + Durable Object (BridgeRoom)
                                        ^
                                   wss:// (room=CODE&role=chrome)
                                        |
                        Chrome Extension (background.js <-> content.js)
                                        |
                                 meet.google.com
```

---

## Deploying the Bridge Worker & Publishing
- **Bridge Worker (Cloudflare Free Tier, zero secrets required)**: See **[OAUTH_SETUP.md](./OAUTH_SETUP.md)** (Step 1).
- **Automated GitHub `.pbw` Builds & Rebble Appstore**: See **[PUBLISHING.md](./PUBLISHING.md)**.

## Local Build & Sideload
```bash
pebble build
pebble install --emulator basalt   # Pebble Time (144x168)
pebble install --emulator chalk    # Pebble Time Round (180x180)
pebble install --emulator diorite  # Pebble 2 Monochrome
pebble install --phone <PHONE_IP>  # Sideload directly to your watch
```
