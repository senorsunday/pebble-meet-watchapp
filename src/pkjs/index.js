/* PebbleKit JS Companion for PebbleMeet
 * Bridges Pebble AppMessage <-> Hosted HTTPS OAuth Settings (with Pebble Clay
 * fallback), auto-refreshing Google Calendar / People / Meet APIs, and the
 * Chrome Browser Bridge.
 */

var Clay = require('pebble-clay');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var HOSTED_CONFIG_URL = 'https://senorsunday.github.io/pebble-meet-watchapp/config/';
var USE_HOSTED_OAUTH_CONFIG = true;
var DEFAULT_OAUTH_RELAY_URL = 'https://pebble-meet-watchapp-oauth.apalson.workers.dev';

var BRIDGE_WS_URL = localStorage.getItem('pebblemeet_bridge_url') || 'ws://localhost:8765';
var oauthRelayUrl = localStorage.getItem('pebblemeet_oauth_relay_url') || DEFAULT_OAUTH_RELAY_URL;
var bridgeSocket = null;

var googleAccessToken = localStorage.getItem('pebblemeet_access_token') || '';
var googleRefreshToken = localStorage.getItem('pebblemeet_refresh_token') || '';
var googleTokenExpiresAt = parseInt(localStorage.getItem('pebblemeet_token_expires_at') || '0', 10) || 0;
var googleEmail = localStorage.getItem('pebblemeet_google_email') || '';

var refreshInFlight = false;
var refreshWaiters = [];

var savedWatchPrefs = (function () {
  try {
    var parsed = JSON.parse(localStorage.getItem('pebblemeet_watch_prefs') || 'null');
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) {}
  return {
    CFG_DEFAULT_PTT: 0,
    CFG_JOIN_MUTED: 0,
    CFG_JOIN_CAM_OFF: 0,
    CFG_UP_SHORT: 0,
    CFG_UP_DOUBLE: 10,
    CFG_UP_LONG: 4,
    CFG_SELECT_SHORT: 3,
    CFG_SELECT_DOUBLE: 9,
    CFG_SELECT_LONG: 11,
    CFG_DOWN_SHORT: 2,
    CFG_DOWN_DOUBLE: 11,
    CFG_DOWN_LONG: 5,
    CFG_SHOW_CAPTIONS: 1,
    CFG_ALERT_CHAT: 1,
    CFG_ALERT_RECORDING: 1,
    CFG_ALERT_LOBBY: 1,
    CFG_WRAP_UP_MINUTES: 5,
  };
})();

var bannerPrefs = (function () {
  try {
    var saved = JSON.parse(localStorage.getItem('pebblemeet_banner_prefs') || 'null');
    if (saved && typeof saved === 'object') return saved;
  } catch (e) {}
  return {
    showCaptions: true,
    alertChat: true,
    alertRecording: true,
    alertLobby: true,
    wrapUpMinutes: 5,
  };
})();

function saveOAuthTokens(accessToken, refreshToken, expiresInSeconds, email) {
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
  if (email !== undefined && email !== null && email !== '') {
    googleEmail = String(email);
    localStorage.setItem('pebblemeet_google_email', googleEmail);
  }
}

function clearOAuthTokens() {
  googleAccessToken = '';
  googleRefreshToken = '';
  googleTokenExpiresAt = 0;
  googleEmail = '';
  localStorage.removeItem('pebblemeet_access_token');
  localStorage.removeItem('pebblemeet_refresh_token');
  localStorage.removeItem('pebblemeet_token_expires_at');
  localStorage.removeItem('pebblemeet_google_email');
}

function flushRefreshWaiters(token) {
  var queue = refreshWaiters.slice();
  refreshWaiters = [];
  refreshInFlight = false;
  for (var i = 0; i < queue.length; i++) {
    try {
      queue[i](token);
    } catch (err) {}
  }
}

