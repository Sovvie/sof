"use strict";

const fs = require("fs");
const path = require("path");
const { INPUT_EXTENSIONS, isSupportedInput } = require("./plan");

const GLOB_CHARS = /[*?[\]{}()!]/;

/** Directory part of a glob before the first segment containing glob characters. */
function staticBase(pattern) {
  const segments = pattern.split("/");
  const keep = [];
  for (const seg of segments) {
    if (GLOB_CHARS.test(seg)) break;
    keep.push(seg);
  }
  if (keep.length === segments.length) keep.pop();
  return keep.join("/") || ".";
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_e) {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_e) {
    return false;
  }
}

/**
 * Expand inputs to [{ file, base }] (absolute paths). Throws if an input matches nothing.
 */
function collectInputs(inputs, { cwd = process.cwd(), recursive = true } = {}) {
  const fg = require("fast-glob");
  const exts = INPUT_EXTENSIONS.map((e) => e.slice(1)).join(",");
  const items = [];
  const seen = new Set();
  const add = (file, base) => {
    const abs = path.resolve(file);
    if (seen.has(abs) || !isSupportedInput(abs)) return;
    seen.add(abs);
    items.push({ file: abs, base: path.resolve(base) });
  };

  for (const input of inputs) {
    const abs = path.resolve(cwd, input);
    if (isDir(abs)) {
      const found = fg.sync(`${recursive ? "**/" : ""}*.{${exts}}`, {
        cwd: abs,
        absolute: true,
        onlyFiles: true,
        caseSensitiveMatch: false,
        ignore: ["**/node_modules/**"],
      });
      found.sort().forEach((f) => add(f, abs));
      continue;
    }
    if (isFile(abs)) {
      if (!isSupportedInput(abs)) throw new Error(`Unsupported image type: ${input}`);
      add(abs, path.dirname(abs));
      continue;
    }
    const pattern = input.split(path.sep).join("/");
    if (!GLOB_CHARS.test(pattern)) throw new Error(`No such file or folder: ${input}`);
    const found = fg.sync(pattern, { cwd, absolute: true, onlyFiles: true, caseSensitiveMatch: false });
    const base = path.resolve(cwd, staticBase(pattern));
    found.sort().forEach((f) => add(f, base));
  }

  if (items.length === 0) throw new Error("No images found for the given inputs.");
  return items;
}

module.exports = { collectInputs, staticBase };
