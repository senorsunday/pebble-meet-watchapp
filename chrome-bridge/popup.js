/* PebbleMeet Chrome Extension Popup Controller */

let state = {
  pairingCode: '',
  formattedCode: '',
  relayUrl: '',
  contacts: [],
};

function setToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg || '';
  if (msg) {
    setTimeout(() => {
      if (el.textContent === msg) el.textContent = '';
    }, 2500);
  }
}

function renderContacts() {
  const container = document.getElementById('contact-list');
  container.textContent = '';

  if (!state.contacts.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No favorite contacts saved yet.';
    container.appendChild(empty);
    return;
  }

  state.contacts.forEach((contact, index) => {
    const row = document.createElement('div');
    row.className = 'contact-item';

    const info = document.createElement('div');
    info.className = 'contact-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'contact-name';
    nameEl.textContent = contact.name || 'Contact';

    const emailEl = document.createElement('div');
    emailEl.className = 'contact-email';
    emailEl.textContent = contact.email + (contact.role ? ' · ' + contact.role : '');

    info.appendChild(nameEl);
    info.appendChild(emailEl);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger';
    delBtn.textContent = 'Remove';
    delBtn.addEventListener('click', () => {
      const next = state.contacts.filter((_, i) => i !== index);
      chrome.runtime.sendMessage({ type: 'POPUP_SAVE_CONTACTS', contacts: next }, (res) => {
        if (res && res.ok) {
          state.contacts = res.contacts;
          renderContacts();
          setToast('Contact removed & synced');
        }
      });
    });

    row.appendChild(info);
    row.appendChild(delBtn);
    container.appendChild(row);
  });
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'POPUP_GET_STATUS' }, (res) => {
    if (!res) return;
    state.pairingCode = res.pairingCode || '';
    state.formattedCode = res.formattedCode || '';
    state.relayUrl = res.relayUrl || '';
    state.contacts = Array.isArray(res.contacts) ? res.contacts : [];

    document.getElementById('pairing-code').textContent = state.formattedCode || '---';
    document.getElementById('input-relay').value = state.relayUrl;

    const dotRelay = document.getElementById('dot-relay');
    const lblRelay = document.getElementById('lbl-relay');
    dotRelay.className = 'dot ' + (res.wsConnected ? 'ok' : 'warn');
    lblRelay.textContent = res.wsConnected ? 'Relay: Connected' : 'Relay: Reconnecting...';

    const dotPebble = document.getElementById('dot-pebble');
    const lblPebble = document.getElementById('lbl-pebble');
    dotPebble.className = 'dot ' + (res.pebbleConnected ? 'ok' : '');
    lblPebble.textContent = res.pebbleConnected
      ? 'Pebble Watch: Connected'
      : 'Pebble Watch: Open PebbleMeet on watch';

    const dotMeet = document.getElementById('dot-meet');
    const lblMeet = document.getElementById('lbl-meet');
    dotMeet.className = 'dot ' + (res.activeMeetUrl ? 'ok' : '');
    lblMeet.textContent = res.activeMeetTitle
      ? 'Google Meet: ' + res.activeMeetTitle.slice(0, 32)
      : 'Google Meet: No active tab';

    renderContacts();
  });
}

document.getElementById('btn-copy').addEventListener('click', async () => {
  if (!state.formattedCode) return;
  try {
    await navigator.clipboard.writeText(state.formattedCode);
    setToast('Copied ' + state.formattedCode);
  } catch {
    setToast('Copy failed — read code above');
  }
});

document.getElementById('btn-regen').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'POPUP_REGENERATE_CODE' }, (res) => {
    if (res && res.formattedCode) {
      state.pairingCode = res.pairingCode;
      state.formattedCode = res.formattedCode;
      document.getElementById('pairing-code').textContent = state.formattedCode;
      setToast('New pairing code generated');
    }
  });
});

document.getElementById('btn-add-contact').addEventListener('click', () => {
  const nameInput = document.getElementById('input-name');
  const emailInput = document.getElementById('input-email');
  const roleInput = document.getElementById('input-role');

  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  const role = roleInput.value.trim() || 'Favorite';

  if (!name || !email || !email.includes('@')) {
    setToast('Enter both a name and valid email');
    return;
  }

  const next = state.contacts.concat([{ name: name.slice(0, 30), email: email.slice(0, 46), role: role.slice(0, 26) }]);
  chrome.runtime.sendMessage({ type: 'POPUP_SAVE_CONTACTS', contacts: next }, (res) => {
    if (res && res.ok) {
      state.contacts = res.contacts;
      nameInput.value = '';
      emailInput.value = '';
      roleInput.value = '';
      renderContacts();
      setToast('Saved & synced to watch');
    }
  });
});

document.getElementById('btn-save-relay').addEventListener('click', () => {
  const relayUrl = document.getElementById('input-relay').value.trim();
  if (!relayUrl || (!relayUrl.startsWith('https://') && !relayUrl.startsWith('http://') && !relayUrl.startsWith('ws://') && !relayUrl.startsWith('wss://'))) {
    setToast('Enter a valid HTTPS or WSS relay URL');
    return;
  }
  chrome.runtime.sendMessage({ type: 'POPUP_SAVE_RELAY', relayUrl }, (res) => {
    if (res && res.ok) {
      state.relayUrl = res.relayUrl;
      setToast('Relay saved — reconnecting');
      setTimeout(refreshStatus, 600);
    }
  });
});

document.getElementById('btn-browser-oauth').addEventListener('click', () => {
  if (!state.relayUrl || !state.relayUrl.startsWith('https://') || !state.pairingCode) {
    setToast('HTTPS Relay URL and pairing code required');
    return;
  }
  const url =
    state.relayUrl +
    '/oauth/start?mode=browser&room=' +
    encodeURIComponent(state.pairingCode);
  chrome.tabs.create({ url });
});

refreshStatus();