function refreshGoogleToken(done) {
  if (!googleRefreshToken || !oauthRelayUrl || oauthRelayUrl.indexOf('https://') !== 0) {
    done(null);
    return;
  }
  refreshWaiters.push(done);
  if (refreshInFlight) return;
  refreshInFlight = true;

  var xhr = new XMLHttpRequest();
  xhr.open('POST', oauthRelayUrl.replace(/\/+$/, '') + '/oauth/refresh');
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function () {
    if (xhr.status === 200) {
      try {
        var data = JSON.parse(xhr.responseText);
        if (data && data.access_token) {
          saveOAuthTokens(data.access_token, null, data.expires_in || 3600, null);
          flushRefreshWaiters(googleAccessToken);
          return;
        }
      } catch (e) {}
    } else if (xhr.status === 401) {
      clearOAuthTokens();
    }
    flushRefreshWaiters(null);
  };
  xhr.onerror = function () {
    flushRefreshWaiters(null);
  };
  xhr.send(JSON.stringify({ refresh_token: googleRefreshToken }));
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

function googleApiRequest(method, url, bodyObj, onSuccess, allowRetry) {
  withValidGoogleToken(function (token) {
    if (!token) return;
    var xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    if (bodyObj !== null && bodyObj !== undefined) {
      xhr.setRequestHeader('Content-Type', 'application/json');
    }
    xhr.onload = function () {
      if (xhr.status === 401 && allowRetry !== false && googleRefreshToken) {
        refreshGoogleToken(function (freshToken) {
          if (freshToken) {
            googleApiRequest(method, url, bodyObj, onSuccess, false);
          }
        });
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          onSuccess(JSON.parse(xhr.responseText));
        } catch (err) {
          console.log('Google API JSON parse error: ' + err);
        }
      }
    };
    xhr.send(bodyObj !== null && bodyObj !== undefined ? JSON.stringify(bodyObj) : null);
  });
}

function connectBridge() {
  if (bridgeSocket) {
    try { bridgeSocket.close(); } catch (e) {}
  }
  try {
    bridgeSocket = new WebSocket(BRIDGE_WS_URL);
    bridgeSocket.onmessage = function (event) {
      var msg = JSON.parse(event.data);
      if (msg.type === 'MEET_STATE') {
        Pebble.sendAppMessage({
          SYNC_MUTE: msg.muted ? 1 : 0,
          SYNC_CAMERA: msg.cameraOn ? 1 : 0,
          SYNC_RECORDING: msg.isRecording ? 1 : 0,
          ACTIVE_SPEAKER: (msg.activeSpeaker || 'In Call').slice(0, 28),
          PARTICIPANT_COUNT: msg.participantCount || 2,
        });
      }
      if (msg.type === 'MEET_ALERT' && msg.body) {
        var kindMap = { chat: 1, recording: 2, lobby: 3, wrap_up: 4 };
        var kindCode = kindMap[msg.kind] || 0;
        if (kindCode === 1 && !bannerPrefs.alertChat) return;
        if (kindCode === 2 && !bannerPrefs.alertRecording) return;
        if (kindCode === 3 && !bannerPrefs.alertLobby) return;
        if (kindCode === 4 && bannerPrefs.wrapUpMinutes === 0) return;
        Pebble.sendAppMessage({
          EVT_BANNER_KIND: kindCode,
          EVT_BANNER_BODY: String(msg.body).slice(0, 60),
        });
      }
    };
  } catch (err) {
    console.log('Bridge WS unavailable: ' + err);
  }
}

function sendQueueToWatch(messages) {
  var i = 0;
  function next() {
    if (i >= messages.length) return;
    Pebble.sendAppMessage(messages[i], function () {
      i++;
      next();
    });
  }
  next();
}

function fetchCalendarMeetings() {
  var nowIso = encodeURIComponent(new Date().toISOString());
  var url =
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=' +
    nowIso +
    '&singleEvents=true&orderBy=startTime&maxResults=6';

  googleApiRequest('GET', url, null, function (data) {
    var queue = [];
    (data.items || []).forEach(function (ev) {
      var videoUri = ev.hangoutLink || '';
      if (!videoUri && ev.conferenceData && ev.conferenceData.entryPoints) {
        for (var j = 0; j < ev.conferenceData.entryPoints.length; j++) {
          if (ev.conferenceData.entryPoints[j].entryPointType === 'video') {
            videoUri = ev.conferenceData.entryPoints[j].uri || '';
            break;
          }
        }
      }
      if (!videoUri) return;
      var code = videoUri.split('/').pop();
      queue.push({
        MEETING_INDEX: queue.length,
        MEETING_TITLE: (ev.summary || 'Google Meet').slice(0, 30),
        MEETING_TIME: ev.start && ev.start.dateTime ? ev.start.dateTime.slice(11, 16) : 'Today',
        MEET_CODE: code,
      });
    });
    sendQueueToWatch(queue);
  });
}

function fetchGoogleContacts() {
  var url =
    'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,organizations&pageSize=16';

  googleApiRequest('GET', url, null, function (data) {
    var queue = (data.connections || []).map(function (p, idx) {
      return {
        CONTACT_INDEX: idx,
        CONTACT_NAME: ((p.names && p.names[0] && p.names[0].displayName) || 'Contact').slice(0, 30),
        CONTACT_ROLE: ((p.organizations && p.organizations[0] && p.organizations[0].title) || 'Google Contact').slice(0, 26),
        CONTACT_EMAIL: ((p.emailAddresses && p.emailAddresses[0] && p.emailAddresses[0].value) || '').slice(0, 46),
      };
    });
    sendQueueToWatch(queue);
  });
}

