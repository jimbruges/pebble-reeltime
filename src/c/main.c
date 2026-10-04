// ReelTime watchface -- receives procedurally generated fish polylines from
// PebbleKit JS (fishdraw runs on the phone) and draws them on the watch.
//
// Layout (emery 200x228), interval mode:
//   fish frame   y   0/2 .. 118  (borderless / bordered)
//   fish name    y 119..155
//   time         y 155..191
//   date         y 191..227
// Seed mode (fish keyed to date+time, no name): fish frame extends over the
// name row to y=155; time and date unchanged.
#include <pebble.h>
#include <math.h>
#define PKEY_INTERVAL_S 1
#define PKEY_BORDER 2
#define PKEY_SEEDMODE 3
#define PKEY_BG 4
#define PKEY_FG 5
#define PKEY_TXT 6
#define PKEY_LW 7

#define FRAME_BOTTOM 118
#define NAME_Y 119
#define NAME_H 36
#define TIME_Y 155
#define TIME_H 36
#define DATE_Y 191
#define DATE_H 36
#define TEXT_X 2

#define FISH_MAX_BYTES 16384
#define INBOX_SIZE 768
#define OUTBOX_SIZE 128

#define REVEAL_TICK_MS 50
#define REVEAL_TOTAL_TICKS 70 // ~3.5s quick-draw animation

#define REQ_TIMEOUT_MS 12000
#define REQ_MAX_ATTEMPTS 3
#define STALL_TIMEOUT_MS 8000

typedef enum {
  Interval60 = 60,
  Interval1h = 3600,
  Interval12h = 43200,
} IntervalS;

static Window *s_window;
static Layer *s_fish_layer;
static Layer *s_labels_layer;

// displayed fish
static uint8_t *s_fish = NULL;
static uint32_t s_fish_len = 0;
static uint16_t s_fish_polys = 0;

// fish currently arriving
static uint8_t *s_in_fish = NULL;
static uint32_t s_in_total = 0;
static uint32_t s_in_recv = 0;
static uint16_t s_in_polys = 0;
static uint16_t s_in_expect = 0;
static char s_in_name[48];

static char s_name[48];

// reveal animation
static AppTimer *s_reveal_timer = NULL;
static int s_reveal_tick = 0;
static int s_reveal_shown = 0;

// fish request
static int s_interval_s = Interval1h;
static int32_t s_bucket = -1;
static int s_req_attempt = 0;
static bool s_awaiting_meta = false;
static AppTimer *s_req_timer = NULL;
static AppTimer *s_stall_timer = NULL;

static GFont s_serif;
static GFont s_name_font;
static int s_border = 0;
static int s_seedmode = 1;
static GColor s_bg = {.argb = GColorWhiteARGB8};
static GColor s_fg = {.argb = GColorBlackARGB8};
static GColor s_txt = {.argb = GColorBlackARGB8};
static int s_lw = 1;
static int s_reply_tries = 0;
static int s_win_w = 200;

static GRect s_frame_rect;
static GRect s_name_box;
static GRect s_time_box;
static GRect s_date_box;
static char s_time_str[16];
static char s_date_str[16];

static void check_bucket(bool force);

static int32_t current_bucket(void) {
  return (int32_t)time(NULL) / s_interval_s;
}

static GRect frame_rect_for(int win_w, int border, int no_name) {
  int bottom = no_name ? TIME_Y : FRAME_BOTTOM;
  if (border) {
    return GRect(2, 2, win_w - 4, bottom - 2);
  }
  return GRect(0, 0, win_w, bottom);
}

