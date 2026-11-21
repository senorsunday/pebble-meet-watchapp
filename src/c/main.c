#include <pebble.h>

#define MAX_MEETINGS 6
#define MAX_CONTACTS 16
#define NAME_LEN 32
#define ROLE_LEN 28
#define CODE_LEN 16

typedef struct {
  char title[NAME_LEN];
  char time_str[ROLE_LEN];
  char meet_code[CODE_LEN];
  int attendees;
} CalendarMeeting;

typedef struct {
  char name[NAME_LEN];
  char role[ROLE_LEN];
  char email[48];
  bool is_favorite;
} MeetContact;

static Window *s_menu_window;
static MenuLayer *s_menu_layer;
static StatusBarLayer *s_status_bar;

static Window *s_call_window;
static ActionBarLayer *s_action_bar;
static TextLayer *s_callee_layer;
static TextLayer *s_timer_layer;
static TextLayer *s_speaker_layer;
static TextLayer *s_mic_layer;
static TextLayer *s_cam_layer;
static TextLayer *s_banner_layer;

static Window *s_confirm_window;
static TextLayer *s_confirm_title_layer;
static TextLayer *s_confirm_body_layer;
static int s_pending_section = -1;
static int s_pending_row = -1;
static char s_confirm_buf[128];

#if defined(PBL_MICROPHONE)
static DictationSession *s_dictation_session;
static char s_dictation_buf[96];
#endif

static GBitmap *s_icon_mic_on;
static GBitmap *s_icon_mic_off;
static GBitmap *s_icon_cam_on;
static GBitmap *s_icon_cam_off;
static GBitmap *s_icon_hangup;

static CalendarMeeting s_meetings[MAX_MEETINGS];
static int s_meeting_count = 0;

static MeetContact s_contacts[MAX_CONTACTS];
static int s_contact_count = 0;

static bool s_in_call = false;
static bool s_is_muted = false;
static bool s_is_camera_on = true;
static bool s_hand_raised = false;
static bool s_ptt_mode = false;
static int s_call_seconds = 0;
static int s_participant_count = 2;
static bool s_is_recording = false;
static bool s_banner_visible = false;
static char s_banner_body[64] = "";

#define PERSIST_KEY_CONFIG 1

typedef enum {
  ACT_TOGGLE_MUTE = 0,
  ACT_PUSH_TO_TALK = 1,
  ACT_TOGGLE_CAMERA = 2,
  ACT_END_CALL = 3,
  ACT_RAISE_HAND = 4,
  ACT_OPEN_CHAT = 5,
  ACT_OPEN_NOTES = 6,
  ACT_OPEN_PARTICIPANTS = 7,
  ACT_TOGGLE_CAPTIONS = 8,
  ACT_SEND_REACTION = 9,
  ACT_TOGGLE_PTT_MODE = 10,
  ACT_NONE = 11
} WatchButtonAction;

typedef struct {
  bool default_ptt;
  bool join_muted;
  bool join_cam_off;
  uint8_t up_short;
  uint8_t up_long;
  uint8_t select_short;
  uint8_t select_long;
  uint8_t down_short;
  uint8_t down_long;
} PebbleMeetConfig;

static PebbleMeetConfig s_cfg = {
  .default_ptt = false,
  .join_muted = false,
  .join_cam_off = false,
  .up_short = ACT_TOGGLE_MUTE,
  .up_long = ACT_RAISE_HAND,
  .select_short = ACT_END_CALL,
  .select_long = ACT_OPEN_NOTES,
  .down_short = ACT_TOGGLE_CAMERA,
  .down_long = ACT_OPEN_CHAT,
};

static char s_active_callee[NAME_LEN] = "";
static char s_active_speaker[NAME_LEN] = "Waiting...";
static char s_timer_buf[24] = "00:00";
static char s_speaker_buf[48] = "Spk: -- (2)";

/* -------------------------------------------------------------------------
 * AppMessage Outbound Helpers (Watch -> Phone PebbleKit JS)
 * ------------------------------------------------------------------------- */
