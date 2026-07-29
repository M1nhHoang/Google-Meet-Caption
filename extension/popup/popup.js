import {
  listSessions, getSession, getTurns, getFrames,
  deleteSession, renameSession, contentDuration,
} from "../lib/db.js";
import { buildMarkdown } from "../lib/markdown.js";
import { getSettings } from "../lib/settings.js";
import { mmss, bytes, whenLabel, fileStamp, safeFileName } from "../lib/format.js";

const $ = (id) => document.getElementById(id);

const state = {
  tab: null,
  live: null,        // state from the content script, null when there is none
  sessions: [],
  settings: null,
  activeTab: "live",
  busy: new Set(),
  injectError: null, // the real injection error, shown to the user verbatim
};

/* ---------------- boot ---------------- */

async function init() {
  state.settings = await getSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;
  state.live = await askLive({ tryInject: true });
  state.sessions = await listSessions();

  wire();
  renderAll();
  setInterval(tickLive, 1000);
}

const onMeetTab = () => !!state.tab?.url?.startsWith("https://meet.google.com/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping() {
  try {
    return await chrome.tabs.sendMessage(state.tab.id, { type: "live:get" });
  } catch {
    return null;
  }
}

/**
 * Being on a Meet tab with nobody answering means the content script never loaded: the
 * tab predates the install, the extension was just reloaded, or site access is set to
 * "on click". Ask the service worker to re-inject and try once more — and if that still
 * fails, keep the real error so we can show it instead of guessing for the user.
 */
async function askLive({ tryInject = false } = {}) {
  if (!onMeetTab()) return null;

  const first = await ping();
  if (first) return first;
  if (!tryInject) return { unreachable: true, error: state.injectError };

  const res = await chrome.runtime.sendMessage({ type: "inject:ensure", tabId: state.tab.id });
  state.injectError = res?.ok ? null : (res?.error || "không rõ lý do");
  if (res?.ok) {
    await sleep(400);
    const second = await ping();
    if (second) return second;
  }
  return { unreachable: true, error: state.injectError };
}

async function tickLive() {
  const next = await askLive();
  const wasRecording = state.live?.recording;
  state.live = next;
  if (state.activeTab === "live") renderLivePane();
  if (wasRecording && !next?.recording) {
    state.sessions = await listSessions();
    renderHistory();
  }
}

function wire() {
  for (const t of document.querySelectorAll(".ptab")) {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  }
  $("btnSettings1").addEventListener("click", openOptions);
  $("footRight").addEventListener("click", (e) => { e.preventDefault(); openOptions(); });
  $("btnOpenMeet").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://meet.google.com/" });
    window.close();
  });
  $("btnReloadTab").addEventListener("click", async () => {
    if (!state.tab) return;
    const btn = $("btnReloadTab");
    btn.disabled = true;
    btn.textContent = "Đang nối…";
    state.live = await askLive({ tryInject: true });
    if (state.live?.unreachable) {
      // If manual injection also fails, reloading the page is the last resort.
      await chrome.tabs.reload(state.tab.id);
      window.close();
      return;
    }
    btn.disabled = false;
    btn.textContent = "Kết nối lại";
    renderLivePane();
  });

  $("btnCapture").addEventListener("click", captureNow);
  $("btnPause").addEventListener("click", togglePause);
  $("btnCopyLive").addEventListener("click", () => {
    const sid = currentSid();
    if (sid) copyFromButton(sid, $("btnCopyLive"));
  });
  $("btnDownloadLive").addEventListener("click", () => downloadRecord(currentSid()));
}

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}

function switchTab(name) {
  state.activeTab = name;
  for (const t of document.querySelectorAll(".ptab")) {
    const on = t.dataset.tab === name;
    t.classList.toggle("cur", on);
    t.setAttribute("aria-selected", String(on));
  }
  $("paneLive").hidden = name !== "live";
  $("paneHist").hidden = name !== "hist";
}

function currentSid() {
  return state.live?.sid || latestSession()?.id || null;
}

function latestSession() {
  return state.sessions[0] || null;
}

/* ---------------- rendering ---------------- */

function renderAll() {
  renderLivePane();
  renderHistory();
  renderFoot();
}

function renderLivePane() {
  const live = state.live;
  const recording = !!live?.recording;
  const inCall = live?.phase === "call";

  $("code").textContent = live?.code || "";

  const pill = $("statePill");
  if (recording && live.paused) { pill.className = "pill pause"; pill.textContent = "Tạm dừng"; }
  else if (recording) { pill.className = "pill rec"; pill.innerHTML = '<span class="dot blink"></span>Đang ghi'; }
  else if (live?.unreachable) { pill.className = "pill pause"; pill.textContent = "Chưa nối"; }
  else if (live) { pill.className = "pill wait"; pill.textContent = "Sẵn sàng"; }
  else { pill.className = "pill"; pill.textContent = "Nghỉ"; }

  // This tab has exactly two states: waiting, or recording. A finished recording
  // belongs to the History tab; do not duplicate it here.
  $("viewWaiting").hidden = recording;
  $("viewLive").hidden = !recording;

  if (recording) renderRecording(live);
  else renderWaiting();
}