static void prv_req_timeout(void *ctx) {
  s_req_timer = NULL;
  if (!s_awaiting_meta) {
    return;
  }
  if (s_req_attempt < REQ_MAX_ATTEMPTS) {
    s_req_attempt++;
    APP_LOG(APP_LOG_LEVEL_INFO, "fish request retry %d", s_req_attempt);
  } else {
    APP_LOG(APP_LOG_LEVEL_WARNING, "fish request giving up (no phone?)");
    s_awaiting_meta = false;
    return;
  }

  DictionaryIterator *iter;
  AppMessageResult r = app_message_outbox_begin(&iter);
  if (r != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox_begin failed: %d", (int)r);
    return;
  }
  static char buf[48];
  snprintf(buf, sizeof(buf), "%ld,%d,%d,%d,%d", (long)s_bucket, s_interval_s,
           (int)s_frame_rect.size.w, (int)s_frame_rect.size.h, s_seedmode);
  dict_write_cstring(iter, MESSAGE_KEY_REQUEST_FISH, buf);
  r = app_message_outbox_send();
  if (r != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox_send failed: %d", (int)r);
    return;
  }
  s_req_timer = app_timer_register(REQ_TIMEOUT_MS, prv_req_timeout, NULL);
}

static void prv_send_request(void) {
  s_req_attempt = 1;
  s_awaiting_meta = true;
  DictionaryIterator *iter;
  AppMessageResult r = app_message_outbox_begin(&iter);
  if (r != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox_begin failed: %d", (int)r);
    return;
  }
  static char buf[48];
  snprintf(buf, sizeof(buf), "%ld,%d,%d,%d,%d", (long)s_bucket, s_interval_s,
           (int)s_frame_rect.size.w, (int)s_frame_rect.size.h, s_seedmode);
  dict_write_cstring(iter, MESSAGE_KEY_REQUEST_FISH, buf);
  r = app_message_outbox_send();
  if (r != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox_send failed: %d", (int)r);
    s_awaiting_meta = false;
    return;
  }
  if (s_req_timer) {
    app_timer_cancel(s_req_timer);
  }
  s_req_timer = app_timer_register(REQ_TIMEOUT_MS, prv_req_timeout, NULL);
}

// --- receive stall watchdog -------------------------------------------

static void prv_abort_and_retry(const char *why);

static void prv_stall_timeout(void *ctx) {
  s_stall_timer = NULL;
  if (!s_in_fish || s_in_recv >= s_in_total) {
    return;
  }
  prv_abort_and_retry("stall");
}

static void prv_arm_stall_timer(void) {
  if (s_stall_timer) {
    app_timer_cancel(s_stall_timer);
  }
  s_stall_timer = app_timer_register(STALL_TIMEOUT_MS, prv_stall_timeout, NULL);
}

static void prv_cancel_stall_timer(void) {
  if (s_stall_timer) {
    app_timer_cancel(s_stall_timer);
    s_stall_timer = NULL;
  }
}

static int s_stall_count = 0;
static AppTimer *s_retry_timer = NULL;

static void prv_retry_send(void *ctx) {
  s_retry_timer = NULL;
  prv_send_request();
}

static void prv_abort_and_retry(const char *why) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "abort receive: %s", why);
  if (s_in_fish) {
    free(s_in_fish);
    s_in_fish = NULL;
  }
  s_in_total = 0;
  s_in_recv = 0;
  s_in_expect = 0;
  prv_cancel_stall_timer();
  s_stall_count++;
  if (s_stall_count > 5) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "too many failed receives, giving up");
    s_awaiting_meta = false;
    if (s_req_timer) {
      app_timer_cancel(s_req_timer);
      s_req_timer = NULL;
    }
    return;
  }
  // delay the re-request so a deterministically bad fish cannot storm
  if (s_retry_timer) {
    app_timer_cancel(s_retry_timer);
  }
  s_retry_timer = app_timer_register(4000, prv_retry_send, NULL);
}

// --- reveal animation -------------------------------------------------

static void prv_reveal_step(void *ctx) {
  s_reveal_timer = NULL;
  if (s_reveal_tick >= REVEAL_TOTAL_TICKS || s_fish_polys == 0) {
    s_reveal_shown = s_fish_polys;
    layer_mark_dirty(s_fish_layer);
    return;
  }
  s_reveal_tick++;
  int target =
      (int)(((int64_t)s_fish_polys * s_reveal_tick) / REVEAL_TOTAL_TICKS);
  if (target > s_fish_polys) {
    target = s_fish_polys;
  }
  if (target > s_reveal_shown) {
    s_reveal_shown = target;
    layer_mark_dirty(s_fish_layer);
  }
  s_reveal_timer = app_timer_register(REVEAL_TICK_MS, prv_reveal_step, NULL);
}

