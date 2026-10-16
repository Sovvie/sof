"use strict";

const fs = require("fs");
const path = require("path");

function loadSharp() {
  return require("sharp");
}

function encoderOptions(format, options) {
  const quality = options.quality;
  switch (format) {
    case "png":
      return options.lossless
        ? { compressionLevel: 9, effort: 8 }
        : { compressionLevel: 9, effort: 8, palette: quality < 100, quality };
    case "jpeg":
      return { quality, mozjpeg: true };
    case "webp":
      return { quality, lossless: Boolean(options.lossless), effort: 4 };
    case "avif":
      return { quality, lossless: Boolean(options.lossless), effort: 4 };
    case "tiff":
      return { quality, compression: "lzw" };
    default:
      return {};
  }
}

/** Encode one image to a Buffer. Pure sharp work, no file writes. */
async function encode(src, format, options) {
  const sharp = loadSharp();
  const animated = format === "webp" || format === "gif";
  let img = sharp(src, { animated, failOn: "error" }).rotate();
  if (options.width || options.height) {
    img = img.resize({
      width: options.width,
      height: options.height,
      fit: options.fit || "inside",
      withoutEnlargement: !options.enlarge,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  if (options.keepMetadata) img = img.keepMetadata();
  img = img.toFormat(format, encoderOptions(format, options));
  return img.toBuffer();
}

/** Run one plan entry. Returns a result object; never throws. */
async function processOne(plan, options) {
  const result = { src: plan.src, dest: plan.dest, status: "ok", inBytes: 0, outBytes: 0 };
  try {
    if (plan.error) throw new Error(plan.error);
    result.inBytes = fs.statSync(plan.src).size;
    const buffer = await encode(plan.src, plan.format, options);
    result.outBytes = buffer.length;

    if (plan.keepOnlyIfSmaller && buffer.length >= result.inBytes) {
      result.status = "skipped";
      result.reason = "not smaller";
      return result;
    }
    if (options.dryRun) return result;

    fs.mkdirSync(path.dirname(plan.dest), { recursive: true });
    const tmp = `${plan.dest}.sof-img-${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, plan.dest);
    if (plan.deleteSource) fs.unlinkSync(plan.src);
    return result;
  } catch (err) {
    return { src: plan.src, dest: plan.dest, status: "failed", inBytes: result.inBytes, outBytes: 0, error: err.message };
  }
}

module.exports = { encode, processOne, encoderOptions };
