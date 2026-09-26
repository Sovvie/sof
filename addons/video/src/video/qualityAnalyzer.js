"use strict";

const { downsampleRGBA } = require("./BsplineDownsampler");

function bilinearUpsample(src, srcW, srcH, dstW, dstH) {
  const dst    = new Uint8Array(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = (dx + 0.5) * scaleX - 0.5;
      const sy = (dy + 0.5) * scaleY - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(srcW - 1, x0 + 1);
      const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(srcH - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const di = (dy * dstW + dx) * 4;

      for (let c = 0; c < 4; c++) {
        const v00 = src[(y0 * srcW + x0) * 4 + c];
        const v10 = src[(y0 * srcW + x1) * 4 + c];
        const v01 = src[(y1 * srcW + x0) * 4 + c];
        const v11 = src[(y1 * srcW + x1) * 4 + c];
        dst[di + c] = Math.round(
          v00*(1-fx)*(1-fy) + v10*fx*(1-fy) + v01*(1-fx)*fy + v11*fx*fy
        );
      }
    }
  }
  return dst;
}

function psnr(a, b, len) {
  let mse = 0, count = 0;
  for (let i = 0; i < len; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c];
      mse += d * d;
      count++;
    }
  }
  mse /= count;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

function findBestScale(rgba, width, height, minPsnr = 32) {
  const SCALES = [0.5, 0.45, 0.40, 0.35, 0.30, 0.25, 0.20];
  let bestScale = 0.5;

  for (const scale of SCALES) {
    const dstW = Math.max(1, Math.floor(width  * scale));
    const dstH = Math.max(1, Math.floor(height * scale));

    const { rgba: down } = downsampleRGBA(rgba, width, height, dstW, dstH);
    const up              = bilinearUpsample(down, dstW, dstH, width, height);
    const score           = psnr(rgba, up, rgba.length);

    if (score >= minPsnr) {
      bestScale = scale;
    } else {
      break;
    }
  }

  return bestScale;
}

module.exports = { findBestScale };