function createGoogleMeetCall(contactName, contactEmail) {
  googleApiRequest('POST', 'https://meet.googleapis.com/v2/spaces', {}, function (space) {
    if (!space || !space.meetingCode) return;
    Pebble.sendAppMessage({ MEET_CODE: space.meetingCode });
    if (bridgeSocket && bridgeSocket.readyState === 1) {
      bridgeSocket.send(JSON.stringify({
        cmd: 'OPEN_MEET',
        url: space.meetingUri,
        callee: contactName,
        email: contactEmail,
      }));
    }
  });
}

Pebble.addEventListener('showConfiguration', function () {
  if (USE_HOSTED_OAUTH_CONFIG && HOSTED_CONFIG_URL.indexOf('https://') === 0) {
    var publicState = {
      BRIDGE_WS_URL: BRIDGE_WS_URL,
      OAUTH_RELAY_URL: oauthRelayUrl,
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
    var url =
      HOSTED_CONFIG_URL +
      '?return_to=' +
      encodeURIComponent('pebblejs://close#') +
      '&state=' +
      encodeURIComponent(JSON.stringify(publicState));
    Pebble.openURL(url);
    return;
  }
  Pebble.openURL(clay.generateUrl());
});

function unwrapSettingValue(settings, key) {
  var entry = settings[key];
  if (entry === undefined || entry === null) return undefined;
  if (typeof entry === 'object' && entry.value !== undefined) {
    return entry.value;
  }
  return entry;
}

function readActionSetting(settings, key, fallback) {
  var val = unwrapSettingValue(settings, key);
  if (val === undefined || val === null || val === '') {
    return fallback;
  }
  var parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function readToggleSetting(settings, key, fallback) {
  var val = unwrapSettingValue(settings, key);
  if (val === undefined || val === null) {
    return fallback ? 1 : 0;
  }
  return val === true || val === 1 || val === '1' || val === 'true' ? 1 : 0;
}

function parseWebviewSettings(rawResponse) {
  try {
    var decoded = decodeURIComponent(rawResponse);
    var parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object') {
      // Detect Pebble Clay format ({ KEY: { value: ... } }) vs Hosted JSON format
      var firstKey = Object.keys(parsed)[0];
      if (firstKey && parsed[firstKey] && typeof parsed[firstKey] === 'object' && 'value' in parsed[firstKey]) {
        return clay.getSettings(rawResponse, false);
      }
      return parsed;
    }
  } catch (e) {}
  return clay.getSettings(rawResponse, false);
}

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  var rawSettings = parseWebviewSettings(e.response);

  var relayVal = unwrapSettingValue(rawSettings, 'OAUTH_RELAY_URL');
  if (typeof relayVal === 'string' && relayVal.indexOf('https://') === 0) {
    oauthRelayUrl = relayVal.replace(/\/+$/, '');
    localStorage.setItem('pebblemeet_oauth_relay_url', oauthRelayUrl);
  }

  var disconnectVal = unwrapSettingValue(rawSettings, 'GOOGLE_DISCONNECT');
  if (disconnectVal === 1 || disconnectVal === true || disconnectVal === '1') {
    clearOAuthTokens();
  } else {
    var tokenVal = unwrapSettingValue(rawSettings, 'GOOGLE_TOKEN');
    var refreshVal = unwrapSettingValue(rawSettings, 'GOOGLE_REFRESH_TOKEN');
    var expiresVal = unwrapSettingValue(rawSettings, 'GOOGLE_EXPIRES_IN');
    var emailVal = unwrapSettingValue(rawSettings, 'GOOGLE_EMAIL');
    if (tokenVal || refreshVal || emailVal) {
      saveOAuthTokens(tokenVal || '', refreshVal || '', expiresVal || 3600, emailVal || '');
    }
  }

  var bridgeVal = unwrapSettingValue(rawSettings, 'BRIDGE_WS_URL');
  if (typeof bridgeVal === 'string' && bridgeVal) {
    BRIDGE_WS_URL = bridgeVal;
    localStorage.setItem('pebblemeet_bridge_url', BRIDGE_WS_URL);
    connectBridge();
  }

  var showCaptions = readToggleSetting(rawSettings, 'CFG_SHOW_CAPTIONS', true);
  var alertChat = readToggleSetting(rawSettings, 'CFG_ALERT_CHAT', true);
  var alertRecording = readToggleSetting(rawSettings, 'CFG_ALERT_RECORDING', true);
  var alertLobby = readToggleSetting(rawSettings, 'CFG_ALERT_LOBBY', true);
  var wrapUpMinutes = readActionSetting(rawSettings, 'CFG_WRAP_UP_MINUTES', 5);

  bannerPrefs = {
    showCaptions: showCaptions === 1,
    alertChat: alertChat === 1,
    alertRecording: alertRecording === 1,
    alertLobby: alertLobby === 1,
    wrapUpMinutes: wrapUpMinutes,
  };
  localStorage.setItem('pebblemeet_banner_prefs', JSON.stringify(bannerPrefs));

  var watchPayload = {
    CFG_DEFAULT_PTT: readToggleSetting(rawSettings, 'CFG_DEFAULT_PTT', false),
    CFG_JOIN_MUTED: readToggleSetting(rawSettings, 'CFG_JOIN_MUTED', false),
    CFG_JOIN_CAM_OFF: readToggleSetting(rawSettings, 'CFG_JOIN_CAM_OFF', false),
    CFG_UP_SHORT: readActionSetting(rawSettings, 'CFG_UP_SHORT', 0),
    CFG_UP_DOUBLE: readActionSetting(rawSettings, 'CFG_UP_DOUBLE', 10),
    CFG_UP_LONG: readActionSetting(rawSettings, 'CFG_UP_LONG', 4),
    CFG_SELECT_SHORT: readActionSetting(rawSettings, 'CFG_SELECT_SHORT', 3),
    CFG_SELECT_DOUBLE: readActionSetting(rawSettings, 'CFG_SELECT_DOUBLE', 9),
    CFG_SELECT_LONG: readActionSetting(rawSettings, 'CFG_SELECT_LONG', 11),
    CFG_DOWN_SHORT: readActionSetting(rawSettings, 'CFG_DOWN_SHORT', 2),
    CFG_DOWN_DOUBLE: readActionSetting(rawSettings, 'CFG_DOWN_DOUBLE', 11),
    CFG_DOWN_LONG: readActionSetting(rawSettings, 'CFG_DOWN_LONG', 5),
    CFG_SHOW_CAPTIONS: showCaptions,
    CFG_ALERT_CHAT: alertChat,
    CFG_ALERT_RECORDING: alertRecording,
    CFG_ALERT_LOBBY: alertLobby,
    CFG_WRAP_UP_MINUTES: wrapUpMinutes,
  };

  savedWatchPrefs = watchPayload;
  localStorage.setItem('pebblemeet_watch_prefs', JSON.stringify(watchPayload));

  Pebble.sendAppMessage(watchPayload, function () {
    fetchCalendarMeetings();
    fetchGoogleContacts();
  });
});

