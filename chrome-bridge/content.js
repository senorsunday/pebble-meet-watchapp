/* PebbleMeet Chrome Extension Content Script
 * Matches: https://meet.google.com/*
 * Executes wrist commands and streams live Meet state & active speaker to Pebble.
 */

const ws = new WebSocket('ws://localhost:8765');

function findMeetControl(keyword) {
  const buttons = Array.from(
    document.querySelectorAll('button[aria-label], div[role="button"][aria-label]')
  );
  return buttons.find((el) => {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    return label.includes(keyword);
  });
}

function getParticipantCount() {
  const peopleBtn = findMeetControl('show everyone');
  const text = peopleBtn?.parentElement?.textContent || '';
  const match = text.match(/\d+/);
  return match ? Number(match[0]) : 2;
}

function broadcastCurrentMeetState() {
  const micBtn = findMeetControl('microphone');
  const camBtn = findMeetControl('camera');
  if (!micBtn && !camBtn) return;

  const muted = micBtn?.getAttribute('data-is-muted') === 'true';
  const camOff = camBtn?.getAttribute('data-is-muted') === 'true';

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'MEET_STATE',
      muted,
      cameraOn: !camOff,
      participantCount: getParticipantCount(),
      activeSpeaker: muted ? 'Remote Speaker' : 'You',
    }));
  }
}

function submitMeetChat(text) {
  const chatBtn = findMeetControl('chat with everyone');
  if (chatBtn && chatBtn.getAttribute('aria-pressed') !== 'true') {
    chatBtn.click();
  }
  setTimeout(() => {
    const input = document.querySelector('textarea[aria-label*="Send a message"]');
    if (!input) return;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const sendBtn = findMeetControl('send a message');
    sendBtn?.click();
  }, 200);
}

ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);

  if (data.cmd === 'TOGGLE_MUTE') {
    findMeetControl('microphone')?.click();
    setTimeout(broadcastCurrentMeetState, 150);
  }
  if (data.cmd === 'TOGGLE_CAMERA') {
    findMeetControl('camera')?.click();
    setTimeout(broadcastCurrentMeetState, 150);
  }
  if (data.cmd === 'RAISE_HAND') {
    findMeetControl('raise hand')?.click();
  }
  if (data.cmd === 'SEND_CHAT' && data.text) {
    submitMeetChat(data.text);
  }
  if (data.cmd === 'ADMIT_GUEST') {
    findMeetControl('admit')?.click();
  }
  if (data.cmd === 'END_CALL') {
    findMeetControl('leave call')?.click();
  }
});

const observer = new MutationObserver(() => broadcastCurrentMeetState());
observer.observe(document.body, {
  attributes: true,
  subtree: true,
  attributeFilter: ['data-is-muted'],
});