static void send_int_command(uint32_t key, int32_t value) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
  dict_write_int32(iter, key, value);
  app_message_outbox_send();
}

static void send_chat_message(const char *message) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
  dict_write_cstring(iter, MESSAGE_KEY_CMD_SEND_CHAT, message);
  app_message_outbox_send();
}

/* -------------------------------------------------------------------------
 * Active Call UI Refresh (Supports Rectangular & PBL_ROUND Chalk)
 * ------------------------------------------------------------------------- */
static void update_call_ui(void) {
  if (!s_call_window || !window_is_loaded(s_call_window)) return;

  text_layer_set_text(s_callee_layer, s_active_callee);

  if (s_is_recording) {
    snprintf(s_timer_buf, sizeof(s_timer_buf), "REC %02d:%02d",
             s_call_seconds / 60, s_call_seconds % 60);
  } else {
    snprintf(s_timer_buf, sizeof(s_timer_buf), "%02d:%02d",
             s_call_seconds / 60, s_call_seconds % 60);
  }
  text_layer_set_text(s_timer_layer, s_timer_buf);

  snprintf(s_speaker_buf, sizeof(s_speaker_buf), "Spk: %.14s (%d)",
           s_active_speaker, s_participant_count);
  text_layer_set_text(s_speaker_layer, s_speaker_buf);

  if (s_hand_raised) {
    text_layer_set_text(s_mic_layer, s_is_muted ? "MUTED * HAND" : "LIVE * HAND");
  } else if (s_ptt_mode) {
    text_layer_set_text(s_mic_layer, s_is_muted ? "PTT: HOLD UP" : "PTT: TALKING");
  } else {
    text_layer_set_text(s_mic_layer, s_is_muted ? "MIC: MUTED" : "MIC: LIVE");
  }
  text_layer_set_text(s_cam_layer, s_is_camera_on ? "CAM: ON" : "CAM: OFF");

  layer_set_hidden(text_layer_get_layer(s_banner_layer), !s_banner_visible);
  if (s_banner_visible) {
    text_layer_set_text(s_banner_layer, s_banner_body);
  }

  action_bar_layer_set_icon(
    s_action_bar, BUTTON_ID_UP,
    s_is_muted ? s_icon_mic_off : s_icon_mic_on
  );
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_SELECT, s_icon_hangup);
  action_bar_layer_set_icon(
    s_action_bar, BUTTON_ID_DOWN,
    s_is_camera_on ? s_icon_cam_on : s_icon_cam_off
  );
}

/* -------------------------------------------------------------------------
 * Pebble Microphone Dictation -> Google Meet Chat
 * ------------------------------------------------------------------------- */
#if defined(PBL_MICROPHONE)
static void dictation_callback(DictationSession *session,
                               DictationSessionStatus status,
                               char *transcription,
                               void *context) {
  if (status == DictationSessionStatusSuccess && transcription) {
    snprintf(s_dictation_buf, sizeof(s_dictation_buf), "%s", transcription);
    vibes_short_pulse();
    send_chat_message(s_dictation_buf);
  }
}
#endif

/* -------------------------------------------------------------------------
 * Configurable In-Call Action Dispatch & BACK-Dismissible Watch Banners
 * ------------------------------------------------------------------------- */
