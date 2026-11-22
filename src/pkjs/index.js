/* PebbleKit JS Companion for PebbleMeet
 *
 * Architecture (Option A — Zero Google OAuth Required):
 *  - Connects outbound over WSS to a Cloudflare Workers Durable Object relay
 *    (`BridgeRoom`) paired with the Chrome Extension via a 6-character code.
 *  - Syncs open Google Meet tabs and Favorite Contacts directly from Chrome
 *    (plus optional zero-OAuth private Calendar `.ics` feed and optional
 *    self-hosted Google Contacts OAuth with all ticket/revoke/WebView fixes).
 *  - Serializes all AppMessage sends through a single queue with NACK retry.
 */

var HOSTED_CONFIG_URL = 'https://senorsunday.github.io/pebble-meet-watchapp/config/';
var DEFAULT_RELAY_URL = 'https://pebble-meet-watchapp-oauth.apalson.workers.dev';

var relayUrl = (
  localStorage.getItem('pebblemeet_relay_url') ||
  localStorage.getItem('pebblemeet_oauth_relay_url') ||
  DEFAULT_RELAY_URL
).replace(/\/+$/, '');
var pairingCode = normalizeRoomCode(localStorage.getItem('pebblemeet_pairing_code') || '');
var calendarIcsUrl = localStorage.getItem('pebblemeet_calendar_ics_url') || '';

var bridgeSocket = null;
var bridgeReconnectTimer = null;
var bridgeReconnectDelayMs = 2000;

// Optional self-hosted OAuth state (patched: single-use ticket exchange, session proof, real revoke)
var googleAccessToken = localStorage.getItem('pebblemeet_access_token') || '';
var googleRefreshToken = localStorage.getItem('pebblemeet_refresh_token') || '';
var googleSessionProof = localStorage.getItem('pebblemeet_session_proof') || '';
var googleTokenExpiresAt = parseInt(localStorage.getItem('pebblemeet_token_expires_at') || '0', 10) || 0;
var googleEmail = localStorage.getItem('pebblemeet_google_email') || '';
var refreshInFlight = false;
var refreshWaiters = [];

// Cached lists so Chrome tabs, optional ICS meetings, local favorites, and optional Google contacts merge cleanly
var chromeMeetTabs = [];
var icsMeetings = [];
var localContacts = loadJsonStorage('pebblemeet_local_contacts', []);
var chromeContacts = [];
var oauthContacts = [];
var wrapUpTimer = null;

var savedWatchPrefs = loadJsonStorage('pebblemeet_watch_prefs', {
  CFG_DEFAULT_PTT: 0,
  CFG_JOIN_MUTED: 0,
  CFG_JOIN_CAM_OFF: 0,
  CFG_UP_SHORT: 0,
  CFG_UP_DOUBLE: 11,
  CFG_UP_LONG: 4,
  CFG_SELECT_SHORT: 10,
  CFG_SELECT_DOUBLE: 9,
  CFG_SELECT_LONG: 3,
  CFG_DOWN_SHORT: 2,
  CFG_DOWN_DOUBLE: 11,
  CFG_DOWN_LONG: 5,
  CFG_SHOW_CAPTIONS: 1,
  CFG_ALERT_CHAT: 1,
  CFG_ALERT_RECORDING: 1,
  CFG_ALERT_LOBBY: 1,
  CFG_WRAP_UP_MINUTES: 5,
});

var bannerPrefs = loadJsonStorage('pebblemeet_banner_prefs', {
  showCaptions: true,
  alertChat: true,
  alertRecording: true,
  alertLobby: true,
  wrapUpMinutes: 5,
});

function loadJsonStorage(key, fallback) {
  try {
    var parsed = JSON.parse(localStorage.getItem(key) || 'null');
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch (e) {}
  return fallback;
}

function normalizeRoomCode(raw) {
  if (!raw) return '';
  var cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length < 6 || cleaned.length > 16) return '';
  return cleaned;
}

/* -------------------------------------------------------------------------
 * Serialized AppMessage Send Queue (Prevents BUSY collisions on Pebble)
 * ------------------------------------------------------------------------- */
var watchMsgQueue = [];
var watchMsgSending = false;

