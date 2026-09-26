"use strict";

function randInt(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("randInt expects finite min/max values.");
  }
  if (max < min) {
    throw new Error(`randInt invalid range: min=${min}, max=${max}`);
  }
  const low = Math.floor(min);
  const high = Math.floor(max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function chance(probability) {
  return Math.random() < probability;
}

function pick(array) {
  if (!Array.isArray(array) || array.length === 0) {
    throw new Error("pick expects a non-empty array.");
  }
  return array[randInt(0, array.length - 1)];
}

function shuffleInPlace(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = randInt(0, i);
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

module.exports = {
  randInt,
  chance,
  pick,
  shuffleInPlace,
};
