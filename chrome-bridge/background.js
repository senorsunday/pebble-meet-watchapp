/* PebbleMeet Chrome Extension — MV3 Background Service Worker
 *
 * Maintains a single outbound WebSocket connection to the Cloudflare Workers
 * Durable Object relay (`BridgeRoom`), manages Google Meet tabs, handles
 * opening new Meet rooms & inviting/ringing contacts, and forwards live state
 * between `content.js` and the Pebble phone app.
 */

const DEFAULT_RELAY_HTTP = 'https://pebble-meet-watchapp-oauth.apalson.workers.dev';
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omits 0/O/1/I
const KEEPALIVE_ALARM = 'pebblemeet_ws_keepalive';

let ws = null;
let reconnectTimer = null;
let reconnectDelayMs = 2000;
let activeMeetTabId = null;
let lastPresence = { chromeConnected: false, pebbleConnected: false };
let lastMeetState = null;

// Pending invite map keyed by tabId: { email, name, autoJoin, createdAt }
const pendingInvites = new Map();

function generatePairingCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  return code;
}

function normalizeRoomCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function formatPairingCode(code) {
  const clean = normalizeRoomCode(code);
  return clean.length === 6 ? clean.slice(0, 3) + '-' + clean.slice(3) : clean;
}

function httpToWsUrl(relayHttpUrl, roomCode) {
  const trimmed = String(relayHttpUrl || DEFAULT_RELAY_HTTP).trim().replace(/\/+$/, '');
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    const sep = trimmed.includes('?') ? '&' : '?';
    return `${trimmed}${sep}room=${encodeURIComponent(roomCode)}&role=chrome`;
  }
  const wsBase = trimmed.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  return `${wsBase}/bridge/ws?room=${encodeURIComponent(roomCode)}&role=chrome`;
}

async function getConfig() {
  const stored = await chrome.storage.local.get([
    'pairingCode',
    'relayUrl',
    'contacts',
  ]);
  let pairingCode = normalizeRoomCode(stored.pairingCode);
  if (pairingCode.length < 6) {
    pairingCode = generatePairingCode();
    await chrome.storage.local.set({ pairingCode });
  }
  const relayUrl = (stored.relayUrl || DEFAULT_RELAY_HTTP).trim().replace(/\/+$/, '');
  const contacts = Array.isArray(stored.contacts) ? stored.contacts : [];
  return { pairingCode, relayUrl, contacts };
}

function sendToBridge(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (err) {
    console.warn('[PebbleMeet] WS send failed:', err);
    return false;
  }
}

async function broadcastMeetTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    const meetings = [];
    for (const tab of tabs) {
      const match = (tab.url || '').match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
      if (!match) continue;
      const code = match[1].toLowerCase();
      const rawTitle = (tab.title || 'Google Meet').replace(/^Meet\s*[-–]\s*/i, '').trim();
      meetings.push({
        tabId: tab.id,
        code,
        title: (rawTitle || code).slice(0, 30),
        time: tab.active ? 'Active Tab' : 'Open Tab',
        active: Boolean(tab.active),
      });
    }
    sendToBridge({ type: 'MEET_TABS', meetings });
  } catch (err) {
    console.warn('[PebbleMeet] Failed querying Meet tabs:', err);
  }
}

async function broadcastContacts() {
  const { contacts } = await getConfig();
  sendToBridge({ type: 'CONTACTS_SYNC', contacts });
}

async function findTargetMeetTab() {
  if (activeMeetTabId !== null) {
    try {
      const tab = await chrome.tabs.get(activeMeetTabId);
      if (tab && tab.url && tab.url.startsWith('https://meet.google.com/')) {
        return tab;
      }
    } catch {
      activeMeetTabId = null;
    }
  }
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  if (!tabs.length) return null;
  const activeTab = tabs.find((t) => t.active) || tabs[0];
  activeMeetTabId = activeTab.id;
  return activeTab;
}

