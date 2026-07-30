import { DEFAULTS, getSettings, setSettings } from "../lib/settings.js";
import {
  listSessions, deleteSession, deleteAll, usage, contentDuration,
} from "../lib/db.js";
import { downloadBundle } from "../lib/bundle.js";
import { bytes, whenLabel, mmss } from "../lib/format.js";

const $ = (id) => document.getElementById(id);

const PERCENT_KEYS = new Set(["minChangeRatio", "settleRatio"]);
const NUMBER_KEYS = new Set([
  "minChangeRatio", "settleRatio", "pixelTol", "threshold", "watchMs",
  "exportMaxSide", "exportQuality", "captureHardCap",
  "retentionDays", "maxBytes", "copyMaxBytes",
]);

let settings = null;

/* ---------------- populate the form ---------------- */

function formatOut(key, value) {
  if (PERCENT_KEYS.has(key)) return (value * 100).toFixed(1).replace(".", ",") + " %";
  if (key === "exportQuality") return value.toFixed(2).replace(".", ",");
  return String(value);
}

function fill() {
  for (const el of document.querySelectorAll("[data-key]")) {
    const key = el.dataset.key;
    const v = settings[key];
    if (el.type === "checkbox") el.checked = !!v;
    else if (el.tagName === "TEXTAREA") el.value = Array.isArray(v) ? v.join("\n") : v || "";
    else el.value = String(v);
  }
  for (const out of document.querySelectorAll("[data-out]")) {
    const key = out.dataset.out;
    out.textContent = formatOut(key, settings[key]);
  }
  updateSizeHint();
}

function readValue(el) {
  const key = el.dataset.key;
  if (el.type === "checkbox") return el.checked;
  if (el.tagName === "TEXTAREA") {
    return el.value.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  if (NUMBER_KEYS.has(key)) return Number(el.value);
  return el.value;
}

let savedTimer = null;
function flashSaved() {
  $("saved").hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($("saved").hidden = true), 1400);
}

/* chrome.storage.sync allows roughly 120 writes per minute, and dragging one slider
   fires hundreds of input events. Paint immediately, but batch the writes. */
const pendingWrites = {};
let writeTimer = null;

function queueWrite(key, value) {
  pendingWrites[key] = value;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    const patch = { ...pendingWrites };
    for (const k of Object.keys(pendingWrites)) delete pendingWrites[k];
    await setSettings(patch);
    flashSaved();
  }, 400);
}

function wireForm() {
  for (const el of document.querySelectorAll("[data-key]")) {
    const key = el.dataset.key;
    const event = el.type === "range" ? "input" : "change";
    el.addEventListener(event, () => {
      const v = readValue(el);
      settings[key] = v;
      const out = document.querySelector(`[data-out="${key}"]`);
      if (out) out.textContent = formatOut(key, v);
      updateSizeHint();
      queueWrite(key, v);
    });
  }
}

/** Show the user up front what the resolution they just picked will cost. */
function updateSizeHint() {
  const side = settings.exportMaxSide || settings.captureHardCap;
  const q = settings.exportQuality;
  // Rough estimate for slide images: ~0.08 bytes per pixel at WebP q0.9.
  const px = side * side * (9 / 16);
  const perImage = px * 0.08 * (q / 0.9) * (settings.exportFormat === "image/png" ? 6 : 1);
  $("sizeHint").textContent =
    `Ước lượng khoảng ${bytes(perImage)} mỗi ảnh — một buổi 50 ảnh vào khoảng ${bytes(perImage * 50)}. ` +
    `Ảnh nét thì bản markdown nặng theo, xem "Ngưỡng chuyển sang tải file" ở mục Dữ liệu đã lưu.`;
}

/* ---------------- stored data ---------------- */

