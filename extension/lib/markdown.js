/* Build self-contained markdown: images are embedded as base64 so they survive a paste
   anywhere. Images were already encoded at capture time, so this is just string
   concatenation and runs almost instantly.
   The emitted document text is user-facing and stays in Vietnamese. */

import { mmss } from "./format.js";
import { contentDuration } from "./db.js";

function header(session, turns, frames, withImages) {
  const speakers = session.speakers?.length
    ? session.speakers
    : [...new Set(turns.map((t) => t.speaker))];
  const started = new Date(session.startedAt);
  const lines = [
    `# ${session.title || session.code}`,
    "",
    `- **Mã cuộc họp**: ${session.code}`,
    `- **Bắt đầu**: ${started.toLocaleString("vi-VN")}`,
    `- **Người nói**: ${speakers.join(", ") || "—"}`,
    `- **Số lượt nói**: ${turns.length}${withImages ? ` · **Ảnh**: ${frames.length}` : ""}`,
  ];
  const dur = contentDuration(session);
  if (dur > 0) lines.push(`- **Thời lượng**: ${mmss(dur)}`);
  if (session.segments?.length > 1) {
    lines.push(`- **Số lần vào họp**: ${session.segments.length}`);
  }
  lines.push("", "---", "");
  return lines;
}

/**
 * @param {object} session the recording
 * @param {array}  turns   [{seq, speaker, text, at}]
 * @param {array}  frames  [{fid, at, w, h, mime, b64}]
 */
export function buildMarkdown(session, turns, frames, { embedImages = true } = {}) {
  const withImages = embedImages && frames.length > 0;
  const out = header(session, turns, frames, withImages);

  const stream = [
    ...turns.map((t) => ({ kind: "turn", at: t.at, t })),
    ...(withImages ? frames.map((f) => ({ kind: "img", at: f.at, f })) : []),
  ].sort((a, b) => a.at - b.at);

  let lastSpeaker = null;
  for (const e of stream) {
    if (e.kind === "img") {
      out.push(`![Ảnh ${e.f.fid} — ${mmss(e.at)} — ${e.f.w}×${e.f.h}][img-${e.f.fid}]`, "");
      lastSpeaker = null; // an image breaks the thread; next speaker needs a fresh heading
    } else if (e.t.speaker !== lastSpeaker) {
      out.push(`## ${e.t.speaker} [${mmss(e.at)}]`, "", e.t.text, "");
      lastSpeaker = e.t.speaker;
    } else {
      out.push(e.t.text, "");
    }
  }

  if (withImages) {
    out.push(
      "",
      "<!-- ================================================================",
      "     ẢNH NHÚNG BASE64 — mọi dòng dưới đây bắt đầu bằng [img-",
      "     Bản chữ sạch:  grep -v '^\\[img-' file.md",
      "     ================================================================ -->",
      ""
    );
    for (const f of frames) out.push(`[img-${f.fid}]: data:${f.mime};base64,${f.b64}`);
    out.push("");
  }

  return out.join("\n");
}

/** Estimate the markdown size without building it — decides copy vs. download. */
export function estimateSize(session, turns, frameMetas) {
  const text = turns.reduce((a, t) => a + (t.text?.length || 0) + 40, 400);
  const img = frameMetas.reduce((a, f) => a + Math.ceil((f.size || 0) * 1.37) + 30, 0);
  return text + img;
}
