/* Everything that touches Meet's DOM lives here.
   Meet renames its classes constantly, so no signal stands alone: prefer Material
   Symbols ligature text (identical in every interface language), then ARIA roles, and
   only then hashed class names.
   The label regexes below must keep their Vietnamese alternatives — they match the
   Vietnamese Meet interface. */

/* var, not const: content scripts share one global scope, like sibling <script>
   tags. A second `const MC` would throw "Identifier MC has already been declared"
   and block every file listed after it. */
var MC = (window.__MC ||= {});

const CODE_RX = /^[a-z0-9]{3,}-[a-z0-9]{3,}-[a-z0-9]{3,}$/i;
const CC_LABEL_RX = /^(ph[uụ] ?[dđ][eề]|captions?|subtitles?|字幕|subtítulos?)$/i;
const HANGUP_LABEL_RX = /(r[oờ]i kh[oỏ]i|k[eế]t th[uú]c cu[oộ]c g[oọ]i|leave call|end call|abandonar|退出会议)/i;
const CC_ON_LABEL_RX = /(t[aắ]t ph[uụ] ?[dđ][eề]|turn off captions?|hide captions?|stop captions?)/i;

const SYMBOL_SELECTOR =
  "i.google-symbols, i.google-material-icons, span.google-symbols, span.material-icons, i.material-icons";

function symbolNode(match) {
  for (const n of document.querySelectorAll(SYMBOL_SELECTOR)) {
    const t = (n.textContent || "").trim();
    if (t && match(t)) return n;
  }
  return null;
}

function buttonByLabel(rx) {
  for (const b of document.querySelectorAll("button[aria-label], [role='button'][aria-label]")) {
    if (rx.test(b.getAttribute("aria-label") || "")) return b;
  }
  return null;
}

MC.sel = {
  /** Meeting code from the URL. Returns null on the home page or /lookup/*. */
  meetingCode() {
    const seg = (location.pathname.replace(/^\//, "").split("/")[0] || "").trim();
    return CODE_RX.test(seg) ? seg.toLowerCase() : null;
  },

  /** Human-readable meeting name — strips the tab title's "Meet - " prefix. */
  meetingTitle(code) {
    const t = (document.title || "").replace(/^Meet\s*[–—-]\s*/, "").trim();
    if (!t || t.toLowerCase() === (code || "").toLowerCase()) return null;
    return t;
  },

  /** Leave-call button — the primary signal that we are INSIDE the call. */
  hangupButton() {
    return (
      symbolNode((t) => t === "call_end")?.closest("button") ||
      buttonByLabel(HANGUP_LABEL_RX) ||
      null
    );
  },

  ccButton() {
    return (
      symbolNode((t) => t.startsWith("closed_caption"))?.closest("button") ||
      document.querySelector('[jscontroller="FBlsNe"] button[jsname="RrG0hf"]') ||
      buttonByLabel(/ph[uụ] ?[dđ][eề]|captions?|subtitles?/i) ||
      null
    );
  },

  /** Container holding caption lines. Its presence means captions are on. */
  captionRegion() {
    for (const r of document.querySelectorAll('[role="region"][aria-label]')) {
      if (CC_LABEL_RX.test((r.getAttribute("aria-label") || "").trim())) return r;
    }
    return (
      document.querySelector(".vNKgIf.UDinHf") ||
      document.querySelector('[jsname="dsyhDe"]') ||
      null
    );
  },

  /**
   * Whether captions are currently on.
   * @returns {"on"|"off"|"unknown"}
   */
  captionsState() {
    if (this.captionRegion()) return "on";
    const icon = symbolNode((t) => t.startsWith("closed_caption"));
    const lig = (icon?.textContent || "").trim();
    if (lig === "closed_caption_off" || lig === "closed_caption_disabled") return "off";
    const btn = icon?.closest("button");
    const label = btn?.getAttribute("aria-label") || "";
    if (CC_ON_LABEL_RX.test(label)) return "on";
    if (label) return "off";
    return "unknown";
  },

  /** Is a dialog open — Meet asks for a caption language on first use. */
  openDialog() {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (d.getBoundingClientRect().height > 0) return d;
    }
    return null;
  },

  /* From idea.js v7: every caption line is a child of the region and has an <img>
     avatar plus a <span> name. The .IMKgW button and the hidden .GvZY2 div lack one of
     those two, so they are filtered out. */
  captionItems(region) {
    const out = [];
    for (const kid of region.children) {
      const img = kid.querySelector("img");
      const span = kid.querySelector("span");
      if (!img || !span) continue;
      const textEl =
        [...kid.children].reverse().find((c) => !c.querySelector("img") && (c.innerText || "").trim()) ||
        kid.querySelector(".ygicle");
      if (textEl) out.push({ el: kid, img, span, textEl });
    }
    return out;
  },

  listVideos() {
    return [...document.querySelectorAll("video")]
      .map((v, i) => ({ i, v, res: v.videoWidth * v.videoHeight, w: v.videoWidth, h: v.videoHeight }))
      .filter((o) => o.res > 0 && o.v.readyState >= 2);
  },

  /** With nothing pinned, take the highest-resolution video — usually the shared screen. */
  pickVideo(pinnedIndex) {
    const vids = this.listVideos();
    if (!vids.length) return null;
    if (pinnedIndex != null) return vids.find((o) => o.i === pinnedIndex)?.v || null;
    return vids.sort((a, b) => b.res - a.res)[0].v;
  },
};

/** Wait for a condition, watched with MutationObserver so slow machines still keep up. */
MC.waitFor = function waitFor(test, timeout = 3000) {
  const now = test();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      obs.disconnect();
      clearTimeout(timer);
      clearInterval(poll);
      resolve(v);
    };
    const check = () => {
      const v = test();
      if (v) finish(v);
    };
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const poll = setInterval(check, 250);
    const timer = setTimeout(() => finish(null), timeout);
  });
};
