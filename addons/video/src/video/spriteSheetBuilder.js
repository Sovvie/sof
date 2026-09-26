"use strict";

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { MaxRects } = require("./maxRects");
const { downsampleRGBA } = require("./BsplineDownsampler");
const { findBestScale } = require("./qualityAnalyzer");

const SHEET_SIZE = 1024;
const PADDING    = 2;

function blitRGBA(dst, dstStride, src, srcW, srcH, x, y) {
  for (let row = 0; row < srcH; row++) {
    const srcOff = row * srcW * 4;
    const dstOff = ((y + row) * dstStride + x) * 4;
    dst.set(src.subarray(srcOff, srcOff + srcW * 4), dstOff);
  }
}

function savePNG(sheetRGBA, outDir, sheetIndex, cropW, cropH) {
  const num  = String(sheetIndex).padStart(2, "0");
  const name = `spritesheet_${num}.png`;
  const w = cropW || SHEET_SIZE;
  const h = cropH || SHEET_SIZE;

  let data;
  if (w === SHEET_SIZE && h === SHEET_SIZE) {
    data = Buffer.from(sheetRGBA.buffer, sheetRGBA.byteOffset, sheetRGBA.byteLength);
  } else {
    const cropped = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const srcOff = row * SHEET_SIZE * 4;
      const dstOff = row * w * 4;
      cropped.set(sheetRGBA.subarray(srcOff, srcOff + w * 4), dstOff);
    }
    data = Buffer.from(cropped.buffer, cropped.byteOffset, cropped.byteLength);
  }

  const png  = new PNG({ width: w, height: h, filterType: -1 });
  png.data   = data;
  const outPath = path.join(outDir, name);
  fs.writeFileSync(outPath, PNG.sync.write(png));
  console.log(`  \u2714  Saved ${name} (${w}\u00D7${h})`);
  return outPath;
}

/**
 * Write the Luau manifest for the packed spritesheets.
 *
 * @param {string}   outDir
 * @param {Array}    allPlacements
 * @param {number}   sheetCount
 * @param {number}   scale
 * @param {Object}   [sheetAssetIds]  Optional map of sheet index (1-based) to asset ID string.
 * @param {Object}   [sheetSizes]     Optional map of sheet index (1-based) to { width, height }.
 */
function writeManifest(outDir, allPlacements, sheetCount, scale, sheetAssetIds, sheetSizes) {
  const animations = new Map();

  for (const p of allPlacements) {
    const name = path.basename(p.source).replace(/\.[^/.]+$/, "");
    if (!animations.has(name))
      animations.set(name, { fps: p.fps ?? 30, frames: [] });
    animations.get(name).frames.push({
      index: p.frame + 1,
      sheet: p.sheet,
      x: p.x, y: p.y,
      w: p.w, h: p.h,
    });
  }

  for (const anim of animations.values())
    anim.frames.sort((a, b) => a.index - b.index);

  const L = [];

  L.push("--!strict");
  L.push(`-- Auto-generated sprite sheet manifest`);
  L.push(`-- Scale: ${scale}  |  Max sheet size: ${SHEET_SIZE}x${SHEET_SIZE}`);
  L.push(``);
  L.push(`local Manifest = {}`);
  L.push(``);

  L.push(`Manifest.sheets = {`);
  for (let i = 1; i <= sheetCount; i++) {
    const assetId = sheetAssetIds && sheetAssetIds[i];
    const size    = sheetSizes && sheetSizes[i];
    const assetStr = assetId ? `"${assetId}"` : `0`;
    const w = size ? size.width  : SHEET_SIZE;
    const h = size ? size.height : SHEET_SIZE;
    L.push(`\t[${i}] = { asset = ${assetStr}, width = ${w}, height = ${h} },`);
  }
  L.push(`}`);
  L.push(``);

  L.push(`Manifest.animations = {`);
  L.push(``);

  for (const [name, anim] of animations) {
    const fc  = anim.frames.length;
    const idxW = String(fc).length;
    const xW  = Math.max(...anim.frames.map(f => String(f.x).length));
    const yW  = Math.max(...anim.frames.map(f => String(f.y).length));
    const wW  = Math.max(...anim.frames.map(f => String(f.w).length));
    const hW  = Math.max(...anim.frames.map(f => String(f.h).length));
    const shW = Math.max(...anim.frames.map(f => String(f.sheet).length));

    L.push(`\t["${name}"] = {`);
    L.push(`\t\tframeCount = ${fc},`);
    L.push(`\t\tfps        = ${anim.fps},`);
    L.push(`\t\tframes     = {`);

    for (const f of anim.frames) {
      const idx = String(f.index).padStart(idxW);
      const sh  = String(f.sheet).padStart(shW);
      const x   = String(f.x).padStart(xW);
      const y   = String(f.y).padStart(yW);
      const w   = String(f.w).padStart(wW);
      const h   = String(f.h).padStart(hW);
      L.push(`\t\t\t[${idx}] = { sheet = ${sh}, x = ${x}, y = ${y}, w = ${w}, h = ${h} },`);
    }

    L.push(`\t\t},`);
    L.push(`\t},`);
    L.push(``);
  }

  L.push(`}`);
  L.push(``);
  L.push(`return Manifest`);
  L.push(``);

  const manifestPath = path.join(outDir, "manifest.luau");
  fs.writeFileSync(manifestPath, L.join("\n"));
  console.log(`  \u2714  Saved manifest.luau`);
  return manifestPath;
}

