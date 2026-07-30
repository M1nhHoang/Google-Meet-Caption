# MeetCap

A Chrome extension that records captions and captures slides in Google Meet. Grown out of
the `idea.js v7` console script into something that runs by itself.

The user interface is in Vietnamese. Code, comments and this document are in English.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick the `extension/` folder
4. Join a Google Meet call

No build step, no dependencies.

The service worker re-injects the content script into every open Meet tab whenever the
extension is reloaded, so you normally do not need to refresh anything. If it still cannot
connect, the popup says *"Chưa nối được với trang Meet"* with a reconnect button and
**Chrome's verbatim error**.

### When nothing happens

1. **The Meet tab's console** should contain
   `[MeetCap] content script loaded · room: … · state: …`
2. **The service worker console**: `chrome://extensions` → MeetCap → click *service worker*.
   It logs `[MeetCap] injected content script into tab N`, or why injection failed.
3. **Site access**: `chrome://extensions` → MeetCap → Details. If it is set to *On click*,
   manifest-declared content scripts are **never injected and nothing is logged** — the
   console stays completely silent. Switch it to *On meet.google.com*. This is the cause
   that best matches "the console prints nothing".

## How it works

Joining a call starts the recording. There is no start button.

```text
not on Meet → Meet home → lobby → IN CALL → left
                                    │         │
                          record + enable CC  stop
```

Being inside a call is detected from the **leave-call button**, found by its Material
Symbols ligature text `call_end` rather than by `aria-label` (changes with interface
language) or a hashed class name (Google changes those without warning). A transition only
commits once the signal has held steady for 1.5s on the way in and 3s on the way out.

Leaving the call **only stops recording**. It never downloads a file.

### Enabling captions

Never click blind. If captions are already on, the button is not touched. After clicking,
wait for the caption region to appear; if it does not, **click back** so we never turn off
captions the user had on. On first use Meet asks which caption language to use — the
extension does not choose for you, it shows a notice with a retry button.

### One meeting is one recording

The recording key **is the meeting code**. Reloading the page, dropping off the network, or
rejoining all append to the existing recording rather than creating a second one.

Because every join is a "segment", timestamps inside a recording are **cumulative content
time** rather than wall clock time — rejoining the next day continues at 42:20 instead of
jumping to 24:00:00.

Known trade-off: a recurring meeting reuses the same code, so all of its sessions collapse
into one recording. To split by day, change the key in `openSession` (`lib/db.js`) to
`` `${code}#${day}` ``.

Duplicate speech is avoided on append by comparing against the last 6 stored turns: same
speaker plus a normalised prefix match overwrites instead of adding a row
(`content/captions.js`). Images are de-duplicated by dHash against **every** image in the
recording.

One meeting code, one recording tab. A second tab in the same room reports that another tab
is already recording.

## Blurry images?

Meet **lowers the video stream resolution to match the displayed tile size**. In a small
tile `videoWidth` drops to 640x360 and no amount of encoding quality can bring the detail
back.

- By default the extension does **not downscale** (`exportMaxSide: 0`) and encodes WebP at 0.92
- The HUD shows the real resolution of the image it just captured
- Below a 1000px-wide stream the HUD suggests enlarging the presentation

For the sharpest images, **pin or enlarge the presentation** in Meet.

## Where data lives

Everything stays on the machine. No server, no outbound `fetch`.

| Data | Stored in |
| --- | --- |
| Recordings, turns, images | IndexedDB `meetcap` on the **extension origin** (not on meet.google.com) |
| Settings | `chrome.storage.sync` |
| HUD position and open/collapsed state | `chrome.storage.local` |
| Which tab is recording which room | `chrome.storage.session` |

It sits on the extension origin so the popup can read it with no Meet tab open, and so
clearing Meet's site data does not destroy recordings.

Images are stored as base64 directly — 33% more bytes, in exchange for a near-instant copy,
because the exported markdown is base64 anyway.

Pruning: keeps 30 days or 4 GB, whichever comes first. When it has to prune it **drops the
oldest recording's images and keeps its text**.

## Export

Two ways out, both one click.

**Copy / `.md`** — **self-contained markdown** with base64 images, so a paste anywhere
keeps the pictures.

