"use strict";

function compress(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input || "");
  const output = [];
  let pos = 0;

  while (pos < data.length) {
    let bestLen = 0;
    let bestDist = 0;

    const maxDist = Math.min(pos, 4095);
    for (let dist = 1; dist <= maxDist; dist += 1) {
      const start = pos - dist;
      let len = 0;
      while (
        len < 255 &&
        pos + len < data.length &&
        data[start + len] === data[pos + len]
      ) {
        len += 1;
      }
      if (len > bestLen) {
        bestLen = len;
        bestDist = dist;
      }
    }

    if (bestLen > 3) {
      output.push(0);
      const packed = Buffer.allocUnsafe(3);
      packed.writeUInt16LE(bestDist, 0);
      packed.writeUInt8(bestLen, 2);
      output.push(...packed);
      pos += bestLen;
    } else {
      const byte = data[pos];
      if (byte === 0) {
        output.push(0, 0, 0);
      } else {
        output.push(byte);
      }
      pos += 1;
    }
  }

  return Buffer.from(output);
}

function decompress(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input || "");
  const output = [];
  let pos = 0;

  while (pos < data.length) {
    const byte = data[pos];
    if (byte === 0) {
      const nextByte = data[pos + 1];
      if (nextByte === 0) {
        output.push(0);
        pos += 2;
      } else {
        const dist = data.readUInt16LE(pos + 1);
        const len = data.readUInt8(pos + 3);
        const start = output.length - dist;
        for (let i = 0; i < len; i += 1) {
          output.push(output[start + i]);
        }
        pos += 4;
      }
    } else {
      output.push(byte);
      pos += 1;
    }
  }

  return Buffer.from(output);
}

module.exports = {
  compress,
  decompress,
};
