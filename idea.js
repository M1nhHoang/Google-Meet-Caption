/* Google Meet Caption Recorder v7 — phụ đề + ảnh chụp theo mức thay đổi thật
 *
 * Cơ chế chụp (3 tầng, chạy mỗi giây):
 *   1. Cổng diện tích  — signature 32×18 xám, tính % ô đổi so với ảnh đã lưu gần nhất.
 *                        Dưới minChangeRatio (chuột, caret nhấp nháy, đồng hồ) -> bỏ qua.
 *   2. Chờ ổn định     — Δ vượt ngưỡng thì đợi nhịp sau; chỉ chụp khi frame đã đứng yên,
 *                        tránh bắt frame giữa lúc slide fade / trang scroll dở.
 *   3. dHash 64-bit    — so với TẤT CẢ ảnh đã lưu, để quay lại slide cũ không lưu bản sao.
 *
 * Ảnh xuất: cạnh dài 512px, WebP q0.82. Ảnh gốc giữ 1280px trong RAM để xuất lại được lớn hơn.
 *
 * Dán vào Console khi đang họp và ĐÃ bật CC.
 * API: __meetCap.debug() .tune() .preview() .previewExport() .copy() .b64() .json() .zip() .stop()
 * Tuỳ chỉnh:
 *   __meetCap.cfg.minChangeRatio = 0.05   // % diện tích phải đổi mới coi là cảnh mới
 *   __meetCap.cfg.settleRatio    = 0.015  // dưới mức này coi như frame đã đứng yên
 *   __meetCap.cfg.pixelTol       = 12     // lệch độ sáng (0-255) để tính một ô là đã đổi
 *   __meetCap.cfg.watchMs        = 1000
 *   __meetCap.cfg.threshold      = 6      // Hamming dHash, chống lưu lại slide cũ
 *   __meetCap.cfg.maxSide        = 1280   // khi CHỤP    __meetCap.cfg.quality       = 0.8
 *   __meetCap.cfg.exportMaxSide  = 512    // khi XUẤT    __meetCap.cfg.exportQuality = 0.82
 *   __meetCap.cfg.exportFormat   = "image/webp"
 */