function enqueueWatchMessage(payload, onDone) {
  watchMsgQueue.push({ payload: payload, attempts: 0, onDone: onDone || null });
  pumpWatchQueue();
}

function pumpWatchQueue() {
  if (watchMsgSending || watchMsgQueue.length === 0) return;
  watchMsgSending = true;
  var item = watchMsgQueue[0];

  Pebble.sendAppMessage(
    item.payload,
    function () {
      watchMsgQueue.shift();
      watchMsgSending = false;
      if (item.onDone) {
        try { item.onDone(true); } catch (e) {}
      }
      pumpWatchQueue();
    },
    function () {
      item.attempts += 1;
      watchMsgSending = false;
      if (item.attempts < 3) {
        setTimeout(pumpWatchQueue, 150 * item.attempts);
      } else {
        watchMsgQueue.shift();
        if (item.onDone) {
          try { item.onDone(false); } catch (e) {}
        }
        pumpWatchQueue();
      }
    }
  );
}

/* -------------------------------------------------------------------------
 * Sync Merged Meetings & Contacts to Watch (Resets counts cleanly)
 * ------------------------------------------------------------------------- */
function syncMeetingsToWatch() {
  var merged = [];
  var seen = {};
  var i;

  for (i = 0; i < chromeMeetTabs.length && merged.length < 6; i++) {
    var t = chromeMeetTabs[i];
    if (!t || !t.code || seen[t.code]) continue;
    seen[t.code] = true;
    merged.push({
      title: String(t.title || t.code).slice(0, 30),
      time: String(t.time || 'Open Tab').slice(0, 26),
      code: String(t.code).slice(0, 15),
      attendees: t.attendees || 1,
    });
  }

  for (i = 0; i < icsMeetings.length && merged.length < 6; i++) {
    var m = icsMeetings[i];
    if (!m || !m.code || seen[m.code]) continue;
    seen[m.code] = true;
    merged.push({
      title: String(m.title || 'Google Meet').slice(0, 30),
      time: String(m.time || 'Today').slice(0, 26),
      code: String(m.code).slice(0, 15),
      attendees: m.attendees || 2,
    });
  }

  enqueueWatchMessage({ MEETING_COUNT: merged.length });
  for (i = 0; i < merged.length; i++) {
    enqueueWatchMessage({
      MEETING_INDEX: i,
      MEETING_TITLE: merged[i].title,
      MEETING_TIME: merged[i].time,
      MEET_CODE: merged[i].code,
      MEETING_ATTENDEES: merged[i].attendees,
    });
  }
}

function syncContactsToWatch() {
  var merged = [];
  var seen = {};
  var sources = [localContacts, chromeContacts, oauthContacts];
  var s, i;

  for (s = 0; s < sources.length; s++) {
    var list = sources[s] || [];
    for (i = 0; i < list.length && merged.length < 16; i++) {
      var c = list[i];
      if (!c || (!c.name && !c.email)) continue;
      var key = String(c.email || c.name).toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      merged.push({
        name: String(c.name || c.email).slice(0, 30),
        role: String(c.role || 'Favorite').slice(0, 26),
        email: String(c.email || '').slice(0, 46),
      });
    }
  }

  enqueueWatchMessage({ CONTACT_COUNT: merged.length });
  for (i = 0; i < merged.length; i++) {
    enqueueWatchMessage({
      CONTACT_INDEX: i,
      CONTACT_NAME: merged[i].name,
      CONTACT_ROLE: merged[i].role,
      CONTACT_EMAIL: merged[i].email,
    });
  }
}

/* -------------------------------------------------------------------------
 * Optional Zero-OAuth Private ICS Calendar Parser (+ Wrap-Up Reminder)
 * ------------------------------------------------------------------------- */
function parseIcsTimestamp(raw) {
  if (!raw) return null;
  var clean = raw.replace(/[^0-9TZ]/g, '');
  var m = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  var year = parseInt(m[1], 10);
  var month = parseInt(m[2], 10) - 1;
  var day = parseInt(m[3], 10);
  var hour = parseInt(m[4], 10);
  var min = parseInt(m[5], 10);
  var sec = parseInt(m[6], 10);
  if (m[7] === 'Z') {
    return new Date(Date.UTC(year, month, day, hour, min, sec));
  }
  return new Date(year, month, day, hour, min, sec);
}

