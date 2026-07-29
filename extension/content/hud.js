/* The in-page HUD.
   Built inside a Shadow DOM so Meet's CSS cannot reach it and vice versa.
   While recording the HUD is never fully hidden: the extension is recording other
   people's speech, and the red dot is what tells the room that. */

/* var, not const: content scripts share one global scope, like sibling <script>
   tags. A second `const MC` would throw "Identifier MC has already been declared"
   and block every file listed after it. */
var MC = (window.__MC ||= {});

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
/* Any display rule of ours outranks the hidden attribute's display:none, so pin it
   down here — .live using -webkit-box is exactly that case. */
[hidden] { display: none !important; }
.wrap {
  position: fixed; z-index: 2147483647;
  font: 500 12px/1.35 "Google Sans", Roboto, system-ui, sans-serif;
  color: #e9edea;
}
.card {
  background: rgba(18,22,24,.93);
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 10px;
  box-shadow: 0 6px 26px rgba(0,0,0,.5);
  backdrop-filter: blur(10px);
  overflow: hidden;
  user-select: none;
}
.pill { display: flex; align-items: center; gap: 9px; padding: 7px 10px; cursor: grab; }
.pill:active { cursor: grabbing; }
.grip { width: 3px; height: 15px; border-radius: 2px; background: rgba(255,255,255,.2); flex: none; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: #e0464b; }
.dot.blink { animation: mcPulse 1.6s ease-in-out infinite; }
.dot.grey { background: #8a9390; }
.dot.amber { background: #e8a33d; }
.dot.teal { background: #35b3a5; }
@keyframes mcPulse { 0%,100% { opacity: 1 } 50% { opacity: .32 } }
@media (prefers-reduced-motion: reduce) { .dot.blink { animation: none } }
.stat {
  font: 500 12px/1 ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.stat s { text-decoration: none; color: rgba(233,237,234,.4); margin: 0 5px; }
.chev { color: rgba(233,237,234,.5); font: 500 11px/1 ui-monospace, monospace; padding-left: 2px; cursor: pointer; }

.panel { width: 322px; }
.head { display: flex; align-items: center; gap: 9px; padding: 9px 11px;
        border-bottom: 1px solid rgba(255,255,255,.08); cursor: grab; }
.head:active { cursor: grabbing; }
.head .name { font: 600 11px/1 ui-monospace, monospace; letter-spacing: .1em;
              text-transform: uppercase; color: rgba(233,237,234,.55); margin-left: auto; }
.body { padding: 11px; display: flex; flex-direction: column; gap: 11px; }
.nums { display: flex; }
.num { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.num b { font: 600 19px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; font-variant-numeric: tabular-nums; }
.num b.teal { color: #35b3a5; }
.num span { font: 500 9.5px/1 ui-monospace, monospace; letter-spacing: .11em;
            text-transform: uppercase; color: rgba(233,237,234,.45); }

.meter { display: flex; flex-direction: column; gap: 5px; }
.meter-top { display: flex; justify-content: space-between; align-items: baseline; }
.meter-top span { font: 500 9.5px/1 ui-monospace, monospace; letter-spacing: .11em;
                  text-transform: uppercase; color: rgba(233,237,234,.45); }
.meter-top b { font: 600 11.5px/1 ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.track { position: relative; height: 7px; border-radius: 2px; background: rgba(255,255,255,.09); }
.fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px;
        background: #35b3a5; transition: width .2s linear; }
.fill.hot { background: #e8a33d; }
.thresh { position: absolute; top: -3px; bottom: -3px; width: 2px; background: #e8a33d; }

.live { font-size: 11.5px; line-height: 1.45; color: rgba(233,237,234,.72);
        border-left: 2px solid #35b3a5; padding-left: 8px;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.live b { color: rgba(233,237,234,.95); font-weight: 600; }

.row { display: flex; gap: 6px; flex-wrap: wrap; }
button.b {
  font: 500 11.5px/1 inherit; color: #e9edea; background: rgba(255,255,255,.1);
  border: 0; border-radius: 6px; padding: 7px 9px; cursor: pointer; white-space: nowrap;
}
button.b:hover { background: rgba(255,255,255,.16); }
button.b:focus-visible { outline: 2px solid #e8a33d; outline-offset: 2px; }
button.b.primary { background: #e8a33d; color: #1a1207; font-weight: 600; }
button.b.primary:hover { background: #f0b559; }
button.b[disabled] { opacity: .45; cursor: default; }
.foot { padding: 8px 11px; border-top: 1px solid rgba(255,255,255,.08);
        font: 500 10.5px/1.4 ui-monospace, monospace; color: rgba(233,237,234,.45);
        display: flex; align-items: center; gap: 7px; }
.foot .ok { color: #35b3a5; }
.foot .bad { color: #e8a33d; }

.toasts { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.toast {
  display: flex; align-items: flex-start; gap: 9px; width: 300px; padding: 10px 11px;
  background: rgba(18,22,24,.95); border: 1px solid rgba(255,255,255,.11);
  border-left: 3px solid #35b3a5; border-radius: 8px;
  font-size: 12.5px; line-height: 1.45; box-shadow: 0 6px 26px rgba(0,0,0,.5);
}
.toast.warn { border-left-color: #e8a33d; }
.toast.bad { border-left-color: #e0464b; }
.toast b { display: block; font-weight: 600; margin-bottom: 2px; }
.toast .act { color: #e8a33d; font-weight: 600; margin-top: 6px; display: inline-block;
              background: none; border: 0; padding: 0; cursor: pointer; font-size: 12px; }
`;

const TPL = `
<div class="wrap">
  <div class="toasts" part="toasts"></div>

  <div class="card pillcard">
    <div class="pill" data-drag>
      <span class="grip"></span>
      <span class="dot blink" data-dot></span>
      <span class="stat" data-pillstat>0 lượt<s>·</s>0 ảnh<s>·</s>0:00</span>
      <span class="chev" data-expand>▲</span>
    </div>
  </div>

  <div class="card panel" hidden>
    <div class="head" data-drag>
      <span class="dot blink" data-dot2></span>
      <span class="stat" data-title style="font-weight:600">ĐANG GHI</span>
      <span class="name">meetcap</span>
      <button class="b" data-collapse style="padding:5px 7px">▼</button>
    </div>
    <div class="body">
      <div class="nums">
        <span class="num"><b data-turns>0</b><span>Lượt nói</span></span>
        <span class="num"><b class="teal" data-frames>0</b><span>Ảnh</span></span>
        <span class="num"><b data-elapsed>0:00</b><span>Thời lượng</span></span>
      </div>
      <div class="meter">
        <div class="meter-top"><span>Δ khung hình</span><b data-delta>0,0 %</b></div>
        <div class="track">
          <div class="fill" data-fill style="width:0%"></div>
          <div class="thresh" data-thresh style="left:50%"></div>
        </div>
      </div>
      <p class="live" data-live hidden></p>
      <div class="row">
        <button class="b primary" data-capture>Chụp ngay</button>
        <button class="b" data-pause>Tạm dừng</button>
        <button class="b" data-copy>Sao chép</button>
      </div>
    </div>
    <div class="foot" data-foot></div>
  </div>
</div>`;

MC.hud = {
  el: null,
  root: null,
  q: {},
  listeners: {},
  open: false,
  code: null,

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
  },
  emit(event, arg) {
    for (const fn of this.listeners[event] || []) {
      try { fn(arg); } catch (e) { console.warn("[MeetCap] hud", event, e); }
    }
  },

  async mount(code) {
    if (this.el) return;
    this.code = code;
    const host = document.createElement("div");
    host.id = "__meetcap_hud";
    host.style.cssText = "all:initial;position:static";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(style);
    const holder = document.createElement("div");
    holder.innerHTML = TPL;
    root.append(holder.firstElementChild);
    document.body.append(host);

    this.el = host;
    this.root = root;
    const wrap = root.querySelector(".wrap");
    this.q = {
      wrap,
      toasts: root.querySelector(".toasts"),
      pillcard: root.querySelector(".pillcard"),
      panel: root.querySelector(".panel"),
      dot: root.querySelector("[data-dot]"),
      dot2: root.querySelector("[data-dot2]"),
      pillstat: root.querySelector("[data-pillstat]"),
      title: root.querySelector("[data-title]"),
      turns: root.querySelector("[data-turns]"),
      frames: root.querySelector("[data-frames]"),
      elapsed: root.querySelector("[data-elapsed]"),
      delta: root.querySelector("[data-delta]"),
      fill: root.querySelector("[data-fill]"),
      thresh: root.querySelector("[data-thresh]"),
      live: root.querySelector("[data-live]"),
      foot: root.querySelector("[data-foot]"),
      capture: root.querySelector("[data-capture]"),
      pause: root.querySelector("[data-pause]"),
      copy: root.querySelector("[data-copy]"),
    };

    root.querySelector("[data-expand]").addEventListener("click", (e) => {
      e.stopPropagation();
      this.setOpen(true);
    });
    root.querySelector("[data-collapse]").addEventListener("click", () => this.setOpen(false));
    this.q.capture.addEventListener("click", () => this.emit("capture"));
    this.q.pause.addEventListener("click", () => this.emit("pause"));
    this.q.copy.addEventListener("click", (e) => this.emit("copy", e));

    await this.restorePosition();
    this.enableDrag();
  },

  unmount() {
    this.el?.remove();
    this.el = null;
  },

  setOpen(open) {
    this.open = open;
    this.q.pillcard.hidden = open;
    this.q.panel.hidden = !open;
    chrome.storage.local.set({ [`hud:open:${this.code}`]: open });
  },

  async restorePosition() {
    const key = `hud:pos:${this.code}`;
    const got = await chrome.storage.local.get([key, `hud:open:${this.code}`]);
    const pos = got[key];
    const w = this.q.wrap;
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      w.style.left = Math.min(pos.left, innerWidth - 60) + "px";
      w.style.top = Math.min(pos.top, innerHeight - 60) + "px";
    } else {
      w.style.left = "16px";
      w.style.bottom = "96px";
    }
    this.setOpen(!!got[`hud:open:${this.code}`]);
  },

  enableDrag() {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    const w = this.q.wrap;

    const down = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      const r = w.getBoundingClientRect();
      w.style.left = r.left + "px";
      w.style.top = r.top + "px";
      w.style.bottom = "auto";
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const move = (e) => {
      if (!dragging) return;
      const left = Math.max(0, Math.min(innerWidth - 40, ox + e.clientX - sx));
      const top = Math.max(0, Math.min(innerHeight - 40, oy + e.clientY - sy));
      w.style.left = left + "px";
      w.style.top = top + "px";
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      chrome.storage.local.set({
        [`hud:pos:${this.code}`]: { left: parseFloat(w.style.left), top: parseFloat(w.style.top) },
      });
    };

    for (const h of this.root.querySelectorAll("[data-drag]")) {
      h.addEventListener("pointerdown", down);
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    }
  },

  /** @param {object} v {state,turns,frames,elapsed,delta,threshold,live,foot,footTone} */
  render(v) {
    if (!this.el) return;
    const q = this.q;
    const dotClass =
      v.state === "recording" ? "dot blink" :
      v.state === "paused" ? "dot amber" :
      v.state === "ended" ? "dot teal" : "dot grey";
    q.dot.className = dotClass;
    q.dot2.className = dotClass;

    if (v.state === "waiting") {
      q.pillstat.innerHTML = "Sẵn sàng — sẽ tự ghi khi bạn vào họp";
    } else {
      q.pillstat.innerHTML =
        `${v.turns} lượt<s>·</s>${v.frames} ảnh<s>·</s>${v.elapsed}`;
    }

    q.title.textContent =
      v.state === "recording" ? "ĐANG GHI" :
      v.state === "paused" ? "TẠM DỪNG" :
      v.state === "ended" ? "ĐÃ DỪNG" : "SẴN SÀNG";

    q.turns.textContent = v.turns;
    q.frames.textContent = v.frames;
    q.elapsed.textContent = v.elapsed;

    const pct = Math.min(100, (v.delta || 0) * 1000); // axis spans 0-10%
    q.delta.textContent = ((v.delta || 0) * 100).toFixed(1).replace(".", ",") + " %" + (v.pending ? " ⏳" : "");
    q.fill.style.width = pct + "%";
    q.fill.className = "fill" + (v.delta >= v.threshold ? " hot" : "");
    q.thresh.style.left = Math.min(100, (v.threshold || 0) * 1000) + "%";

    q.pause.textContent =
      v.state === "paused" ? "Ghi tiếp" :
      v.state === "waiting" ? "Bắt đầu ghi" : "Tạm dừng";
    q.pause.disabled = v.state === "ended";
    q.capture.disabled = v.state !== "recording";
    q.copy.disabled = v.turns === 0 && v.frames === 0;

    if (v.live) {
      q.live.hidden = false;
      q.live.innerHTML = `<b></b> `;
      q.live.firstChild.textContent = v.live.speaker;
      q.live.append(v.live.text);
    } else {
      q.live.hidden = true;
    }

    q.foot.innerHTML = "";
    const mark = document.createElement("span");
    mark.className = v.footTone === "bad" ? "bad" : "ok";
    mark.textContent = "●";
    q.foot.append(mark, document.createTextNode(" " + (v.foot || "")));
  },

  toast(title, body, { tone = "", action, actionLabel, timeout = 5000 } = {}) {
    if (!this.el) return;
    const t = document.createElement("div");
    t.className = "toast" + (tone ? " " + tone : "");
    const dot = document.createElement("span");
    dot.className = "dot " + (tone === "warn" ? "amber" : tone === "bad" ? "" : "teal");
    dot.style.marginTop = "3px";
    const box = document.createElement("span");
    const b = document.createElement("b");
    b.textContent = title;
    box.append(b);
    if (body) box.append(document.createTextNode(body));
    if (action) {
      const btn = document.createElement("button");
      btn.className = "act";
      btn.textContent = actionLabel || "Thử lại";
      btn.addEventListener("click", () => { t.remove(); action(); });
      box.append(document.createElement("br"), btn);
    }
    t.append(dot, box);
    this.q.toasts.append(t);
    if (!action && timeout) setTimeout(() => t.remove(), timeout);
  },
};
