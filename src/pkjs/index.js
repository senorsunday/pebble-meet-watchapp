/* PebbleKit JS Companion for PebbleMeet
 * Bridges Pebble AppMessage <-> Pebble Clay Settings, Google Calendar,
 * People, Meet APIs, and the Chrome Browser Bridge.
 */

var Clay = require('pebble-clay');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var BRIDGE_WS_URL = localStorage.getItem('pebblemeet_bridge_url') || 'ws://localhost:8765';
var bridgeSocket = null;
var googleAccessToken = localStorage.getItem('pebblemeet_access_token') || '';
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
  if (!googleAccessToken) return;
  var nowIso = encodeURIComponent(new Date().toISOString());
  var xhr = new XMLHttpRequest();
  xhr.open(
    'GET',
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=' +
      nowIso +
      '&singleEvents=true&orderBy=startTime&maxResults=6'
  );
  xhr.setRequestHeader('Authorization', 'Bearer ' + googleAccessToken);
  xhr.onload = function () {
    if (xhr.status !== 200) return;
    var data = JSON.parse(xhr.responseText);
    var queue = [];
    (data.items || []).forEach(function (ev) {
      if (!ev.hangoutLink) return;
      var code = ev.hangoutLink.split('/').pop();
      queue.push({
        MEETING_INDEX: queue.length,
        MEETING_TITLE: (ev.summary || 'Google Meet').slice(0, 30),
        MEETING_TIME: (ev.start && ev.start.dateTime ? ev.start.dateTime.slice(11, 16) : 'Today'),
        MEET_CODE: code,
      });
    });
    sendQueueToWatch(queue);
  };
  xhr.send();
}

function fetchGoogleContacts() {
  if (!googleAccessToken) return;
  var xhr = new XMLHttpRequest();
  xhr.open(
    'GET',
    'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,organizations&pageSize=16'
  );
  xhr.setRequestHeader('Authorization', 'Bearer ' + googleAccessToken);
  xhr.onload = function () {
    if (xhr.status !== 200) return;
    var data = JSON.parse(xhr.responseText);
    var queue = (data.connections || []).map(function (p, idx) {
      return {
        CONTACT_INDEX: idx,
        CONTACT_NAME: ((p.names && p.names[0] && p.names[0].displayName) || 'Contact').slice(0, 30),
        CONTACT_ROLE: ((p.organizations && p.organizations[0] && p.organizations[0].title) || 'Google Contact').slice(0, 26),
        CONTACT_EMAIL: ((p.emailAddresses && p.emailAddresses[0] && p.emailAddresses[0].value) || '').slice(0, 46),
      };
    });
    sendQueueToWatch(queue);
  };
  xhr.send();
}

function createGoogleMeetCall(contactName, contactEmail) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://meet.googleapis.com/v2/spaces');
  xhr.setRequestHeader('Authorization', 'Bearer ' + googleAccessToken);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      var space = JSON.parse(xhr.responseText);
      Pebble.sendAppMessage({ MEET_CODE: space.meetingCode });
      if (bridgeSocket && bridgeSocket.readyState === 1) {
        bridgeSocket.send(JSON.stringify({
          cmd: 'OPEN_MEET',
          url: space.meetingUri,
          callee: contactName,
          email: contactEmail,
        }));
      }
    }
  };
  xhr.send('{}');
}

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

function readActionSetting(settings, key, fallback) {
  var entry = settings[key];
  if (!entry || entry.value === undefined || entry.value === null || entry.value === '') {
    return fallback;
  }
  var parsed = parseInt(entry.value, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function readToggleSetting(settings, key, fallback) {
  var entry = settings[key];
  if (!entry || entry.value === undefined || entry.value === null) {
    return fallback ? 1 : 0;
  }
  return entry.value ? 1 : 0;
}

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  var rawSettings = clay.getSettings(e.response, false);
  if (rawSettings.GOOGLE_TOKEN && rawSettings.GOOGLE_TOKEN.value) {
    googleAccessToken = rawSettings.GOOGLE_TOKEN.value;
    localStorage.setItem('pebblemeet_access_token', googleAccessToken);
  }
  if (rawSettings.BRIDGE_WS_URL && rawSettings.BRIDGE_WS_URL.value) {
    BRIDGE_WS_URL = rawSettings.BRIDGE_WS_URL.value;
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