function formatLocalHHMM(d) {
  if (!d) return 'Today';
  var h = d.getHours();
  var m = d.getMinutes();
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function scheduleNextWrapUpAlert(events) {
  if (wrapUpTimer) {
    clearTimeout(wrapUpTimer);
    wrapUpTimer = null;
  }
  if (!bannerPrefs.wrapUpMinutes || bannerPrefs.wrapUpMinutes <= 0) return;

  var now = Date.now();
  var leadMs = bannerPrefs.wrapUpMinutes * 60 * 1000;
  var nextAlertAt = null;
  var nextTitle = '';

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (!ev.endMs) continue;
    var triggerAt = ev.endMs - leadMs;
    if (triggerAt > now && (nextAlertAt === null || triggerAt < nextAlertAt)) {
      nextAlertAt = triggerAt;
      nextTitle = ev.title;
    }
  }

  if (nextAlertAt !== null && nextAlertAt - now < 12 * 60 * 60 * 1000) {
    wrapUpTimer = setTimeout(function () {
      enqueueWatchMessage({
        EVT_BANNER_KIND: 4,
        EVT_BANNER_BODY: (bannerPrefs.wrapUpMinutes + 'm left: ' + nextTitle).slice(0, 60),
      });
    }, nextAlertAt - now);
  }
}

function fetchIcsCalendarMeetings() {
  if (!calendarIcsUrl || calendarIcsUrl.indexOf('https://') !== 0) {
    icsMeetings = [];
    syncMeetingsToWatch();
    return;
  }
  var xhr = new XMLHttpRequest();
  xhr.open('GET', calendarIcsUrl);
  xhr.onload = function () {
    if (xhr.status !== 200) return;
    var unfolded = xhr.responseText.replace(/\r?\n[ \t]/g, '');
    var blocks = unfolded.split('BEGIN:VEVENT');
    var now = Date.now();
    var horizon = now + 24 * 60 * 60 * 1000;
    var parsed = [];

    for (var i = 1; i < blocks.length; i++) {
      var block = blocks[i].split('END:VEVENT')[0];
      var codeMatch = block.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
      if (!codeMatch) continue;

      var summaryMatch = block.match(/^SUMMARY[^:]*:(.*)$/m);
      var startMatch = block.match(/^DTSTART[^:]*:(.*)$/m);
      var endMatch = block.match(/^DTEND[^:]*:(.*)$/m);
      var startDate = parseIcsTimestamp(startMatch ? startMatch[1].trim() : '');
      var endDate = parseIcsTimestamp(endMatch ? endMatch[1].trim() : '');
      if (!startDate) continue;

      var startMs = startDate.getTime();
      var endMs = endDate ? endDate.getTime() : startMs + 30 * 60 * 1000;
      if (endMs < now || startMs > horizon) continue;

      var attendeeMatches = block.match(/^ATTENDEE/gm);
      parsed.push({
        startMs: startMs,
        endMs: endMs,
        title: (summaryMatch ? summaryMatch[1].trim().replace(/\\,/g, ',') : 'Google Meet').slice(0, 30),
        time: formatLocalHHMM(startDate),
        code: codeMatch[1].toLowerCase(),
        attendees: attendeeMatches ? attendeeMatches.length : 2,
      });
    }

    parsed.sort(function (a, b) { return a.startMs - b.startMs; });
    icsMeetings = parsed.slice(0, 6);
    scheduleNextWrapUpAlert(icsMeetings);
    syncMeetingsToWatch();
  };
  xhr.send();
}

/* -------------------------------------------------------------------------
 * Optional Patched Self-Hosted Google OAuth (Single-Use Ticket + Real Revoke)
 * ------------------------------------------------------------------------- */
