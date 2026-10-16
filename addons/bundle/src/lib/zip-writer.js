"use strict";

const fs = require("fs");
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// MS-DOS date/time (UTC, 1980-2107).
function dosDateTime(date) {
  const d = new Date(Math.max(date.getTime(), Date.UTC(1980, 0, 1)));
  const year = Math.min(d.getUTCFullYear(), 2107);
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

const LIMIT = 0xffffffff;

// Writes a zip (no zip64) of entries [{ name, data|abs, mode, mtime }] to `file`. Deterministic for the same input.
// Entries are written in the order given. Each entry: name (posix path), abs (file to read), mode (unix permissions), mtime (Date).
function writeZip(entries, file) {
  if (entries.length > 0xffff) {
    throw new Error("Too many files for a .zip (65535 at most); use --format tar.gz.");
  }
  const fd = fs.openSync(file, "w");
  let offset = 0;
  const central = [];
  const put = (buffer) => {
    let done = 0;
    while (done < buffer.length) done += fs.writeSync(fd, buffer, done, buffer.length - done);
    offset += buffer.length;
  };
  try {
    for (const entry of entries) {
      const raw = fs.readFileSync(entry.abs);
      const name = Buffer.from(entry.name, "utf8");
      if (raw.length > LIMIT || offset > LIMIT - raw.length) {
        throw new Error(`The archive would pass 4 GB, which .zip can't hold here; use --format tar.gz.`);
      }
      let method = 0;
      let data = raw;
      if (raw.length > 0) {
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        if (deflated.length < raw.length) {
          method = 8;
          data = deflated;
        }
      }
      const { date, time } = dosDateTime(entry.mtime);
      const crc = crc32(raw);
      const flags = 0x0800; // UTF-8 names
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(method === 8 ? 20 : 10, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const headerOffset = offset;
      put(local);
      put(name);
      put(data);
      central.push({ name, method, time, date, crc, flags, size: data.length, rawSize: raw.length, mode: entry.mode, headerOffset });
    }
    const centralStart = offset;
    for (const c of central) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE((3 << 8) | 20, 4); // made by: unix
      head.writeUInt16LE(c.method === 8 ? 20 : 10, 6);
      head.writeUInt16LE(c.flags, 8);
      head.writeUInt16LE(c.method, 10);
      head.writeUInt16LE(c.time, 12);
      head.writeUInt16LE(c.date, 14);
      head.writeUInt32LE(c.crc, 16);
      head.writeUInt32LE(c.size, 20);
      head.writeUInt32LE(c.rawSize, 24);
      head.writeUInt16LE(c.name.length, 28);
      head.writeUInt32LE((((0o100000 | (c.mode & 0o7777)) << 16) >>> 0), 38);
      head.writeUInt32LE(c.headerOffset, 42);
      put(head);
      put(c.name);
    }
    const centralSize = offset - centralStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    put(end);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { writeZip, crc32 };