static void prv_start_reveal(void) {
  if (s_reveal_timer) {
    app_timer_cancel(s_reveal_timer);
    s_reveal_timer = NULL;
  }
  s_reveal_tick = 0;
  s_reveal_shown = 0;
  s_reveal_timer = app_timer_register(REVEAL_TICK_MS, prv_reveal_step, NULL);
}

// --- drawing ----------------------------------------------------------

static int prv_iround(float v) {
  return (int)(v >= 0.0f ? v + 0.5f : v - 0.5f);
}

// Draw a segment at an exact w-px width. The platform stroke-width clamps
// to 2, so widths >= 3 are drawn as overlapping native width-2 passes spaced
// ~1px apart along the segment normal (always overlap => no AA gaps; the
// union spans exactly w px on axis-aligned segments).
static void prv_draw_seg(GContext *ctx, GPoint a, GPoint b, int w) {
  if (w <= 2) {
    graphics_context_set_stroke_width(ctx, w);
    graphics_draw_line(ctx, a, b);
    return;
  }
  float dx = (float)b.x - (float)a.x;
  float dy = (float)b.y - (float)a.y;
  float len = sqrtf(dx * dx + dy * dy);
  if (len < 1.0f) {
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_line(ctx, a, b);
    return;
  }
  float nx = -dy / len;
  float ny = dx / len;
  int j_start = -((w - 2) / 2);
  int j_end = j_start + (w - 2);
  graphics_context_set_stroke_width(ctx, 2);
  for (int j = j_start; j <= j_end; j++) {
    int ox = prv_iround(nx * (float)j);
    int oy = prv_iround(ny * (float)j);
    GPoint p1 = GPoint(a.x + ox, a.y + oy);
    GPoint p2 = GPoint(b.x + ox, b.y + oy);
    graphics_draw_line(ctx, p1, p2);
  }
}

static void prv_draw_rect_w(GContext *ctx, GRect r, int w) {
  GPoint tl = r.origin;
  GPoint br = GPoint(r.origin.x + r.size.w - 1, r.origin.y + r.size.h - 1);
  prv_draw_seg(ctx, tl, GPoint(br.x, tl.y), w);
  prv_draw_seg(ctx, GPoint(br.x, tl.y), GPoint(br.x, br.y), w);
  prv_draw_seg(ctx, GPoint(br.x, br.y), GPoint(tl.x, br.y), w);
  prv_draw_seg(ctx, GPoint(tl.x, br.y), GPoint(tl.x, tl.y), w);
}

static void prv_fish_layer_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_stroke_color(ctx, s_fg);
  if (s_border) {
    prv_draw_rect_w(ctx, bounds, s_lw);
  }

  if (!s_fish || s_fish_len < 4 || s_reveal_shown <= 0) {
    return;
  }

  GPoint prev = GPoint(0, 0);
  bool pen = false;
  int polys_drawn = 0;
  for (uint32_t i = 0; i + 3 < s_fish_len; i += 4) {
    int16_t x = (int16_t)((uint16_t)s_fish[i] | ((uint16_t)s_fish[i + 1] << 8));
    int16_t y = (int16_t)((uint16_t)s_fish[i + 2] | ((uint16_t)s_fish[i + 3] << 8));
    if (x == INT16_MIN && y == INT16_MIN) {
      pen = false;
      polys_drawn++;
      if (polys_drawn >= s_reveal_shown) {
        break;
      }
      continue;
    }
    GPoint cur = GPoint(x, y);
    if (pen) {
      prv_draw_seg(ctx, prev, cur, s_lw);
    }
    prev = cur;
    pen = true;
  }
}

static void prv_labels_layer_update(Layer *layer, GContext *ctx) {
  graphics_context_set_text_color(ctx, s_txt);
  graphics_draw_text(ctx, s_name, s_name_font, s_name_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter,
                     NULL);
  graphics_draw_text(ctx, s_time_str, s_serif, s_time_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter,
                     NULL);
  graphics_draw_text(ctx, s_date_str, s_serif, s_date_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter,
                     NULL);
}

