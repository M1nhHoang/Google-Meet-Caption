/* Capture images on real change — the three filter stages from idea.js v7:
     1. Area gate   — 32x18 greyscale signature; below minChangeRatio it is skipped
                      (mouse pointer, blinking caret, a clock).
     2. Settle wait — over the threshold, wait for the next tick and only capture once
                      the frame has stopped moving.
     3. dHash 64bit — compared against EVERY image in the recording, so returning to an
                      earlier slide does not store a duplicate.
   Unlike the script, images are encoded at final size at capture time, so copying later
   never has to wait. */

/* var, not const: content scripts share one global scope, like sibling <script>
   tags. A second `const MC` would throw "Identifier MC has already been declared"
   and block every file listed after it. */
var MC = (window.__MC ||= {});

const GW = 32, GH = 18;

const mk = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
};

const sc = mk(GW, GH), sctx = sc.getContext("2d", { willReadFrequently: true });
const hc = mk(9, 8), hctx = hc.getContext("2d", { willReadFrequently: true });
const fc = mk(1, 1), fctx = fc.getContext("2d");

function supports(fmt) {
  const c = mk(1, 1);
  return c.toDataURL(fmt).startsWith("data:" + fmt);
}

function signature(video) {
  sctx.drawImage(video, 0, 0, GW, GH);
  const d = sctx.getImageData(0, 0, GW, GH).data;
  const g = new Uint8Array(GW * GH);
  for (let i = 0; i < g.length; i++) {
    g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) | 0;
  }
  return g;
}

function changeRatio(a, b, pixelTol) {
  if (!a || !b) return 1;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > pixelTol) n++;
  return n / a.length;
}

function dhash(video) {
  hctx.drawImage(video, 0, 0, 9, 8);
  const d = hctx.getImageData(0, 0, 9, 8).data;
  const g = new Float32Array(72);
  for (let i = 0; i < 72; i++) {
    g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += g[y * 9 + x] < g[y * 9 + x + 1] ? "1" : "0";
  }
  return bits;
}

const hamming = (a, b) => {
  let n = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) n++;
  return n;
};

const blobToB64 = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

async function encode(video, cfg) {
  const mime = supports(cfg.exportFormat) ? cfg.exportFormat : "image/jpeg";
  // exportMaxSide = 0 means keep the stream's native resolution; the hard cap still
  // applies so a 4K screen does not produce multi-megabyte stills.
  const cap = cfg.exportMaxSide > 0
    ? Math.min(cfg.exportMaxSide, cfg.captureHardCap)
    : cfg.captureHardCap;
  const scale = Math.min(1, cap / Math.max(video.videoWidth, video.videoHeight));
  fc.width = Math.max(1, Math.round(video.videoWidth * scale));
  fc.height = Math.max(1, Math.round(video.videoHeight * scale));
  fctx.imageSmoothingQuality = "high";
  fctx.drawImage(video, 0, 0, fc.width, fc.height);
  const blob = await new Promise((r) => fc.toBlob(r, mime, cfg.exportQuality));
  if (!blob) return null;
  return { mime, w: fc.width, h: fc.height, size: blob.size, b64: await blobToB64(blob) };
}

MC.frames = {
  signature,
  changeRatio,
  dhash,

  isDuplicate(S, hash, threshold) {
    return S.frameHashes.some((h) => hamming(h, hash) <= threshold);
  },

  /** Forced capture that bypasses every filter. Used by the "Chụp ngay" button. */
  async captureNow(S, cfg) {
    const video = MC.sel.pickVideo(S.videoIdx);
    if (!video || !video.videoWidth) throw new Error("no-video");
    const enc = await encode(video, cfg);
    if (!enc) throw new Error("canvas-blocked");
    S.storedSig = signature(video);
    S.pendingSig = null;
    const hash = dhash(video);
    S.frameHashes.push(hash);
    const ts = Date.now();
    return { fid: S.nextFid++, hash, ts, at: MC.contentAt(ts), ...enc };
  },

  /**
   * One watch tick. Returns a frame when it decides to store one, null when filtered.
   * Throws when there is no video or the canvas is blocked.
   */
  async tick(S, cfg) {
    const video = MC.sel.pickVideo(S.videoIdx);
    if (!video || !video.videoWidth) throw new Error("no-video");

    const sig = signature(video);
    S.lastRatio = changeRatio(S.storedSig, sig, cfg.pixelTol);

    // First image of the session: capture right away to establish a baseline.
    if (!S.storedSig) {
      const hash = dhash(video);
      S.storedSig = sig;
      if (this.isDuplicate(S, hash, cfg.threshold)) return null;
      const enc = await encode(video, cfg);
      if (!enc) throw new Error("canvas-blocked");
      S.frameHashes.push(hash);
      const ts = Date.now();
      return { fid: S.nextFid++, hash, ts, at: MC.contentAt(ts), ...enc };
    }

    // Stage 1 — too little changed, skip.
    if (S.lastRatio < cfg.minChangeRatio) {
      if (S.pendingSig) S.skipped++;
      S.pendingSig = null;
      return null;
    }

    // Stage 2 — a real change; wait for the frame to settle before capturing.
    if (!S.pendingSig || changeRatio(S.pendingSig, sig, cfg.pixelTol) >= cfg.settleRatio) {
      S.pendingSig = sig;
      return null;
    }

    // Stage 3 — an earlier slide came back, do not store a duplicate.
    const hash = dhash(video);
    if (this.isDuplicate(S, hash, cfg.threshold)) {
      S.storedSig = sig;
      S.pendingSig = null;
      S.skipped++;
      return null;
    }

    const enc = await encode(video, cfg);
    if (!enc) throw new Error("canvas-blocked");
    S.storedSig = sig;
    S.pendingSig = null;
    S.frameHashes.push(hash);
    const ts = Date.now();
    return { fid: S.nextFid++, hash, ts, at: MC.contentAt(ts), ...enc };
  },
};