Pebble.addEventListener('ready', function () {
  connectBridge();
  fetchCalendarMeetings();
  fetchGoogleContacts();
});

Pebble.addEventListener('appmessage', function (e) {
  var payload = e.payload || {};
  if (payload.CMD_JOIN_MEETING && bridgeSocket && bridgeSocket.readyState === 1) {
    bridgeSocket.send(JSON.stringify({
      cmd: 'OPEN_MEET',
      url: 'https://meet.google.com/' + payload.CMD_JOIN_MEETING,
    }));
  }
  if (payload.CMD_START_CALL !== undefined) {
    createGoogleMeetCall(payload.CONTACT_NAME || '', payload.CONTACT_EMAIL || '');
  }
  if (payload.CMD_TOGGLE_MUTE !== undefined && bridgeSocket && bridgeSocket.readyState === 1) {
    bridgeSocket.send(JSON.stringify({ cmd: 'TOGGLE_MUTE', muted: payload.CMD_TOGGLE_MUTE === 1 }));
  }
  if (payload.CMD_TOGGLE_CAMERA !== undefined && bridgeSocket && bridgeSocket.readyState === 1) {
    bridgeSocket.send(JSON.stringify({ cmd: 'TOGGLE_CAMERA', cameraOn: payload.CMD_TOGGLE_CAMERA === 1 }));
  }
  if (payload.CMD_RAISE_HAND !== undefined && bridgeSocket && bridgeSocket.readyState === 1) {
    bridgeSocket.send(JSON.stringify({ cmd: 'RAISE_HAND', raised: payload.CMD_RAISE_HAND === 1 }));
  }
  if (payload.CMD_SEND_CHAT && bridgeSocket && bridgeSocket.readyState === 1) {
    bridgeSocket.send(JSON.stringify({ cmd: 'SEND_CHAT', text: payload.CMD_SEND_CHAT }));
  }
  if (payload.CMD_ADMIT_GUEST !== undefined && bridgeSocket && bridgeSocket.readyState === 1) {
    bridgeSocket.send(JSON.stringify({ cmd: 'ADMIT_GUEST' }));
  }
  if (payload.CMD_END_CALL !== undefined && bridgeSocket && bridgeSocket.readyState === 1) {
    bridgeSocket.send(JSON.stringify({ cmd: 'END_CALL' }));
  }
});
