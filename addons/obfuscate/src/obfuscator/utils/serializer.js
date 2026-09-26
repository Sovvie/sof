"use strict";

const bit32 = require("./bit32");

function newWriter() {
  const buffer = [];
  let byte = 0;
  let bits = 0;

  function flush() {
    if (bits > 0) {
      buffer.push(byte & 0xff);
      byte = 0;
      bits = 0;
    }
  }

  function writeBit(bit) {
    byte = bit32.bor(byte, bit32.lshift(bit32.band(bit, 1), bits));
    bits += 1;
    if (bits === 8) {
      buffer.push(byte & 0xff);
      byte = 0;
      bits = 0;
    }
  }

  function writeBits(value, count) {
    for (let i = 0; i < count; i += 1) {
      writeBit(bit32.rshift(value, i));
    }
  }

  function writeByte(value) {
    writeBits(value & 0xff, 8);
  }

  function writeVint(value) {
    let val = Number(value) >>> 0;
    while (val >= 128) {
      writeByte(bit32.bor(bit32.band(val, 127), 128));
      val = bit32.rshift(val, 7);
    }
    writeByte(val);
  }

  return {
    writeNil() {
      writeBits(0, 3);
    },
    writeBool(v) {
      writeBits(1, 3);
      writeBit(v ? 1 : 0);
    },
    writeNumber(v) {
      writeBits(2, 3);
      const bytes = Buffer.allocUnsafe(8);
      bytes.writeDoubleLE(Number(v), 0);
      for (let i = 0; i < 8; i += 1) {
        writeByte(bytes[i]);
      }
    },
    writeString(v) {
      const value = String(v);
      writeBits(3, 3);
      writeVint(Buffer.byteLength(value, "utf8"));
      const raw = Buffer.from(value, "utf8");
      for (const b of raw) {
        writeByte(b);
      }
    },
    export() {
      flush();
      return Buffer.from(buffer);
    },
  };
}

function newReader(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || "", "binary");
  let pos = 0;
  let bitPos = 0;

  function readBit() {
    const current = bytes[pos] || 0;
    const bit = bit32.band(bit32.rshift(current, bitPos), 1);
    bitPos += 1;
    if (bitPos === 8) {
      pos += 1;
      bitPos = 0;
    }
    return bit;
  }

  function readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      value = bit32.bor(value, bit32.lshift(readBit(), i));
    }
    return value;
  }

  function readByte() {
    return readBits(8);
  }

  function readVint() {
    let value = 0;
    let shift = 0;
    while (true) {
      const b = readByte();
      value = bit32.bor(value, bit32.lshift(bit32.band(b, 127), shift));
      if (bit32.band(b, 128) === 0) break;
      shift += 7;
    }
    return value >>> 0;
  }

  return {
    read() {
      const tag = readBits(3);
      if (tag === 0) return null;
      if (tag === 1) return readBit() === 1;
      if (tag === 2) {
        const raw = Buffer.allocUnsafe(8);
        for (let i = 0; i < 8; i += 1) {
          raw[i] = readByte();
        }
        return raw.readDoubleLE(0);
      }
      if (tag === 3) {
        const len = readVint();
        const raw = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1) {
          raw[i] = readByte();
        }
        return raw.toString("utf8");
      }
      return null;
    },
  };
}

module.exports = {
  newWriter,
  newReader,
};
