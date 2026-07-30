import { getSession, getTurns, getFrames, contentDuration } from "../lib/db.js";
import { buildMarkdown } from "../lib/markdown.js";
import { saveBundle, saveMarkdown } from "../lib/bundle.js";
import { mmss, bytes, whenLabel } from "../lib/format.js";
import { getSettings } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);
const sid = new URLSearchParams(location.search).get("sid");

let session = null, turns = [], frames = [];

async function init() {
  if (!sid) return fail("Thiếu mã bản ghi trong địa chỉ.");
  session = await getSession(sid);
  if (!session) return fail("Không thấy bản ghi này. Có thể nó đã bị xoá.");

  [turns, frames] = await Promise.all([getTurns(sid), getFrames(sid)]);

  document.title = `${session.title || session.code} — MeetCap`;
  $("title").textContent = session.title || session.code;
  $("meta").textContent = [
    session.code,
    whenLabel(session.startedAt),
    mmss(contentDuration(session)),
    `${turns.length} lượt nói`,
    `${frames.length} ảnh`,
    bytes(session.bytes || 0),
  ].join("  ·  ");

  render();
  $("btnCopy").addEventListener("click", copy);
  $("btnDownload").addEventListener("click", download);
  $("btnZip").addEventListener("click", downloadZip);
}

function fail(msg) {
  $("title").textContent = "Không mở được";
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = msg;
  $("body").append(p);
  $("btnCopy").disabled = true;
  $("btnDownload").disabled = true;
  $("btnZip").disabled = true;
}

async function render() {
  const settings = await getSettings();
  const box = $("body");
  box.innerHTML = "";

  if (!turns.length && !frames.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Bản ghi này chưa có gì. Phụ đề có thể chưa được bật trong lúc họp.";
    box.append(p);
    return;
  }

  const stream = [
    ...turns.map((t) => ({ kind: "turn", at: t.at, t })),
    ...frames.map((f) => ({ kind: "img", at: f.at, f })),
  ].sort((a, b) => a.at - b.at);

  let lastSpeaker = null;
  let current = null;

  for (const e of stream) {
    if (e.kind === "img") {
      box.append(figureFor(e.f, settings));
      lastSpeaker = null;
      current = null;
      continue;
    }
    if (e.t.speaker !== lastSpeaker) {
      current = document.createElement("div");
      current.className = "turn";
      const who = document.createElement("div");
      who.className = "who";
      const b = document.createElement("b");
      b.textContent = e.t.speaker;
      const when = document.createElement("span");
      when.textContent = mmss(e.at);
      who.append(b, when);
      current.append(who);
      box.append(current);
      lastSpeaker = e.t.speaker;
    }
    const p = document.createElement("p");
    p.textContent = e.t.text;
    current.append(p);
  }
}

function figureFor(f, settings) {
  const fig = document.createElement("figure");
  const img = document.createElement("img");
  img.src = `data:${f.mime};base64,${f.b64}`;
  img.alt = `Ảnh ${f.fid} lúc ${mmss(f.at)}`;
  img.loading = "lazy";

  const cap = document.createElement("figcaption");
  const parts = [`#${f.fid}`, mmss(f.at), `${f.w}×${f.h}`, bytes(f.size || 0)];
  cap.append(document.createTextNode(parts.join("  ·  ")));

  if (f.w < settings.videoWarnWidth) {
    const warn = document.createElement("span");
    warn.className = "low";
    warn.textContent = "luồng video hẹp — ghim hoặc mở to phần trình bày để ảnh nét hơn";
    cap.append(warn);
  }

  const open = document.createElement("a");
  open.href = img.src;
  open.target = "_blank";
  open.rel = "noopener";
  open.textContent = "Mở ảnh gốc";
  cap.append(open);

  fig.append(img, cap);
  return fig;
}

async function copy() {
  const btn = $("btnCopy");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Đang dựng…";
  const build = (async () => {
    const text = buildMarkdown(session, turns, frames);
    return new Blob([text], { type: "text/plain" });
  })();
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": build })]);
    const blob = await build;
    btn.textContent = `✓ Đã chép ${bytes(blob.size)}`;
  } catch {
    try {
      const blob = await build;
      await navigator.clipboard.writeText(await blob.text());
      btn.textContent = `✓ Đã chép ${bytes(blob.size)}`;
    } catch {
      btn.textContent = "Không chép được";
    }
  } finally {
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 3000);
  }
}

async function download() {
  await saveMarkdown(session, turns, frames);
}

/* The .zip: the same transcript twice — one file linking images/, one with the pictures
   embedded — plus the images as real files. Packing decodes every image out of base64,
   so the button counts them off. */
async function downloadZip() {
  const btn = $("btnZip");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Đang gói…";
  try {
    const res = await saveBundle(session, turns, frames, {
      onProgress: ({ step, done, total }) => {
        if (step === "images" && total) btn.textContent = `Đang gói ảnh ${done}/${total}`;
      },
    });
    btn.textContent = `✓ ${bytes(res.size)}`;
  } catch (e) {
    btn.textContent = "Không tải được";
    console.warn("[MeetCap] zip failed", e);
  } finally {
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 3000);
  }
}

init();
