# Publishing PebbleMeet to GitHub & the Pebble Appstore

This standalone repository contains everything required to compile a native Pebble `.pbw` binary in GitHub Actions and publish it to the **Rebble / Pebble Appstore**.

---

## Step 1: Push Standalone Repo to GitHub

1. Create an empty repository named **`pebble-meet-watchapp`** at https://github.com/new (leave README / .gitignore unchecked).
2. Run these commands from your computer:

```bash
# 1. Unzip downloaded release kit
unzip pebble-meet-watchapp-v0.0.1.zip -d pebble-meet-watchapp
cd pebble-meet-watchapp

# 2. Push to empty GitHub repo (create "pebble-meet-watchapp" on github.com/new)
git init -b main
git add .
git commit -m "Release PebbleMeet v0.0.1 for Pebble"
git remote add origin https://github.com/your-github-username/pebble-meet-watchapp.git
git push -u origin main

# 3. Tag v0.0.1 to auto-build & attach .pbw via GitHub Actions
git tag v0.0.1
git push origin v0.0.1
```

3. Open **Actions** in your GitHub repository (`https://github.com/your-github-username/pebble-meet-watchapp/actions`).
   - The **Build & Release Pebble .pbw** workflow compiles C + PebbleKit JS + PNG resources inside the official `rebble/pebble-sdk` container.
   - Pushing tag `v0.0.1` automatically creates a GitHub Release with **`pebble-meet-watchapp.pbw`** attached.

---

## Step 2: Publish to the Pebble Appstore (Rebble Developer Portal)

1. Sign in at **https://dev-portal.rebble.io** with your Rebble developer account.
2. Click **Create a New App** -> choose **Watchapp**.
3. Fill out the Appstore listing using `appstore/store-listing.json`:
   - **Title**: `PebbleMeet`
   - **Category**: `Remotes`
   - **Source URL**: `https://github.com/your-github-username/pebble-meet-watchapp`
   - **Description**: Copy from `appstore/store-listing.json`
4. Upload the store images already included in this repository:
   - **Small Icon (48x48)**: `appstore/icon-48.png`
   - **Large Icon (144x144)**: `appstore/icon-144.png`
   - **Header Banner (720x320)**: `appstore/banner-720x320.png`
   - **Watch Screenshots**: Capture from the Pebble emulator (`pebble screenshot`) or the PebbleMeet simulator for Basalt (144x168), Chalk (180x180), and Diorite (144x168).
5. Upload the **`.pbw`** release binary downloaded from your GitHub Release (`https://github.com/your-github-username/pebble-meet-watchapp/releases/tag/v0.0.1`).
6. Enter the release notes for `v0.0.1` and click **Publish**.

---

## Optional: Local Build & Watch Sideload

```bash
npm install
pebble build
pebble install --emulator basalt   # Pebble Time
pebble install --emulator chalk    # Pebble Time Round
pebble install --emulator diorite  # Pebble 2 Monochrome
pebble install --phone <PHONE_IP>  # Direct watch install
```
