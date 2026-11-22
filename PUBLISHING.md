# Publishing PebbleMeet to GitHub & the Pebble Appstore

This standalone repository contains everything required to compile a native Pebble `.pbw` binary in GitHub Actions and publish it to the **Rebble / Pebble Appstore**.

---

## Step 1: Tag & Release on GitHub

```bash
git tag v0.2.0
git push origin v0.2.0
```

Open **Actions** in your GitHub repository (`https://github.com/senorsunday/pebble-meet-watchapp/actions`):
- The **Build & Release Pebble .pbw** workflow validates the JS/JSON manifests and compiles C + PebbleKit JS + PNG resources inside the official `rebble/pebble-sdk` container.
- Pushing a `v*` tag automatically creates a GitHub Release with **`pebble-meet-watchapp-v0.2.0.pbw`** attached.

---

## Step 2: Deploy Bridge Worker & GitHub Pages

1. Deploy `oauth-worker/` (`cd oauth-worker && npm install && npm run deploy`) to power the Durable Object Phone ↔ Chrome relay (free tier, zero secrets required).
2. Enable GitHub Pages from `main` → `/docs` so `https://senorsunday.github.io/pebble-meet-watchapp/config/` serves the watch settings page.

---

## Step 3: Publish to the Pebble Appstore (Rebble Developer Portal)

1. Sign in at **https://dev-portal.rebble.io** with your Rebble developer account.
2. Click **Create a New App** -> choose **Watchapp**.
3. Fill out the Appstore listing using `appstore/store-listing.json`:
   - **Title**: `PebbleMeet`
   - **Category**: `Remotes`
   - **Source URL**: `https://github.com/senorsunday/pebble-meet-watchapp`
   - **Description**: Copy from `appstore/store-listing.json`
4. Upload the store images already included in this repository:
   - **Small Icon (48x48)**: `appstore/icon-48.png`
   - **Large Icon (144x144)**: `appstore/icon-144.png`
   - **Header Banner (720x320)**: `appstore/banner-720x320.png`
   - **Watch Screenshots**: Capture from the Pebble emulator (`pebble screenshot`) for Basalt (144x168), Chalk (180x180), and Diorite (144x168).
5. Upload the **`.pbw`** release binary downloaded from your GitHub Release.
6. Enter the release notes and click **Publish**.

---

## Optional: Local Build & Watch Sideload

```bash
pebble build
pebble install --emulator basalt   # Pebble Time
pebble install --emulator chalk    # Pebble Time Round
pebble install --emulator diorite  # Pebble 2 Monochrome
pebble install --phone <PHONE_IP>  # Direct watch install
```
