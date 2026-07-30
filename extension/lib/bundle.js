/* The export bundle: one .zip with the transcript and the images as real files.

     <tiêu đề>-<mã>-<lúc>.zip
     └── <mã>-<lúc>/
         ├── <tiêu đề>-<mã>-<lúc>.md   points at images/anh-001.webp …
         └── images/
             ├── anh-001.webp
             └── …

   Everything sits inside one folder so unzipping never scatters files into the user's
   Downloads, and the relative images/ links keep working wherever that folder is moved.
   No base64 copy of the transcript in here: the paste-anywhere shape is one click away on
   the Sao chép button, and shipping the same text twice only doubles the download.

   The folder is named after the meeting code, not the title, and the document stem is
   capped: Windows still refuses paths over 260 characters, and Explorer extracts into a
   folder named after the .zip — so a long title would otherwise be paid for twice over in
   one path. Verified against Expand-Archive, which fails outright at that limit.

   Saving goes through chrome.downloads so there is no dialog, with an <a download>
   fallback for a page that cannot reach the API. */

import { getSession, getTurns, getFrames } from "./db.js";
import { buildMarkdown, buildLinkedMarkdown, imageName, IMAGE_DIR } from "./markdown.js";
import { createZip } from "./zip.js";
import { fileStamp, safeFileName } from "./format.js";

const DOC_STEM_MAX = 64; // margin for the two folder levels above the file

/** Shared stem for every exported file of one recording. */
export function exportName(session) {
  return safeFileName(
    `${session.title || session.code}-${session.code}-${fileStamp(session.startedAt)}`
  );
}

/** Folder name inside the archive — unique without carrying the title's length. */
function folderName(session) {
  return safeFileName(`${session.code}-${fileStamp(session.startedAt)}`);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Hand the frame back to the browser so a progress label actually repaints between
   images — a tight loop over 50 pictures would otherwise show nothing until it ends. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param {object}   session
 * @param {array}    turns
 * @param {array}    frames   with b64 — getFrames(), not the metadata list
 * @param {function} onProgress ({ step, done, total }) — "text" then "images"
 * @returns {Promise<{blob: Blob, name: string, files: string[]}>}
 */
export async function buildBundle(session, turns, frames, { onProgress } = {}) {
  const folder = folderName(session);
  const doc = exportName(session).slice(0, DOC_STEM_MAX);
  const zip = createZip({ modifiedAt: session.startedAt });
  const files = [];

  const add = async (path, data, opts) => {
    await zip.add(`${folder}/${path}`, data, opts);
    files.push(path);
  };

  onProgress?.({ step: "text", done: 0, total: frames.length });
  await add(`${doc}.md`, buildLinkedMarkdown(session, turns, frames));

  let done = 0;
  for (const f of frames) {
    // Already WebP or JPEG: deflating again costs time and gains nothing.
    await add(`${IMAGE_DIR}/${imageName(f)}`, b64ToBytes(f.b64), { compress: false });
    onProgress?.({ step: "images", done: ++done, total: frames.length });
    await tick();
  }

  return { blob: zip.finish(), name: `${exportName(session)}.zip`, files };
}

/**
 * Save a blob to the Downloads folder. Revokes the URL once Chrome is finished with it —
 * revoking too early cancels the download, never revoking leaks the whole archive.
 */
export async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    URL.revokeObjectURL(url);
  };

  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: false });
    const onChanged = (delta) => {
      if (delta.id !== id || delta.state?.current === "in_progress") return;
      chrome.downloads.onChanged.removeListener(onChanged);
      revoke();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      revoke();
    }, 600000);
  } catch {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(revoke, 60000);
  }
  return filename;
}

/** Build the bundle from data already in hand and save it. */
export async function saveBundle(session, turns, frames, { onProgress } = {}) {
  const { blob, name, files } = await buildBundle(session, turns, frames, { onProgress });
  await saveBlob(blob, name);
  return { name, size: blob.size, turns: turns.length, frames: frames.length, files };
}

/** Same, for a caller that only has the recording id. */
export async function downloadBundle(sid, { onProgress } = {}) {
  const session = await getSession(sid);
  if (!session) throw new Error("Không thấy bản ghi");
  const [turns, frames] = await Promise.all([getTurns(sid), getFrames(sid)]);
  return saveBundle(session, turns, frames, { onProgress });
}

/** The single self-contained .md, no folder and no zip. */
export async function saveMarkdown(session, turns, frames) {
  const text = buildMarkdown(session, turns, frames);
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  await saveBlob(blob, `${exportName(session)}.md`);
  return { name: `${exportName(session)}.md`, size: blob.size };
}

export async function downloadMarkdown(sid) {
  const session = await getSession(sid);
  if (!session) throw new Error("Không thấy bản ghi");
  const [turns, frames] = await Promise.all([getTurns(sid), getFrames(sid)]);
  return saveMarkdown(session, turns, frames);
}