static void execute_watch_action(WatchButtonAction action) {
  switch (action) {
    case ACT_TOGGLE_MUTE:
      if (s_ptt_mode) return;
      s_is_muted = !s_is_muted;
      vibes_short_pulse();
      send_int_command(MESSAGE_KEY_CMD_TOGGLE_MUTE, s_is_muted ? 1 : 0);
      update_call_ui();
      break;
    case ACT_RAISE_HAND:
      s_hand_raised = !s_hand_raised;
      vibes_double_pulse();
      send_int_command(MESSAGE_KEY_CMD_RAISE_HAND, s_hand_raised ? 1 : 0);
      update_call_ui();
      break;
    case ACT_END_CALL:
      s_in_call = false;
      s_hand_raised = false;
      s_banner_visible = false;
      vibes_double_pulse();
      send_int_command(MESSAGE_KEY_CMD_END_CALL, 1);
      window_stack_pop(true);
      break;
    case ACT_TOGGLE_CAMERA:
      s_is_camera_on = !s_is_camera_on;
      vibes_short_pulse();
      send_int_command(MESSAGE_KEY_CMD_TOGGLE_CAMERA, s_is_camera_on ? 1 : 0);
      update_call_ui();
      break;
    case ACT_OPEN_CHAT:
      vibes_short_pulse();
#if defined(PBL_MICROPHONE)
      if (s_dictation_session) {
        dictation_session_start(s_dictation_session);
        return;
      }
#endif
      send_chat_message("On mute, listening in from Pebble");
      break;
    case ACT_TOGGLE_PTT_MODE:
      s_ptt_mode = !s_ptt_mode;
      if (s_ptt_mode) s_is_muted = true;
      vibes_short_pulse();
      update_call_ui();
      break;
    case ACT_SEND_REACTION:
      vibes_short_pulse();
      send_chat_message("Thumbs up");
      break;
    default:
      break;
  }
}

static void call_back_click_handler(ClickRecognizerRef recognizer, void *ctx) {
  if (s_banner_visible) {
    s_banner_visible = false;
    s_banner_body[0] = '\0';
    update_call_ui();
    return;
  }
  window_stack_pop(true);
}

static void call_up_click_handler(ClickRecognizerRef recognizer, void *ctx) {
  execute_watch_action((WatchButtonAction)s_cfg.up_short);
}

static void call_up_long_click_handler(ClickRecognizerRef recognizer, void *ctx) {
  if (s_ptt_mode) {
    s_is_muted = false;
    send_int_command(MESSAGE_KEY_CMD_TOGGLE_MUTE, 0);
    update_call_ui();
    return;
  }
  execute_watch_action((WatchButtonAction)s_cfg.up_long);
}

static void call_up_long_release_handler(ClickRecognizerRef recognizer, void *ctx) {
  if (s_ptt_mode) {
    s_is_muted = true;
    send_int_command(MESSAGE_KEY_CMD_TOGGLE_MUTE, 1);
    update_call_ui();
  }
}

static void call_select_click_handler(ClickRecognizerRef recognizer, void *ctx) {
  if (s_banner_visible) {
    s_banner_visible = false;
    send_int_command(MESSAGE_KEY_CMD_ADMIT_GUEST, 1);
    update_call_ui();
    return;
  }
  execute_watch_action((WatchButtonAction)s_cfg.select_short);
}

static void call_select_long_click_handler(ClickRecognizerRef recognizer, void *ctx) {
  execute_watch_action((WatchButtonAction)s_cfg.select_long);
}

static void call_down_click_handler(ClickRecognizerRef recognizer, void *ctx) {
  execute_watch_action((WatchButtonAction)s_cfg.down_short);
}

static void call_down_long_click_handler(ClickRecognizerRef recognizer, void *ctx) {
  execute_watch_action((WatchButtonAction)s_cfg.down_long);
}

static void call_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_BACK, call_back_click_handler);
  window_single_click_subscribe(BUTTON_ID_UP, call_up_click_handler);
  window_long_click_subscribe(
    BUTTON_ID_UP, 350, call_up_long_click_handler, call_up_long_release_handler
  );
  window_single_click_subscribe(BUTTON_ID_SELECT, call_select_click_handler);
  window_long_click_subscribe(BUTTON_ID_SELECT, 500, call_select_long_click_handler, NULL);
  window_single_click_subscribe(BUTTON_ID_DOWN, call_down_click_handler);
  window_long_click_subscribe(BUTTON_ID_DOWN, 500, call_down_long_click_handler, NULL);
}

