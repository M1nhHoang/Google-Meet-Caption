/* A ZIP writer in one file — no library, because the project has no build step and a
   remote script would be blocked by the extension CSP anyway.

   Only what an export bundle needs: every entry's size is known before it is written, so
   there are no data descriptors and no streaming. Names are written as UTF-8 with bit 11
   set, which is what keeps Vietnamese file names intact in Explorer and unzip.

   No ZIP64: sizes and offsets are 4 bytes, so a bundle stops at 4 GB and 65 535 entries.
   Both limits sit far above the pruning cap, and add() / finish() throw a plain message
   instead of writing a corrupt archive if one is ever hit. */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const STORE = 0;
const DEFLATE = 8;
const UTF8_NAME = 0x0800; // general purpose bit 11

const U32_MAX = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/* Bytes go into a Blob every 8 MB. Blob data lives in the browser's own store (spilled
   to disk when large), so the JS heap stays flat no matter how big the archive gets. */
const FLUSH_AT = 8 << 20;

let crcTable = null;

function table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

export function crc32(bytes) {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* deflate-raw landed in Chrome 103. Without it every entry is stored, which still
   produces a valid archive — just a larger one. */
const canDeflate = (() => {
  try {
    new CompressionStream("deflate-raw");
    return true;
  } catch {
    return false;
  }
})();

async function deflateRaw(raw) {
  const packed = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(packed).arrayBuffer());
}

/** MS-DOS timestamp: 2-second resolution, epoch 1980. */
function dosStamp(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function localHeader(e) {
  const h = new Uint8Array(30 + e.name.length);
  const v = new DataView(h.buffer);
  v.setUint32(0, SIG_LOCAL, true);
  v.setUint16(4, 20, true); // version needed: 2.0
  v.setUint16(6, UTF8_NAME, true);
  v.setUint16(8, e.method, true);
  v.setUint16(10, e.time, true);
  v.setUint16(12, e.date, true);
  v.setUint32(14, e.crc, true);
  v.setUint32(18, e.csize, true);
  v.setUint32(22, e.usize, true);
  v.setUint16(26, e.name.length, true);
  v.setUint16(28, 0, true); // no extra field
  h.set(e.name, 30);
  return h;
}

function centralHeader(e) {
  const h = new Uint8Array(46 + e.name.length);
  const v = new DataView(h.buffer);
  v.setUint32(0, SIG_CENTRAL, true);
  v.setUint16(4, 20, true); // version made by
  v.setUint16(6, 20, true); // version needed
  v.setUint16(8, UTF8_NAME, true);
  v.setUint16(10, e.method, true);
  v.setUint16(12, e.time, true);
  v.setUint16(14, e.date, true);
  v.setUint32(16, e.crc, true);
  v.setUint32(20, e.csize, true);
  v.setUint32(24, e.usize, true);
  v.setUint16(28, e.name.length, true);
  // extra, comment, disk number, internal + external attributes all stay zero
  v.setUint32(42, e.offset, true);
  h.set(e.name, 46);
  return h;
}

function endRecord(count, cdSize, cdOffset) {
  const h = new Uint8Array(22);
  const v = new DataView(h.buffer);
  v.setUint32(0, SIG_EOCD, true);
  v.setUint16(8, count, true); // entries on this disk
  v.setUint16(10, count, true); // entries total
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  return h;
}

/**
 * createZip() → { add, finish }
 *
 *   const zip = createZip({ modifiedAt });
 *   await zip.add("folder/notes.md", "# text");        // deflated
 *   await zip.add("folder/a.webp", bytes, { compress: false });  // stored as-is
 *   const blob = zip.finish();
 *
 * Every entry shares one timestamp — a bundle is one export, not a set of files with
 * separate histories.
 */
export function createZip({ modifiedAt = Date.now() } = {}) {
  const enc = new TextEncoder();
  const { time, date } = dosStamp(modifiedAt);

  const entries = [];
  const blobs = [];
  let pending = [];
  let pendingBytes = 0;
  let offset = 0;

  const write = (chunk) => {
    pending.push(chunk);
    pendingBytes += chunk.length;
    offset += chunk.length;
  };

  const flush = () => {
    if (!pending.length) return;
    blobs.push(new Blob(pending));
    pending = [];
    pendingBytes = 0;
  };

  const tooBig = () =>
    new Error("Gói đã vượt 4 GB — không đóng được vào một file zip. Hãy tải riêng .md.");

  return {
    /**
     * @param {string} path      path inside the archive, "/" separated
     * @param {string|Uint8Array} data
     * @param {object} opts      compress: false for data that is already compressed
     */
    async add(path, data, { compress = true } = {}) {
      const raw = typeof data === "string" ? enc.encode(data) : data;
      const name = enc.encode(path);

      let body = raw;
      let method = STORE;
      // Deflating an image that is already WebP or JPEG costs time and gains nothing;
      // callers pass compress:false for those. Tiny entries are not worth a stream.
      if (compress && canDeflate && raw.length > 64) {
        const packed = await deflateRaw(raw);
        if (packed.length < raw.length) {
          body = packed;
          method = DEFLATE;
        }
      }

      if (raw.length > U32_MAX || offset + 30 + name.length + body.length > U32_MAX) {
        throw tooBig();
      }

      // The same record describes the local header now and the central directory later,
      // which is exactly why offset is captured before anything is written.
      const entry = {
        name,
        method,
        time,
        date,
        crc: crc32(raw),
        csize: body.length,
        usize: raw.length,
        offset,
      };
      entries.push(entry);

      write(localHeader(entry));
      write(body);
      if (pendingBytes >= FLUSH_AT) flush();

      return { path, size: raw.length, packed: body.length, method };
    },

    /** Writes the central directory and returns the finished archive. */
    finish() {
      if (entries.length > MAX_ENTRIES) {
        throw new Error(`Gói có ${entries.length} file, vượt giới hạn ${MAX_ENTRIES} của zip.`);
      }
      const cdOffset = offset;
      for (const e of entries) write(centralHeader(e));
      if (offset > U32_MAX) throw tooBig();
      write(endRecord(entries.length, offset - cdOffset, cdOffset));
      flush();
      return new Blob(blobs, { type: "application/zip" });
    },
  };
}
