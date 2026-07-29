/* IndexedDB lives on the EXTENSION origin (chrome-extension://…), not on
   meet.google.com. That way the popup can read it even with no Meet tab open, and
   clearing Meet's site data does not wipe recordings.
   The service worker writes; popup / options / preview read the same DB directly.

   A recording's key IS the meeting code: rejoining the same room always appends to
   the existing recording, including after a page reload. */

const DB_NAME = "meetcap";
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("turns")) {
        const s = db.createObjectStore("turns", { keyPath: ["sid", "seq"] });
        s.createIndex("sid", "sid");
      }
      if (!db.objectStoreNames.contains("frames")) {
        const s = db.createObjectStore("frames", { keyPath: ["sid", "fid"] });
        s.createIndex("sid", "sid");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
  return { t, done };
}

const call = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

/* ---------------- recording sessions ---------------- */

/**
 * Open the recording for a meeting code. If one exists it is returned as-is so the
 * content script can append to it; otherwise a new one is created.
 */
export async function openSession(code, title) {
  const db = await openDB();
  const { t, done } = tx(db, ["sessions", "turns", "frames"], "readwrite");
  const sessions = t.objectStore("sessions");

  let session = await call(sessions.get(code));
  const resumed = !!session;
  const now = Date.now();

  if (!session) {
    session = {
      id: code,
      code,
      title: title || code,
      startedAt: now,
      lastSeenAt: now,
      endedAt: null,
      turnCount: 0,
      frameCount: 0,
      bytes: 0,
      speakers: [],
      renamed: false,
      // Every join is one segment. Timestamps inside a recording are cumulative
      // content time, not wall clock — so rejoining the next day continues at 42:20
      // instead of jumping to 24:00:00.
      segments: [{ s: now, e: now }],
    };
  } else {
    session.segments = session.segments?.length
      ? session.segments
      : [{ s: session.startedAt, e: session.lastSeenAt }];
    session.segments.push({ s: now, e: now });
    session.lastSeenAt = now;
    session.endedAt = null;
    // Never overwrite a title the user renamed by hand.
    if (!session.renamed && title && title !== code) session.title = title;
  }
  sessions.put(session);

  const baseOffset = session.segments
    .slice(0, -1)
    .reduce((a, g) => a + Math.max(0, (g.e || g.s) - g.s), 0);

  const turns = await call(t.objectStore("turns").index("sid").getAll(code));
  const frames = await call(t.objectStore("frames").index("sid").getAll(code));
  await done;

  turns.sort((a, b) => a.seq - b.seq);
  const frameMetas = frames
    .map((f) => ({ fid: f.fid, hash: f.hash, ts: f.ts, w: f.w, h: f.h, size: f.size }))
    .sort((a, b) => a.fid - b.fid);

  return { session, turns, frameMetas, resumed, baseOffset, segmentStart: now };
}

/** Total content time of a recording, summed across every join. */
export function contentDuration(session) {
  const segs = session?.segments;
  if (!segs?.length) {
    return Math.max(0, (session?.endedAt || session?.lastSeenAt || 0) - (session?.startedAt || 0));
  }
  return segs.reduce((a, g) => a + Math.max(0, (g.e || g.s) - g.s), 0);
}

/** Upsert by [sid, seq] — calling again with the same seq updates instead of adding. */
export async function putTurns(sid, rows) {
  if (!rows?.length) return;
  const db = await openDB();
  const { t, done } = tx(db, ["turns", "sessions"], "readwrite");
  const store = t.objectStore("turns");
  for (const r of rows) store.put({ sid, ...r });

  const sessions = t.objectStore("sessions");
  const s = await call(sessions.get(sid));
  if (s) {
    const speakers = new Set(s.speakers || []);
    for (const r of rows) if (r.speaker) speakers.add(r.speaker);
    s.speakers = [...speakers];
    s.turnCount = Math.max(s.turnCount || 0, ...rows.map((r) => r.seq + 1));
    s.lastSeenAt = Date.now();
    if (s.segments?.length) s.segments[s.segments.length - 1].e = s.lastSeenAt;
    sessions.put(s);
  }
  await done;
}

export async function putFrame(sid, frame) {
  const db = await openDB();
  const { t, done } = tx(db, ["frames", "sessions"], "readwrite");
  t.objectStore("frames").put({ sid, ...frame });

  const sessions = t.objectStore("sessions");
  const s = await call(sessions.get(sid));
  if (s) {
    s.frameCount = Math.max(s.frameCount || 0, frame.fid);
    s.bytes = (s.bytes || 0) + (frame.size || 0);
    s.lastSeenAt = Date.now();
    if (s.segments?.length) s.segments[s.segments.length - 1].e = s.lastSeenAt;
    sessions.put(s);
  }
  await done;
}

export async function touchSession(sid) {
  const db = await openDB();
  const { t, done } = tx(db, ["sessions"], "readwrite");
  const store = t.objectStore("sessions");
  const s = await call(store.get(sid));
  if (s) {
    const now = Date.now();
    s.lastSeenAt = now;
    if (s.segments?.length) s.segments[s.segments.length - 1].e = now;
    store.put(s);
  }
  await done;
}