function saveOAuthTokens(accessToken, refreshToken, expiresInSeconds, email, sessionProof) {
  if (accessToken) {
    googleAccessToken = accessToken;
    localStorage.setItem('pebblemeet_access_token', googleAccessToken);
    var ttlSec = parseInt(expiresInSeconds, 10);
    if (isNaN(ttlSec) || ttlSec <= 0) ttlSec = 3600;
    googleTokenExpiresAt = Date.now() + ttlSec * 1000;
    localStorage.setItem('pebblemeet_token_expires_at', String(googleTokenExpiresAt));
  }
  if (refreshToken) {
    googleRefreshToken = refreshToken;
    localStorage.setItem('pebblemeet_refresh_token', googleRefreshToken);
  }
  if (sessionProof) {
    googleSessionProof = sessionProof;
    localStorage.setItem('pebblemeet_session_proof', googleSessionProof);
  }
  if (email !== undefined && email !== null && email !== '') {
    googleEmail = String(email);
    localStorage.setItem('pebblemeet_google_email', googleEmail);
  }
}

function clearOAuthTokens(revokeRemote) {
  var tokenToRevoke = googleRefreshToken || googleAccessToken;
  var proofToSend = googleSessionProof;

  if (revokeRemote && tokenToRevoke && relayUrl && relayUrl.indexOf('https://') === 0) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', relayUrl + '/oauth/revoke');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ token: tokenToRevoke, session_proof: proofToSend }));
    } catch (e) {}
  }

  googleAccessToken = '';
  googleRefreshToken = '';
  googleSessionProof = '';
  googleTokenExpiresAt = 0;
  googleEmail = '';
  oauthContacts = [];
  localStorage.removeItem('pebblemeet_access_token');
  localStorage.removeItem('pebblemeet_refresh_token');
  localStorage.removeItem('pebblemeet_session_proof');
  localStorage.removeItem('pebblemeet_token_expires_at');
  localStorage.removeItem('pebblemeet_google_email');
  syncContactsToWatch();
}

function redeemOAuthTicket(ticket, onComplete) {
  if (!ticket || !relayUrl || relayUrl.indexOf('https://') !== 0) {
    if (onComplete) onComplete(false);
    return;
  }
  var xhr = new XMLHttpRequest();
  xhr.open('POST', relayUrl + '/oauth/exchange');
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function () {
    if (xhr.status === 200) {
      try {
        var data = JSON.parse(xhr.responseText);
        if (data && (data.access_token || data.refresh_token)) {
          saveOAuthTokens(
            data.access_token || '',
            data.refresh_token || '',
            data.expires_in || 3600,
            data.email || '',
            data.session_proof || ''
          );
          if (onComplete) onComplete(true);
          return;
        }
      } catch (e) {}
    }
    if (onComplete) onComplete(false);
  };
  xhr.onerror = function () {
    if (onComplete) onComplete(false);
  };
  xhr.send(JSON.stringify({ ticket: ticket }));
}

function flushRefreshWaiters(token) {
  var queue = refreshWaiters.slice();
  refreshWaiters = [];
  refreshInFlight = false;
  for (var i = 0; i < queue.length; i++) {
    try { queue[i](token); } catch (err) {}
  }
}

function refreshGoogleToken(done) {
  if (!googleRefreshToken || !relayUrl || relayUrl.indexOf('https://') !== 0) {
    done(null);
    return;
  }
  refreshWaiters.push(done);
  if (refreshInFlight) return;
  refreshInFlight = true;

  var xhr = new XMLHttpRequest();
  xhr.open('POST', relayUrl + '/oauth/refresh');
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function () {
    if (xhr.status === 200) {
      try {
        var data = JSON.parse(xhr.responseText);
        if (data && data.access_token) {
          saveOAuthTokens(data.access_token, null, data.expires_in || 3600, null, null);
          flushRefreshWaiters(googleAccessToken);
          return;
        }
      } catch (e) {}
    } else if (xhr.status === 401 || xhr.status === 403) {
      clearOAuthTokens(false);
    }
    flushRefreshWaiters(null);
  };
  xhr.onerror = function () {
    flushRefreshWaiters(null);
  };
  xhr.send(JSON.stringify({
    refresh_token: googleRefreshToken,
    session_proof: googleSessionProof,
  }));
}