static void call_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  int left_pad = PBL_IF_ROUND_ELSE(24, 6);
  int content_w = bounds.size.w - ACTION_BAR_WIDTH - left_pad - 6;

  s_action_bar = action_bar_layer_create();
  action_bar_layer_add_to_window(s_action_bar, window);
  action_bar_layer_set_click_config_provider(s_action_bar, call_click_config_provider);

  s_callee_layer = text_layer_create(GRect(left_pad, PBL_IF_ROUND_ELSE(24, 10), content_w, 36));
  text_layer_set_font(s_callee_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_callee_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  layer_add_child(root, text_layer_get_layer(s_callee_layer));

  s_timer_layer = text_layer_create(GRect(left_pad, PBL_IF_ROUND_ELSE(60, 48), content_w, 28));
  text_layer_set_font(s_timer_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_timer_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  layer_add_child(root, text_layer_get_layer(s_timer_layer));

  s_speaker_layer = text_layer_create(GRect(left_pad, PBL_IF_ROUND_ELSE(92, 82), content_w, 20));
  text_layer_set_font(s_speaker_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_speaker_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  layer_add_child(root, text_layer_get_layer(s_speaker_layer));

  s_mic_layer = text_layer_create(GRect(left_pad, PBL_IF_ROUND_ELSE(114, 108), content_w, 20));
  text_layer_set_font(s_mic_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_text_alignment(s_mic_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  layer_add_child(root, text_layer_get_layer(s_mic_layer));

  s_cam_layer = text_layer_create(GRect(left_pad, PBL_IF_ROUND_ELSE(134, 130), content_w, 20));
  text_layer_set_font(s_cam_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_text_alignment(s_cam_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  layer_add_child(root, text_layer_get_layer(s_cam_layer));

  s_banner_layer = text_layer_create(
    GRect(left_pad, bounds.size.h - PBL_IF_ROUND_ELSE(44, 34), content_w, 28)
  );
  text_layer_set_font(s_banner_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_background_color(s_banner_layer, GColorBlack);
  text_layer_set_text_color(s_banner_layer, GColorWhite);
  text_layer_set_text_alignment(s_banner_layer, GTextAlignmentCenter);
  layer_set_hidden(text_layer_get_layer(s_banner_layer), true);
  layer_add_child(root, text_layer_get_layer(s_banner_layer));

#ifdef PBL_ROUND
  text_layer_enable_screen_text_flow_and_paging(s_callee_layer, 4);
#endif

  update_call_ui();
}

static void call_window_unload(Window *window) {
  action_bar_layer_destroy(s_action_bar);
  text_layer_destroy(s_callee_layer);
  text_layer_destroy(s_timer_layer);
  text_layer_destroy(s_speaker_layer);
  text_layer_destroy(s_mic_layer);
  text_layer_destroy(s_cam_layer);
  text_layer_destroy(s_banner_layer);
}

/* -------------------------------------------------------------------------
 * Multi-Section MenuLayer:
 *   When in call: Section 0 = CURRENT CALL (pinned first & highlighted),
 *                 Section 1 = MEETINGS, Section 2 = FAVORITES & CONTACTS
 *   When idle:    Section 0 = MEETINGS, Section 1 = FAVORITES & CONTACTS
 * ------------------------------------------------------------------------- */
static uint16_t menu_get_num_sections(MenuLayer *menu_layer, void *ctx) {
  return s_in_call ? 3 : 2;
}

static uint16_t menu_get_num_rows(MenuLayer *menu_layer, uint16_t section, void *ctx) {
  if (s_in_call) {
    if (section == 0) return 1;
    section -= 1;
  }
  if (section == 0) return s_meeting_count > 0 ? s_meeting_count : 1;
  return s_contact_count > 0 ? s_contact_count : 1;
}

#ifndef PBL_ROUND
static int16_t menu_get_header_height(MenuLayer *menu_layer, uint16_t section, void *ctx) {
  return MENU_CELL_BASIC_HEADER_HEIGHT;
}

static void menu_draw_header(GContext *ctx, const Layer *cell_layer, uint16_t section, void *data) {
  if (s_in_call) {
    if (section == 0) {
      menu_cell_basic_header_draw(ctx, cell_layer, "CURRENT CALL");
      return;
    }
    section -= 1;
  }
  menu_cell_basic_header_draw(ctx, cell_layer, section == 0 ? "MEETINGS" : "FAVORITES & CONTACTS");
}
#endif

static void menu_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *idx, void *data) {
  uint16_t section = idx->section;
  if (s_in_call) {
    if (section == 0) {
      static char s_live_sub[40];
      snprintf(s_live_sub, sizeof(s_live_sub), "LIVE %02d:%02d * %s",
               s_call_seconds / 60, s_call_seconds % 60,
               s_is_muted ? "Muted" : "Mic On");
#ifdef PBL_COLOR
      if (menu_cell_layer_is_highlighted(cell_layer)) {
        graphics_context_set_fill_color(ctx, GColorIslamicGreen);
        graphics_fill_rect(ctx, layer_get_bounds(cell_layer), 0, GCornerNone);
      }
#endif
      menu_cell_basic_draw(ctx, cell_layer, s_active_callee, s_live_sub, NULL);
      return;
    }
    section -= 1;
  }

  if (section == 0) {
    if (s_meeting_count == 0) {
      menu_cell_basic_draw(ctx, cell_layer, "No Upcoming Meets", "Sync Google Calendar", NULL);
      return;
    }
    CalendarMeeting *m = &s_meetings[idx->row];
    menu_cell_basic_draw(ctx, cell_layer, m->title, m->time_str, NULL);
    return;
  }

  if (s_contact_count == 0) {
    menu_cell_basic_draw(ctx, cell_layer, "Syncing Contacts...", "Open Phone Settings", NULL);
    return;
  }
  MeetContact *c = &s_contacts[idx->row];
  menu_cell_basic_draw(ctx, cell_layer, c->name, c->role, NULL);
}

static void start_selected_target(uint16_t section, uint16_t row) {
  DictionaryIterator *iter;
  if (section == 0 && s_meeting_count > 0) {
    CalendarMeeting *m = &s_meetings[row];
    snprintf(s_active_callee, sizeof(s_active_callee), "%s", m->title);
    s_participant_count = m->attendees;
    if (app_message_outbox_begin(&iter) == APP_MSG_OK) {
      dict_write_cstring(iter, MESSAGE_KEY_CMD_JOIN_MEETING, m->meet_code);
      app_message_outbox_send();
    }
  } else if (section == 1 && s_contact_count > 0) {
    MeetContact *c = &s_contacts[row];
    snprintf(s_active_callee, sizeof(s_active_callee), "%s", c->name);
    s_participant_count = 2;
    if (app_message_outbox_begin(&iter) == APP_MSG_OK) {
      dict_write_int32(iter, MESSAGE_KEY_CMD_START_CALL, row);
      dict_write_cstring(iter, MESSAGE_KEY_CONTACT_EMAIL, c->email);
      dict_write_cstring(iter, MESSAGE_KEY_CONTACT_NAME, c->name);
      app_message_outbox_send();
    }
  } else {
    return;
  }

  s_in_call = true;
  s_ptt_mode = s_cfg.default_ptt;
  s_is_muted = s_cfg.join_muted || s_cfg.default_ptt;
  s_is_camera_on = !s_cfg.join_cam_off;
  s_hand_raised = false;
  s_is_recording = false;
  s_call_seconds = 0;
  vibes_short_pulse();
  window_stack_push(s_call_window, true);
}

static void confirm_select_handler(ClickRecognizerRef recognizer, void *ctx) {
  send_int_command(MESSAGE_KEY_CMD_END_CALL, 1);
  window_stack_pop(false);
  if (s_pending_section >= 0 && s_pending_row >= 0) {
    start_selected_target((uint16_t)s_pending_section, (uint16_t)s_pending_row);
  }
  s_pending_section = -1;
  s_pending_row = -1;
}

static void confirm_stay_handler(ClickRecognizerRef recognizer, void *ctx) {
  s_pending_section = -1;
  s_pending_row = -1;
  window_stack_pop(true);
}

static void confirm_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, confirm_select_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, confirm_stay_handler);
}

static void confirm_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  const char *next_name =
    (s_pending_section == 0 && s_pending_row < s_meeting_count)
      ? s_meetings[s_pending_row].title
      : (s_pending_section == 1 && s_pending_row < s_contact_count)
          ? s_contacts[s_pending_row].name
          : "Next Call";

  int pad = PBL_IF_ROUND_ELSE(22, 8);
  s_confirm_title_layer = text_layer_create(GRect(pad, PBL_IF_ROUND_ELSE(22, 12), bounds.size.w - pad * 2, 24));
  text_layer_set_font(s_confirm_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_confirm_title_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  text_layer_set_text(s_confirm_title_layer, "Leave Call?");
  layer_add_child(root, text_layer_get_layer(s_confirm_title_layer));

  snprintf(s_confirm_buf, sizeof(s_confirm_buf),
           "Leaving: %s\nNext: %s\n\nSELECT: Switch\nDOWN: Stay",
           s_active_callee, next_name);
  s_confirm_body_layer = text_layer_create(GRect(pad, PBL_IF_ROUND_ELSE(50, 40), bounds.size.w - pad * 2, bounds.size.h - 60));
  text_layer_set_font(s_confirm_body_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_confirm_body_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  text_layer_set_text(s_confirm_body_layer, s_confirm_buf);
  layer_add_child(root, text_layer_get_layer(s_confirm_body_layer));

  window_set_click_config_provider(window, confirm_click_config_provider);
}

static void confirm_window_unload(Window *window) {
  text_layer_destroy(s_confirm_title_layer);
  text_layer_destroy(s_confirm_body_layer);
}

static void menu_select_callback(MenuLayer *menu_layer, MenuIndex *idx, void *ctx) {
  uint16_t section = idx->section;
  if (s_in_call) {
    if (section == 0) {
      window_stack_push(s_call_window, true);
      return;
    }
    section -= 1;
    s_pending_section = section;
    s_pending_row = idx->row;
    vibes_short_pulse();
    window_stack_push(s_confirm_window, true);
    return;
  }

  start_selected_target(section, idx->row);
}

static void menu_window_appear(Window *window) {
  if (!s_menu_layer) return;
  menu_layer_reload_data(s_menu_layer);
  if (s_in_call) {
    menu_layer_set_selected_index(s_menu_layer, MenuIndex(0, 0), MenuRowAlignTop, false);
  }
}

static void menu_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_status_bar = status_bar_layer_create();
  layer_add_child(root, status_bar_layer_get_layer(s_status_bar));

  GRect menu_bounds = GRect(0, STATUS_BAR_LAYER_HEIGHT, bounds.size.w,
                            bounds.size.h - STATUS_BAR_LAYER_HEIGHT);
  s_menu_layer = menu_layer_create(menu_bounds);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
    .get_num_sections = menu_get_num_sections,
    .get_num_rows = menu_get_num_rows,
#ifndef PBL_ROUND
    .get_header_height = menu_get_header_height,
    .draw_header = menu_draw_header,
#endif
    .draw_row = menu_draw_row,
    .select_click = menu_select_callback,
  });
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
#ifdef PBL_COLOR
  menu_layer_set_highlight_colors(s_menu_layer, GColorOrange, GColorWhite);
#endif
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));
}