function renderWaiting() {
  const onMeet = onMeetTab();
  const unreachable = !!state.live?.unreachable;

  $("btnOpenMeet").hidden = onMeet;
  $("btnReloadTab").hidden = !unreachable;

  if (unreachable) {
    $("waitTitle").textContent = "Chưa nối được với trang Meet";
    const err = state.live?.error;
    $("waitBody").textContent = err
      ? `Chrome không cho chèn script vào tab này: ${err}. ` +
        "Kiểm tra chrome://extensions → MeetCap → Chi tiết → Quyền truy cập trang web, " +
        "đặt thành “Trên tất cả trang web” hoặc “Trên meet.google.com”."
      : "Bấm Kết nối lại. Nếu vẫn không được, trang sẽ được tải lại.";
  } else {
    $("waitTitle").textContent = onMeet ? "Đang chờ bạn vào họp" : "Đang chờ cuộc họp";
    $("waitBody").textContent = onMeet
      ? "Bấm “Tham gia ngay” trên Meet, tiện ích sẽ tự chạy. Không cần mở lại cửa sổ này."
      : "Vào một cuộc họp Google Meet là tiện ích tự ghi. Bản ghi cũ vẫn còn nguyên trong máy.";
  }

  // With no connection, the settings checklist tells the user nothing useful.
  $("checklist").hidden = unreachable;
  if (unreachable) return;

  const s = state.settings;
  const rows = [
    [s.autoRecord, "Tự ghi khi vào họp"],
    [s.autoCaption, "Tự bật phụ đề"],
    [s.captureEnabled, "Tự chụp khi hình đổi", `ngưỡng ${(s.minChangeRatio * 100).toFixed(1).replace(".", ",")}%`],
    [s.keepCaptionOn, "Giữ phụ đề luôn bật"],
  ];
  $("checklist").innerHTML = "";
  for (const [on, label, extra] of rows) {
    const d = document.createElement("span");
    d.className = "ck";
    const i = document.createElement("i");
    i.className = on ? "" : "off";
    i.textContent = on ? "✓" : "○";
    d.append(i, document.createTextNode(label));
    if (extra) {
      const em = document.createElement("em");
      em.textContent = " — " + extra;
      d.append(em);
    }
    $("checklist").append(d);
  }
}

function renderRecording(live) {
  $("lvTurns").textContent = live.turns;
  $("lvFrames").textContent = live.frames;
  $("lvElapsed").textContent = mmss(live.elapsedMs || 0);

  const thr = live.threshold || 0;
  $("lvMeterLabel").textContent = `Δ khung hình · ngưỡng ${(thr * 100).toFixed(1).replace(".", ",")}%`;
  $("lvDelta").textContent = ((live.delta || 0) * 100).toFixed(1).replace(".", ",") + " %";
  $("lvFill").style.width = Math.min(100, (live.delta || 0) * 1000) + "%";
  $("lvFill").className = "pmeter-fill" + ((live.delta || 0) >= thr ? " hot" : "");
  $("lvThresh").style.left = Math.min(100, thr * 1000) + "%";

  const note = $("lvNote");
  note.textContent = live.note || "";
  note.className = "hint" + (live.videoNarrow || /chặn|giảm nhịp|chưa bật/i.test(live.note || "") ? " warn" : "");

  $("btnPause").textContent = live.paused ? "Ghi tiếp" : "Tạm dừng";
  $("btnCapture").disabled = live.paused;

  const box = $("lvRecent");
  box.innerHTML = "";
  for (const t of live.recent || []) {
    const row = document.createElement("div");
    row.className = "tline";
    const tt = document.createElement("span");
    tt.className = "tt";
    tt.textContent = mmss(t.at);
    const tx = document.createElement("span");
    tx.className = "tx";
    const b = document.createElement("b");
    b.textContent = t.speaker;
    tx.append(b, document.createTextNode(" " + t.text));
    row.append(tt, tx);
    box.append(row);
  }
}

function renderFoot() {
  const total = state.sessions.reduce((a, s) => a + (s.bytes || 0), 0);
  $("footLeft").textContent = state.sessions.length
    ? `${state.sessions.length} bản ghi · ${bytes(total)}`
    : "Chưa có bản ghi";
  document.querySelector('[data-tab="hist"]').textContent =
    state.sessions.length ? `Lịch sử · ${state.sessions.length}` : "Lịch sử";
}

/* ---------------- history ---------------- */

