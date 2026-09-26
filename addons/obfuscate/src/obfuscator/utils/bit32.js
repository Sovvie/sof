"use strict";

function toUint32(value) {
  return Number(value) >>> 0;
}

function toInt32(value) {
  return (Number(value) >> 0);
}

function normalizeShift(bits) {
  return Number(bits) & 31;
}

function bxor(...args) {
  let out = 0;
  for (const arg of args) {
    out ^= toUint32(arg);
  }
  return toUint32(out);
}

function band(...args) {
  if (args.length === 0) {
    return 0xffffffff >>> 0;
  }
  let out = 0xffffffff >>> 0;
  for (const arg of args) {
    out &= toUint32(arg);
  }
  return toUint32(out);
}

function bor(...args) {
  let out = 0;
  for (const arg of args) {
    out |= toUint32(arg);
  }
  return toUint32(out);
}

function bnot(value) {
  return toUint32(~toUint32(value));
}

function lshift(value, bits) {
  return toUint32(toUint32(value) << normalizeShift(bits));
}

function rshift(value, bits) {
  return toUint32(toUint32(value) >>> normalizeShift(bits));
}

function arshift(value, bits) {
  return toUint32(toInt32(value) >> normalizeShift(bits));
}

module.exports = {
  toUint32,
  bxor,
  band,
  bor,
  bnot,
  lshift,
  rshift,
  arshift,
};
