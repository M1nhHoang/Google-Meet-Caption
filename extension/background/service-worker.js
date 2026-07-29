/* Service worker: owns IndexedDB, arbitrates between tabs, and paints the badge.
   Content scripts only push data here; popup / options / preview read the DB directly. */

import {
  openSession, putTurns, putFrame, endSession, touchSession,
  getSession, getTurns, getFrames, prune,
} from "../lib/db.js";
import { buildMarkdown } from "../lib/markdown.js";
import { getSettings } from "../lib/settings.js";

const OWNERS_KEY = "owners"; // { [code]: tabId }

/* ---------------- content script injection ----------------
   Do not rely on manifest content_scripts alone. Declarative injection has gaps: tabs
   opened before install never get it, reloading the extension orphans the old copy, and
   if site access is set to "on click" nothing is injected at all and nothing is logged.
   So the service worker checks and re-injects when needed. */

const CONTENT_FILES = [
  "content/selectors.js",
  "content/captions.js",
  "content/frames.js",
  "content/cc-toggle.js",
  "content/hud.js",
  "content/detector.js",
];

const isMeetUrl = (url) => !!url?.startsWith("https://meet.google.com/");

async function hasContentScript(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => !!window.__MC,
  });
  return !!res?.result;
}

/** @returns {Promise<{ok:boolean, already?:boolean, injected?:boolean, error?:string}>} */
async function ensureInjected(tabId) {
  try {
    if (await hasContentScript(tabId)) return { ok: true, already: true };
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    console.log("[MeetCap] injected content script into tab", tabId);
    return { ok: true, injected: true };
  } catch (e) {
    const error = String(e?.message || e);
    console.warn("[MeetCap] could not inject into tab", tabId, error);
    return { ok: false, error };
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && isMeetUrl(tab.url)) ensureInjected(tabId);
});

async function injectAllMeetTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
    for (const t of tabs) if (t.id != null) await ensureInjected(t.id);
  } catch (e) {
    console.warn("[MeetCap] scanning Meet tabs failed:", e);
  }
}

async function owners() {
  const got = await chrome.storage.session.get(OWNERS_KEY);
  return got[OWNERS_KEY] || {};
}

async function setOwners(map) {
  await chrome.storage.session.set({ [OWNERS_KEY]: map });
}

async function tabAlive(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/** One meeting code, one recording tab — stops two tabs pushing the same meeting. */
async function claim(code, tabId) {
  const map = await owners();
  const cur = map[code];
  if (cur != null && cur !== tabId && (await tabAlive(cur))) return false;
  map[code] = tabId;
  await setOwners(map);
  return true;
}

async function release(tabId) {
  const map = await owners();
  let changed = false;
  for (const [code, id] of Object.entries(map)) {
    if (id === tabId) {
      delete map[code];
      changed = true;
    }
  }
  if (changed) await setOwners(map);
}

/* ---------------- badge ---------------- */

async function badge(tabId, state, count) {
  if (tabId == null) return;
  try {
    if (state === "recording") {
      await chrome.action.setBadgeText({ tabId, text: "REC" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#e0464b" });
    } else if (state === "paused") {
      await chrome.action.setBadgeText({ tabId, text: "II" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#e8a33d" });
    } else if (state === "ended" && count) {
      await chrome.action.setBadgeText({ tabId, text: String(count).slice(0, 4) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#35b3a5" });
    } else {
      await chrome.action.setBadgeText({ tabId, text: "" });
    }
  } catch { /* tab is gone */ }
}

/* ---------------- router ---------------- */

const handlers = {
  async "session:open"({ code, title }, sender) {
    const tabId = sender.tab?.id;
    const mine = await claim(code, tabId);
    if (!mine) return { owner: false };

    const { session, turns, frameMetas, resumed, baseOffset, segmentStart } =
      await openSession(code, title);
    await badge(tabId, "recording");
    return {
      owner: true,
      resumed,
      session,
      baseOffset,
      segmentStart,
      turns: turns.map((t) => ({ seq: t.seq, speaker: t.speaker, text: t.text, at: t.at, ts: t.ts })),
      frameMetas,
    };
  },

  async "turns:put"({ sid, rows }) {
    await putTurns(sid, rows);
    return { ok: true };
  },

  async "frame:put"({ sid, frame }) {
    await putFrame(sid, frame);
    return { ok: true };
  },

  async "session:touch"({ sid, state, count }, sender) {
    await touchSession(sid);
    await badge(sender.tab?.id, state, count);
    return { ok: true };
  },

  async "session:end"({ sid, count }, sender) {
    const s = await endSession(sid);
    const tabId = sender.tab?.id;
    if (tabId != null) await release(tabId);
    await badge(tabId, "ended", count ?? s?.turnCount);
    schedulePrune();
    return { ok: true };
  },

  /** Called by the popup when it cannot reach a tab: retry injection and hand back the
      real error if it fails, so the popup can show it instead of guessing. */
  async "inject:ensure"({ tabId }) {
    return ensureInjected(tabId);
  },

  /** HUD copy button — content scripts cannot read the DB, so the SW builds it. */
  async "md:build"({ sid }) {
    const session = await getSession(sid);
    if (!session) return { error: "Không thấy bản ghi" };
    const [turns, frames] = await Promise.all([getTurns(sid), getFrames(sid)]);
    const text = buildMarkdown(session, turns, frames);
    return { text, turns: turns.length, frames: frames.length, bytes: text.length };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  fn(msg, sender).then(sendResponse, (err) => {
    console.error("[MeetCap]", msg.type, err);
    sendResponse({ error: String(err?.message || err) });
  });
  return true; // keep the channel open for the async reply
});

chrome.tabs.onRemoved.addListener((tabId) => release(tabId));

/* ---------------- pruning ---------------- */

let pruneTimer = null;
function schedulePrune() {
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(async () => {
    try {
      const s = await getSettings();
      await prune(s);
    } catch (e) {
      console.warn("[MeetCap] prune:", e);
    }
  }, 5000);
}

chrome.runtime.onStartup.addListener(() => {
  schedulePrune();
  injectAllMeetTabs();
});

chrome.runtime.onInstalled.addListener(async () => {
  schedulePrune();
  // Ask for persistent storage, otherwise Chrome may evict the data when disk is low.
  try { await navigator.storage.persist(); } catch {}
  // Reloading the extension orphans the previous content script — re-inject right away
  // so the user does not have to reload every Meet tab by hand.
  await injectAllMeetTabs();
});