- Clicking a recording in the **History** tab copies it immediately
- Past the threshold (25 MB by default) it downloads a `.md` file instead of copying,
  because pasting an oversized base64 string freezes the target editor
- Copying uses `ClipboardItem` with a `Promise` to keep the user gesture alive across the
  markdown build — calling `writeText` after the build makes Chrome throw
  *Document is not focused*

To get the clean text without images:

```bash
grep -v '^\[img-' file.md
```

**`.zip`** — the `zip` button on a history row, `Tải .zip` on the current-meeting tab and
the preview page, `zip` in the options table. Base64 is easy to paste but awkward to work
with: no single image can be opened on its own, and a 400 MB markdown file bogs down every
editor. The bundle is the transcript with the images as real files:

```text
Họp kế hoạch quý 3-kqr-mfvd-xzt-2026-07-29-0915.zip
└── kqr-mfvd-xzt-2026-07-29-0915/
    ├── Họp kế hoạch quý 3-…-0915.md   → images/anh-001.webp
    └── images/anh-001.webp …
```

- One folder inside the archive, so unzipping never scatters files into Downloads, and the
  relative `images/` links survive moving the folder
- No base64 copy of the transcript in the bundle — that shape is one click away on the copy
  button, and shipping the same text twice only doubles the download
- The folder is named after the meeting **code**, and the document stem is capped at 64
  characters. Windows still refuses paths over 260 characters and Explorer extracts into a
  folder named after the `.zip`, so a long title would otherwise be paid for twice in one
  path — `Expand-Archive` fails outright when it happens
- `lib/zip.js` writes the archive: CRC-32, `CompressionStream("deflate-raw")` for the
  markdown, stored as-is for the images (WebP does not deflate). No library, no build step
- Bytes go into a `Blob` every 8 MB while packing, so the heap stays flat — 50 images of
  500 KB pack in about a second and never hold more than a few MB of JS memory
- No ZIP64: an archive stops at 4 GB and 65 535 entries, above the pruning cap. Past either,
  it refuses with a message instead of writing a corrupt file

## Layout

```text
manifest.json
lib/            db.js · markdown.js · settings.js · format.js      (ES modules, shared)
                zip.js                the ZIP writer, ~180 lines
                bundle.js             one recording → one .zip, and saving files
background/     service-worker.js    owns IndexedDB, badge, arbiter between tabs
content/        selectors.js          everything that touches Meet's DOM, 3 fallback layers
                captions.js           read and merge speaker turns
                frames.js             the three-stage capture filter
                cc-toggle.js          the verified caption-enabling sequence
                hud.js                the HUD, inside a Shadow DOM
                detector.js           state machine, conductor
popup/          two tabs: current meeting · history
options/        settings
preview/        preview page, opens in its own tab
ui/tokens.css   shared colour and type tokens
THIET-KE.html   UI design document (Vietnamese)
```

Content scripts cannot load ES modules, so the files in `content/` are classic scripts
sharing a `window.__MC` namespace (in the isolated world, invisible to the Meet page).

That is why `DEFAULTS` is duplicated: the source of truth is `lib/settings.js` and a mirror
sits at the top of `content/detector.js`. **Change one, change both.**

And because all six files share **one global scope** like sibling `<script>` tags,
top-level bindings must use `var`, never `const` or `let`. A second `const MC` throws
`Identifier 'MC' has already been declared` and **blocks every file after it** — the
extension silently does nothing and the popup only ever shows "Nghỉ". This has already
happened once; do not repeat it.

## Things to know before changing anything

- **Vietnamese label regexes in `content/selectors.js` must stay.** They match the
  Vietnamese Meet interface; translating them breaks detection. The ligature lookups are
  the language-independent path, and those regexes are the fallback.
- **Background-tab timers**: Chrome collapses `setInterval` in a background tab to once a
  minute after 5 minutes. A Meet tab playing audio is exempt. The extension measures the
  drift and reports it in the HUD instead of silently dropping images.
- **Meet's class names**: every selector lives in `content/selectors.js` with at least two
  fallback layers. When one breaks the HUD says so rather than freezing.
- **It records other people's speech**: the HUD has no hide button. Collapsed to its
  smallest state it still shows the red dot. Do not remove that.
