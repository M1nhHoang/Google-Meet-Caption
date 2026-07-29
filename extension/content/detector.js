/* The state machine and conductor of the content script.
   Meet is a single-page app: the URL changes without a reload and the DOM is built
   gradually. So everything here keys off DOM signals, never off when this script loaded.

   States:  home -> lobby -> call -> ended
   A transition only commits once the new signal has held steady (1.5s on the way in,
   3s on the way out), so it does not flicker while Meet rebuilds its toolbar. */

/* var, not const: content scripts share one global scope, like sibling <script>
   tags. A second `const MC` would throw "Identifier MC has already been declared"
   and block every file listed after it. */
var MC = (window.__MC ||= {});

/* Mirror of DEFAULTS in lib/settings.js — content scripts cannot load ES modules.
   Change it there and you must change it here too. */
const DEFAULTS = {
  autoRecord: true,
  autoCaption: true,
  keepCaptionOn: false,
  captureEnabled: true,
  skipCodes: [],
  minChangeRatio: 0.05,
  settleRatio: 0.015,
  pixelTol: 12,
  threshold: 6,
  watchMs: 1000,
  exportMaxSide: 0,
  exportQuality: 0.92,
  exportFormat: "image/webp",
  captureHardCap: 2560,
  videoWarnWidth: 1000,
  copyMaxBytes: 25 * 1024 * 1024,
};

let cfg = { ...DEFAULTS };

const S = {
  phase: "home",
  code: null,
  sid: null,
  title: null,

  /* cumulative content time, summed across rejoins */
  offset: 0,
  segStart: Date.now(),
  startedAt: Date.now(),

  turns: [],
  seen: new WeakMap(),
  dirty: new Set(),
  nextSeq: 0,

  frameHashes: [],
  nextFid: 1,
  frameCount: 0,

  storedSig: null,
  pendingSig: null,
  lastRatio: 0,
  skipped: 0,
  videoIdx: null,

  recording: false,
  paused: false,
  owner: true,
  ccStatus: null,
  note: "",
  noteTone: "",
  videoSize: "",
  throttleHits: 0,

  timers: [],
  stopStayOn: null,
};

const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

const elapsed = () => S.offset + (Date.now() - S.segStart);

/* Timestamps inside a recording are cumulative CONTENT time across rejoins, not wall
   clock time. captions.js and frames.js call this. */
MC.contentAt = (ts) => Math.max(0, S.offset + (ts - S.segStart));

/* ---------------- settings ---------------- */

async function loadCfg() {
  const got = await chrome.storage.sync.get(DEFAULTS);
  cfg = { ...DEFAULTS, ...got };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [k, v] of Object.entries(changes)) cfg[k] = v.newValue;
  if (changes.watchMs && S.recording) restartFrameTimer();
});

/* ---------------- state machine ---------------- */

function evaluate() {
  const code = MC.sel.meetingCode();
  if (!code) return "home";
  if (MC.sel.hangupButton()) return "call";
  return "lobby";
}

let candidate = null;
let candidateSince = 0;

function poll() {
  const next = evaluate();
  const now = Date.now();

  if (next === S.phase) {
    candidate = null;
    return;
  }
  if (candidate !== next) {
    candidate = next;
    candidateSince = now;
    return;
  }
  // Leaving needs more certainty than joining: Meet rebuilds the toolbar on layout changes.
  const need = S.phase === "call" ? 3000 : 1500;
  if (now - candidateSince >= need) {
    candidate = null;
    commit(next);
  }
}

async function commit(phase) {
  const was = S.phase;
  S.phase = phase;

  if (phase === "call") {
    await enterCall();
    return;
  }
  if (was === "call") {
    await leaveCall();
  }
  if (phase === "home") {
    MC.hud.unmount();
    S.code = null;
  } else if (phase === "lobby") {
    S.code = MC.sel.meetingCode();
    await MC.hud.mount(S.code || "lobby");
    wireHud();
    render();
  }
}

/* ---------------- joining the call ---------------- */

async function enterCall() {
  const code = MC.sel.meetingCode();
  if (!code) return;
  S.code = code;
  S.title = MC.sel.meetingTitle(code);

  if (cfg.skipCodes?.some((c) => c.trim().toLowerCase() === code)) {
    MC.hud.unmount();
    return;
  }

  await MC.hud.mount(code);
  wireHud();

  if (!cfg.autoRecord) {
    S.note = "Tự động ghi đang tắt";
    render();
    return;
  }
  await beginRecording();
}