static void menu_window_unload(Window *window) {
  menu_layer_destroy(s_menu_layer);
  status_bar_layer_destroy(s_status_bar);
}

/* -------------------------------------------------------------------------
 * AppMessage Inbox (Phone PebbleKit JS -> Watch)
 * ------------------------------------------------------------------------- */
static void inbox_received_handler(DictionaryIterator *iter, void *ctx) {
  Tuple *m_idx = dict_find(iter, MESSAGE_KEY_MEETING_INDEX);
  Tuple *m_title = dict_find(iter, MESSAGE_KEY_MEETING_TITLE);
  Tuple *m_time = dict_find(iter, MESSAGE_KEY_MEETING_TIME);
  Tuple *m_code = dict_find(iter, MESSAGE_KEY_MEET_CODE);
  if (m_idx && m_title && m_code) {
    int idx = m_idx->value->int32;
    if (idx >= 0 && idx < MAX_MEETINGS) {
      snprintf(s_meetings[idx].title, NAME_LEN, "%s", m_title->value->cstring);
      snprintf(s_meetings[idx].time_str, ROLE_LEN, "%s",
               m_time ? m_time->value->cstring : "Today");
      snprintf(s_meetings[idx].meet_code, CODE_LEN, "%s", m_code->value->cstring);
      s_meetings[idx].attendees = 4;
      if (idx + 1 > s_meeting_count) s_meeting_count = idx + 1;
      menu_layer_reload_data(s_menu_layer);
    }
  }

  Tuple *c_idx = dict_find(iter, MESSAGE_KEY_CONTACT_INDEX);
  Tuple *c_name = dict_find(iter, MESSAGE_KEY_CONTACT_NAME);
  Tuple *c_role = dict_find(iter, MESSAGE_KEY_CONTACT_ROLE);
  Tuple *c_email = dict_find(iter, MESSAGE_KEY_CONTACT_EMAIL);
  if (c_idx && c_name) {
    int idx = c_idx->value->int32;
    if (idx >= 0 && idx < MAX_CONTACTS) {
      snprintf(s_contacts[idx].name, NAME_LEN, "%s", c_name->value->cstring);
      snprintf(s_contacts[idx].role, ROLE_LEN, "%s",
               c_role ? c_role->value->cstring : "Google Contact");
      snprintf(s_contacts[idx].email, sizeof(s_contacts[idx].email), "%s",
               c_email ? c_email->value->cstring : "");
      if (idx + 1 > s_contact_count) s_contact_count = idx + 1;
      menu_layer_reload_data(s_menu_layer);
    }
  }

  Tuple *spk_t = dict_find(iter, MESSAGE_KEY_ACTIVE_SPEAKER);
  if (spk_t) {
    snprintf(s_active_speaker, NAME_LEN, "%s", spk_t->value->cstring);
    update_call_ui();
  }

  Tuple *cnt_t = dict_find(iter, MESSAGE_KEY_PARTICIPANT_COUNT);
  if (cnt_t) {
    s_participant_count = cnt_t->value->int32;
    update_call_ui();
  }

  Tuple *mute_t = dict_find(iter, MESSAGE_KEY_SYNC_MUTE);
  if (mute_t) {
    s_is_muted = mute_t->value->int32 == 1;
    update_call_ui();
  }

  Tuple *cam_t = dict_find(iter, MESSAGE_KEY_SYNC_CAMERA);
  if (cam_t) {
    s_is_camera_on = cam_t->value->int32 == 1;
    update_call_ui();
  }

  Tuple *rec_t = dict_find(iter, MESSAGE_KEY_SYNC_RECORDING);
  if (rec_t) {
    s_is_recording = rec_t->value->int32 == 1;
    update_call_ui();
  }

  bool cfg_changed = false;
  Tuple *cfg_ptt = dict_find(iter, MESSAGE_KEY_CFG_DEFAULT_PTT);
  if (cfg_ptt) {
    s_cfg.default_ptt = cfg_ptt->value->int32 == 1;
    s_ptt_mode = s_cfg.default_ptt;
    cfg_changed = true;
  }
  Tuple *cfg_muted = dict_find(iter, MESSAGE_KEY_CFG_JOIN_MUTED);
  if (cfg_muted) {
    s_cfg.join_muted = cfg_muted->value->int32 == 1;
    cfg_changed = true;
  }
  Tuple *cfg_cam_off = dict_find(iter, MESSAGE_KEY_CFG_JOIN_CAM_OFF);
  if (cfg_cam_off) {
    s_cfg.join_cam_off = cfg_cam_off->value->int32 == 1;
    cfg_changed = true;
  }
  Tuple *cfg_up = dict_find(iter, MESSAGE_KEY_CFG_UP_SHORT);
  if (cfg_up) {
    s_cfg.up_short = (uint8_t)cfg_up->value->int32;
    cfg_changed = true;
  }
  Tuple *cfg_sel = dict_find(iter, MESSAGE_KEY_CFG_SELECT_SHORT);
  if (cfg_sel) {
    s_cfg.select_short = (uint8_t)cfg_sel->value->int32;
    cfg_changed = true;
  }
  Tuple *cfg_dn = dict_find(iter, MESSAGE_KEY_CFG_DOWN_SHORT);
  if (cfg_dn) {
    s_cfg.down_short = (uint8_t)cfg_dn->value->int32;
    cfg_changed = true;
  }
  if (cfg_changed) {
    persist_write_data(PERSIST_KEY_CONFIG, &s_cfg, sizeof(s_cfg));
    update_call_ui();
  }

  Tuple *banner_t = dict_find(iter, MESSAGE_KEY_EVT_BANNER_BODY);
  if (banner_t) {
    snprintf(s_banner_body, sizeof(s_banner_body), "%s", banner_t->value->cstring);
    s_banner_visible = true;
    vibes_short_pulse();
    update_call_ui();
  }
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  if (s_in_call) {
    s_call_seconds++;
    update_call_ui();
    if (s_menu_layer && window_stack_get_top_window() == s_menu_window) {
      menu_layer_reload_data(s_menu_layer);
    }
  }
}