function withValidGoogleToken(callback) {
  var needsRefresh =
    !googleAccessToken ||
    (googleTokenExpiresAt > 0 && Date.now() >= googleTokenExpiresAt - 60000);

  if (!needsRefresh) {
    callback(googleAccessToken);
    return;
  }
  if (googleRefreshToken) {
    refreshGoogleToken(function (freshToken) {
      callback(freshToken || googleAccessToken || null);
    });
    return;
  }
  callback(googleAccessToken || null);
}

function fetchOptionalGoogleContacts() {
  if (!googleAccessToken && !googleRefreshToken) return;
  withValidGoogleToken(function (token) {
    if (!token) return;
    var xhr = new XMLHttpRequest();
    xhr.open(
      'GET',
      'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,organizations&pageSize=16'
    );
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = function () {
      if (xhr.status === 401 && googleRefreshToken) {
        refreshGoogleToken(function (fresh) {
          if (fresh) fetchOptionalGoogleContacts();
        });
        return;
      }
      if (xhr.status !== 200) return;
      try {
        var data = JSON.parse(xhr.responseText);
        oauthContacts = (data.connections || []).map(function (p) {
          return {
            name: ((p.names && p.names[0] && p.names[0].displayName) || 'Contact').slice(0, 30),
            role: ((p.organizations && p.organizations[0] && p.organizations[0].title) || 'Google Contact').slice(0, 26),
            email: ((p.emailAddresses && p.emailAddresses[0] && p.emailAddresses[0].value) || '').slice(0, 46),
          };
        });
        syncContactsToWatch();
      } catch (e) {}
    };
    xhr.send();
  });
}

/* -------------------------------------------------------------------------
 * Cloudflare Workers Durable Object WebSocket Bridge Client
 * ------------------------------------------------------------------------- */
function buildBridgeWsUrl() {
  if (!pairingCode) return '';
  var base = (relayUrl || DEFAULT_RELAY_URL).trim().replace(/\/+$/, '');
  if (base.indexOf('ws://') === 0 || base.indexOf('wss://') === 0) {
    var sep = base.indexOf('?') === -1 ? '?' : '&';
    return base + sep + 'room=' + encodeURIComponent(pairingCode) + '&role=pebble';
  }
  var wsBase = base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  return wsBase + '/bridge/ws?room=' + encodeURIComponent(pairingCode) + '&role=pebble';
}

function sendToBridge(obj) {
  if (!bridgeSocket || bridgeSocket.readyState !== 1) return false;
  try {
    bridgeSocket.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    return false;
  }
}

function scheduleBridgeReconnect() {
  if (bridgeReconnectTimer || !pairingCode) return;
  bridgeReconnectTimer = setTimeout(function () {
    bridgeReconnectTimer = null;
    connectBridge();
  }, bridgeReconnectDelayMs);
  bridgeReconnectDelayMs = Math.min(bridgeReconnectDelayMs * 2, 30000);
}