async function sendToMeetTab(payload) {
  const tab = await findTargetMeetTab();
  if (!tab) {
    sendToBridge({
      type: 'MEET_ALERT',
      kind: 'generic',
      body: 'No Meet tab open in Chrome',
    });
    return false;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, payload);
    return true;
  } catch (err) {
    console.warn('[PebbleMeet] Content script unreachable on tab', tab.id, err);
    return false;
  }
}

async function openOrFocusMeet(targetUrl) {
  const cleanUrl =
    targetUrl && targetUrl.startsWith('https://meet.google.com/')
      ? targetUrl
      : 'https://meet.google.com/new';

  const codeMatch = cleanUrl.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  if (codeMatch) {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    const existing = tabs.find((t) => (t.url || '').toLowerCase().includes(codeMatch[1].toLowerCase()));
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId) {
        await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      }
      activeMeetTabId = existing.id;
      return existing;
    }
  }

  const created = await chrome.tabs.create({ url: cleanUrl, active: true });
  activeMeetTabId = created.id;
  return created;
}

async function handleCallContact(name, email, inviteIntoCurrent) {
  const cleanEmail = String(email || '').trim();
  const cleanName = String(name || cleanEmail || 'Contact').trim();

  if (!cleanEmail) {
    sendToBridge({
      type: 'INVITE_STATUS',
      ok: false,
      name: cleanName,
      message: 'No email saved for ' + cleanName,
    });
    return;
  }

  if (inviteIntoCurrent) {
    const tab = await findTargetMeetTab();
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      try {
        await chrome.tabs.sendMessage(tab.id, {
          cmd: 'INVITE_CONTACT',
          email: cleanEmail,
          name: cleanName,
          autoJoin: false,
        });
        return;
      } catch {
        // Fall through to pending invite if tab is still loading
      }
    }
  }

  // Start a fresh instant Google Meet room using the user's Chrome session (zero OAuth!)
  const tab = await chrome.tabs.create({ url: 'https://meet.google.com/new', active: true });
  activeMeetTabId = tab.id;
  pendingInvites.set(tab.id, {
    email: cleanEmail,
    name: cleanName,
    autoJoin: true,
    createdAt: Date.now(),
  });
}

async function handleBridgeCommand(data) {
  if (!data || typeof data !== 'object') return;

  if (data.type === 'BRIDGE_PRESENCE') {
    lastPresence = {
      chromeConnected: Boolean(data.chromeConnected),
      pebbleConnected: Boolean(data.pebbleConnected),
    };
    if (lastPresence.pebbleConnected) {
      broadcastMeetTabs();
      broadcastContacts();
      if (lastMeetState) {
        sendToBridge(lastMeetState);
      }
    }
    return;
  }

  if (data.type === 'PONG') return;

  switch (data.cmd) {
    case 'NEW_MEET':
      await openOrFocusMeet('https://meet.google.com/new');
      break;
    case 'OPEN_MEET':
      await openOrFocusMeet(data.url);
      break;
    case 'CALL_CONTACT':
      await handleCallContact(data.callee || data.name, data.email, false);
      break;
    case 'INVITE_CONTACT':
      await handleCallContact(data.callee || data.name, data.email, true);
      break;
    case 'REQUEST_STATE':
      await broadcastMeetTabs();
      await broadcastContacts();
      await sendToMeetTab({ cmd: 'REQUEST_STATE' });
      break;
    case 'TOGGLE_MUTE':
    case 'TOGGLE_CAMERA':
    case 'RAISE_HAND':
    case 'TOGGLE_CAPTIONS':
    case 'SEND_CHAT':
    case 'ADMIT_GUEST':
    case 'END_CALL':
      await sendToMeetTab(data);
      break;
    default:
      break;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
}

async function connectBridge(forceReconnect = false) {
  if (ws && !forceReconnect && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }

  const { pairingCode, relayUrl } = await getConfig();
  const wsUrl = httpToWsUrl(relayUrl, pairingCode);

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.warn('[PebbleMeet] Failed constructing WebSocket:', err);
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    reconnectDelayMs = 2000;
    lastPresence.chromeConnected = true;
    broadcastMeetTabs();
    broadcastContacts();
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleBridgeCommand(msg);
    } catch (err) {
      console.warn('[PebbleMeet] Bad JSON from relay:', err);
    }
  });

  ws.addEventListener('close', () => {
    ws = null;
    lastPresence = { chromeConnected: false, pebbleConnected: false };
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    try { if (ws) ws.close(); } catch (e) {}
  });
}

