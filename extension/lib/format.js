/* Number and date formatting for every surface. Kept in one place so the popup,
   options page and preview never disagree on how a value is displayed.
   The returned strings are user-facing and stay in Vietnamese. */

export function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h) return `${h} giờ ${String(m).padStart(2, "0")} phút`;
  if (m) return `${m} phút`;
  return `${s} giây`;
}

export function bytes(n) {
  if (!n) return "0 KB";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0).replace(".", ",") + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1).replace(".", ",") + " MB";
  return (n / 1073741824).toFixed(2).replace(".", ",") + " GB";
}

const DAY = 86400000;

/** "Hôm nay 09:15" (today) / "Hôm qua 14:00" (yesterday) / "27.07 09:05" */
export function whenLabel(ts) {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const midnight = new Date().setHours(0, 0, 0, 0);
  if (ts >= midnight) return `Hôm nay ${hm}`;
  if (ts >= midnight - DAY) return `Hôm qua ${hm}`;
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${hm}`;
}

export function fileStamp(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Download file name — keeps only characters that are safe on every OS. */
export function safeFileName(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
}