// Pick the largest font that fits the whole name on one line.
static GFont prv_pick_name_font(const char *name) {
  GFont candidates[3] = {
      s_serif,
      fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
      fonts_get_system_font(FONT_KEY_GOTHIC_14),
  };
  GRect wide = GRect(0, 0, 4000, 500);
  for (int i = 0; i < 3; i++) {
    int nat = (int)graphics_text_layout_get_content_size(
                  name, candidates[i], wide, GTextOverflowModeTrailingEllipsis,
                  GTextAlignmentLeft)
                  .w;
    if (nat <= (int)s_name_box.size.w) {
      APP_LOG(APP_LOG_LEVEL_INFO, "name font %d: %dpx", i, nat);
      return candidates[i];
    }
  }
  APP_LOG(APP_LOG_LEVEL_INFO, "name font 2 (smallest)");
  return candidates[2];
}

// --- time -------------------------------------------------------------

static void prv_update_time_strings(void) {
  time_t now = time(NULL);
  struct tm *t = localtime(&now);
  strftime(s_time_str, sizeof(s_time_str),
           clock_is_24h_style() ? "%H:%M" : "%I:%M %p", t);
  strftime(s_date_str, sizeof(s_date_str), "%a %d %b", t);
  for (char *p = s_date_str; *p != '\0'; p++) {
    if (*p >= 'a' && *p <= 'z') {
      *p -= 32;
    }
  }
}

static void prv_tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  prv_update_time_strings();
  layer_mark_dirty(s_labels_layer);
  check_bucket(false);
}

// --- fish reception ---------------------------------------------------

// libc strtoul/strtol misparse on this platform (observed dropping the first
// digit), so parse decimal digits by hand.
static bool prv_parse_uint(const char *s, unsigned long *out) {
  unsigned long v = 0;
  if (*s < '0' || *s > '9') {
    return false;
  }
  while (*s >= '0' && *s <= '9') {
    v = v * 10 + (unsigned long)(*s - '0');
    if (v > 1000000UL) {
      return false;
    }
    s++;
  }
  *out = v;
  return true;
}

static void prv_parse_meta(const char *meta) {
  // format: "total_bytes,poly_count,name"
  unsigned long total = 0;
  unsigned long polys = 0;
  if (!prv_parse_uint(meta, &total)) {
    prv_abort_and_retry("bad META");
    return;
  }
  const char *comma1 = strchr(meta, ',');
  if (!comma1) {
    return;
  }
  const char *comma2 = strchr(comma1 + 1, ',');
  if (!comma2) {
    return;
  }
  if (!prv_parse_uint(comma1 + 1, &polys)) {
    prv_abort_and_retry("bad META");
    return;
  }
  if (total == 0 || total > FISH_MAX_BYTES || polys > 4000) {
    prv_abort_and_retry("bad META");
    return;
  }

  if (s_in_fish) {
    free(s_in_fish);
    s_in_fish = NULL;
  }
  s_in_fish = malloc(total);
  if (!s_in_fish) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "malloc(%lu) failed", total);
    return;
  }
  s_in_total = total;
  s_in_recv = 0;
  s_in_polys = (uint16_t)polys;
  s_in_expect = 0;
  strncpy(s_in_name, comma2 + 1, sizeof(s_in_name) - 1);
  s_in_name[sizeof(s_in_name) - 1] = '\0';

  s_awaiting_meta = false;
  if (s_req_timer) {
    app_timer_cancel(s_req_timer);
    s_req_timer = NULL;
  }
  if (s_retry_timer) {
    app_timer_cancel(s_retry_timer);
    s_retry_timer = NULL;
  }
  APP_LOG(APP_LOG_LEVEL_INFO, "receiving fish: %d bytes, %d polys", (int)total,
          (int)polys);
  prv_arm_stall_timer();
}