async function beginRecording() {
  const res = await chrome.runtime.sendMessage({
    type: "session:open",
    code: S.code,
    title: S.title,
  });

  if (!res || res.error) {
    S.note = "Không mở được bản ghi";
    S.noteTone = "bad";
    render();
    return;
  }
  if (res.owner === false) {
    S.owner = false;
    S.note = "Đang ghi ở tab khác";
    S.noteTone = "bad";
    MC.hud.toast("Cuộc họp này đang được ghi ở tab khác.", " Đóng tab kia rồi tải lại trang này nếu muốn ghi ở đây.", { tone: "warn" });
    render();
    return;
  }

  S.owner = true;
  S.sid = res.session.id;
  S.startedAt = res.session.startedAt;
  S.offset = res.baseOffset || 0;
  S.segStart = res.segmentStart || Date.now();
  S.turns = res.turns || [];
  S.nextSeq = S.turns.length ? Math.max(...S.turns.map((t) => t.seq)) + 1 : 0;
  S.frameHashes = (res.frameMetas || []).map((f) => f.hash);
  S.frameCount = res.frameMetas?.length || 0;
  S.nextFid = res.frameMetas?.length ? Math.max(...res.frameMetas.map((f) => f.fid)) + 1 : 1;
  S.seen = new WeakMap();
  S.dirty = new Set();
  S.storedSig = null;
  S.pendingSig = null;
  S.recording = true;
  S.paused = false;
  S.note = "";
  S.noteTone = "";

  if (res.resumed && (S.turns.length || S.frameCount)) {
    MC.hud.toast(
      "Ghi tiếp bản ghi cũ",
      ` Đã có ${S.turns.length} lượt nói và ${S.frameCount} ảnh của phòng này.`
    );
  } else {
    MC.hud.toast("Đã vào họp — bắt đầu ghi", "");
  }

  startTimers();
  MC.hud.setOpen(true);
  setTimeout(() => { if (S.recording) MC.hud.setOpen(false); }, 6000);
  render();

  if (cfg.autoCaption) ensureCaptions();
  if (cfg.keepCaptionOn) {
    S.stopStayOn = MC.cc.watchStayOn((r) => {
      if (r === "on") MC.hud.toast("Phụ đề bị tắt — đã bật lại", "");
    });
  }
}

async function ensureCaptions() {
  const r = await MC.cc.ensureOn();
  S.ccStatus = r;
  if (r === "on") MC.hud.toast("Đã tự bật phụ đề", "");
  else if (r === "needs-language") {
    MC.hud.toast(
      "Chưa bật được phụ đề",
      " Meet đang hỏi chọn ngôn ngữ phụ đề. Chọn giúp một lần, những lần sau tiện ích tự bật.",
      { tone: "warn", action: () => ensureCaptions(), actionLabel: "Đã chọn xong, thử lại" }
    );
  } else if (r === "failed" || r === "no-button") {
    MC.hud.toast(
      "Chưa bật được phụ đề",
      " Bấm nút CC trên thanh Meet, phần ghi lời sẽ tự nối vào.",
      { tone: "warn", timeout: 12000 }
    );
  }
  render();
}

/* ---------------- leaving the call: only stop, never download ---------------- */

async function leaveCall() {
  if (!S.recording) {
    stopTimers();
    return;
  }
  stopTimers();
  await flushTurns();
  const turns = S.turns.length;
  const frames = S.frameCount;
  S.recording = false;
  S.paused = false;
  await chrome.runtime.sendMessage({ type: "session:end", sid: S.sid, count: turns });
  S.note = `Đã lưu ${turns} lượt · ${frames} ảnh`;
  S.noteTone = "";
  render();
  MC.hud.toast("Đã rời họp — dừng ghi", ` Bản ghi đã lưu: ${turns} lượt nói, ${frames} ảnh.`, { timeout: 9000 });
}

/* ---------------- run loops ---------------- */

function startTimers() {
  stopTimers();
  S.timers.push(setInterval(captionTick, 400));
  S.timers.push(setInterval(flushTurns, 2000));
  S.timers.push(setInterval(heartbeat, 15000));
  restartFrameTimer();
}

function restartFrameTimer() {
  if (S.frameTimer) clearInterval(S.frameTimer);
  S.lastFrameTickAt = Date.now();
  S.frameTimer = setInterval(frameTick, Math.max(400, cfg.watchMs));
  S.timers.push(S.frameTimer);
}

function stopTimers() {
  S.timers.forEach(clearInterval);
  S.timers = [];
  S.frameTimer = null;
  S.stopStayOn?.();
  S.stopStayOn = null;
}