(() => {
  const PANEL_ID = "__meetCapPanel";
  const POLL_MS = 400;
  const LABEL_RX = /^(ph[uụ] ?[dđ][eề]|captions?|subtitles?|字幕|subtítulos?)$/i;
  const GW = 32, GH = 18; // lưới signature

  if (window.__meetCap) window.__meetCap.stop();
  document.getElementById(PANEL_ID)?.remove();

  const code = (location.pathname.replace(/^\//, "").split("/")[0] || "meet").trim();
  const KEY = "meetcap7:" + code;

  const cfg = {
    minChangeRatio: 0.05,
    settleRatio: 0.015,
    pixelTol: 12,
    watchMs: 1000,
    threshold: 6,
    maxSide: 1280,
    quality: 0.8,
    exportMaxSide: 512,
    exportQuality: 0.82,
    exportFormat: "image/webp",
  };

  const S = {
    turns: [], frames: [], base: null,
    recording: true, capturing: true,
    seen: new WeakMap(), videoIdx: null, busy: false, note: "", timers: [],
    storedSig: null,   // signature của ảnh đã lưu gần nhất
    pendingSig: null,  // signature đang chờ ổn định
    lastRatio: 0,      // Δ hiện tại, hiện lên panel để tinh chỉnh
    skipped: 0,        // số lần bị cổng chặn
  };

  const mark = (v) => { if (S.base == null || v < S.base) S.base = v; return v; };

  const supports = (fmt) => {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    return c.toDataURL(fmt).startsWith("data:" + fmt);
  };
  const fmtOut = () => (supports(cfg.exportFormat) ? cfg.exportFormat : "image/jpeg");
  const extOf = (fmt) => (fmt === "image/webp" ? "webp" : "jpg");

  /* ================= PHỤ ĐỀ ================= */

  function findRegion() {
    for (const r of document.querySelectorAll('[role="region"][aria-label]'))
      if (LABEL_RX.test((r.getAttribute("aria-label") || "").trim())) return r;
    return document.querySelector(".vNKgIf.UDinHf") || document.querySelector('[jsname="dsyhDe"]') || null;
  }

  function findItems(region) {
    const out = [];
    for (const kid of region.children) {
      const img = kid.querySelector("img");
      const span = kid.querySelector("span");
      if (!img || !span) continue; // loại nút .IMKgW và div ẩn .GvZY2
      const textEl =
        [...kid.children].reverse().find((c) => !c.querySelector("img") && (c.innerText || "").trim()) ||
        kid.querySelector(".ygicle");
      if (textEl) out.push({ el: kid, img, span, textEl });
    }
    return out;
  }

  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

  function merge(a, b) {
    if (!a) return b;
    if (!b) return a;
    const na = norm(a), nb = norm(b);
    if (nb.startsWith(na)) return b;   // câu đang mọc dài ra
    if (na.includes(nb)) return a;     // Meet cắt bớt đầu -> giữ bản đầy đủ
    for (let n = Math.min(a.length, b.length); n > 12; n--)
      if (norm(a.slice(-n)) === norm(b.slice(0, n))) return a + b.slice(n);
    return a.length >= b.length ? a : b;
  }

  function syncCaptions() {
    if (!S.recording) return 0;
    const region = findRegion();
    if (!region) { S.note = "Chưa thấy vùng phụ đề"; return 0; }
    S.note = "";

    let added = 0;
    const items = findItems(region);
    for (const { el, img, span, textEl } of items) {
      const speaker = (span.innerText || "").trim() || "Không rõ";
      const text = (textEl.innerText || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const iml = parseFloat(img.dataset.iml);
      const t = mark(Number.isFinite(iml) ? iml : performance.now());
      const idx = S.seen.get(el);
      if (idx != null) {
        S.turns[idx].text = merge(S.turns[idx].text, text);
        S.turns[idx].speaker = speaker;
      } else {
        S.turns.push({ speaker, text, iml: t });
        S.seen.set(el, S.turns.length - 1);
        added++;
      }
    }
    if (added) {
      S.turns.sort((a, b) => a.iml - b.iml);
      S.seen = new WeakMap();
      for (const { el, img } of items) {
        const i = S.turns.findIndex((t) => t.iml === parseFloat(img.dataset.iml));
        if (i >= 0) S.seen.set(el, i);
      }
    }
    return added;
  }

  /* ================= ẢNH ================= */

  const mk = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  };
  const sc = mk(GW, GH), sctx = sc.getContext("2d", { willReadFrequently: true });
  const hc = mk(9, 8), hctx = hc.getContext("2d", { willReadFrequently: true });
  const fc = mk(1, 1), fctx = fc.getContext("2d");

  const fit = (w, h, maxSide) => (maxSide ? Math.min(1, maxSide / Math.max(w, h)) : 1);

  const listVideos = () =>
    [...document.querySelectorAll("video")]
      .map((v, i) => ({ i, v, res: v.videoWidth * v.videoHeight, w: v.videoWidth, h: v.videoHeight }))
      .filter((o) => o.res > 0 && o.v.readyState >= 2);

  function pickedVideo() {
    const vids = listVideos();
    if (!vids.length) return null;
    if (S.videoIdx != null) return vids.find((o) => o.i === S.videoIdx)?.v || null;
    return vids.sort((a, b) => b.res - a.res)[0].v;
  }

  // signature 32×18 xám. drawImage xuống lưới này đã trung bình hoá cả vùng,
  // nên con trỏ chuột chỉ ảnh hưởng dưới 1 ô.
  function signature(video) {
    sctx.drawImage(video, 0, 0, GW, GH);
    const d = sctx.getImageData(0, 0, GW, GH).data;
    const g = new Uint8Array(GW * GH);
    for (let i = 0; i < g.length; i++)
      g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) | 0;
    return g;
  }

  // tỷ lệ ô đổi vượt pixelTol
  function changeRatio(a, b) {
    if (!a || !b) return 1;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > cfg.pixelTol) n++;
    return n / a.length;
  }

  function dhash(video) {
    hctx.drawImage(video, 0, 0, 9, 8);
    const d = hctx.getImageData(0, 0, 9, 8).data;
    const g = new Float32Array(72);
    for (let i = 0; i < 72; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let bits = "";
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) bits += g[y * 9 + x] < g[y * 9 + x + 1] ? "1" : "0";
    return bits;
  }

  const hamming = (a, b) => { let n = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) n++; return n; };
  const duplicateOf = (h) => S.frames.find((f) => hamming(f.hash, h) <= cfg.threshold) || null;

  // ghi thật một frame ra blob
  async function grab(video, hash) {
    const scale = fit(video.videoWidth, video.videoHeight, cfg.maxSide);
    fc.width = Math.round(video.videoWidth * scale);
    fc.height = Math.round(video.videoHeight * scale);
    fctx.drawImage(video, 0, 0, fc.width, fc.height);
    const blob = await new Promise((res) => fc.toBlob(res, "image/jpeg", cfg.quality));
    if (!blob) { S.note = "Canvas bị chặn"; return null; }
    const frame = {
      id: S.frames.length + 1,
      hash: hash || dhash(video),
      blob, iml: mark(performance.now()), w: fc.width, h: fc.height,
    };
    S.frames.push(frame);
    return frame;
  }

  // Chụp cưỡng chế, bỏ qua mọi cổng (nút "Chụp ngay")
  async function captureNow() {
    const video = pickedVideo();
    if (!video || !video.videoWidth) { S.note = "Không có video"; return null; }
    if (S.busy) return null;
    S.busy = true;
    try {
      const f = await grab(video);
      if (f) S.storedSig = signature(video);
      return f;
    } catch (e) {
      S.note = "Lỗi chụp: " + (e.name || e);
      return null;
    } finally { S.busy = false; }
  }

  /* ---- vòng canh: 3 tầng lọc ---- */
  async function watch() {
    if (!S.capturing || S.busy) return;
    const video = pickedVideo();
    if (!video || !video.videoWidth) { S.note = "Không có video"; return; }
    S.busy = true;
    try {
      const sig = signature(video);
      S.lastRatio = changeRatio(S.storedSig, sig);

      // ảnh đầu tiên: chụp luôn
      if (!S.storedSig) {
        const h = dhash(video);
        if (!duplicateOf(h)) await grab(video, h);
        S.storedSig = sig;
        return;
      }

      // tầng 1 — đổi quá ít (chuột, caret, đồng hồ, nhiễu nén) -> bỏ
      if (S.lastRatio < cfg.minChangeRatio) {
        if (S.pendingSig) S.skipped++;
        S.pendingSig = null;
        return;
      }

      // tầng 2 — đã đổi đáng kể, đợi frame đứng yên rồi mới chụp
      if (!S.pendingSig || changeRatio(S.pendingSig, sig) >= cfg.settleRatio) {
        S.pendingSig = sig;
        return;
      }

      // tầng 3 — dHash: slide cũ quay lại thì không lưu bản sao
      const h = dhash(video);
      if (duplicateOf(h)) {
        S.storedSig = sig;   // cập nhật mốc để khỏi thử lại liên tục
        S.pendingSig = null;
        S.skipped++;
        return;
      }

      await grab(video, h);
      S.storedSig = sig;
      S.pendingSig = null;
    } catch (e) {
      S.note = "Lỗi chụp: " + (e.name || e);
    } finally { S.busy = false; }
  }

  /* ================= XUẤT ================= */

  const mmss = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const rel = (iml) => mmss(iml - (S.base ?? iml));
  const kb = (n) => Math.round(n / 1024) + "KB";
  const mb = (n) => (n / 1048576).toFixed(2) + "MB";

  async function encodeFrame(f, fmt = fmtOut()) {
    const scale = fit(f.w, f.h, cfg.exportMaxSide);
    const bmp = await createImageBitmap(f.blob);
    const c = mk(Math.max(1, Math.round(f.w * scale)), Math.max(1, Math.round(f.h * scale)));
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const out = await new Promise((r) => c.toBlob(r, fmt, cfg.exportQuality));
    return { blob: out || f.blob, w: c.width, h: c.height };
  }

  const toB64 = (blob) =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });

  async function encodeAll() {
    const fmt = fmtOut();
    const map = new Map();
    for (const f of S.frames) {
      const e = await encodeFrame(f, fmt);
      map.set(f.id, {
        dataUrl: `data:${fmt};base64,` + (await toB64(e.blob)),
        w: e.w, h: e.h, size: e.blob.size, blob: e.blob,
      });
    }
    return map;
  }

  const fileName = (f, fmt) => `img/${String(f.id).padStart(3, "0")}.${extOf(fmt)}`;

  function buildMarkdown(mode, enc, fmt) {
    const title = document.title.replace(/^Meet\s*[–—-]\s*/, "").trim() || "Google Meet";
    const speakers = [...new Set(S.turns.map((t) => t.speaker))];
    const withImg = mode !== "none";
    const out = [
      `# ${title}`,
      "",
      `- **Mã cuộc họp**: ${code}`,
      `- **Ghi lúc**: ${new Date().toLocaleString("vi-VN")}`,
      `- **Người nói**: ${speakers.join(", ") || "—"}`,
      `- **Số lượt nói**: ${S.turns.length}${withImg ? ` · **Ảnh**: ${S.frames.length}` : ""}`,
      "",
      "---",
      "",
    ];

    const stream = [
      ...S.turns.map((t) => ({ kind: "turn", at: t.iml, t })),
      ...(withImg ? S.frames.map((f) => ({ kind: "img", at: f.iml, f })) : []),
    ].sort((a, b) => a.at - b.at);

    let last = null;
    for (const e of stream) {
      if (e.kind === "img") {
        const m = enc?.get(e.f.id);
        const cap = `Ảnh ${e.f.id} — ${rel(e.at)}${m ? ` — ${m.w}×${m.h}` : ""}`;
        out.push(mode === "base64" ? `![${cap}][img-${e.f.id}]` : `![${cap}](${fileName(e.f, fmt)})`, "");
        last = null;
      } else if (e.t.speaker !== last) {
        out.push(`## ${e.t.speaker} [${rel(e.at)}]`, "", e.t.text, "");
        last = e.t.speaker;
      } else {
        out.push(e.t.text, "");
      }
    }

    if (mode === "base64" && S.frames.length) {
      out.push(
        "",
        "<!-- ================================================================",
        `     ẢNH NHÚNG BASE64 (${fmt}, cạnh dài ${cfg.exportMaxSide}px)`,
        "     Mọi dòng dưới đây bắt đầu bằng [img-",
        "     Bản text sạch:  grep -v '^\\[img-' file.b64.md",
        "     ================================================================ -->",
        ""
      );
      for (const f of S.frames) out.push(`[img-${f.id}]: ${enc.get(f.id).dataUrl}`);
      out.push("");
    }
    return out.join("\n");
  }

  async function buildJson() {
    const fmt = fmtOut();
    const enc = await encodeAll();
    return JSON.stringify(
      {
        meeting: {
          code,
          title: document.title.replace(/^Meet\s*[–—-]\s*/, "").trim(),
          capturedAt: new Date().toISOString(),
          imageFormat: fmt,
          imageMaxSide: cfg.exportMaxSide,
        },
        turns: S.turns.map((t) => ({ speaker: t.speaker, text: t.text, at: rel(t.iml), ms: Math.round(t.iml - S.base) })),
        frames: S.frames.map((f) => {
          const m = enc.get(f.id);
          return { id: f.id, at: rel(f.iml), ms: Math.round(f.iml - S.base), w: m.w, h: m.h, dataUrl: m.dataUrl };
        }),
      },
      null,
      2
    );
  }

  /* ---- ZIP store ---- */
  let CRCT;
  function crc32(u8) {
    if (!CRCT) {
      CRCT = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRCT[n] = c;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRCT[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeZip(files) {
    const enc = new TextEncoder();
    const local = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, f.data.length, true);
      lh.setUint32(22, f.data.length, true);
      lh.setUint16(26, name.length, true);
      local.push(new Uint8Array(lh.buffer), name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, f.data.length, true);
      ch.setUint32(24, f.data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + f.data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true);
    eo.setUint16(8, files.length, true);
    eo.setUint16(10, files.length, true);
    eo.setUint32(12, cdSize, true);
    eo.setUint32(16, offset, true);
    return new Blob([...local, ...central, new Uint8Array(eo.buffer)], { type: "application/zip" });
  }

  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  const dlMd = () =>
    save(new Blob([buildMarkdown("none")], { type: "text/markdown;charset=utf-8" }), `meet-${code}-${stamp()}.md`);

  async function b64Text() {
    const fmt = fmtOut();
    const enc = await encodeAll();
    const text = buildMarkdown("base64", enc, fmt);
    return { text, count: enc.size, imgBytes: [...enc.values()].reduce((a, m) => a + m.size, 0) };
  }

  async function dlB64() {
    flash("Đang nén ảnh…");
    const { text, count, imgBytes } = await b64Text();
    save(new Blob([text], { type: "text/markdown;charset=utf-8" }), `meet-${code}-${stamp()}.b64.md`);
    flash(`${count} ảnh · ${kb(imgBytes / Math.max(1, count))}/ảnh · ${mb(text.length)}`);
  }

  async function dlJson() {
    flash("Đang nén ảnh…");
    const text = await buildJson();
    save(new Blob([text], { type: "application/json" }), `meet-${code}-${stamp()}.json`);
    flash(`Đã tải ${mb(text.length)}`);
  }

  async function dlZip() {
    flash("Đang đóng gói…");
    const fmt = fmtOut();
    const enc = await encodeAll();
    const te = new TextEncoder();
    const files = [{ name: "transcript.md", data: te.encode(buildMarkdown("files", enc, fmt)) }];
    for (const f of S.frames)
      files.push({ name: fileName(f, fmt), data: new Uint8Array(await enc.get(f.id).blob.arrayBuffer()) });
    save(makeZip(files), `meet-${code}-${stamp()}.zip`);
    flash(`Đã tải ${files.length} file`);
  }

  async function copyAll() {
    flash("Đang nén ảnh…");
    const { text, count } = await b64Text();
    try {
      await navigator.clipboard.writeText(text);
      flash(`Đã sao chép ${count} ảnh · ${mb(text.length)}`);
    } catch {
      flash("Clipboard chặn — đang tải file");
      save(new Blob([text], { type: "text/markdown;charset=utf-8" }), `meet-${code}-${stamp()}.b64.md`);
    }
  }

  async function preview(exportSize = false) {
    const w = window.open("", "_blank");
    if (!w) return flash("Popup bị chặn");
    const enc = exportSize ? await encodeAll() : null;
    w.document.write(
      `<title>Ảnh ${exportSize ? `xuất ${cfg.exportMaxSide}px` : "gốc"} (${S.frames.length})</title>` +
      `<body style="margin:0;background:#111;color:#ddd;font:13px system-ui">` +
      S.frames.map((f) => {
        const m = enc?.get(f.id);
        return `<figure style="margin:0 0 16px"><figcaption style="padding:6px 10px">#${f.id} · ${rel(f.iml)} · ` +
          `${m ? `${m.w}×${m.h} · ${kb(m.size)}` : `${f.w}×${f.h} · ${kb(f.blob.size)}`}</figcaption>` +
          `<img src="${m ? m.dataUrl : URL.createObjectURL(f.blob)}" style="display:block"></figure>`;
      }).join("")
    );
  }

  // In Δ liên tục 15s để chọn minChangeRatio: di chuột, đổi slide, xem số nhảy thế nào
  function tune(seconds = 15) {
    console.log(`%cĐo Δ trong ${seconds}s — thử di chuột rồi đổi slide và so hai dãy số.`,
      "color:#8ab4f8;font-weight:600");
    let n = 0;
    const id = setInterval(() => {
      const v = pickedVideo();
      if (!v) return console.log("không có video");
      const r = changeRatio(S.storedSig, signature(v));
      console.log(`${String(++n).padStart(3)}s  Δ ${(r * 100).toFixed(2)}%`,
        r < cfg.minChangeRatio ? "-> bỏ qua" : "-> đủ ngưỡng");
      if (n >= seconds) clearInterval(id);
    }, 1000);
  }

  function debug() {
    const region = findRegion();
    console.log("region:", region, "| aria-label:", JSON.stringify(region?.getAttribute("aria-label")));
    if (region) {
      const items = findItems(region);
      console.log("items:", items.length);
      items.forEach(({ span, textEl, img }) =>
        console.log("  ", JSON.stringify(span.innerText.trim()), "| iml", img.dataset.iml, "|",
          JSON.stringify(textEl.innerText.trim().slice(0, 60))));
    }
    console.log("--- video ---");
    listVideos().forEach((o) => console.log(`  [${o.i}] ${o.w}×${o.h}` + (o.v === pickedVideo() ? "   <== đang dùng" : "")));
    console.log("turns:", S.turns.length, "| frames:", S.frames.length, "| bị cổng chặn:", S.skipped);
    console.log("Δ hiện tại:", (S.lastRatio * 100).toFixed(2) + "%", "| ngưỡng:", (cfg.minChangeRatio * 100) + "%");
    console.log("hamming giữa các ảnh liền nhau:", S.frames.slice(1).map((f, i) => hamming(S.frames[i].hash, f.hash)));
    console.log("xuất:", fmtOut(), cfg.exportMaxSide + "px | ảnh gốc trong RAM:",
      mb(S.frames.reduce((a, f) => a + f.blob.size, 0)));
    console.log("chạy __meetCap.tune() để chọn minChangeRatio");
    return region;
  }

  /* ================= PANEL ================= */

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText = `position:fixed;left:16px;bottom:100px;z-index:2147483647;
    display:flex;flex-direction:column;gap:6px;padding:9px 11px;
    font:500 12px/1.3 "Google Sans",Roboto,system-ui,sans-serif;color:#e8eaed;
    background:rgba(32,33,36,.94);border:1px solid #3c4043;border-radius:10px;
    box-shadow:0 4px 20px rgba(0,0,0,.45);backdrop-filter:blur(8px);user-select:none`;

  const row = () => {
    const d = document.createElement("div");
    d.style.cssText = "display:flex;gap:6px;align-items:center";
    return d;
  };
  const r1 = row(), r2 = row();

  const dot = document.createElement("span");
  dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#ea4335;flex:none";
  const label = document.createElement("span");
  label.style.cssText = "flex:1;min-width:214px;font-variant-numeric:tabular-nums";

  const btn = (text, fn, accent) => {
    const b = document.createElement("button");
    b.textContent = text;
    const bg = accent ? "#1a73e8" : "#3c4043";
    b.style.cssText = `all:unset;cursor:pointer;padding:5px 8px;border-radius:6px;
      background:${bg};color:#e8eaed;font:inherit;white-space:nowrap`;
    b.onmouseenter = () => (b.style.background = accent ? "#2b7de9" : "#4d5156");
    b.onmouseleave = () => (b.style.background = bg);
    b.onclick = fn;
    return b;
  };

  const bRec = btn("Tạm dừng", () => {
    S.recording = !S.recording;
    bRec.textContent = S.recording ? "Tạm dừng" : "Tiếp tục";
    dot.style.background = S.recording ? "#ea4335" : "#9aa0a6";
  });
  const bCap = btn("Ảnh: bật", () => {
    S.capturing = !S.capturing;
    bCap.textContent = S.capturing ? "Ảnh: bật" : "Ảnh: tắt";
  });

  let flashMsg = null;
  const flash = (m) => { flashMsg = m; render(); setTimeout(() => { flashMsg = null; render(); }, 3000); };
  function render() {
    const dur = S.turns.length ? rel(S.turns[S.turns.length - 1].iml) : "0:00";
    const d = (S.lastRatio * 100).toFixed(1);
    const wait = S.pendingSig ? " ⏳" : "";
    label.textContent = flashMsg || S.note ||
      `${S.turns.length} lượt · ${S.frames.length} ảnh · Δ${d}%${wait} · ${dur}`;
  }

  r1.append(dot, label, bRec, bCap);
  r2.append(
    btn("Chụp ngay", async () => { const f = await captureNow(); flash(f ? `Ảnh #${f.id}` : "Không chụp được"); }),
    btn(`Xem ${cfg.exportMaxSide}px`, () => preview(true)),
    btn("Xem gốc", () => preview(false)),
    btn("Sao chép base64", copyAll, true),
    btn(".b64.md", dlB64),
    btn(".json", dlJson),
    btn(".md", dlMd),
    btn(".zip", dlZip)
  );
  panel.append(r1, r2);
  document.body.appendChild(panel);

  /* ================= KHỞI ĐỘNG ================= */

  function tick() {
    syncCaptions();
    render();
    try { localStorage.setItem(KEY, JSON.stringify({ base: S.base, turns: S.turns })); } catch {}
  }

  S.timers.push(setInterval(tick, POLL_MS));
  S.timers.push(setInterval(watch, cfg.watchMs));
  tick();

  window.__meetCap = {
    cfg, debug, tune, listVideos,
    preview: () => preview(false),
    previewExport: () => preview(true),
    pickVideo(i) { S.videoIdx = i; flash(i == null ? "Tự chọn video" : `Dùng video [${i}]`); },
    capture: captureNow,
    text: () => buildMarkdown("none"),
    b64: dlB64, json: dlJson, zip: dlZip, download: dlMd, copy: copyAll,
    get turns() { return S.turns; },
    get frames() { return S.frames; },
    get delta() { return S.lastRatio; },
    restore() {
      try {
        const s = JSON.parse(localStorage.getItem(KEY) || "null");
        if (!s?.turns?.length) return flash("Không có bản lưu");
        const known = new Set(S.turns.map((t) => t.iml));
        S.turns = s.turns.filter((t) => !known.has(t.iml)).concat(S.turns).sort((a, b) => a.iml - b.iml);
        if (s.base != null) mark(s.base);
        S.seen = new WeakMap();
        flash(`Phục hồi ${s.turns.length} lượt`);
      } catch { flash("Bản lưu lỗi"); }
    },
    stop() {
      S.timers.forEach(clearInterval);
      S.recording = S.capturing = false;
      document.getElementById(PANEL_ID)?.remove();
      delete window.__meetCap;
    },
  };

  console.log("%cv7 đang chạy.", "color:#8ab4f8;font-weight:600",
    "__meetCap.tune() để chọn ngưỡng · .debug() · .previewExport()");
})();