static void prv_finish_fish(uint32_t checksum) {
  prv_cancel_stall_timer();
  if (!s_in_fish || s_in_recv != s_in_total) {
    prv_abort_and_retry("incomplete END");
    return;
  }
  uint32_t sum = 0;
  for (uint32_t i = 0; i < s_in_total; i++) {
    sum += s_in_fish[i];
  }
  if (sum != checksum) {
    char why[40];
    snprintf(why, sizeof(why), "checksum %lu != %lu", (unsigned long)sum,
             (unsigned long)checksum);
    prv_abort_and_retry(why);
    return;
  }

  if (s_fish) {
    free(s_fish);
  }
  s_fish = s_in_fish;
  s_in_fish = NULL;
  s_fish_len = s_in_total;
  s_fish_polys = s_in_polys;
  strncpy(s_name, s_in_name, sizeof(s_name) - 1);
  s_name[sizeof(s_name) - 1] = '\0';
  s_stall_count = 0;
  s_name_font = prv_pick_name_font(s_name);

  layer_mark_dirty(s_labels_layer);
  APP_LOG(APP_LOG_LEVEL_INFO, "fish ready: %d bytes, %d polys, name=%s",
          (int)s_fish_len, (int)s_fish_polys, s_name);
  prv_start_reveal();
}

// --- settings reply (phone asks on config open) ------------------------

