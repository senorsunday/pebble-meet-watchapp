/* PebbleMeet Chrome Extension Content Script
 * Matches: https://meet.google.com/*
 *
 * Communicates with background.js (no direct WebSocket here) to:
 *  - Execute state-aware mute, camera, raise/lower hand, captions, chat, admit, and leave commands
 *  - Automate inviting/ringing a contact via Google Meet's "Add people" dialog
 *  - Stream live Meet state, lobby knocks, recording alerts, chat previews, and captions to Pebble
 */

(function () {
  let stateDebounceTimer = null;
  let lastRecordingState = false;
  let lastLobbyAlertAt = 0;
  let lastCaptionText = '';
  let lastCaptionSentAt = 0;
  let lastChatFingerprint = '';
  let readyAnnounced = false;

  function queryButtons() {
    return Array.from(
      document.querySelectorAll('button[aria-label], div[role="button"][aria-label]')
    );
  }

  function findControlByLabels(keywords) {
    const list = Array.isArray(keywords) ? keywords : [keywords];
    const buttons = queryButtons();
    for (const kw of list) {
      const lowerKw = kw.toLowerCase();
      const found = buttons.find((el) => {
        if (el.offsetParent === null) return false;
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        return label.includes(lowerKw);
      });
      if (found) return found;
    }
    return null;
  }

  function findButtonByText(keywords) {
    const list = Array.isArray(keywords) ? keywords : [keywords];
    const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
    for (const kw of list) {
      const lowerKw = kw.toLowerCase();
      const found = buttons.find((el) => {
        if (el.offsetParent === null) return false;
        const text = (el.textContent || '').trim().toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        return text === lowerKw || text.includes(lowerKw) || label.includes(lowerKw);
      });
      if (found) return found;
    }
    return null;
  }

  function isInActiveCall() {
    return Boolean(findControlByLabels(['leave call', 'microphone', 'turn off microphone', 'turn on microphone']));
  }

  function getMicButton() {
    return findControlByLabels(['turn off microphone', 'turn on microphone', 'microphone']);
  }

  function getCamButton() {
    return findControlByLabels(['turn off camera', 'turn on camera', 'camera']);
  }

  function getHandButton() {
    return findControlByLabels(['raise hand', 'lower hand']);
  }

  function getCaptionsButton() {
    return findControlByLabels(['turn on captions', 'turn off captions', 'captions']);
  }

  function isMicMuted(micBtn) {
    if (!micBtn) return false;
    const attr = micBtn.getAttribute('data-is-muted');
    if (attr !== null) return attr === 'true';
    const label = (micBtn.getAttribute('aria-label') || '').toLowerCase();
    return label.includes('turn on microphone');
  }

  function isCamOff(camBtn) {
    if (!camBtn) return false;
    const attr = camBtn.getAttribute('data-is-muted');
    if (attr !== null) return attr === 'true';
    const label = (camBtn.getAttribute('aria-label') || '').toLowerCase();
    return label.includes('turn on camera');
  }

  function isHandRaised(handBtn) {
    if (!handBtn) return false;
    if (handBtn.getAttribute('aria-pressed') === 'true') return true;
    const label = (handBtn.getAttribute('aria-label') || '').toLowerCase();
    return label.includes('lower hand');
  }

  function isRecordingActive() {
    const recEl = document.querySelector(
      '[aria-label*="Recording" i], [data-tooltip*="Recording" i]'
    );
    if (recEl && recEl.offsetParent !== null) {
      const txt = (recEl.getAttribute('aria-label') || recEl.textContent || '').toLowerCase();
      if (txt.includes('recording') && !txt.includes('start recording') && !txt.includes('record meeting')) {
        return true;
      }
    }
    return false;
  }

  function getParticipantCount() {
    const peopleBtn = findControlByLabels(['people', 'show everyone']);
    const text =
      (peopleBtn && peopleBtn.parentElement && peopleBtn.parentElement.textContent) ||
      (peopleBtn && peopleBtn.textContent) ||
      '';
    const match = text.match(/\d+/);
    return match ? Number(match[0]) : 1;
  }

  function getActiveSpeaker(muted) {
    // Attempt to read visible participant name tiles if Meet highlights an active speaker
    const speakingTile = document.querySelector('[data-self-name], [data-participant-id] [data-tooltip]');
    if (!muted) return 'You';
    const nameEl =
      (speakingTile && speakingTile.getAttribute && speakingTile.getAttribute('data-self-name')) ||
      (speakingTile && speakingTile.textContent && speakingTile.textContent.trim()) ||
      '';
    if (nameEl && nameEl.length <= 28) return nameEl;
    return 'In Call';
  }

  function sendMessage(payload) {
    try {
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch {
      // Extension context may be reloading
    }
  }

  function broadcastCurrentMeetState() {
    const micBtn = getMicButton();
    const camBtn = getCamButton();
    if (!micBtn && !camBtn) return;

    if (!readyAnnounced && isInActiveCall()) {
      readyAnnounced = true;
      sendMessage({ type: 'MEET_CONTENT_READY' });
    }

    const muted = isMicMuted(micBtn);
    const camOff = isCamOff(camBtn);
    const handBtn = getHandButton();
    const handRaised = isHandRaised(handBtn);
    const recording = isRecordingActive();

    if (recording && !lastRecordingState) {
      sendMessage({
        type: 'MEET_ALERT',
        kind: 'recording',
        body: 'Recording started (BACK)',
      });
    }
    lastRecordingState = recording;

    sendMessage({
      type: 'MEET_STATE',
      muted,
      cameraOn: !camOff,
      handRaised,
      isRecording: recording,
      participantCount: getParticipantCount(),
      activeSpeaker: getActiveSpeaker(muted),
    });
  }

  function scheduleStateBroadcast() {
    if (stateDebounceTimer) return;
    stateDebounceTimer = setTimeout(() => {
      stateDebounceTimer = null;
      broadcastCurrentMeetState();
    }, 150);
  }

  function checkLobbyKnock() {
    const admitBtn = findButtonByText(['admit']);
    if (!admitBtn) return;
    const now = Date.now();
    if (now - lastLobbyAlertAt < 15000) return;
    lastLobbyAlertAt = now;
    const dialog = admitBtn.closest('[role="dialog"], [role="alertdialog"], div');
    const raw = ((dialog && dialog.textContent) || '').replace(/\s+/g, ' ').trim();
    const body = raw.length > 5 ? raw.slice(0, 58) : 'Guest waiting (SEL: Admit)';
    sendMessage({
      type: 'MEET_ALERT',
      kind: 'lobby',
      body,
    });
  }

  function checkLiveCaptions() {
    // Google Meet renders captions inside a live region container
    const region = document.querySelector('[aria-label*="Captions" i][role="region"], div[jsname="tgaKEf"]');
    if (!region || region.offsetParent === null) return;
    const text = (region.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text === lastCaptionText) return;
    const now = Date.now();
    if (now - lastCaptionSentAt < 1200) return;
    lastCaptionText = text;
    lastCaptionSentAt = now;
    sendMessage({
      type: 'MEET_CAPTION',
      text: text.slice(-56),
    });
  }

  function checkIncomingChatToast() {
    const toast = document.querySelector('[aria-live="polite"][role="alert"], [data-message-text]');
    if (!toast || toast.offsetParent === null) return;
    const text = (toast.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2 || text === lastChatFingerprint) return;
    if (/recording|wants to join|captions|microphone|camera/i.test(text)) return;
    lastChatFingerprint = text;
    sendMessage({
      type: 'MEET_ALERT',
      kind: 'chat',
      body: ('Chat: ' + text).slice(0, 60),
    });
  }

  function setNativeInputValue(input, value) {
    const proto =
      input.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const setter = desc && desc.set;
    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function waitForElement(finderFn, timeoutMs = 8000, intervalMs = 200) {
    return new Promise((resolve) => {
      const immediate = finderFn();
      if (immediate) return resolve(immediate);
      const started = Date.now();
      const timer = setInterval(() => {
        const found = finderFn();
        if (found) {
          clearInterval(timer);
          resolve(found);
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, intervalMs);
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function submitMeetChat(text) {
    const chatBtn = findControlByLabels(['chat with everyone', 'chat']);
    if (chatBtn && chatBtn.getAttribute('aria-pressed') !== 'true') {
      chatBtn.click();
    }
    const input = await waitForElement(
      () =>
        document.querySelector('textarea[aria-label*="Send a message" i]') ||
        document.querySelector('textarea[placeholder*="Send a message" i]') ||
        document.querySelector('input[aria-label*="Send a message" i]'),
      3000
    );
    if (!input) return;
    input.focus();
    setNativeInputValue(input, text);
    await sleep(120);
    const sendBtn = findControlByLabels(['send a message']);
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
      );
    }
  }

  /**
   * Automates inviting or ringing a contact in Google Meet:
   *  1. Auto-joins if we landed on a pre-join screen with "Join now"
   *  2. Opens "Add others" (on fresh Meet rooms) or People -> "Add people"
   *  3. Enters the contact's email, selects the autocomplete chip
   *  4. Clicks "Call" (direct ring when supported) or "Send email" (live invite)
   */
  async function inviteContact(email, name, autoJoin) {
    const labelName = name || email;
    try {
      // Wait for Meet UI (either pre-join or in-call)
      await waitForElement(
        () => isInActiveCall() || findButtonByText(['join now', 'ask to join']),
        15000
      );

      if (autoJoin && !isInActiveCall()) {
        const joinBtn = findButtonByText(['join now']);
        if (joinBtn) {
          joinBtn.click();
          await waitForElement(() => isInActiveCall(), 10000);
        }
      }

      // Open the Add people / Add others dialog
      let addBtn = findButtonByText(['add others', 'add people']);
      if (!addBtn) {
        const peopleBtn = findControlByLabels(['people', 'show everyone']);
        if (peopleBtn && peopleBtn.getAttribute('aria-pressed') !== 'true') {
          peopleBtn.click();
          await sleep(400);
        }
        addBtn = await waitForElement(() => findButtonByText(['add people', 'add others']), 4000);
      }

      if (!addBtn) {
        sendMessage({
          type: 'INVITE_STATUS',
          ok: false,
          email,
          name: labelName,
          message: 'Could not open Add People',
        });
        return;
      }
      addBtn.click();

      // Wait for email input inside the Add People modal
      const emailInput = await waitForElement(
        () =>
          document.querySelector('input[aria-label*="Enter name or email" i]') ||
          document.querySelector('input[placeholder*="Enter name or email" i]') ||
          document.querySelector('[role="dialog"] input[type="text"], [role="dialog"] input[type="email"]'),
        5000
      );

      if (!emailInput) {
        sendMessage({
          type: 'INVITE_STATUS',
          ok: false,
          email,
          name: labelName,
          message: 'Invite input not found',
        });
        return;
      }

      emailInput.focus();
      setNativeInputValue(emailInput, email);
      await sleep(500);

      // Select autocomplete option matching the email (or press Enter to create chip)
      const suggestion = Array.from(
        document.querySelectorAll('[role="option"], [role="listitem"], li')
      ).find((el) => {
        if (el.offsetParent === null) return false;
        return (el.textContent || '').toLowerCase().includes(email.toLowerCase());
      });

      if (suggestion) {
        suggestion.click();
      } else {
        emailInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
        );
      }

      await sleep(400);

      // Prefer direct "Call" (ring) if available; otherwise click "Send email"
      const callBtn = findButtonByText(['call']);
      const sendEmailBtn = findButtonByText(['send email', 'send invite']);
      const actionBtn =
        callBtn && !callBtn.disabled && callBtn.closest('[role="dialog"]')
          ? callBtn
          : sendEmailBtn;

      if (actionBtn && !actionBtn.disabled) {
        actionBtn.click();
        const method = actionBtn === callBtn ? 'Ringing' : 'Invited';
        sendMessage({
          type: 'INVITE_STATUS',
          ok: true,
          email,
          name: labelName,
          message: `${method} ${labelName.slice(0, 20)}`,
        });
      } else {
        sendMessage({
          type: 'INVITE_STATUS',
          ok: false,
          email,
          name: labelName,
          message: `Ready: confirm ${labelName.slice(0, 14)}`,
        });
      }
    } catch (err) {
      console.warn('[PebbleMeet] inviteContact failed:', err);
      sendMessage({
        type: 'INVITE_STATUS',
        ok: false,
        email,
        name: labelName,
        message: 'Invite failed in Chrome',
      });
    }
  }

  chrome.runtime.onMessage.addListener((data, _sender, sendResponse) => {
    if (!data || typeof data !== 'object') return false;

    if (data.cmd === 'REQUEST_STATE') {
      broadcastCurrentMeetState();
      sendResponse({ ok: true });
      return false;
    }

    if (data.cmd === 'TOGGLE_MUTE') {
      const micBtn = getMicButton();
      if (micBtn) {
        const currentlyMuted = isMicMuted(micBtn);
        const wantMuted = typeof data.muted === 'boolean' ? data.muted : !currentlyMuted;
        if (currentlyMuted !== wantMuted) {
          micBtn.click();
        }
        setTimeout(broadcastCurrentMeetState, 150);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (data.cmd === 'TOGGLE_CAMERA') {
      const camBtn = getCamButton();
      if (camBtn) {
        const currentlyOn = !isCamOff(camBtn);
        const wantOn = typeof data.cameraOn === 'boolean' ? data.cameraOn : !currentlyOn;
        if (currentlyOn !== wantOn) {
          camBtn.click();
        }
        setTimeout(broadcastCurrentMeetState, 150);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (data.cmd === 'RAISE_HAND') {
      const handBtn = getHandButton();
      if (handBtn) {
        const currentlyRaised = isHandRaised(handBtn);
        const wantRaised = typeof data.raised === 'boolean' ? data.raised : !currentlyRaised;
        if (currentlyRaised !== wantRaised) {
          handBtn.click();
        }
        setTimeout(broadcastCurrentMeetState, 150);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (data.cmd === 'TOGGLE_CAPTIONS') {
      const capBtn = getCaptionsButton();
      if (capBtn) {
        capBtn.click();
        setTimeout(broadcastCurrentMeetState, 150);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (data.cmd === 'SEND_CHAT' && data.text) {
      submitMeetChat(String(data.text));
      sendResponse({ ok: true });
      return false;
    }

    if (data.cmd === 'ADMIT_GUEST') {
      const admitBtn = findButtonByText(['admit']);
      if (admitBtn) admitBtn.click();
      sendResponse({ ok: true });
      return false;
    }

    if (data.cmd === 'END_CALL') {
      const leaveBtn = findControlByLabels(['leave call']);
      if (leaveBtn) leaveBtn.click();
      sendResponse({ ok: true });
      return false;
    }

    if (data.cmd === 'INVITE_CONTACT' && data.email) {
      inviteContact(String(data.email), String(data.name || ''), Boolean(data.autoJoin));
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  // Observe Meet UI state changes, lobby knocks, chat toasts, and live captions
  const observer = new MutationObserver(() => {
    scheduleStateBroadcast();
    checkLobbyKnock();
    checkLiveCaptions();
    checkIncomingChatToast();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-is-muted', 'aria-pressed', 'aria-label'],
  });

  // Light periodic check so ready/state is reported even if Meet mounts quietly
  setInterval(() => {
    if (isInActiveCall()) {
      broadcastCurrentMeetState();
    }
  }, 3000);

  if (isInActiveCall()) {
    readyAnnounced = true;
    sendMessage({ type: 'MEET_CONTENT_READY' });
    broadcastCurrentMeetState();
  }
})();
