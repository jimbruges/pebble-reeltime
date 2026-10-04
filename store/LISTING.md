# ReelTime — Rebble app store submission

## Fields

| Field | Value |
|---|---|
| Name | ReelTime |
| Type | Watchface |
| Version | 1.0.0 |
| Platforms | emery (200×228) only |
| PBW | `ReelTime-1.0.0.pbw` |
| Tagline | Procedural fish, drawn live on your wrist |
| Website | (optional) |
| Source code URL | (fill in after GitHub push — run `git remote add origin … && git push -u origin main`) |
| Support email | (optional) |
| Category | not required for watchfaces |
| Store icons | not required for watchfaces |
| Release notes (first release) | hello world |

## Description (1080 / 1600 chars)

ReelTime is a watchface that draws you a brand-new fish.

Every hour (or every 12 hours, or every minute - your choice) ReelTime generates a unique, procedurally drawn fish: fins, scales, spots and all, in the style of the open-source fishdraw project. The drawing happens on your phone, streams to your watch, and is revealed with a pen-plotter style animation, one stroke at a time.

Features:
- New fish every hour, 12 hours, or minute - configurable in settings
- Latin species name, live time and date below the drawing
- Time-seed mode: fish seeded from the exact date and time, so every hour and every day gets its own fish (deterministic, no name)
- Colour themes: 19 presets, or set your own background, fish and text colours
- Optional border frame and three line weights: thin, medium, bold
- Black & white or full colour - looks great on any Pebble

Fish artwork is generated with fishdraw by LingDong- (MIT licence), running in PebbleKit JS on your phone and streamed to the watch. ReelTime is open source.

Set the interval to 1 minute and watch fish appear all day.

## Screenshots — upload exactly these 5, in this order

Portal allows max 5 per platform (png/jpg/gif/animated-gif), **exact platform size**, no device frame.

1. `screenshots/1-reeltime-drawing.gif` — 200×228 animated GIF — the fish-drawing reveal, black & white (defaults)
2. `screenshots/3-bw-named.png` — 200×228 — Latin name + time + date, white/black, 12-hour interval, named mode
3. `screenshots/2-bw-inverted-bold.png` — 200×228 — inverted black background, white fish, 3 px bold border (bold line weight)
4. `screenshots/4-color-oxford-chrome.png` — 200×228 — Oxford blue background, chrome-yellow fish, white text, named mode
5. `screenshots/5-color-chrome-yellow.png` — 200×228 — chrome-yellow background, black fish + black 2 px border

Alternates kept in the folder but not uploaded (slot limit): `0-bw-default.png` (hero/default state), `6-color-drawing.gif` (colour reveal animation — swap in for slot 5 if an animated colour shot is preferred).

## Banner

`banner-720x320.png` — 720×320, dark background, title + tagline + two framed screenshots (default B/W and Oxford/chrome colour).

## Screenshot settings used (for reshoots)

| File | interval | border | seedmode | bg | fg | text | lw |
|---|---|---|---|---|---|---|---|
| 0-bw-default | 3600 | 0 | 1 | 255 | 192 | 192 | 1 |
| 1 (gif) | 60→3600 | 0 | 1 | 255 | 192 | 192 | 1 |
| 2-bw-inverted-bold | 3600 | 1 | 1 | 192 | 255 | 255 | 3 |
| 3-bw-named | 43200 | 0 | 0 | 255 | 192 | 192 | 1 |
| 4-color-oxford-chrome | 3600 | 0 | 0 | 193 | 248 | 255 | 1 |
| 5-color-chrome-yellow | 3600 | 1 | 1 | 248 | 192 | 192 | 2 |
| 6 (gif) | 60 | 0 | 0 | 193 | 248 | 255 | 1 |

## Tooling notes (emulator)

- Static shots: QEMU monitor `screendump` + inverse colour LUT (`/tmp/ss.sh`) — never wedges, unlike `pebble screenshot`.
- Config apply: `/tmp/cfg.sh` (emu-app-config, hard curl timeouts). A successful emu-app-config wedges the *next* tool connection; recover with `/tmp/recycle.sh` (kill → install → logs).
- GIF capture: `/tmp/capture.py` (screendump burst after a fresh `fish ready`) → `/tmp/mkgif.py` (global palette, 40 ms/frame,2 s hold).