/**
 * Build sprite sheets from extracted video frames.
 *
 * Returns the file paths and placement data so the caller can upload
 * the PNGs and then write the manifest with real asset IDs.
 *
 * @returns {{ sheetPaths: string[], sheetCount: number, placements: Array, scale: number, sheetSizes: Object }}
 */
function buildSpriteSheets(frames, outDir, options = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const { autoScale = false, minPsnr = 32 } = options;
  let   { scale = 0.5 } = options;

  if (autoScale) {
    console.log("  Auto-scale: sampling representative frame\u2026");
    const sample = frames[Math.floor(frames.length / 2)];
    scale = findBestScale(sample.rgba, sample.width, sample.height, minPsnr);
    console.log(`  Auto-scale selected: ${(scale * 100).toFixed(0)}%  (PSNR \u2265 ${minPsnr} dB)`);
  } else {
    console.log(`  Using fixed scale: ${(scale * 100).toFixed(0)}%`);
  }

  console.log(`  Downsampling ${frames.length} frame(s)\u2026`);
  const sprites = frames.map((f, i) => {
    const dstW = Math.max(1, Math.floor(f.width  * scale));
    const dstH = Math.max(1, Math.floor(f.height * scale));
    if ((i + 1) % 50 === 0 || i === frames.length - 1)
      process.stdout.write(`\r    ${i + 1}/${frames.length}`);
    const { rgba, width, height } = downsampleRGBA(f.rgba, f.width, f.height, dstW, dstH);
    return { rgba, width, height, source: f.source, frame: f.index,
             fps: f.fps, srcW: f.width, srcH: f.height };
  });
  process.stdout.write("\n");

  sprites.sort((a, b) => b.height - a.height);

  const packer       = new MaxRects(SHEET_SIZE, SHEET_SIZE);
  let   sheetRGBA    = new Uint8Array(SHEET_SIZE * SHEET_SIZE * 4);
  let   sheetIdx     = 1;
  let   sheetSprites = 0;
  const allPlacements = [];
  const sheetPaths    = [];
  const sheetSizes    = {};
  let   sheetPlaceStart = 0;

  const flushSheet = () => {
    if (sheetSprites === 0) return;

    let cropW = 0, cropH = 0;
    for (let i = sheetPlaceStart; i < allPlacements.length; i++) {
      const p = allPlacements[i];
      cropW = Math.max(cropW, p.x + p.w);
      cropH = Math.max(cropH, p.y + p.h);
    }

    sheetSizes[sheetIdx] = { width: cropW, height: cropH };
    sheetPaths.push(savePNG(sheetRGBA, outDir, sheetIdx, cropW, cropH));
    sheetIdx++;
    sheetSprites = 0;
    sheetPlaceStart = allPlacements.length;
    packer.reset();
    sheetRGBA = new Uint8Array(SHEET_SIZE * SHEET_SIZE * 4);
  };

  let pending = [...sprites];

  while (pending.length > 0) {
    const placed = [];

    for (let i = 0; i < pending.length; i++) {
      const sp = pending[i];

      if (sp.width > SHEET_SIZE || sp.height > SHEET_SIZE) {
        console.warn(`  \u26A0  Frame too large (${sp.width}\u00D7${sp.height}), skipping.`);
        placed.push(i);
        continue;
      }

      const rect = packer.insert(sp.width + PADDING, sp.height + PADDING);
      if (rect) {
        blitRGBA(sheetRGBA, SHEET_SIZE, sp.rgba, sp.width, sp.height, rect.x, rect.y);
        allPlacements.push({
          source: sp.source, frame: sp.frame, fps: sp.fps,
          sheet:  sheetIdx,
          x: rect.x, y: rect.y, w: sp.width, h: sp.height,
        });
        sheetSprites++;
        placed.push(i);
      }
    }

    pending = pending.filter((_, i) => !placed.includes(i));

    if (placed.length === 0 && pending.length > 0) {
      flushSheet();
      continue;
    }
  }

  flushSheet();

  const sheetCount = sheetIdx - 1;
  console.log(`\n  \u2714  Done \u2014 ${sheetCount} sheet(s) in "${outDir}"`);

  return { sheetPaths, sheetCount, placements: allPlacements, scale, sheetSizes };
}

module.exports = { buildSpriteSheets, writeManifest, SHEET_SIZE };
