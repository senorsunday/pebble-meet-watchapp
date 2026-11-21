/* Pebble Clay Configuration Schema for PebbleMeet
 * Opens automatically in the Pebble phone app under PebbleMeet -> Settings.
 */
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
      { type: 'heading', defaultValue: 'In-Call Button Actions' },
      {
        type: 'select',
        messageKey: 'CFG_UP_SHORT',
        label: 'Up Button (Tap)',
        defaultValue: '0',
        options: [
          { label: 'Toggle Mute', value: '0' },
          { label: 'Push-to-Talk (Hold)', value: '1' },
          { label: 'Toggle Camera', value: '2' },
          { label: 'End Call', value: '3' },
          { label: 'Raise Hand', value: '4' },
          { label: 'Chat & Replies', value: '5' },
          { label: 'Toggle PTT Mode', value: '10' },
        ],
      },
      {
        type: 'select',
        messageKey: 'CFG_SELECT_SHORT',
        label: 'Select Button (Tap)',
        defaultValue: '3',
        options: [
          { label: 'End Call', value: '3' },
          { label: 'Toggle Mute', value: '0' },
          { label: 'Push-to-Talk (Hold)', value: '1' },
          { label: 'Toggle Camera', value: '2' },
          { label: 'Raise Hand', value: '4' },
        ],
      },
      {
        type: 'select',
        messageKey: 'CFG_DOWN_SHORT',
        label: 'Down Button (Tap)',
        defaultValue: '2',
        options: [
          { label: 'Toggle Camera', value: '2' },
          { label: 'Chat & Replies', value: '5' },
          { label: 'Raise Hand', value: '4' },
          { label: 'Toggle PTT Mode', value: '10' },
          { label: 'End Call', value: '3' },
        ],
      },
    ],
  },
  {
    type: 'submit',
    defaultValue: 'Save to Pebble Watch',
  },
];
