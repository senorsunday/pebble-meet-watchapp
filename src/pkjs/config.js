/* Pebble Clay Configuration Schema for PebbleMeet
 * Opens automatically in the Pebble phone app under PebbleMeet -> Settings.
 * Supports Short Press (Tap), Double Press (2x Tap), and Long Press (Hold)
 * across all 3 hardware buttons (Up, Select, Down).
 */
var BUTTON_ACTIONS = [
  { label: 'Toggle Mute', value: '0' },
  { label: 'Push-to-Talk (Hold)', value: '1' },
  { label: 'Toggle Camera', value: '2' },
  { label: 'End Call', value: '3' },
  { label: 'Raise / Lower Hand', value: '4' },
  { label: 'Chat & Replies (Dictation)', value: '5' },
  { label: 'Quick Reaction', value: '9' },
  { label: 'Toggle PTT Mode', value: '10' },
  { label: 'Disabled', value: '11' },
];

module.exports = [
  {
    type: 'heading',
    defaultValue: 'PebbleMeet Watch Settings',
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Google & Chrome Bridge' },
      {
        type: 'input',
        id: 'BRIDGE_WS_URL',
        label: 'Chrome Bridge WebSocket URL',
        defaultValue: 'ws://localhost:8765',
        attributes: {
          placeholder: 'ws://192.168.1.50:8765',
        },
      },
      {
        type: 'input',
        id: 'GOOGLE_TOKEN',
        label: 'Google OAuth Access Token (Optional)',
        defaultValue: '',
        description: 'Enables live Google Calendar meetings and Google Contacts sync.',
      },
    ],
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Audio & Join Defaults' },
      {
        type: 'toggle',
        messageKey: 'CFG_DEFAULT_PTT',
        label: 'Push-to-Talk (PTT) by Default',
        defaultValue: false,
      },
      {
        type: 'toggle',
        messageKey: 'CFG_JOIN_MUTED',
        label: 'Always Join Muted',
        defaultValue: false,
      },
      {
        type: 'toggle',
        messageKey: 'CFG_JOIN_CAM_OFF',
        label: 'Join with Camera Off',
        defaultValue: false,
      },
    ],
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Up Button Actions' },
      {
        type: 'select',
        messageKey: 'CFG_UP_SHORT',
        label: 'Short Press (Tap)',
        defaultValue: '0',
        options: BUTTON_ACTIONS,
      },
      {
        type: 'select',
        messageKey: 'CFG_UP_DOUBLE',
        label: 'Double Press (2x Tap)',
        defaultValue: '10',
        description: 'Set to Disabled for instant single-tap response.',
        options: BUTTON_ACTIONS,
      },
      {
        type: 'select',
        messageKey: 'CFG_UP_LONG',
        label: 'Long Press (Hold)',
        defaultValue: '4',
        options: BUTTON_ACTIONS,
      },
    ],
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Select Button Actions' },
      {
        type: 'select',
        messageKey: 'CFG_SELECT_SHORT',
        label: 'Short Press (Tap)',
        defaultValue: '3',
        options: BUTTON_ACTIONS,
      },
      {
        type: 'select',
        messageKey: 'CFG_SELECT_DOUBLE',
        label: 'Double Press (2x Tap)',
        defaultValue: '9',
        description: 'Set to Disabled for instant single-tap response.',
        options: BUTTON_ACTIONS,
      },
      {
        type: 'select',
        messageKey: 'CFG_SELECT_LONG',
        label: 'Long Press (Hold)',
        defaultValue: '11',
        options: BUTTON_ACTIONS,
      },
    ],
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Down Button Actions' },
      {
        type: 'select',
        messageKey: 'CFG_DOWN_SHORT',
        label: 'Short Press (Tap)',
        defaultValue: '2',
        options: BUTTON_ACTIONS,
      },
      {
        type: 'select',
        messageKey: 'CFG_DOWN_DOUBLE',
        label: 'Double Press (2x Tap)',
        defaultValue: '11',
        description: 'Set to Disabled for instant single-tap response.',
        options: BUTTON_ACTIONS,
      },
      {
        type: 'select',
        messageKey: 'CFG_DOWN_LONG',
        label: 'Long Press (Hold)',
        defaultValue: '5',
        options: BUTTON_ACTIONS,
      },
    ],
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Watch Info & Alert Banners' },
      {
        type: 'toggle',
        messageKey: 'CFG_SHOW_CAPTIONS',
        label: 'Live Captions (CC) Ticker',
        description: 'Show recent Google Meet captions on your watch when CC is on.',
        defaultValue: true,
      },
      {
        type: 'toggle',
        messageKey: 'CFG_ALERT_CHAT',
        label: 'Incoming Meet Chat Banners',
        description: 'Vibrate and show a banner when Meet chat arrives (Back to dismiss).',
        defaultValue: true,
      },
      {
        type: 'toggle',
        messageKey: 'CFG_ALERT_RECORDING',
        label: 'Recording & Note-Taking Banners',
        description: 'Alert your wrist whenever Meet recording starts (Back to dismiss).',
        defaultValue: true,
      },
      {
        type: 'toggle',
        messageKey: 'CFG_ALERT_LOBBY',
        label: 'Waiting Room / Lobby Knock Banners',
        description: 'Alert when a guest knocks (Select to admit, Back to dismiss).',
        defaultValue: true,
      },
      {
        type: 'select',
        messageKey: 'CFG_WRAP_UP_MINUTES',
        label: 'Meeting Wrap-Up Reminder',
        defaultValue: '5',
        description: 'Gentle wrist buzz before your scheduled meeting ends.',
        options: [
          { label: 'Off', value: '0' },
          { label: '1 minute before', value: '1' },
          { label: '5 minutes before', value: '5' },
        ],
      },
    ],
  },
  {
    type: 'submit',
    defaultValue: 'Save to Pebble Watch',
  },
];