static void init(void) {
  if (persist_exists(PERSIST_KEY_CONFIG)) {
    persist_read_data(PERSIST_KEY_CONFIG, &s_cfg, sizeof(s_cfg));
    s_ptt_mode = s_cfg.default_ptt;
  }

  s_icon_mic_on = gbitmap_create_with_resource(RESOURCE_ID_ICON_MIC_ON);
  s_icon_mic_off = gbitmap_create_with_resource(RESOURCE_ID_ICON_MIC_OFF);
  s_icon_cam_on = gbitmap_create_with_resource(RESOURCE_ID_ICON_CAM_ON);
  s_icon_cam_off = gbitmap_create_with_resource(RESOURCE_ID_ICON_CAM_OFF);
  s_icon_hangup = gbitmap_create_with_resource(RESOURCE_ID_ICON_HANGUP);

  s_menu_window = window_create();
  window_set_window_handlers(s_menu_window, (WindowHandlers){
    .load = menu_window_load,
    .appear = menu_window_appear,
    .unload = menu_window_unload,
  });

  s_call_window = window_create();
  window_set_window_handlers(s_call_window, (WindowHandlers){
    .load = call_window_load,
    .unload = call_window_unload,
  });

  s_confirm_window = window_create();
  window_set_window_handlers(s_confirm_window, (WindowHandlers){
    .load = confirm_window_load,
    .unload = confirm_window_unload,
  });

#if defined(PBL_MICROPHONE)
  s_dictation_session = dictation_session_create(
    sizeof(s_dictation_buf), dictation_callback, NULL
  );
#endif

  app_message_register_inbox_received(inbox_received_handler);
  app_message_open(512, 512);
  tick_timer_service_subscribe(SECOND_UNIT, tick_handler);

  window_stack_push(s_menu_window, true);
}

static void deinit(void) {
#if defined(PBL_MICROPHONE)
  if (s_dictation_session) dictation_session_destroy(s_dictation_session);
#endif
  tick_timer_service_unsubscribe();
  window_destroy(s_confirm_window);
  window_destroy(s_call_window);
  window_destroy(s_menu_window);
  gbitmap_destroy(s_icon_mic_on);
  gbitmap_destroy(s_icon_mic_off);
  gbitmap_destroy(s_icon_cam_on);
  gbitmap_destroy(s_icon_cam_off);
  gbitmap_destroy(s_icon_hangup);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
