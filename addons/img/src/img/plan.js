"use strict";

const path = require("path");

const INPUT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".tif", ".tiff"];
const EXT_TO_FORMAT = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
  ".avif": "avif",
  ".gif": "gif",
  ".tif": "tiff",
  ".tiff": "tiff",
};
const FORMAT_TO_EXT = { png: ".png", jpeg: ".jpg", webp: ".webp", avif: ".avif", gif: ".gif", tiff: ".tiff" };

function isSupportedInput(file) {
  return INPUT_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

function formatOfFile(file) {
  return EXT_TO_FORMAT[path.extname(file).toLowerCase()] || null;
}

/**
 * Decide where one input goes.
 * item: { file (absolute), base (absolute dir used for mirroring) }
 * returns { src, dest, format, sameFile, keepOnlyIfSmaller, deleteSource }
 */
function planOutput(item, options) {
  const src = path.resolve(item.file);
  const srcFormat = formatOfFile(src);
  const format = options.format || srcFormat;
  const parsed = path.parse(src);
  const sameExt = format === srcFormat;
  const ext = sameExt ? parsed.ext : FORMAT_TO_EXT[format];

  let dest;
  if (options.out) {
    const rel = path.relative(item.base, src);
    const relDir = rel.startsWith("..") || path.isAbsolute(rel) ? "" : path.dirname(rel);
    dest = path.join(path.resolve(options.out), relDir, parsed.name + ext);
  } else if (options.inPlace) {
    dest = path.join(parsed.dir, parsed.name + ext);
  } else {
    dest = path.join(parsed.dir, parsed.name + (sameExt ? ".min" + ext : ext));
  }

  // Never overwrite the source unless --in-place asked for it.
  if (dest === src && !options.inPlace) {
    dest = path.join(parsed.dir, parsed.name + ".min" + parsed.ext);
  }

  const sameFile = dest === src;
  return {
    src,
    dest,
    format,
    sameFile,
    keepOnlyIfSmaller: Boolean(options.inPlace) && sameFile,
    deleteSource: Boolean(options.inPlace && options.deleteSource) && !sameFile,
  };
}

/** Plan all items; later items that map to an already-used destination get an `error`. */
function planAll(items, options) {
  const seen = new Map();
  return items.map((item) => {
    const plan = planOutput(item, options);
    const key = process.platform === "win32" ? plan.dest.toLowerCase() : plan.dest;
    if (seen.has(key)) {
      return {
        ...plan,
        error: `output ${plan.dest} would also be written by ${seen.get(key)}`,
      };
    }
    seen.set(key, plan.src);
    return plan;
  });
}

module.exports = { INPUT_EXTENSIONS, isSupportedInput, formatOfFile, planOutput, planAll };