// Keep MV3 service worker connection healthy while Chrome is running
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendToBridge({ type: 'PING' });
  } else {
    connectBridge();
  }
});

// Track Meet tabs & dispatch pending contact invites once the new room is ready
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url || !tab.url.startsWith('https://meet.google.com/')) return;
  if (changeInfo.status === 'complete' || changeInfo.title) {
    broadcastMeetTabs();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingInvites.delete(tabId);
  if (activeMeetTabId === tabId) {
    activeMeetTabId = null;
  }
  broadcastMeetTabs();
});

// Messages from content.js and popup.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  // Content script events
  if (sender.tab) {
    const tabId = sender.tab.id;
    activeMeetTabId = tabId;

    if (msg.type === 'MEET_CONTENT_READY') {
      const pending = pendingInvites.get(tabId);
      if (pending && Date.now() - pending.createdAt < 120000) {
        pendingInvites.delete(tabId);
        chrome.tabs
          .sendMessage(tabId, {
            cmd: 'INVITE_CONTACT',
            email: pending.email,
            name: pending.name,
            autoJoin: pending.autoJoin,
          })
          .catch(() => {});
      }
      broadcastMeetTabs();
      sendResponse({ ok: true });
      return false;
    }

    if (
      msg.type === 'MEET_STATE' ||
      msg.type === 'MEET_ALERT' ||
      msg.type === 'MEET_CAPTION' ||
      msg.type === 'INVITE_STATUS'
    ) {
      if (msg.type === 'MEET_STATE') {
        lastMeetState = msg;
      }
      sendToBridge(msg);
      sendResponse({ ok: true });
      return false;
    }
  }

  // Popup UI RPCs
  if (msg.type === 'POPUP_GET_STATUS') {
    (async () => {
      const cfg = await getConfig();
      const tab = await findTargetMeetTab();
      sendResponse({
        pairingCode: cfg.pairingCode,
        formattedCode: formatPairingCode(cfg.pairingCode),
        relayUrl: cfg.relayUrl,
        contacts: cfg.contacts,
        wsConnected: Boolean(ws && ws.readyState === WebSocket.OPEN),
        pebbleConnected: Boolean(lastPresence.pebbleConnected),
        activeMeetUrl: tab ? tab.url : '',
        activeMeetTitle: tab ? tab.title : '',
      });
    })();
    return true;
  }

  if (msg.type === 'POPUP_REGENERATE_CODE') {
    (async () => {
      const pairingCode = generatePairingCode();
      await chrome.storage.local.set({ pairingCode });
      await connectBridge(true);
      sendResponse({ pairingCode, formattedCode: formatPairingCode(pairingCode) });
    })();
    return true;
  }

  if (msg.type === 'POPUP_SAVE_RELAY') {
    (async () => {
      const relayUrl = String(msg.relayUrl || DEFAULT_RELAY_HTTP).trim().replace(/\/+$/, '');
      await chrome.storage.local.set({ relayUrl });
      await connectBridge(true);
      sendResponse({ ok: true, relayUrl });
    })();
    return true;
  }

  if (msg.type === 'POPUP_SAVE_CONTACTS') {
    (async () => {
      const contacts = Array.isArray(msg.contacts) ? msg.contacts.slice(0, 16) : [];
      await chrome.storage.local.set({ contacts });
      await broadcastContacts();
      sendResponse({ ok: true, contacts });
    })();
    return true;
  }

  return false;
});

connectBridge();