function connectBridge() {
  if (bridgeReconnectTimer) {
    clearTimeout(bridgeReconnectTimer);
    bridgeReconnectTimer = null;
  }
  if (bridgeSocket) {
    try { bridgeSocket.close(); } catch (e) {}
    bridgeSocket = null;
  }
  var wsUrl = buildBridgeWsUrl();
  if (!wsUrl) return;

  try {
    bridgeSocket = new WebSocket(wsUrl);
    bridgeSocket.onopen = function () {
      bridgeReconnectDelayMs = 2000;
      sendToBridge({ cmd: 'REQUEST_STATE' });
    };
    bridgeSocket.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'MEET_STATE') {
        enqueueWatchMessage({
          SYNC_MUTE: msg.muted ? 1 : 0,
          SYNC_CAMERA: msg.cameraOn ? 1 : 0,
          SYNC_HAND_RAISED: msg.handRaised ? 1 : 0,
          SYNC_RECORDING: msg.isRecording ? 1 : 0,
          ACTIVE_SPEAKER: String(msg.activeSpeaker || 'In Call').slice(0, 28),
          PARTICIPANT_COUNT: msg.participantCount || 1,
        });
      }

      if (msg.type === 'MEET_ALERT' && msg.body) {
        var kindMap = { chat: 1, recording: 2, lobby: 3, wrap_up: 4 };
        var kindCode = kindMap[msg.kind] || 0;
        if (kindCode === 1 && !bannerPrefs.alertChat) return;
        if (kindCode === 2 && !bannerPrefs.alertRecording) return;
        if (kindCode === 3 && !bannerPrefs.alertLobby) return;
        if (kindCode === 4 && bannerPrefs.wrapUpMinutes === 0) return;
        enqueueWatchMessage({
          EVT_BANNER_KIND: kindCode,
          EVT_BANNER_BODY: String(msg.body).slice(0, 60),
        });
      }

      if (msg.type === 'MEET_CAPTION' && msg.text && bannerPrefs.showCaptions) {
        enqueueWatchMessage({
          EVT_CAPTION: String(msg.text).slice(0, 56),
        });
      }

      if (msg.type === 'MEET_TABS' && Array.isArray(msg.meetings)) {
        chromeMeetTabs = msg.meetings;
        syncMeetingsToWatch();
      }

      if (msg.type === 'CONTACTS_SYNC' && Array.isArray(msg.contacts)) {
        chromeContacts = msg.contacts;
        syncContactsToWatch();
      }

      if (msg.type === 'INVITE_STATUS' && msg.message) {
        enqueueWatchMessage({
          EVT_BANNER_KIND: 0,
          EVT_BANNER_BODY: String(msg.message).slice(0, 60),
        });
      }

      // Browser-initiated OAuth (opened from Chrome Extension popup -> bypasses Pebble WebView!)
      if (msg.type === 'OAUTH_TICKET' && msg.ticket) {
        redeemOAuthTicket(msg.ticket, function (ok) {
          if (ok) {
            fetchOptionalGoogleContacts();
            enqueueWatchMessage({
              EVT_BANNER_KIND: 0,
              EVT_BANNER_BODY: 'Google Contacts connected',
            });
          }
        });
      }
    };
    bridgeSocket.onclose = function () {
      bridgeSocket = null;
      scheduleBridgeReconnect();
    };
    bridgeSocket.onerror = function () {
      try { if (bridgeSocket) bridgeSocket.close(); } catch (e) {}
    };
  } catch (err) {
    console.log('Bridge WS unavailable: ' + err);
    scheduleBridgeReconnect();
  }
}

/* -------------------------------------------------------------------------
 * Configuration Page (Single Source of Truth: docs/config/index.html)
 * ------------------------------------------------------------------------- */
Pebble.addEventListener('showConfiguration', function () {
  var publicState = {
    PAIRING_CODE: pairingCode,
    RELAY_URL: relayUrl,
    CALENDAR_ICS_URL: calendarIcsUrl,
    LOCAL_CONTACTS: localContacts,
    GOOGLE_EMAIL: googleEmail,
    CFG_DEFAULT_PTT: savedWatchPrefs.CFG_DEFAULT_PTT,
    CFG_JOIN_MUTED: savedWatchPrefs.CFG_JOIN_MUTED,
    CFG_JOIN_CAM_OFF: savedWatchPrefs.CFG_JOIN_CAM_OFF,
    CFG_UP_SHORT: savedWatchPrefs.CFG_UP_SHORT,
    CFG_UP_DOUBLE: savedWatchPrefs.CFG_UP_DOUBLE,
    CFG_UP_LONG: savedWatchPrefs.CFG_UP_LONG,
    CFG_SELECT_SHORT: savedWatchPrefs.CFG_SELECT_SHORT,
    CFG_SELECT_DOUBLE: savedWatchPrefs.CFG_SELECT_DOUBLE,
    CFG_SELECT_LONG: savedWatchPrefs.CFG_SELECT_LONG,
    CFG_DOWN_SHORT: savedWatchPrefs.CFG_DOWN_SHORT,
    CFG_DOWN_DOUBLE: savedWatchPrefs.CFG_DOWN_DOUBLE,
    CFG_DOWN_LONG: savedWatchPrefs.CFG_DOWN_LONG,
    CFG_SHOW_CAPTIONS: savedWatchPrefs.CFG_SHOW_CAPTIONS,
    CFG_ALERT_CHAT: savedWatchPrefs.CFG_ALERT_CHAT,
    CFG_ALERT_RECORDING: savedWatchPrefs.CFG_ALERT_RECORDING,
    CFG_ALERT_LOBBY: savedWatchPrefs.CFG_ALERT_LOBBY,
    CFG_WRAP_UP_MINUTES: savedWatchPrefs.CFG_WRAP_UP_MINUTES,
  };
  // Do NOT hardcode `return_to` here so `pebble emu-app-config` can append its own return_to!
  var url = HOSTED_CONFIG_URL + '?state=' + encodeURIComponent(JSON.stringify(publicState));
  Pebble.openURL(url);
});

