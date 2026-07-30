# MeetCap

A Chrome extension that records captions and captures slides in Google Meet. It starts
itself when you join a call, keeps everything on your machine, and exports either one
self-contained markdown file with the images embedded, or a `.zip` holding the markdown
next to an `images/` folder of real image files.

The user interface is in Vietnamese; the code and docs are in English.

## What is in this repo

| Path | What it is |
| --- | --- |
| [`extension/`](extension/) | The extension. See [extension/README.md](extension/README.md) for install steps and architecture. |
| [`extension/THIET-KE.html`](extension/THIET-KE.html) | UI design document (in Vietnamese) — mockups of all three surfaces, the detection state machine, and the full copy deck. Open it in a browser. |
| [`idea.js`](idea.js) | The original console script (v7). Its core — the three-stage image filter and the caption merge function — was carried over verbatim. |

## Install

1. Open `chrome://extensions` and turn on **Developer mode**
2. **Load unpacked** → pick the `extension/` folder
3. Check **Details → Site access** is *On meet.google.com*, not *On click*. Set to
   *On click*, Chrome injects no content script and logs no error at all
4. Join a Google Meet call

No build step, no dependencies.

## What it does

- Detects that you are inside a call via the leave-call button, then **starts recording
  and turns captions on** by itself
- Captures an image only when the frame really changed — three filter stages: an area
  gate, a settle wait, and a dHash duplicate check
- **One meeting is one recording**, keyed by meeting code: reloading the page appends to
  the existing recording instead of starting a second one
- Leaving the call only stops the recording. It never downloads anything on its own
- Click a recording in the History tab to copy it as markdown; rename and delete in place
- Or download it as a `.zip` — markdown plus an `images/` folder it references, so the
  pictures can be opened, edited and dragged around on their own

## Privacy

No server, no outbound `fetch`. It runs only on `meet.google.com`. Captions and images
live in the extension's own IndexedDB on your machine.

The extension records other people's speech, so while recording the in-page HUD is never
fully hidden — the red dot always shows. Tell the people in the room that you are
recording.

Transcripts and images from real meetings are excluded by `.gitignore` and are not part of
this repo.
