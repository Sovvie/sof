"use strict";

const fs = require("fs");
const zlib = require("zlib");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

const MAX_OCTAL_11 = 0o77777777777; // 8 GiB - 1

function octal(value, length) {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function header({ name, size, mode, mtime, type, prefix = "" }) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write(octal(mode & 0o7777, 8), 100, "latin1");
  block.write(octal(0, 8), 108, "latin1");
  block.write(octal(0, 8), 116, "latin1");
  block.write(octal(size, 12), 124, "latin1");
  block.write(octal(mtime, 12), 136, "latin1");
  block.fill(0x20, 148, 156);
  block.write(type, 156, "latin1");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  if (prefix) block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += block[i];
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return block;
}

function pad(length) {
  const rest = length % 512;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - rest);
}

// Split a long path into ustar prefix/name when possible, else null.
function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { prefix: "", name };
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (rest && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { prefix, name: rest };
  }
  return null;
}

function* tarBlocks(entries) {
  for (const entry of entries) {
    const raw = fs.readFileSync(entry.abs);
    if (raw.length > MAX_OCTAL_11) throw new Error(`${entry.name} is too large for a tar entry.`);
    const mtime = Math.max(0, Math.floor(entry.mtime.getTime() / 1000));
    const split = splitName(entry.name);
    let fields;
    if (split) {
      fields = { name: split.name, prefix: split.prefix };
    } else {
      // GNU long name entry, understood by every tar
      const long = Buffer.from(entry.name + "\0", "utf8");
      yield header({ name: "././@LongLink", size: long.length, mode: 0o644, mtime: 0, type: "L" });
      yield long;
      yield pad(long.length);
      fields = { name: Buffer.from(entry.name).subarray(0, 100).toString("utf8").replace(/�$/, "") };
    }
    yield header({ ...fields, size: raw.length, mode: entry.mode, mtime, type: "0" });
    yield raw;
    yield pad(raw.length);
  }
  yield Buffer.alloc(1024);
}

// zlib stamps the OS of the build in byte 9 of the gzip header; pin it so Windows and Linux agree.
function pinGzipHeader() {
  let first = true;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (first && chunk.length > 9) {
        chunk[9] = 3;
        first = false;
      }
      cb(null, chunk);
    },
  });
}

// Writes entries [{ name, abs, mode, mtime }] as a ustar .tar.gz to `file`; deterministic for the same input.
async function writeTarGz(entries, file) {
  const { Readable } = require("stream");
  await pipeline(
    Readable.from(tarBlocks(entries), { objectMode: false }),
    zlib.createGzip({ level: 9 }),
    pinGzipHeader(),
    fs.createWriteStream(file)
  );
}

module.exports = { writeTarGz };