static void prv_send_settings_reply(void *ctx) {
  DictionaryIterator *iter;
  AppMessageResult r = app_message_outbox_begin(&iter);
  if (r != APP_MSG_OK) {
    if (s_reply_tries++ < 4) {
      app_timer_register(400, prv_send_settings_reply, NULL);
    } else {
      s_reply_tries = 0;
    }
    return;
  }
  s_reply_tries = 0;
  dict_write_int32(iter, MESSAGE_KEY_SETTINGS, s_interval_s);
  dict_write_int32(iter, MESSAGE_KEY_BORDER, s_border);
  dict_write_int32(iter, MESSAGE_KEY_SEEDMODE, s_seedmode);
  dict_write_int32(iter, MESSAGE_KEY_BGCOLOR, s_bg.argb);
  dict_write_int32(iter, MESSAGE_KEY_FGCOLOR, s_fg.argb);
  dict_write_int32(iter, MESSAGE_KEY_TEXTCOLOR, s_txt.argb);
  dict_write_int32(iter, MESSAGE_KEY_LINEWIDTH, s_lw);
  r = app_message_outbox_send();
  if (r != APP_MSG_OK) {
    if (s_reply_tries++ < 4) {
      app_timer_register(400, prv_send_settings_reply, NULL);
    } else {
      s_reply_tries = 0;
    }
    return;
  }
  APP_LOG(APP_LOG_LEVEL_INFO, "settings reply sent");
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *tuple;

  tuple = dict_find(iter, MESSAGE_KEY_FISH_META);
  if (tuple) {
    prv_parse_meta(tuple->value->cstring);
    return;
  }

  tuple = dict_find(iter, MESSAGE_KEY_FISH_CHUNK);
  if (tuple) {
    if (!s_in_fish) {
      return;
    }
    uint32_t len = tuple->length;
    if (len < 4) {
      return;
    }
    const uint8_t *d = tuple->value->data;
    uint16_t idx = (uint16_t)(d[0] | (d[1] << 8));
    if (idx != s_in_expect) {
      APP_LOG(APP_LOG_LEVEL_WARNING, "chunk %u out of order (want %u)", idx,
              s_in_expect);
      return;
    }
    uint32_t plen = len - 2;
    if (s_in_recv + plen > s_in_total) {
      plen = s_in_total - s_in_recv;
    }
    memcpy(s_in_fish + s_in_recv, d + 2, plen);
    s_in_recv += plen;
    s_in_expect++;
    prv_arm_stall_timer();
    return;
  }

  tuple = dict_find(iter, MESSAGE_KEY_FISH_END);
  if (tuple) {
    prv_finish_fish((uint32_t)tuple->value->int32);
    return;
  }

  tuple = dict_find(iter, MESSAGE_KEY_BORDER);
  if (tuple) {
    int b = tuple->value->int32 ? 1 : 0;
    if (b != s_border) {
      APP_LOG(APP_LOG_LEVEL_INFO, "border -> %d", b);
      s_border = b;
      persist_write_int(PKEY_BORDER, s_border);
      GRect old = s_frame_rect;
      s_frame_rect = frame_rect_for(s_win_w, s_border, s_seedmode);
      if (!grect_equal(&old, &s_frame_rect)) {
        layer_set_frame(s_fish_layer, s_frame_rect);
        layer_mark_dirty(s_fish_layer);
        s_bucket = -1;
        check_bucket(true);
      }
    }
    // SETTINGS / SEEDMODE may be present in the same message
  }

  tuple = dict_find(iter, MESSAGE_KEY_SEEDMODE);
  if (tuple) {
    int m = tuple->value->int32 ? 1 : 0;
    if (m != s_seedmode) {
      APP_LOG(APP_LOG_LEVEL_INFO, "seed mode -> %d", m);
      s_seedmode = m;
      persist_write_int(PKEY_SEEDMODE, s_seedmode);
      s_frame_rect = frame_rect_for(s_win_w, s_border, s_seedmode);
      layer_set_frame(s_fish_layer, s_frame_rect);
      layer_mark_dirty(s_fish_layer);
      s_bucket = -1;
      check_bucket(true);
    }
  }

  tuple = dict_find(iter, MESSAGE_KEY_BGCOLOR);
  if (tuple) {
    GColor c = {.argb = (uint8_t)tuple->value->int32};
    if (c.argb != s_bg.argb) {
      APP_LOG(APP_LOG_LEVEL_INFO, "bg -> %d", (int)c.argb);
      s_bg = c;
      persist_write_int(PKEY_BG, c.argb);
      window_set_background_color(s_window, s_bg);
      layer_mark_dirty(window_get_root_layer(s_window));
      layer_mark_dirty(s_fish_layer);
      layer_mark_dirty(s_labels_layer);
    }
  }

  tuple = dict_find(iter, MESSAGE_KEY_FGCOLOR);
  if (tuple) {
    GColor c = {.argb = (uint8_t)tuple->value->int32};
    if (c.argb != s_fg.argb) {
      APP_LOG(APP_LOG_LEVEL_INFO, "fish -> %d", (int)c.argb);
      s_fg = c;
      persist_write_int(PKEY_FG, c.argb);
      layer_mark_dirty(s_fish_layer);
    }
  }

  tuple = dict_find(iter, MESSAGE_KEY_TEXTCOLOR);
  if (tuple) {
    GColor c = {.argb = (uint8_t)tuple->value->int32};
    if (c.argb != s_txt.argb) {
      APP_LOG(APP_LOG_LEVEL_INFO, "text -> %d", (int)c.argb);
      s_txt = c;
      persist_write_int(PKEY_TXT, c.argb);
      layer_mark_dirty(s_labels_layer);
    }
  }

  tuple = dict_find(iter, MESSAGE_KEY_LINEWIDTH);
  if (tuple) {
    int w = tuple->value->int32;
    if (w < 1 || w > 3) {
      w = 1;
    }
    if (w != s_lw) {
      APP_LOG(APP_LOG_LEVEL_INFO, "line width -> %d", w);
      s_lw = w;
      persist_write_int(PKEY_LW, w);
      layer_mark_dirty(s_fish_layer);
    }
  }

  tuple = dict_find(iter, MESSAGE_KEY_GET_SETTINGS);
  if (tuple) {
    APP_LOG(APP_LOG_LEVEL_INFO, "get settings");
    prv_send_settings_reply(NULL);
  }

  tuple = dict_find(iter, MESSAGE_KEY_SETTINGS);
  if (tuple) {
    int32_t iv = tuple->value->int32;
    if ((iv == Interval60 || iv == Interval1h || iv == Interval12h) &&
        iv != s_interval_s) {
      APP_LOG(APP_LOG_LEVEL_INFO, "interval -> %ld", (long)iv);
      s_interval_s = (int)iv;
      persist_write_int(PKEY_INTERVAL_S, s_interval_s);
      s_bucket = -1;
      check_bucket(true);
    }
    return;
  }
}

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "inbox dropped: %d", (int)reason);
}

static void prv_outbox_failed(DictionaryIterator *iter, AppMessageResult reason,
                              void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "outbox failed: %d", (int)reason);
}

