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
        Pebble.sendAppMessage({
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

  var watchPayload = {
    CFG_DEFAULT_PTT: rawSettings.CFG_DEFAULT_PTT && rawSettings.CFG_DEFAULT_PTT.value ? 1 : 0,
    CFG_JOIN_MUTED: rawSettings.CFG_JOIN_MUTED && rawSettings.CFG_JOIN_MUTED.value ? 1 : 0,
    CFG_JOIN_CAM_OFF: rawSettings.CFG_JOIN_CAM_OFF && rawSettings.CFG_JOIN_CAM_OFF.value ? 1 : 0,
    CFG_UP_SHORT: parseInt((rawSettings.CFG_UP_SHORT && rawSettings.CFG_UP_SHORT.value) || '0', 10),
    CFG_SELECT_SHORT: parseInt((rawSettings.CFG_SELECT_SHORT && rawSettings.CFG_SELECT_SHORT.value) || '3', 10),
    CFG_DOWN_SHORT: parseInt((rawSettings.CFG_DOWN_SHORT && rawSettings.CFG_DOWN_SHORT.value) || '2', 10),
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