function renderHistory() {
  const box = $("histList");
  box.innerHTML = "";
  renderFoot();

  if (!state.sessions.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Chưa có bản ghi nào. Vào một cuộc họp là tiện ích tự lưu.";
    box.append(p);
    return;
  }

  for (const s of state.sessions) box.append(historyRow(s));
}

function historyRow(s) {
  const isLive = state.live?.recording && state.live.sid === s.id;

  const row = document.createElement("div");
  row.className = "hrow" + (isLive ? " live" : "");
  row.tabIndex = 0;
  row.dataset.sid = s.id;
  row.setAttribute("role", "button");
  row.title = "Bấm để chép markdown";

  const main = document.createElement("div");
  main.className = "hmain";

  const code = document.createElement("span");
  code.className = "hcode";
  if (isLive) {
    const d = document.createElement("span");
    d.className = "dot blink";
    code.append(d);
  }
  code.append(document.createTextNode(s.code));

  const title = document.createElement("span");
  title.className = "htitle";
  title.textContent = s.title || s.code;

  const meta = document.createElement("span");
  meta.className = "hmeta";
  const parts = [
    whenLabel(s.startedAt),
    isLive ? `đang ghi ${mmss(contentDuration(s))}` : mmss(contentDuration(s)),
    `${s.turnCount || 0} lượt`,
    `${s.frameCount || 0} ảnh`,
    bytes(s.bytes || 0),
  ];
  meta.textContent = parts.join(" · ");
  if (s.framesPruned) meta.textContent += " · ảnh đã dọn";

  const status = document.createElement("span");
  status.className = "hstatus";

  main.append(code, title, meta, status);

  const acts = document.createElement("div");
  acts.className = "hacts";
  acts.append(
    iconButton("⧉", "Sao chép markdown", (e) => { e.stopPropagation(); copyRecord(s.id, row); }),
    iconButton("✎", "Sửa tên", (e) => { e.stopPropagation(); startRename(s, row, title); }),
    iconButton("✕", "Xoá bản ghi", (e) => { e.stopPropagation(); askDelete(s, row); }, "danger")
  );

  row.append(main, acts);
  row.addEventListener("click", () => copyRecord(s.id, row));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyRecord(s.id, row); }
  });
  return row;
}

function iconButton(glyph, title, fn, extra = "") {
  const b = document.createElement("button");
  b.className = "iconbtn" + (extra ? " " + extra : "");
  b.textContent = glyph;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", fn);
  return b;
}

/* ---------------- copy ---------------- */

/**
 * Click to copy. Hand a Promise to ClipboardItem WHILE the click is still being handled,
 * to keep the user gesture alive — waiting for the markdown build to finish before
 * calling writeText makes Chrome throw "Document is not focused".
 */
async function copyRecord(sid, rowEl) {
  if (!sid || state.busy.has(sid)) return;
  state.busy.add(sid);

  const status = rowEl?.querySelector(".hstatus");
  const setStatus = (html, cls) => {
    if (!status) return;
    status.className = "hstatus " + (cls || "");
    status.innerHTML = html;
  };

  try {
    const session = await getSession(sid);
    if (!session) throw new Error("Không thấy bản ghi");

    // Sharp images are heavy, and pasting an oversized base64 string freezes the target.
    // Base64 inflates image bytes by roughly 37%, plus the text.
    const est = (session.turnCount || 0) * 120 + Math.ceil((session.bytes || 0) * 1.37) + 600;
    if (est > state.settings.copyMaxBytes) {
      setStatus(
        `Bản ghi ${bytes(est)} quá lớn để chép — đang tải file .md`,
        "hfail"
      );
      await downloadRecord(sid);
      return;
    }

    setStatus('<span class="bar"><i style="width:35%"></i></span>Đang dựng markdown…', "hprog");

    let info = null;
    const build = (async () => {
      const [turns, frames] = await Promise.all([getTurns(sid), getFrames(sid)]);
      const text = buildMarkdown(session, turns, frames);
      info = { turns: turns.length, frames: frames.length, bytes: text.length };
      return new Blob([text], { type: "text/plain" });
    })();

    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": build })]);
    } catch {
      const blob = await build;
      await navigator.clipboard.writeText(await blob.text());
    }

    rowEl?.classList.add("hot");
    setStatus(
      `✓ Đã chép ${info.turns} lượt · ${info.frames} ảnh · ${bytes(info.bytes)}`,
      "hdone"
    );
    setTimeout(() => {
      rowEl?.classList.remove("hot");
      setStatus("", "");
    }, 3500);
  } catch (e) {
    setStatus("Không chép được: " + (e.message || e), "hfail");
  } finally {
    state.busy.delete(sid);
  }
}

/* The copy button on the current-meeting tab has no row to show progress in, so it
   reports progress on its own label. */