async function renderData() {
  const sessions = await listSessions();
  const u = await usage();

  const imageBytes = sessions.reduce((a, s) => a + (s.bytes || 0), 0);
  const cap = settings.maxBytes || u.quota || 1;
  const imgPct = Math.min(100, (imageBytes / cap) * 100);
  const otherPct = Math.min(100 - imgPct, Math.max(0, ((u.used - imageBytes) / cap) * 100));

  $("usageBar").innerHTML = "";
  const add = (w, color) => {
    const i = document.createElement("i");
    i.style.width = w + "%";
    i.style.background = color;
    $("usageBar").append(i);
  };
  add(imgPct, "var(--teal)");
  add(otherPct, "var(--amber-bright)");
  add(Math.max(0, 100 - imgPct - otherPct), "var(--surface-3)");

  $("usageKey").innerHTML = "";
  const key = (color, label) => {
    const s = document.createElement("span");
    const u2 = document.createElement("u");
    u2.style.background = color;
    s.append(u2, document.createTextNode(label));
    $("usageKey").append(s);
  };
  key("var(--teal)", `Ảnh · ${bytes(imageBytes)}`);
  key("var(--amber-bright)", `Chữ và dữ liệu khác · ${bytes(Math.max(0, u.used - imageBytes))}`);
  key("var(--surface-3)", `Còn lại trong hạn ${bytes(cap)}`);

  const tbody = $("recTable");
  tbody.innerHTML = "";
  if (!sessions.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.className = "m";
    td.textContent = "Chưa có bản ghi nào.";
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const s of sessions) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    const b = document.createElement("a");
    b.className = "recname";
    b.href = chrome.runtime.getURL(`preview/preview.html?sid=${encodeURIComponent(s.id)}`);
    b.target = "_blank";
    b.rel = "noopener";
    b.textContent = s.title || s.code;
    b.title = "Mở trang xem trước";
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = s.code + (s.framesPruned ? " · ảnh đã dọn" : "");
    tdName.append(b, sub);

    const cells = [
      whenLabel(s.startedAt),
      mmss(contentDuration(s)),
      String(s.turnCount || 0),
      String(s.frameCount || 0),
      bytes(s.bytes || 0),
    ].map((v) => {
      const td = document.createElement("td");
      td.className = "m";
      td.textContent = v;
      return td;
    });

    const tdAct = document.createElement("td");
    const zip = document.createElement("button");
    zip.className = "iconbtn wide";
    zip.textContent = "zip";
    zip.title = "Tải .zip — markdown kèm thư mục ảnh";
    zip.setAttribute("aria-label", `Tải bản ghi ${s.code} dạng zip`);
    zip.addEventListener("click", () => zipRow(s, zip));

    const del = document.createElement("button");
    del.className = "iconbtn danger";
    del.textContent = "✕";
    del.title = "Xoá bản ghi";
    del.setAttribute("aria-label", `Xoá bản ghi ${s.code}`);
    del.addEventListener("click", () => askDeleteRow(s, tr));

    const acts = document.createElement("div");
    acts.className = "acts";
    acts.append(zip, del);
    tdAct.append(acts);

    tr.append(tdName, ...cells, tdAct);
    tbody.append(tr);
  }
}

/* Packing counts the images off on the button itself — the table has nowhere else to
   put progress, and a big recording takes a few seconds. */
async function zipRow(s, btn) {
  btn.disabled = true;
  const old = { text: btn.textContent, title: btn.title };
  btn.textContent = "…";
  try {
    await downloadBundle(s.id, {
      onProgress: ({ step, done, total }) => {
        if (step === "images" && total) btn.textContent = `${done}/${total}`;
      },
    });
    btn.textContent = "✓";
  } catch (e) {
    btn.textContent = "!";
    btn.title = "Không tải được .zip: " + (e.message || e);
  } finally {
    setTimeout(() => {
      btn.textContent = old.text;
      btn.title = old.title;
      btn.disabled = false;
    }, 2500);
  }
}

function askDeleteRow(s, tr) {
  const holder = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 7;
  const box = document.createElement("div");
  box.className = "confirm";
  const b = document.createElement("b");
  b.textContent = `Xoá bản ghi ${s.code}?`;
  const p = document.createElement("p");
  p.textContent =
    `${s.title || s.code} · ${s.turnCount || 0} lượt nói · ${s.frameCount || 0} ảnh · ${bytes(s.bytes || 0)}. ` +
    "Không khôi phục lại được.";
  const row = document.createElement("div");
  row.className = "btnrow";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Huỷ";
  cancel.addEventListener("click", () => holder.replaceWith(tr));
  const ok = document.createElement("button");
  ok.className = "btn solid-danger";
  ok.textContent = "Xoá bản ghi";
  ok.addEventListener("click", async () => {
    await deleteSession(s.id);
    await renderData();
  });
  row.append(cancel, ok);
  box.append(b, p, row);
  td.append(box);
  holder.append(td);
  tr.replaceWith(holder);
}

function askClearAll() {
  const holder = $("clearConfirm");
  if (holder.firstChild) { holder.innerHTML = ""; return; }
  listSessions().then((sessions) => {
    const total = sessions.reduce((a, s) => a + (s.bytes || 0), 0);
    const box = document.createElement("div");
    box.className = "confirm";
    const b = document.createElement("b");
    b.textContent = "Xoá tất cả bản ghi?";
    const p = document.createElement("p");
    p.textContent = `${sessions.length} bản ghi · ${bytes(total)}. Không khôi phục lại được.`;
    const row = document.createElement("div");
    row.className = "btnrow";
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.textContent = "Huỷ";
    cancel.addEventListener("click", () => (holder.innerHTML = ""));
    const ok = document.createElement("button");
    ok.className = "btn solid-danger";
    ok.textContent = "Xoá tất cả";
    ok.addEventListener("click", async () => {
      await deleteAll();
      holder.innerHTML = "";
      await renderData();
    });
    row.append(cancel, ok);
    box.append(b, p, row);
    holder.append(box);
  });
}

/* ---------------- nav highlighting ---------------- */

function wireNav() {
  const links = [...document.querySelectorAll(".opt-nav a")];
  const sections = links.map((a) => document.querySelector(a.getAttribute("href")));
  const obs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const i = sections.indexOf(e.target);
        links.forEach((a, j) => a.classList.toggle("cur", j === i));
      }
    },
    { rootMargin: "-20% 0px -70% 0px" }
  );
  sections.forEach((s) => s && obs.observe(s));
}

/* ---------------- boot ---------------- */

(async function init() {
  settings = { ...DEFAULTS, ...(await getSettings()) };
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  fill();
  wireForm();
  wireNav();
  await renderData();
  $("btnRefresh").addEventListener("click", renderData);
  $("btnClearAll").addEventListener("click", askClearAll);
})();