export async function endSession(sid) {
  const db = await openDB();
  const { t, done } = tx(db, ["sessions"], "readwrite");
  const store = t.objectStore("sessions");
  const s = await call(store.get(sid));
  if (s) {
    s.endedAt = Date.now();
    s.lastSeenAt = s.endedAt;
    if (s.segments?.length) s.segments[s.segments.length - 1].e = s.endedAt;
    store.put(s);
  }
  await done;
  return s || null;
}

/* ---------------- reads ---------------- */

export async function listSessions() {
  const db = await openDB();
  const { t, done } = tx(db, ["sessions"], "readonly");
  const all = await call(t.objectStore("sessions").getAll());
  await done;
  return all.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export async function getSession(sid) {
  const db = await openDB();
  const { t, done } = tx(db, ["sessions"], "readonly");
  const s = await call(t.objectStore("sessions").get(sid));
  await done;
  return s || null;
}

export async function getTurns(sid) {
  const db = await openDB();
  const { t, done } = tx(db, ["turns"], "readonly");
  const rows = await call(t.objectStore("turns").index("sid").getAll(sid));
  await done;
  return rows.sort((a, b) => a.at - b.at || a.seq - b.seq);
}

/** Includes each image's base64 — used when building markdown or the preview page. */
export async function getFrames(sid) {
  const db = await openDB();
  const { t, done } = tx(db, ["frames"], "readonly");
  const rows = await call(t.objectStore("frames").index("sid").getAll(sid));
  await done;
  return rows.sort((a, b) => a.fid - b.fid);
}

export async function renameSession(sid, title) {
  const db = await openDB();
  const { t, done } = tx(db, ["sessions"], "readwrite");
  const store = t.objectStore("sessions");
  const s = await call(store.get(sid));
  if (s) {
    s.title = title;
    s.renamed = true;
    store.put(s);
  }
  await done;
  return s || null;
}

/* ---------------- delete & prune ---------------- */

async function deleteByIndex(store, sid) {
  const req = store.index("sid").openKeyCursor(IDBKeyRange.only(sid));
  await new Promise((res, rej) => {
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return res();
      store.delete(cur.primaryKey);
      cur.continue();
    };
    req.onerror = () => rej(req.error);
  });
}

export async function deleteSession(sid) {
  const db = await openDB();
  const { t, done } = tx(db, ["sessions", "turns", "frames"], "readwrite");
  t.objectStore("sessions").delete(sid);
  await deleteByIndex(t.objectStore("turns"), sid);
  await deleteByIndex(t.objectStore("frames"), sid);
  await done;
}

/** Drop only the images and keep the text — text is a hundred times lighter. */
export async function dropFrames(sid) {
  const db = await openDB();
  const { t, done } = tx(db, ["sessions", "frames"], "readwrite");
  await deleteByIndex(t.objectStore("frames"), sid);
  const store = t.objectStore("sessions");
  const s = await call(store.get(sid));
  if (s) {
    s.bytes = 0;
    s.frameCount = 0;
    s.framesPruned = true;
    store.put(s);
  }
  await done;
}

export async function deleteAll() {
  const db = await openDB();
  const { t, done } = tx(db, ["sessions", "turns", "frames"], "readwrite");
  t.objectStore("sessions").clear();
  t.objectStore("turns").clear();
  t.objectStore("frames").clear();
  await done;
}

export async function usage() {
  const sessions = await listSessions();
  const imageBytes = sessions.reduce((a, s) => a + (s.bytes || 0), 0);
  let quota = 0, used = imageBytes;
  try {
    const est = await navigator.storage.estimate();
    quota = est.quota || 0;
    used = est.usage || imageBytes;
  } catch { /* no estimate() available: fall back to our own tally */ }
  return { sessions: sessions.length, imageBytes, used, quota };
}

/**
 * Prune by age limit and size limit. Images of the oldest recording go first; text
 * is only deleted once the recording is past the age limit.
 */
export async function prune({ retentionDays, maxBytes }) {
  const sessions = await listSessions();
  const now = Date.now();
  const report = { deleted: [], framesDropped: [] };

  for (const s of sessions) {
    if (s.endedAt == null && now - s.lastSeenAt < 86400000) continue; // still running
    if (retentionDays > 0 && now - s.lastSeenAt > retentionDays * 86400000) {
      await deleteSession(s.id);
      report.deleted.push(s.id);
    }
  }

  if (maxBytes > 0) {
    let live = (await listSessions()).filter((s) => (s.bytes || 0) > 0);
    let total = live.reduce((a, s) => a + s.bytes, 0);
    live.sort((a, b) => a.lastSeenAt - b.lastSeenAt); // oldest first
    for (const s of live) {
      if (total <= maxBytes) break;
      if (s.endedAt == null && now - s.lastSeenAt < 3600000) continue; // spare whatever is recording right now
      await dropFrames(s.id);
      total -= s.bytes;
      report.framesDropped.push(s.id);
    }
  }

  return report;
}