function captionTick() {
  if (!S.recording || S.paused) return;
  const r = MC.captions.sync(S);
  if (!r.region && !S.note) S.note = "Chưa thấy vùng phụ đề";
  else if (r.region && S.note === "Chưa thấy vùng phụ đề") S.note = "";
  render();
}

async function frameTick() {
  if (!S.recording || S.paused || !cfg.captureEnabled || S.busy) return;

  // Chrome throttles background-tab timers to once per minute after 5 minutes. A Meet tab
  // playing audio is exempt, but silence makes that unreliable — measure the drift and
  // tell the user the truth instead of silently dropping images.
  const now = Date.now();
  const gap = now - (S.lastFrameTickAt || now);
  S.lastFrameTickAt = now;
  if (gap > cfg.watchMs * 2.5) {
    if (++S.throttleHits >= 2) {
      S.note = "Tab nền bị Chrome giảm nhịp chụp — quay lại tab này để chụp đủ";
      S.noteTone = "bad";
    }
  } else if (S.throttleHits) {
    S.throttleHits = 0;
    if (S.noteTone === "bad") { S.note = ""; S.noteTone = ""; }
  }

  S.busy = true;
  try {
    const frame = await MC.frames.tick(S, cfg);
    if (frame) await saveFrame(frame);
    noteVideo();
  } catch (e) {
    if (e.message === "no-video") S.note = "Không có video để chụp";
    else if (e.message === "canvas-blocked") {
      S.note = "Trình duyệt chặn đọc khung hình video";
      S.noteTone = "bad";
      cfg.captureEnabled = false;
    }
  } finally {
    S.busy = false;
    render();
  }
}

async function saveFrame(frame) {
  S.frameCount++;
  await chrome.runtime.sendMessage({ type: "frame:put", sid: S.sid, frame });
}

function noteVideo() {
  const v = MC.sel.pickVideo(S.videoIdx);
  if (!v) return;
  S.videoSize = `${v.videoWidth}×${v.videoHeight}`;
  S.videoNarrow = v.videoWidth < cfg.videoWarnWidth;
}

async function flushTurns() {
  if (!S.sid || !S.dirty.size) return;
  const rows = [];
  for (const seq of S.dirty) {
    const t = S.turns.find((x) => x.seq === seq);
    if (t) rows.push({ seq: t.seq, speaker: t.speaker, text: t.text, at: t.at, ts: t.ts });
  }
  S.dirty.clear();
  if (rows.length) {
    try {
      await chrome.runtime.sendMessage({ type: "turns:put", sid: S.sid, rows });
    } catch {
      for (const r of rows) S.dirty.add(r.seq); // retry on the next tick
    }
  }
}

function heartbeat() {
  if (!S.sid) return;
  chrome.runtime.sendMessage({
    type: "session:touch",
    sid: S.sid,
    state: S.recording ? (S.paused ? "paused" : "recording") : "ended",
    count: S.turns.length,
  }).catch(() => {});
}

/* ---------------- HUD ---------------- */

function hudState() {
  if (!S.recording) return S.phase === "call" && !cfg.autoRecord ? "waiting" : S.sid ? "ended" : "waiting";
  return S.paused ? "paused" : "recording";
}

function footText() {
  if (S.note) return S.note;
  const cc =
    S.ccStatus === "on" || S.ccStatus === "already-on" || MC.sel.captionRegion()
      ? "Phụ đề bật"
      : "Phụ đề chưa bật";
  const vid = S.videoSize ? ` · ảnh ${S.videoSize}` : "";
  const warn = S.videoNarrow ? " · mở to phần trình bày để ảnh nét hơn" : "";
  return cc + vid + warn;
}

function render() {
  const last = S.turns[S.turns.length - 1];
  MC.hud.render({
    state: hudState(),
    turns: S.turns.length,
    frames: S.frameCount,
    elapsed: mmss(S.recording ? elapsed() : S.offset),
    delta: S.lastRatio,
    threshold: cfg.minChangeRatio,
    pending: !!S.pendingSig,
    live: last ? { speaker: last.speaker, text: " " + last.text } : null,
    foot: footText(),
    footTone: S.noteTone || (S.videoNarrow ? "bad" : ""),
  });
}

function wireHud() {
  if (MC.hud._wired) return;
  MC.hud._wired = true;

  MC.hud.on("pause", async () => {
    if (!S.recording) {
      if (S.phase === "call") await beginRecording();
      return;
    }
    S.paused = !S.paused;
    if (S.paused) await flushTurns();
    heartbeat();
    render();
  });

  MC.hud.on("capture", async () => {
    if (!S.recording) return;
    try {
      const frame = await MC.frames.captureNow(S, cfg);
      await saveFrame(frame);
      MC.hud.toast(`Đã chụp ảnh #${frame.fid}`, ` ${frame.w}×${frame.h}`, { timeout: 3000 });
    } catch (e) {
      MC.hud.toast("Không chụp được", e.message === "no-video" ? " Không có video." : " Trình duyệt chặn đọc khung hình.", { tone: "bad" });
    }
    render();
  });

  MC.hud.on("copy", () => copyToClipboard());
}

