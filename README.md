# PebbleMeet — Native Pebble Watchapp for Google Meet

[![Build Pebble .pbw](https://github.com/your-github-username/pebble-meet-watchapp/actions/workflows/build-pbw.yml/badge.svg)](https://github.com/your-github-username/pebble-meet-watchapp/actions/workflows/build-pbw.yml)

PebbleMeet turns your Pebble smartwatch into a tactile Google Meet hardware controller.

Features:
- Browse upcoming Google Calendar meetings and Google Contacts right on your wrist
- Join scheduled meetings or launch a new Google Meet room with one press
- Physical ActionBar controls: Mic Mute / Push-to-Talk (UP), End Call (SELECT), Camera On/Off (DOWN)
- Long-press actions for Raise Hand, Quick Chat / Pebble Mic Dictation, and Meeting Notes
- Active call pinned first & highlighted when browsing back to the menu, with call-switch confirmation
- Dismissible watch alerts (Lobby guests, Chat previews, Recording notices) using the BACK button
- Full phone configuration via Pebble Clay (Push-to-Talk default, join muted/cam-off, full button remapping)
- Native layouts for Pebble Classic (Aplite), Pebble Time (Basalt), Pebble Time Round (Chalk), Pebble 2 (Diorite), and Pebble Time 2 (Emery)

Companion Chrome Bridge & source code: https://github.com/your-github-username/pebble-meet-watchapp

## Hardware Button Map
- **Menu (Current Call, Calendar Meetings, Favorites & Contacts)**:
  - `UP` / `DOWN`: Scroll scheduled Google Calendar meetings and contacts
  - `SELECT`: Join highlighted meeting, return to active call, or switch calls (with confirmation)
- **Active Call Screen (ActionBarLayer)**:
  - `UP` (tap): Toggle Microphone Mute (or hold to talk in Push-to-Talk mode)
  - `UP` (long-press): Raise or Lower Hand
  - `SELECT` (tap): End call (or Admit waiting guest when a lobby banner is active)
  - `DOWN` (tap): Toggle Camera On/Off
  - `DOWN` (long-press): Dictate & send Google Meet chat message
  - `BACK`: Dismiss active watch banner first, or return to the menu while staying on the call

## Automated GitHub .pbw Builds & Appstore Submission
See **[PUBLISHING.md](./PUBLISHING.md)** for the complete GitHub release workflow and **Rebble Developer Portal** (`dev-portal.rebble.io`) submission steps.

## Local Build & Sideload
```bash
npm install
pebble build
pebble install --emulator basalt   # Pebble Time (144x168)
pebble install --emulator chalk    # Pebble Time Round (180x180)
pebble install --emulator diorite  # Pebble 2 Monochrome
pebble install --phone <PHONE_IP>  # Sideload directly to your watch
```