async function copyFromButton(sid, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Đang dựng…";
  try {
    const session = await getSession(sid);
    if (!session) throw new Error("no-session");
    let info = null;
    const build = (async () => {
      await flushLive();
      const [turns, frames] = await Promise.all([getTurns(sid), getFrames(sid)]);
      const text = buildMarkdown(session, turns, frames);
      info = { turns: turns.length, frames: frames.length, bytes: text.length };
      return new Blob([text], { type: "text/plain" });
    })();
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": build })]);
    } catch {
      const blob = await build;
      await navigator.clipboard.writeText(await blob.text());
    }
    btn.textContent = `✓ ${info.turns} lượt · ${bytes(info.bytes)}`;
  } catch {
    btn.textContent = "Không chép được";
  } finally {
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 3000);
  }
}

async function flushLive() {
  if (!state.live?.recording || !state.tab) return;
  try {
    await chrome.tabs.sendMessage(state.tab.id, { type: "live:flush" });
  } catch { /* tab is gone */ }
}

/* ---------------- download & preview ---------------- */

async function downloadRecord(sid) {
  if (!sid) return;
  await flushLive();
  const session = await getSession(sid);
  if (!session) return;
  const [turns, frames] = await Promise.all([getTurns(sid), getFrames(sid)]);
  const text = buildMarkdown(session, turns, frames);
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const name = safeFileName(`${session.title || session.code}-${session.code}-${fileStamp(session.startedAt)}`);
  try {
    await chrome.downloads.download({ url, filename: `${name}.md`, saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

/* ---------------- rename ---------------- */

function startRename(s, row, titleEl) {
  if (row.querySelector(".rename")) return;
  const box = document.createElement("div");
  box.className = "rename";
  const input = document.createElement("input");
  input.value = s.title || s.code;
  input.maxLength = 120;
  const ok = iconButton("✓", "Lưu tên", async (e) => {
    e.stopPropagation();
    await commit();
  });
  box.append(input, ok);
  titleEl.replaceWith(box);
  input.focus();
  input.select();

  const commit = async () => {
    const v = input.value.trim();
    if (v && v !== s.title) {
      await renameSession(s.id, v);
      s.title = v;
    }
    titleEl.textContent = s.title || s.code;
    box.replaceWith(titleEl);
  };

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { titleEl.textContent = s.title || s.code; box.replaceWith(titleEl); }
  });
}

/* ---------------- delete ---------------- */

function deleteConfirmBox(s, onCancel, onConfirm) {
  const box = document.createElement("div");
  box.className = "confirm";

  const b = document.createElement("b");
  b.textContent = "Xoá bản ghi này?";

  const meta = document.createElement("span");
  meta.className = "cmeta";
  meta.textContent = `${s.code} · ${s.title || s.code}`;
  const meta2 = document.createElement("span");
  meta2.className = "cmeta";
  meta2.textContent = `${s.turnCount || 0} lượt nói · ${s.frameCount || 0} ảnh · ${bytes(s.bytes || 0)}`;

  const p = document.createElement("p");
  p.textContent = "Không khôi phục lại được. Nếu cần giữ, hãy chép hoặc tải file trước.";

  const row = document.createElement("div");
  row.className = "btnrow";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Huỷ";
  cancel.addEventListener("click", (e) => { e.stopPropagation(); onCancel(); });
  const del = document.createElement("button");
  del.className = "btn solid-danger";
  del.textContent = "Xoá bản ghi";
  del.addEventListener("click", async (e) => { e.stopPropagation(); await onConfirm(); });
  row.append(cancel, del);

  box.append(b, meta, meta2, p, row);
  box.addEventListener("click", (e) => e.stopPropagation());
  return box;
}

function askDelete(s, row) {
  const box = deleteConfirmBox(
    s,
    () => box.replaceWith(row),
    async () => {
      await deleteSession(s.id);
      state.sessions = await listSessions();
      renderHistory();
      renderLivePane();
    }
  );
  row.replaceWith(box);
}

/* ---------------- controlling the in-call tab ---------------- */

async function togglePause() {
  if (!state.tab) return;
  try {
    const res = await chrome.tabs.sendMessage(state.tab.id, {
      type: "live:pause",
      paused: !state.live?.paused,
    });
    if (res) state.live = { ...state.live, paused: res.paused, recording: res.recording };
    renderLivePane();
  } catch { /* tab is gone */ }
}

async function captureNow() {
  if (!state.tab) return;
  const btn = $("btnCapture");
  const old = btn.textContent;
  btn.disabled = true;
  try {
    const res = await chrome.tabs.sendMessage(state.tab.id, { type: "live:capture" });
    btn.textContent = res?.error ? "Không chụp được" : `✓ Ảnh #${res.fid}`;
    state.sessions = await listSessions();
  } catch {
    btn.textContent = "Không chụp được";
  } finally {
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2000);
  }
}

init();
