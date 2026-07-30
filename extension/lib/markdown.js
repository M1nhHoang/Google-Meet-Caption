/* Two shapes of the same document:

   buildMarkdown()        images embedded as base64 — one file, survives a paste anywhere
   buildLinkedMarkdown()  images referenced as images/anh-001.webp — for the .zip bundle

   Both walk one merged stream of turns and images, so a picture always sits between the
   same two sentences in either shape. Images were already encoded at capture time, so
   this is string concatenation and runs almost instantly.
   The emitted document text is user-facing and stays in Vietnamese. */

import { mmss } from "./format.js";
import { contentDuration } from "./db.js";

/** Folder the linked variant points at, and the folder used inside the bundle. */
export const IMAGE_DIR = "images";

const EXT = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/avif": "avif",
};

/** File name of one image inside the bundle. Zero-padded so a file listing sorts right. */
export function imageName(f) {
  const ext = EXT[f.mime] || f.mime?.split("/")[1] || "bin";
  return `anh-${String(f.fid).padStart(3, "0")}.${ext}`;
}

function header(session, turns, frames, mode) {
  const speakers = session.speakers?.length
    ? session.speakers
    : [...new Set(turns.map((t) => t.speaker))];
  const started = new Date(session.startedAt);
  const withImages = mode !== "none" && frames.length > 0;
  const lines = [
    `# ${session.title || session.code}`,
    "",
    `- **Mã cuộc họp**: ${session.code}`,
    `- **Bắt đầu**: ${started.toLocaleString("vi-VN")}`,
    `- **Người nói**: ${speakers.join(", ") || "—"}`,
    // In link mode the picture count goes on its own line below, next to the folder.
    `- **Số lượt nói**: ${turns.length}${
      withImages && mode === "embed" ? ` · **Ảnh**: ${frames.length}` : ""
    }`,
  ];
  const dur = contentDuration(session);
  if (dur > 0) lines.push(`- **Thời lượng**: ${mmss(dur)}`);
  if (session.segments?.length > 1) {
    lines.push(`- **Số lần vào họp**: ${session.segments.length}`);
  }
  if (withImages && mode === "link") {
    lines.push(
      `- **Ảnh**: ${frames.length} file trong thư mục [${IMAGE_DIR}/](${IMAGE_DIR}/), ` +
        "được tham chiếu tại đúng vị trí trong transcript"
    );
  }
  lines.push("", "---", "");
  return lines;
}

/** Turns and images in one timeline; an image breaks the thread so the next speaker
    always gets a fresh heading. `image` returns the markdown line for one picture. */
function body(turns, frames, image) {
  const out = [];
  const stream = [
    ...turns.map((t) => ({ kind: "turn", at: t.at, t })),
    ...(image ? frames.map((f) => ({ kind: "img", at: f.at, f })) : []),
  ].sort((a, b) => a.at - b.at);

  let lastSpeaker = null;
  for (const e of stream) {
    if (e.kind === "img") {
      out.push(image(e.f, e.at), "");
      lastSpeaker = null;
    } else if (e.t.speaker !== lastSpeaker) {
      out.push(`## ${e.t.speaker} [${mmss(e.at)}]`, "", e.t.text, "");
      lastSpeaker = e.t.speaker;
    } else {
      out.push(e.t.text, "");
    }
  }
  return out;
}

const caption = (f, at) => `Ảnh ${f.fid} — ${mmss(at)} — ${f.w}×${f.h}`;

/**
 * Self-contained markdown: base64 images as reference-style link definitions at the end,
 * so the readable text is not cut apart by megabyte-long data URLs.
 *
 * @param {object} session the recording
 * @param {array}  turns   [{seq, speaker, text, at}]
 * @param {array}  frames  [{fid, at, w, h, mime, b64}]
 */
export function buildMarkdown(session, turns, frames, { embedImages = true } = {}) {
  const withImages = embedImages && frames.length > 0;
  const out = header(session, turns, frames, withImages ? "embed" : "none");

  const image = withImages ? (f, at) => `![${caption(f, at)}][img-${f.fid}]` : null;
  out.push(...body(turns, frames, image));

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

/**
 * Markdown that points at the image files next to it. Only useful inside the bundle,
 * where `images/` actually exists — on its own the pictures are missing.
 */
export function buildLinkedMarkdown(session, turns, frames) {
  const withImages = frames.length > 0;
  const out = header(session, turns, frames, withImages ? "link" : "none");
  const image = withImages
    ? (f, at) => `![${caption(f, at)}](${IMAGE_DIR}/${imageName(f)})`
    : null;
  out.push(...body(turns, frames, image));
  return out.join("\n");
}

/** Estimate the markdown size without building it — decides copy vs. download. */
export function estimateSize(session, turns, frameMetas) {
  const text = turns.reduce((a, t) => a + (t.text?.length || 0) + 40, 400);
  const img = frameMetas.reduce((a, f) => a + Math.ceil((f.size || 0) * 1.37) + 30, 0);
  return text + img;
}