// --- bucket scheduling ------------------------------------------------

static void check_bucket(bool force) {
  int32_t b = current_bucket();
  if (force || b != s_bucket) {
    s_bucket = b;
    prv_send_request();
  }
}

// --- window -----------------------------------------------------------

static void prv_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);
  int w = bounds.size.w;

  s_win_w = w;
  s_frame_rect = frame_rect_for(w, s_border, s_seedmode);
  s_name_box = GRect(TEXT_X, NAME_Y, w - 2 * TEXT_X, NAME_H);
  s_time_box = GRect(TEXT_X, TIME_Y, w - 2 * TEXT_X, TIME_H);
  s_date_box = GRect(TEXT_X, DATE_Y, w - 2 * TEXT_X, DATE_H);

  s_fish_layer = layer_create(s_frame_rect);
  layer_set_update_proc(s_fish_layer, prv_fish_layer_update);
  layer_add_child(window_layer, s_fish_layer);

  s_labels_layer = layer_create(bounds);
  layer_set_update_proc(s_labels_layer, prv_labels_layer_update);
  layer_add_child(window_layer, s_labels_layer);

  prv_update_time_strings();
}

static void prv_window_unload(Window *window) {
  if (s_reveal_timer) {
    app_timer_cancel(s_reveal_timer);
    s_reveal_timer = NULL;
  }
  if (s_req_timer) {
    app_timer_cancel(s_req_timer);
    s_req_timer = NULL;
  }
  if (s_retry_timer) {
    app_timer_cancel(s_retry_timer);
    s_retry_timer = NULL;
  }
  prv_cancel_stall_timer();
  layer_destroy(s_fish_layer);
  layer_destroy(s_labels_layer);
}

// --- init -------------------------------------------------------------

static void prv_init(void) {
  APP_LOG(APP_LOG_LEVEL_INFO, "init");
  s_serif = fonts_get_system_font(FONT_KEY_DROID_SERIF_28_BOLD);
  s_name_font = s_serif;

  if (persist_exists(PKEY_INTERVAL_S)) {
    s_interval_s = persist_read_int(PKEY_INTERVAL_S);
    if (s_interval_s != Interval60 && s_interval_s != Interval1h &&
        s_interval_s != Interval12h) {
      s_interval_s = Interval1h;
    }
  }
  if (persist_exists(PKEY_BORDER)) {
    s_border = persist_read_int(PKEY_BORDER) ? 1 : 0;
  }
  if (persist_exists(PKEY_SEEDMODE)) {
    s_seedmode = persist_read_int(PKEY_SEEDMODE) ? 1 : 0;
  }
  if (persist_exists(PKEY_BG)) {
    s_bg.argb = (uint8_t)persist_read_int(PKEY_BG);
  }
  if (persist_exists(PKEY_FG)) {
    s_fg.argb = (uint8_t)persist_read_int(PKEY_FG);
  }
  if (persist_exists(PKEY_TXT)) {
    s_txt.argb = (uint8_t)persist_read_int(PKEY_TXT);
  }
  if (persist_exists(PKEY_LW)) {
    int w = persist_read_int(PKEY_LW);
    s_lw = (w < 1 || w > 3) ? 1 : w;
  }

  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  app_message_register_outbox_failed(prv_outbox_failed);
  app_message_open(INBOX_SIZE, OUTBOX_SIZE);

  s_window = window_create();
  window_set_background_color(s_window, s_bg);
  window_set_window_handlers(s_window, (WindowHandlers){
                                            .load = prv_window_load,
                                            .unload = prv_window_unload,
                                          });
  window_stack_push(s_window, true);

  tick_timer_service_subscribe(MINUTE_UNIT, prv_tick_handler);

  // fish frame lives in window coordinates; shift the fish layer children by
  // using its own bounds as drawing space
  check_bucket(true);
}

static void prv_deinit(void) {
  if (s_fish) {
    free(s_fish);
  }
  if (s_in_fish) {
    free(s_in_fish);
  }
  tick_timer_service_unsubscribe();
  app_message_deregister_callbacks();
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