function readIntSetting(settings, key, fallback) {
  var val = settings[key];
  if (val === undefined || val === null || val === '') return fallback;
  var parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function readBoolSetting(settings, key, fallback) {
  var val = settings[key];
  if (val === undefined || val === null) return fallback ? 1 : 0;
  return val === true || val === 1 || val === '1' || val === 'true' ? 1 : 0;
}

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  var settings;
  try {
    settings = JSON.parse(decodeURIComponent(e.response));
  } catch (err) {
    return;
  }
  if (!settings || typeof settings !== 'object') return;

  var reconnectNeeded = false;

  if (typeof settings.RELAY_URL === 'string' && settings.RELAY_URL) {
    var nextRelay = settings.RELAY_URL.trim().replace(/\/+$/, '');
    if (nextRelay !== relayUrl) {
      relayUrl = nextRelay;
      localStorage.setItem('pebblemeet_relay_url', relayUrl);
      reconnectNeeded = true;
    }
  }

  if (typeof settings.PAIRING_CODE === 'string') {
    var nextCode = normalizeRoomCode(settings.PAIRING_CODE);
    if (nextCode !== pairingCode) {
      pairingCode = nextCode;
      localStorage.setItem('pebblemeet_pairing_code', pairingCode);
      reconnectNeeded = true;
    }
  }

  if (typeof settings.CALENDAR_ICS_URL === 'string') {
    calendarIcsUrl = settings.CALENDAR_ICS_URL.trim();
    localStorage.setItem('pebblemeet_calendar_ics_url', calendarIcsUrl);
  }

  if (Array.isArray(settings.LOCAL_CONTACTS)) {
    localContacts = settings.LOCAL_CONTACTS.slice(0, 16);
    localStorage.setItem('pebblemeet_local_contacts', JSON.stringify(localContacts));
  }

  // Optional OAuth disconnect / single-use ticket redemption
  if (settings.GOOGLE_DISCONNECT === 1 || settings.GOOGLE_DISCONNECT === true) {
    clearOAuthTokens(true);
  } else if (typeof settings.OAUTH_TICKET === 'string' && settings.OAUTH_TICKET) {
    redeemOAuthTicket(settings.OAUTH_TICKET, function (ok) {
      if (ok) fetchOptionalGoogleContacts();
    });
  }

  var showCaptions = readBoolSetting(settings, 'CFG_SHOW_CAPTIONS', true);
  var alertChat = readBoolSetting(settings, 'CFG_ALERT_CHAT', true);
  var alertRecording = readBoolSetting(settings, 'CFG_ALERT_RECORDING', true);
  var alertLobby = readBoolSetting(settings, 'CFG_ALERT_LOBBY', true);
  var wrapUpMinutes = readIntSetting(settings, 'CFG_WRAP_UP_MINUTES', 5);

  bannerPrefs = {
    showCaptions: showCaptions === 1,
    alertChat: alertChat === 1,
    alertRecording: alertRecording === 1,
    alertLobby: alertLobby === 1,
    wrapUpMinutes: wrapUpMinutes,
  };
  localStorage.setItem('pebblemeet_banner_prefs', JSON.stringify(bannerPrefs));

  var watchPayload = {
    CFG_DEFAULT_PTT: readBoolSetting(settings, 'CFG_DEFAULT_PTT', false),
    CFG_JOIN_MUTED: readBoolSetting(settings, 'CFG_JOIN_MUTED', false),
    CFG_JOIN_CAM_OFF: readBoolSetting(settings, 'CFG_JOIN_CAM_OFF', false),
    CFG_UP_SHORT: readIntSetting(settings, 'CFG_UP_SHORT', 0),
    CFG_UP_DOUBLE: readIntSetting(settings, 'CFG_UP_DOUBLE', 11),
    CFG_UP_LONG: readIntSetting(settings, 'CFG_UP_LONG', 4),
    CFG_SELECT_SHORT: readIntSetting(settings, 'CFG_SELECT_SHORT', 10),
    CFG_SELECT_DOUBLE: readIntSetting(settings, 'CFG_SELECT_DOUBLE', 9),
    CFG_SELECT_LONG: readIntSetting(settings, 'CFG_SELECT_LONG', 3),
    CFG_DOWN_SHORT: readIntSetting(settings, 'CFG_DOWN_SHORT', 2),
    CFG_DOWN_DOUBLE: readIntSetting(settings, 'CFG_DOWN_DOUBLE', 11),
    CFG_DOWN_LONG: readIntSetting(settings, 'CFG_DOWN_LONG', 5),
    CFG_SHOW_CAPTIONS: showCaptions,
    CFG_ALERT_CHAT: alertChat,
    CFG_ALERT_RECORDING: alertRecording,
    CFG_ALERT_LOBBY: alertLobby,
    CFG_WRAP_UP_MINUTES: wrapUpMinutes,
  };

  savedWatchPrefs = watchPayload;
  localStorage.setItem('pebblemeet_watch_prefs', JSON.stringify(watchPayload));

  enqueueWatchMessage(watchPayload, function () {
    syncContactsToWatch();
    fetchIcsCalendarMeetings();
    fetchOptionalGoogleContacts();
  });

  if (reconnectNeeded) {
    connectBridge();
  }
});

