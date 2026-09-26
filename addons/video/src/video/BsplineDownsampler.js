"use strict";

const L_BS3 = [
  0.2,        0.26315789, 0.26760563, 0.26792453,
  0.26794742, 0.26794907, 0.26794918, 0.26794919,
];

function reflect(f, i, n) {
  const m = 2 * n;
  const r = ((i % m) + m) % m;
  const idx = Math.min(r, m - 1 - r);
  return f[idx];
}

function digitalFilter(f) {
  const M  = 8;
  const n  = f.length;

  while (f.length <= M) {
    const len = f.length;
    for (let i = len - 1; i >= 0; i--) f.push(f[i]);
  }

  const nn   = f.length;
  const Linf = L_BS3[M - 1];
  const vinv = Linf / (1.0 + Linf);

  for (let i = 1; i < M; i++)
    f[i] = f[i] - L_BS3[i - 1] * f[i - 1];

  for (let i = M; i < nn; i++)
    f[i] = f[i] - Linf * f[i - 1];

  f[nn - 1] = vinv * f[nn - 1];

  for (let i = nn - 2; i >= M - 1; i--)
    f[i] = Linf * (f[i] - f[i + 1]);

  for (let i = M - 2; i >= 0; i--)
    f[i] = L_BS3[i] * (f[i] - f[i + 1]);

  f.length = n;
}

function downsample1D(f, m) {
  const n = f.length;
  const s = m / n;

  let fi = Math.ceil((-1.5 / m) * n - 0.5);
  let u  = ((fi + 0.5) / n) * m + 1.5;

  let b1 = 0, b2 = 0, b3 = 0, b4 = 0;
  const g  = new Array(m).fill(0.0);
  let   gi = -4;

  while (gi < -1) {
    const fu = reflect(f, fi, n);
    const u2 = u * u, u3 = u2 * u;

    b1 += fu * (-u3 + 3*u2 - 3*u + 1);
    b2 += fu * ( 3*u3 - 6*u2 + 4);
    b3 += fu * (-3*u3 + 3*u2 + 3*u + 1);
    b4 += fu * u3;

    fi += 1; u += s;
    const step = Math.floor(u); u -= step; gi += step;
    const keep = 1 - step;
    b1 = b1*keep + b2*step; b2 = b2*keep + b3*step;
    b3 = b3*keep + b4*step; b4 = b4*keep;
  }

  while (gi < m) {
    const fu = reflect(f, fi, n);
    const u2 = u * u, u3 = u2 * u;

    b1 += fu * (-u3 + 3*u2 - 3*u + 1);
    b2 += fu * ( 3*u3 - 6*u2 + 4);
    b3 += fu * (-3*u3 + 3*u2 + 3*u + 1);
    b4 += fu * u3;

    fi += 1; u += s;
    const step = Math.floor(u); u -= step; gi += step;
    const wi = Math.max(0, Math.min(m - 1, gi));
    g[wi] = g[wi] + (s * b1 - g[wi]) * step;

    const keep = 1 - step;
    b1 = b1*keep + b2*step; b2 = b2*keep + b3*step;
    b3 = b3*keep + b4*step; b4 = b4*keep;
  }

  digitalFilter(g);
  return g;
}

function getChannel(p, idx) {
  if (typeof p !== "object" || p === null)
    return 255 * Math.max(0, 1 - Math.abs(idx - 3));
  const keys = [p.r ?? p[0] ?? 0, p.g ?? p[1] ?? 0, p.b ?? p[2] ?? 0, p.a ?? p[3] ?? 255];
  return keys[idx] / 255.0;
}

function downsampleAll(pixels, srcW, srcH, dstW, dstH) {
  const tempR = [], tempG = [], tempB = [], tempA = [];

  for (let y = 0; y < srcH; y++) {
    const rR = new Array(srcW), rG = new Array(srcW);
    const rB = new Array(srcW), rA = new Array(srcW);
    const row = pixels[y];

    for (let x = 0; x < srcW; x++) {
      const p = row[x];
      rR[x] = getChannel(p, 0); rG[x] = getChannel(p, 1);
      rB[x] = getChannel(p, 2); rA[x] = getChannel(p, 3);
    }

    tempR[y] = downsample1D(rR, dstW); tempG[y] = downsample1D(rG, dstW);
    tempB[y] = downsample1D(rB, dstW); tempA[y] = downsample1D(rA, dstW);
  }

  const resR = Array.from({length: dstH}, () => new Array(dstW).fill(0));
  const resG = Array.from({length: dstH}, () => new Array(dstW).fill(0));
  const resB = Array.from({length: dstH}, () => new Array(dstW).fill(0));
  const resA = Array.from({length: dstH}, () => new Array(dstW).fill(0));

  for (let x = 0; x < dstW; x++) {
    const cR = new Array(srcH), cG = new Array(srcH);
    const cB = new Array(srcH), cA = new Array(srcH);

    for (let y = 0; y < srcH; y++) {
      cR[y] = tempR[y][x]; cG[y] = tempG[y][x];
      cB[y] = tempB[y][x]; cA[y] = tempA[y][x];
    }

    const dR = downsample1D(cR, dstH), dG = downsample1D(cG, dstH);
    const dB = downsample1D(cB, dstH), dA = downsample1D(cA, dstH);

    for (let y = 0; y < dstH; y++) {
      resR[y][x] = dR[y]; resG[y][x] = dG[y];
      resB[y][x] = dB[y]; resA[y][x] = dA[y];
    }
  }

  return { r: resR, g: resG, b: resB, a: resA, width: dstW, height: dstH };
}

function Downsample(pixels, srcW, srcH, scale) {
  return downsampleAll(pixels, srcW, srcH,
    Math.max(1, Math.floor(srcW / scale)),
    Math.max(1, Math.floor(srcH / scale)));
}

function DownsampleTo(pixels, srcW, srcH, dstW, dstH) {
  return downsampleAll(pixels, srcW, srcH, Math.max(1, dstW), Math.max(1, dstH));
}

function ToPixels(buf, width, height) {
  const pixels = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    const yOff = y * width;
    for (let x = 0; x < width; x++) {
      const idx = (yOff + x) * 4;
      row.push([buf[idx], buf[idx+1], buf[idx+2], buf[idx+3]]);
    }
    pixels.push(row);
  }
  return pixels;
}

function ToBuffer(result) {
  const { r, g, b, a, width: w, height: h } = result;
  const buf = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const yOff = y * w;
    for (let x = 0; x < w; x++) {
      const idx = (yOff + x) * 4;
      buf[idx]   = Math.max(0, Math.min(255, Math.round(r[y][x] * 255)));
      buf[idx+1] = Math.max(0, Math.min(255, Math.round(g[y][x] * 255)));
      buf[idx+2] = Math.max(0, Math.min(255, Math.round(b[y][x] * 255)));
      buf[idx+3] = Math.max(0, Math.min(255, Math.round(a[y][x] * 255)));
    }
  }
  return buf;
}

function downsampleRGBA(rgba, srcW, srcH, dstW, dstH) {
  const pixels = ToPixels(rgba, srcW, srcH);
  const result = DownsampleTo(pixels, srcW, srcH, dstW, dstH);
  return { rgba: ToBuffer(result), width: dstW, height: dstH };
}

module.exports = {
  Downsample,
  DownsampleTo,
  ToPixels,
  ToBuffer,
  downsampleRGBA,
};