/* Copy: hand a Promise to ClipboardItem WHILE the click is still being handled, to keep
   the user gesture alive. Waiting for the markdown build before calling writeText makes
   Chrome throw "Document is not focused". */
async function copyToClipboard() {
  if (!S.sid) return;
  let info = null;

  const build = (async () => {
    await flushTurns();
    const res = await chrome.runtime.sendMessage({ type: "md:build", sid: S.sid });
    if (!res || res.error) throw new Error(res?.error || "build-failed");
    info = res;
    return new Blob([res.text], { type: "text/plain" });
  })();

  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": build })]);
  } catch {
    try {
      const blob = await build;
      await navigator.clipboard.writeText(await blob.text());
    } catch (e) {
      MC.hud.toast("Không chép được", " Mở popup của tiện ích và bấm Sao chép ở đó.", { tone: "bad" });
      return;
    }
  }

  const mb = info ? (info.bytes / 1048576).toFixed(1).replace(".", ",") : "?";
  MC.hud.toast(
    "Đã chép vào clipboard",
    ` ${info?.turns ?? 0} lượt · ${info?.frames ?? 0} ảnh · ${mb} MB`
  );
  if (info && info.bytes > cfg.copyMaxBytes) {
    MC.hud.toast("Bản ghi khá lớn", ` ${mb} MB — chỗ dán có thể chậm. Cân nhắc tải file .md trong popup.`, { tone: "warn" });
  }
}

/* ---------------- the popup asking for state ---------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "live:get") {
    sendResponse({
      phase: S.phase,
      sid: S.sid,
      code: S.code,
      title: S.title,
      owner: S.owner,
      recording: S.recording,
      paused: S.paused,
      turns: S.turns.length,
      frames: S.frameCount,
      elapsedMs: S.recording ? elapsed() : S.offset,
      delta: S.lastRatio,
      threshold: cfg.minChangeRatio,
      note: footText(),
      videoSize: S.videoSize,
      videoNarrow: !!S.videoNarrow,
      captionsOn: !!MC.sel.captionRegion(),
      recent: S.turns.slice(-3).map((t) => ({ speaker: t.speaker, text: t.text, at: t.at })),
    });
    return true;
  }
  if (msg?.type === "live:pause") {
    (async () => {
      if (!S.recording) {
        if (S.phase === "call") await beginRecording();
      } else {
        S.paused = !!msg.paused;
        if (S.paused) await flushTurns();
        heartbeat();
        render();
      }
      sendResponse({ ok: true, paused: S.paused, recording: S.recording });
    })();
    return true;
  }
  if (msg?.type === "live:capture") {
    (async () => {
      try {
        const frame = await MC.frames.captureNow(S, cfg);
        await saveFrame(frame);
        render();
        sendResponse({ ok: true, fid: frame.fid, w: frame.w, h: frame.h });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }
  if (msg?.type === "live:flush") {
    flushTurns().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

/* ---------------- boot ---------------- */

window.addEventListener("pagehide", () => {
  // Best effort flush of anything unsaved. We cannot await here, but it usually lands.
  if (S.dirty.size) flushTurns();
  if (S.recording && S.sid) {
    chrome.runtime.sendMessage({ type: "session:end", sid: S.sid, count: S.turns.length }).catch(() => {});
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushTurns();
});

(async function boot() {
  // There are two injection paths: declared in the manifest, and manual from the service
  // worker. If both run, the second must bail out or every timer would be doubled.
  if (MC.booted) {
    console.log("[MeetCap] already running, skipping this injection");
    return;
  }
  MC.booted = true;

  await loadCfg();
  console.log(
    "%c[MeetCap]%c content script loaded · room:",
    "color:#e8a33d;font-weight:600", "",
    MC.sel.meetingCode() || "(none)",
    "· state:", evaluate()
  );
  if (window.navigation) {
    navigation.addEventListener("navigate", () => setTimeout(poll, 400));
  }
  setInterval(poll, 1000);
  poll();
  // Landing mid-call (a reload during a meeting) should not wait the 1.5s settle time.
  if (evaluate() === "call") {
    candidate = "call";
    candidateSince = 0;
    poll();
  }
})();