Pebble.addEventListener('ready', function () {
  connectBridge();
  syncContactsToWatch();
  fetchIcsCalendarMeetings();
  fetchOptionalGoogleContacts();
});

/* -------------------------------------------------------------------------
 * Watch -> Phone -> Cloudflare Durable Object -> Chrome Extension Commands
 * ------------------------------------------------------------------------- */
Pebble.addEventListener('appmessage', function (e) {
  var payload = e.payload || {};

  if (payload.CMD_NEW_MEET !== undefined) {
    sendToBridge({ cmd: 'NEW_MEET' });
  }
  if (payload.CMD_JOIN_MEETING) {
    sendToBridge({
      cmd: 'OPEN_MEET',
      url: 'https://meet.google.com/' + payload.CMD_JOIN_MEETING,
    });
  }
  if (payload.CMD_START_CALL !== undefined) {
    sendToBridge({
      cmd: 'CALL_CONTACT',
      callee: payload.CONTACT_NAME || '',
      email: payload.CONTACT_EMAIL || '',
    });
  }
  if (payload.CMD_INVITE_CONTACT !== undefined) {
    sendToBridge({
      cmd: 'INVITE_CONTACT',
      callee: payload.CONTACT_NAME || '',
      email: payload.CONTACT_EMAIL || '',
    });
  }
  if (payload.CMD_TOGGLE_MUTE !== undefined) {
    sendToBridge({ cmd: 'TOGGLE_MUTE', muted: payload.CMD_TOGGLE_MUTE === 1 });
  }
  if (payload.CMD_TOGGLE_CAMERA !== undefined) {
    sendToBridge({ cmd: 'TOGGLE_CAMERA', cameraOn: payload.CMD_TOGGLE_CAMERA === 1 });
  }
  if (payload.CMD_RAISE_HAND !== undefined) {
    sendToBridge({ cmd: 'RAISE_HAND', raised: payload.CMD_RAISE_HAND === 1 });
  }
  if (payload.CMD_TOGGLE_CAPTIONS !== undefined) {
    sendToBridge({ cmd: 'TOGGLE_CAPTIONS' });
  }
  if (payload.CMD_SEND_CHAT) {
    sendToBridge({ cmd: 'SEND_CHAT', text: payload.CMD_SEND_CHAT });
  }
  if (payload.CMD_ADMIT_GUEST !== undefined) {
    sendToBridge({ cmd: 'ADMIT_GUEST' });
  }
  if (payload.CMD_END_CALL !== undefined) {
    sendToBridge({ cmd: 'END_CALL' });
  }
});
