"use strict";

const { Jimp, intToRGBA, rgbaToInt } = require("jimp");

const kTF = 0.0001;
const kT0SafetyFactor = 0.99;
const kSubclusterPerturbation = 1.1;
const kSubclusterTolerance = 0.5;
const kDT = 0.9;
const kPaletteErrorTolerance = 0.05;

function srgbLinear(value) {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearSrgb(value) {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function rgbToXyz(r, g, b) {
  const rr = srgbLinear(r);
  const gg = srgbLinear(g);
  const bb = srgbLinear(b);
  return [
    rr * 0.4124564 + gg * 0.3575761 + bb * 0.1804375,
    rr * 0.2126729 + gg * 0.7151522 + bb * 0.072175,
    rr * 0.0193339 + gg * 0.119192 + bb * 0.9503041,
  ];
}

function xyzToRgb(x, y, z) {
  return [
    linearSrgb(x * 3.2404542 - y * 1.5371385 - z * 0.4985314),
    linearSrgb(-x * 0.969266 + y * 1.8760108 + z * 0.041556),
    linearSrgb(x * 0.0556434 - y * 0.2040259 + z * 1.0572252),
  ];
}

const Xn = 0.95047;
const Yn = 1.0;
const Zn = 1.08883;

function fLab(t) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function fLabInv(t) {
  return t > 0.2069 ? t * t * t : (t - 16 / 116) / 7.787;
}

function rgbToLab(r, g, b) {
  const xyz = rgbToXyz(r, g, b);
  const fy = fLab(xyz[1] / Yn);
  return [116 * fy - 16, 500 * (fLab(xyz[0] / Xn) - fy), 200 * (fy - fLab(xyz[2] / Zn))];
}

function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  return xyzToRgb(
    fLabInv(a / 500 + fy) * Xn,
    fLabInv(fy) * Yn,
    fLabInv(fy - b / 200) * Zn
  );
}

function powerIteration(matrix, iterations) {
  const iters = iterations || 64;
  let vector = [0.577, 0.577, 0.577];
  let value = 0;

  for (let k = 0; k < iters; k += 1) {
    const nextVector = [
      matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
      matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
      matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
    ];
    value = Math.sqrt(
      nextVector[0] * nextVector[0] +
        nextVector[1] * nextVector[1] +
        nextVector[2] * nextVector[2]
    );
    if (value < 1e-12) {
      break;
    }
    vector = [nextVector[0] / value, nextVector[1] / value, nextVector[2] / value];
  }

  return { vec: vector, val: value };
}

function extractAndComposite(img, inputWidth, inputHeight, outputWidth, outputHeight, bgR, bgG, bgB) {
  const rgbF = new Float32Array(inputWidth * inputHeight * 3);
  const alphaOut = new Uint8Array(outputWidth * outputHeight);
  const scaleX = outputWidth / inputWidth;
  const scaleY = outputHeight / inputHeight;

  for (let y = 0; y < inputHeight; y += 1) {
    const outputY = Math.min(outputHeight - 1, (y * scaleY) | 0);
    for (let x = 0; x < inputWidth; x += 1) {
      const rgba = intToRGBA(img.getPixelColor(x, y));
      const pi = y * inputWidth + x;
      const alphaFraction = rgba.a / 255;

      rgbF[pi * 3] = (rgba.r / 255) * alphaFraction + bgR * (1 - alphaFraction);
      rgbF[pi * 3 + 1] = (rgba.g / 255) * alphaFraction + bgG * (1 - alphaFraction);
      rgbF[pi * 3 + 2] = (rgba.b / 255) * alphaFraction + bgB * (1 - alphaFraction);

      const outputX = Math.min(outputWidth - 1, (x * scaleX) | 0);
      const outputIndex = outputY * outputWidth + outputX;
      if (rgba.a > alphaOut[outputIndex]) {
        alphaOut[outputIndex] = rgba.a;
      }
    }
  }

  return { rgbF, alphaOut };
}

class Pix {
  constructor(rgbPixels, inputWidth, inputHeight, outputWidth, outputHeight, maxPalette) {
    this.iw = inputWidth;
    this.ih = inputHeight;
    this.ow = outputWidth;
    this.oh = outputHeight;
    this.maxPal = maxPalette;
    this.range = Math.sqrt((inputHeight / outputHeight) * (inputWidth / outputWidth));

    this.slicFactor = 45;
    this.smoothPosFactor = 0.4;
    this.sigmaColor = 0.87;
    this.sigmaPos = 0.87;
    this.saturation = 1.1;

    this.inputLab = new Float32Array(inputWidth * inputHeight * 3);
    for (let index = 0; index < inputWidth * inputHeight; index += 1) {
      const lab = rgbToLab(rgbPixels[index * 3], rgbPixels[index * 3 + 1], rgbPixels[index * 3 + 2]);
      this.inputLab[index * 3] = lab[0];
      this.inputLab[index * 3 + 1] = lab[1];
      this.inputLab[index * 3 + 2] = lab[2];
    }
    this.inputWeights = new Float32Array(inputWidth * inputHeight).fill(1.0);

    const regionCount = outputWidth * outputHeight;
    this._cSumBuf = new Float32Array(regionCount * 3);
    this._pSumBuf = new Float32Array(regionCount * 2);
    this._wtBuf = new Float32Array(regionCount);
    this._spWtBuf = new Float32Array(regionCount);
    this._distBuf = new Float32Array(inputWidth * inputHeight);
    this._spColorFlat = new Float32Array(regionCount * 3);

    this.palette = [];
    this.probC = [];
    this.probCO = [];
    this.probO = 1.0 / regionCount;
    this.paletteAssign = new Int32Array(regionCount);
    this.spPos = new Float32Array(regionCount * 2);
    this.spWeights = new Float32Array(regionCount);
    this.regionMap = new Int32Array(inputWidth * inputHeight * 2);
    this.subPairs = [];
    this.lockedColors = [];
    this.pixConstraints = new Array(regionCount).fill(null).map(() => []);

    this.converged = false;
    this.palMaxed = false;
    this.temperature = 1.0;
    this.iteration = 0;
    this._avgPalCache = null;
    this._avgPalDirty = true;
    this.splitTolerance = 1.0;
  }

  si(x, y) {
    return x + this.ow * y;
  }

  _getAveragedPalette() {
    if (!this._avgPalDirty && this._avgPalCache) {
      return this._avgPalCache;
    }

    const averaged = this.palette.map((color) => [color[0], color[1], color[2]]);
    if (!this.palMaxed) {
      for (const pair of this.subPairs) {
        const colorOne = this.palette[pair[0]];
        const colorTwo = this.palette[pair[1]];
        const weightOne = this.probC[pair[0]] || 0;
        const weightTwo = this.probC[pair[1]] || 0;
        const totalWeight = weightOne + weightTwo || 1e-9;
        const normalizedOne = weightOne / totalWeight;
        const normalizedTwo = weightTwo / totalWeight;
        const merged = [
          colorOne[0] * normalizedOne + colorTwo[0] * normalizedTwo,
          colorOne[1] * normalizedOne + colorTwo[1] * normalizedTwo,
          colorOne[2] * normalizedOne + colorTwo[2] * normalizedTwo,
        ];
        averaged[pair[0]] = merged;
        averaged[pair[1]] = merged;
      }
    }

    this._avgPalCache = averaged;
    this._avgPalDirty = false;
    return averaged;
  }

  initialize() {
    const regionCount = this.ow * this.oh;

    for (let y = 0; y < this.oh; y += 1) {
      for (let x = 0; x < this.ow; x += 1) {
        const index = this.si(x, y);
        this.spPos[index * 2] = ((x + 0.5) / this.ow) * this.iw;
        this.spPos[index * 2 + 1] = ((y + 0.5) / this.oh) * this.ih;
      }
    }

    for (let y = 0; y < this.ih; y += 1) {
      for (let x = 0; x < this.iw; x += 1) {
        const pi = y * this.iw + x;
        this.regionMap[pi * 2] = Math.min(this.ow - 1, ((x / this.iw) * this.ow) | 0);
        this.regionMap[pi * 2 + 1] = Math.min(this.oh - 1, ((y / this.ih) * this.oh) | 0);
      }
    }

    this._updateSPMeans();

    let fallbackColor = [0, 0, 0];
    for (let index = 0; index < regionCount; index += 1) {
      fallbackColor[0] += this._spColorFlat[index * 3];
      fallbackColor[1] += this._spColorFlat[index * 3 + 1];
      fallbackColor[2] += this._spColorFlat[index * 3 + 2];
    }
    fallbackColor = [
      fallbackColor[0] * this.probO,
      fallbackColor[1] * this.probO,
      fallbackColor[2] * this.probO,
    ];

    this.probC = [0.5, 0.5];
    this.probCO = [new Float32Array(regionCount).fill(0.5), new Float32Array(regionCount).fill(0.5)];

    this.palette = [[fallbackColor[0], fallbackColor[1], fallbackColor[2]]];
    this._avgPalDirty = true;
    const firstEigen = this._getMaxEigen(0).vec;
    this.palette.push([
      fallbackColor[0] + firstEigen[0] * kSubclusterPerturbation,
      fallbackColor[1] + firstEigen[1] * kSubclusterPerturbation,
      fallbackColor[2] + firstEigen[2] * kSubclusterPerturbation,
    ]);
    this.subPairs = [[0, 1]];

    this._avgPalDirty = true;
    const initEigen = this._getMaxEigen(0).val;
    this.temperature = kT0SafetyFactor * Math.sqrt(2 * Math.max(initEigen, 1e-6));
    if (!Number.isFinite(this.temperature) || this.temperature < kTF) {
      this.temperature = kT0SafetyFactor;
    }

    this.lockedColors = new Array(this.maxPal).fill(false);
    this.pixConstraints = new Array(regionCount).fill(null).map(() => []);
    this.converged = false;
    this.palMaxed = false;
    this.iteration = 0;
    this._avgPalDirty = true;
    this._avgPalCache = null;
  }

  iterate() {
    if (this.converged) {
      return;
    }

    this._updateSPMapping();
    this._updateSPMeans();
    this._associatePalette();
    const paletteError = this._refinePalette();
    if (paletteError < kPaletteErrorTolerance) {
      if (this.temperature <= kTF) {
        this.converged = true;
      } else {
        this.temperature = Math.max(this.temperature * kDT, kTF);
      }
      this._expandPalette();
    }
    this.iteration += 1;
  }

  _updateSPMapping() {
    const averagedPalette = this._getAveragedPalette();
    const distances = this._distBuf;
    distances.fill(-1);
    this.regionMap.fill(-1);

    for (let y = 0; y < this.oh; y += 1) {
      for (let x = 0; x < this.ow; x += 1) {
        const si = this.si(x, y);
        const px = this.spPos[si * 2];
        const py = this.spPos[si * 2 + 1];
        const paletteIndex = this.paletteAssign[si];
        const spColor = averagedPalette[paletteIndex];
        const sf = this.slicFactor / this.range;
        const minX = Math.max(0, (px - this.range) | 0);
        const minY = Math.max(0, (py - this.range) | 0);
        const maxX = Math.min(this.iw - 1, Math.ceil(px + this.range));
        const maxY = Math.min(this.ih - 1, Math.ceil(py + this.range));

        for (let yy = minY; yy <= maxY; yy += 1) {
          for (let xx = minX; xx <= maxX; xx += 1) {
            const pi = yy * this.iw + xx;
            const dL = this.inputLab[pi * 3] - spColor[0];
            const da = this.inputLab[pi * 3 + 1] - spColor[1];
            const db = this.inputLab[pi * 3 + 2] - spColor[2];
            const colorError = Math.sqrt(dL * dL + da * da + db * db);
            const dx = xx - px;
            const dy = yy - py;
            const distanceError = Math.sqrt(dx * dx + dy * dy);
            const candidateError = colorError + sf * distanceError;

            if (distances[pi] < 0 || candidateError < distances[pi]) {
              distances[pi] = candidateError;
              this.regionMap[pi * 2] = x;
              this.regionMap[pi * 2 + 1] = y;
            }
          }
        }
      }
    }

    for (let y = 0; y < this.ih; y += 1) {
      for (let x = 0; x < this.iw; x += 1) {
        const pi = y * this.iw + x;
        if (this.regionMap[pi * 2] < 0) {
          this.regionMap[pi * 2] = Math.min(this.ow - 1, ((x / this.iw) * this.ow) | 0);
          this.regionMap[pi * 2 + 1] = Math.min(this.oh - 1, ((y / this.ih) * this.oh) | 0);
        }
      }
    }
  }

  _updateSPMeans() {
    const regionCount = this.ow * this.oh;
    this._cSumBuf.fill(0);
    this._pSumBuf.fill(0);
    this._wtBuf.fill(0);
    this._spWtBuf.fill(0);

    for (let y = 0; y < this.ih; y += 1) {
      for (let x = 0; x < this.iw; x += 1) {
        const pi = y * this.iw + x;
        const sx = this.regionMap[pi * 2];
        const sy = this.regionMap[pi * 2 + 1];
        const si = sx + this.ow * sy;
        this._cSumBuf[si * 3] += this.inputLab[pi * 3];
        this._cSumBuf[si * 3 + 1] += this.inputLab[pi * 3 + 1];
        this._cSumBuf[si * 3 + 2] += this.inputLab[pi * 3 + 2];
        this._pSumBuf[si * 2] += x;
        this._pSumBuf[si * 2 + 1] += y;
        this._wtBuf[si] += 1;
        this._spWtBuf[si] += this.inputWeights[pi];
      }
    }

    let totalWeight = 0;
    for (let y = 0; y < this.oh; y += 1) {
      for (let x = 0; x < this.ow; x += 1) {
        const si = this.si(x, y);
        const weight = this._wtBuf[si];
        if (weight === 0) {
          const ix = Math.min(this.iw - 1, ((x / this.ow) * this.iw) | 0);
          const iy = Math.min(this.ih - 1, ((y / this.oh) * this.ih) | 0);
          const fp = (iy * this.iw + ix) * 3;
          this._spColorFlat[si * 3] = this.inputLab[fp];
          this._spColorFlat[si * 3 + 1] = this.inputLab[fp + 1];
          this._spColorFlat[si * 3 + 2] = this.inputLab[fp + 2];
        } else {
          const invWeight = 1 / weight;
          this._spColorFlat[si * 3] = this._cSumBuf[si * 3] * invWeight;
          this._spColorFlat[si * 3 + 1] = this._cSumBuf[si * 3 + 1] * invWeight;
          this._spColorFlat[si * 3 + 2] = this._cSumBuf[si * 3 + 2] * invWeight;
          this.spPos[si * 2] = this._pSumBuf[si * 2] * invWeight;
          this.spPos[si * 2 + 1] = this._pSumBuf[si * 2 + 1] * invWeight;
          this._spWtBuf[si] *= invWeight;
          totalWeight += this._spWtBuf[si];
        }
      }
    }

    if (totalWeight > 0) {
      for (let index = 0; index < regionCount; index += 1) {
        this._spWtBuf[index] /= totalWeight;
      }
    }
    this.spWeights = this._spWtBuf;

    this._smoothPositions();
    this._smoothColors();
  }

  _smoothPositions() {
    const smoothed = new Float32Array(this.spPos.length);
    for (let y = 0; y < this.oh; y += 1) {
      for (let x = 0; x < this.ow; x += 1) {
        const si = this.si(x, y);
        let sx = 0;
        let sy = 0;
        let count = 0;

        if (x > 0) {
          const n = this.si(x - 1, y);
          sx += this.spPos[n * 2];
          sy += this.spPos[n * 2 + 1];
          count += 1;
        }
        if (x < this.ow - 1) {
          const n = this.si(x + 1, y);
          sx += this.spPos[n * 2];
          sy += this.spPos[n * 2 + 1];
          count += 1;
        }
        if (y > 0) {
          const n = this.si(x, y - 1);
          sx += this.spPos[n * 2];
          sy += this.spPos[n * 2 + 1];
          count += 1;
        }
        if (y < this.oh - 1) {
          const n = this.si(x, y + 1);
          sx += this.spPos[n * 2];
          sy += this.spPos[n * 2 + 1];
          count += 1;
        }

        if (count > 0) {
          sx /= count;
          sy /= count;
        }

        const originalX = this.spPos[si * 2];
        const originalY = this.spPos[si * 2 + 1];
        smoothed[si * 2] =
          x === 0 || x === this.ow - 1
            ? originalX
            : (1 - this.smoothPosFactor) * originalX + this.smoothPosFactor * sx;
        smoothed[si * 2 + 1] =
          y === 0 || y === this.oh - 1
            ? originalY
            : (1 - this.smoothPosFactor) * originalY + this.smoothPosFactor * sy;
      }
    }
    this.spPos = smoothed;
  }

  _smoothColors() {
    const sigmaColorSquared = 2 * this.sigmaColor * this.sigmaColor;
    const sigmaPosSquared = 2 * this.sigmaPos * this.sigmaPos;
    const nextColors = new Float32Array(this.ow * this.oh * 3);

    for (let y = 0; y < this.oh; y += 1) {
      for (let x = 0; x < this.ow; x += 1) {
        const si = this.si(x, y);
        const cL = this._spColorFlat[si * 3];
        const ca = this._spColorFlat[si * 3 + 1];
        const cb = this._spColorFlat[si * 3 + 2];

        let sumL = 0;
        let sumA = 0;
        let sumB = 0;
        let totalWeight = 0;

        const minX = Math.max(0, x - 1);
        const maxX = Math.min(this.ow - 1, x + 1);
        const minY = Math.max(0, y - 1);
        const maxY = Math.min(this.oh - 1, y + 1);

        for (let xx = minX; xx <= maxX; xx += 1) {
          for (let yy = minY; yy <= maxY; yy += 1) {
            const ni = this.si(xx, yy);
            const nL = this._spColorFlat[ni * 3];
            const na = this._spColorFlat[ni * 3 + 1];
            const nb = this._spColorFlat[ni * 3 + 2];
            const dL = nL - cL;
            const da = na - ca;
            const db = nb - cb;
            const dcSq = dL * dL + da * da + db * db;
            const dpSq = (x - xx) * (x - xx) + (y - yy) * (y - yy);
            const weight = Math.exp(-dcSq / sigmaColorSquared) * Math.exp(-dpSq / sigmaPosSquared);

            totalWeight += weight;
            sumL += nL * weight;
            sumA += na * weight;
            sumB += nb * weight;
          }
        }

        const inverse = totalWeight > 0 ? 1 / totalWeight : 1;
        nextColors[si * 3] = sumL * inverse;
        nextColors[si * 3 + 1] = sumA * inverse;
        nextColors[si * 3 + 2] = sumB * inverse;
      }
    }

    this._spColorFlat = nextColors;
  }

  _associatePalette() {
    const paletteSize = this.palette.length;
    const overTemperature = -1.0 / this.temperature;
    this.probCO = new Array(paletteSize);
    for (let k = 0; k < paletteSize; k += 1) {
      this.probCO[k] = new Float32Array(this.ow * this.oh);
    }
    const nextProbabilities = new Float32Array(paletteSize);

    for (let y = 0; y < this.oh; y += 1) {
      for (let x = 0; x < this.ow; x += 1) {
        const si = this.si(x, y);
        const pxL = this._spColorFlat[si * 3];
        const pxa = this._spColorFlat[si * 3 + 1];
        const pxb = this._spColorFlat[si * 3 + 2];

        let constraints = this.pixConstraints[si];
        if (!constraints || constraints.length === 0) {
          constraints = null;
        }

        let bestIndex = 0;
        let bestError = Infinity;
        const probabilities = new Float32Array(paletteSize);
        let sum = 0;
        const candidateCount = constraints ? constraints.length : paletteSize;

        for (let idx = 0; idx < candidateCount; idx += 1) {
          const paletteIndex = constraints ? constraints[idx] : idx;
          const paletteColor = this.palette[paletteIndex];
          const dL = paletteColor[0] - pxL;
          const da = paletteColor[1] - pxa;
          const db = paletteColor[2] - pxb;
          const colorError = Math.sqrt(dL * dL + da * da + db * db);
          const probability = this.probC[paletteIndex] * Math.exp(colorError * overTemperature);
          const finiteProbability = Number.isFinite(probability) ? probability : 0;
          probabilities[paletteIndex] = finiteProbability;
          sum += finiteProbability;
          if (colorError < bestError) {
            bestError = colorError;
            bestIndex = paletteIndex;
          }
        }

        this.paletteAssign[si] = bestIndex;
        const weight = this.spWeights[si];
        const inverse = sum > 1e-300 ? 1 / sum : 1 / candidateCount;

        if (constraints) {
          for (const constrainedIndex of constraints) {
            const normalized = probabilities[constrainedIndex] * inverse;
            this.probCO[constrainedIndex][si] = normalized;
            nextProbabilities[constrainedIndex] += weight * normalized;
          }
        } else {
          for (let paletteIndex = 0; paletteIndex < paletteSize; paletteIndex += 1) {
            const normalized = probabilities[paletteIndex] * inverse;
            this.probCO[paletteIndex][si] = normalized;
            nextProbabilities[paletteIndex] += weight * normalized;
          }
        }
      }
    }

    for (let k = 0; k < paletteSize; k += 1) {
      this.probC[k] = nextProbabilities[k];
    }
    this._avgPalDirty = true;
  }

  _refinePalette() {
    const paletteSize = this.palette.length;
    const colorSums = new Float32Array(paletteSize * 3);

    for (let y = 0; y < this.oh; y += 1) {
      for (let x = 0; x < this.ow; x += 1) {
        const si = this.si(x, y);
        const weight = this.spWeights[si];
        const cL = this._spColorFlat[si * 3];
        const ca = this._spColorFlat[si * 3 + 1];
        const cb = this._spColorFlat[si * 3 + 2];

        for (let k = 0; k < paletteSize; k += 1) {
          const weightedProbability = weight * this.probCO[k][si];
          colorSums[k * 3] += cL * weightedProbability;
          colorSums[k * 3 + 1] += ca * weightedProbability;
          colorSums[k * 3 + 2] += cb * weightedProbability;
        }
      }
    }

    let error = 0;
    for (let k = 0; k < paletteSize; k += 1) {
      if (!this.lockedColors[k] && this.probC[k] > 1e-10) {
        const inverse = 1.0 / this.probC[k];
        const nextL = colorSums[k * 3] * inverse;
        const nextA = colorSums[k * 3 + 1] * inverse;
        const nextB = colorSums[k * 3 + 2] * inverse;

        const deltaL = this.palette[k][0] - nextL;
        const deltaA = this.palette[k][1] - nextA;
        const deltaB = this.palette[k][2] - nextB;
        error += Math.sqrt(deltaL * deltaL + deltaA * deltaA + deltaB * deltaB);

        this.palette[k][0] = nextL;
        this.palette[k][1] = nextA;
        this.palette[k][2] = nextB;
      }
    }

    this._avgPalDirty = true;
    return error / paletteSize;
  }

  _expandPalette() {
    if (this.palMaxed) {
      return;
    }

    const splitCandidates = [];
    for (let idx = 0; idx < this.subPairs.length; idx += 1) {
      const pair = this.subPairs[idx];
      const c1 = this.palette[pair[0]];
      const c2 = this.palette[pair[1]];
      const dL = c1[0] - c2[0];
      const da = c1[1] - c2[1];
      const db = c1[2] - c2[2];
      const distance = Math.sqrt(dL * dL + da * da + db * db);
      const tolerance = this.splitTolerance ?? kSubclusterTolerance;

      if (distance > tolerance) {
        splitCandidates.push([distance, idx]);
      } else {
        const eigen = this._getMaxEigen(pair[0]).vec;
        const perturbation = Math.max(kSubclusterPerturbation, tolerance * 1.05);
        this.palette[pair[1]][0] = this.palette[pair[0]][0] + eigen[0] * perturbation;
        this.palette[pair[1]][1] = this.palette[pair[0]][1] + eigen[1] * perturbation;
        this.palette[pair[1]][2] = this.palette[pair[0]][2] + eigen[2] * perturbation;
      }
    }

    splitCandidates.sort((a, b) => b[0] - a[0]);
    for (const candidate of splitCandidates) {
      this._splitColor(candidate[1]);
      if (this.palette.length >= 2 * this.maxPal) {
        this._condensePalette();
        break;
      }
    }

    this._avgPalDirty = true;
  }

  _splitColor(pairIndex) {
    const pair = this.subPairs[pairIndex];
    const indexOne = pair[0];
    const indexTwo = pair[1];
    const newIndexOne = this.palette.length;
    const newIndexTwo = this.palette.length + 1;

    const eigenOne = this._getMaxEigen(indexOne).vec;
    const eigenTwo = this._getMaxEigen(indexTwo).vec;
    const splitOne = [
      this.palette[indexOne][0] + eigenOne[0] * kSubclusterPerturbation,
      this.palette[indexOne][1] + eigenOne[1] * kSubclusterPerturbation,
      this.palette[indexOne][2] + eigenOne[2] * kSubclusterPerturbation,
    ];
    const splitTwo = [
      this.palette[indexTwo][0] + eigenTwo[0] * kSubclusterPerturbation,
      this.palette[indexTwo][1] + eigenTwo[1] * kSubclusterPerturbation,
      this.palette[indexTwo][2] + eigenTwo[2] * kSubclusterPerturbation,
    ];

    this.palette.push(splitOne);
    this.subPairs[pairIndex][1] = newIndexOne;
    this.probC[indexOne] *= 0.5;
    this.probC.push(this.probC[indexOne]);
    const sourceOne = this.probCO[indexOne];
    this.probCO.push(sourceOne ? new Float32Array(sourceOne) : new Float32Array(this.ow * this.oh));

    this.palette.push(splitTwo);
    this.subPairs.push([indexTwo, newIndexTwo]);
    this.probC[indexTwo] *= 0.5;
    this.probC.push(this.probC[indexTwo]);
    const sourceTwo = this.probCO[indexTwo];
    this.probCO.push(sourceTwo ? new Float32Array(sourceTwo) : new Float32Array(this.ow * this.oh));
    this._avgPalDirty = true;
  }

  _condensePalette() {
    this.palMaxed = true;
    const condensedPalette = [];
    const condensedProbabilities = [];
    const remap = new Int32Array(this.palette.length).fill(-1);

    for (let index = 0; index < this.subPairs.length; index += 1) {
      const pair = this.subPairs[index];
      const weightOne = this.probC[pair[0]] || 0;
      const weightTwo = this.probC[pair[1]] || 0;
      const totalWeight = weightOne + weightTwo || 1e-9;
      const normalizedOne = weightOne / totalWeight;
      const normalizedTwo = weightTwo / totalWeight;

      condensedPalette.push([
        this.palette[pair[0]][0] * normalizedOne + this.palette[pair[1]][0] * normalizedTwo,
        this.palette[pair[0]][1] * normalizedOne + this.palette[pair[1]][1] * normalizedTwo,
        this.palette[pair[0]][2] * normalizedOne + this.palette[pair[1]][2] * normalizedTwo,
      ]);
      condensedProbabilities.push(weightOne + weightTwo);
      remap[pair[0]] = index;
      remap[pair[1]] = index;
    }

    const nextAssignments = new Int32Array(this.ow * this.oh);
    for (let si = 0; si < this.ow * this.oh; si += 1) {
      const mapped = remap[this.paletteAssign[si]];
      nextAssignments[si] = mapped >= 0 ? mapped : 0;
    }

    this.palette = condensedPalette;
    this.paletteAssign = nextAssignments;
    this.probC = condensedProbabilities;
    this.probCO = [];
    this._avgPalDirty = true;
  }

  _getMaxEigen(paletteIndex) {
    const matrix = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const paletteWeight = this.probC[paletteIndex] || 1e-9;
    const paletteColor = this.palette[paletteIndex];
    if (!paletteColor) {
      return { vec: [1, 0, 0], val: 0 };
    }

    for (let y = 0; y < this.oh; y += 1) {
      for (let x = 0; x < this.ow; x += 1) {
        const si = this.si(x, y);
        const row = this.probCO[paletteIndex];
        const pOC = ((row ? row[si] : 0) * this.probO) / paletteWeight;
        const errorL = Math.abs(paletteColor[0] - this._spColorFlat[si * 3]);
        const errorA = Math.abs(paletteColor[1] - this._spColorFlat[si * 3 + 1]);
        const errorB = Math.abs(paletteColor[2] - this._spColorFlat[si * 3 + 2]);

        matrix[0][0] += pOC * errorL * errorL;
        matrix[0][1] += pOC * errorL * errorA;
        matrix[0][2] += pOC * errorL * errorB;
        matrix[1][0] += pOC * errorA * errorL;
        matrix[1][1] += pOC * errorA * errorA;
        matrix[1][2] += pOC * errorA * errorB;
        matrix[2][0] += pOC * errorB * errorL;
        matrix[2][1] += pOC * errorB * errorA;
        matrix[2][2] += pOC * errorB * errorB;
      }
    }

    return powerIteration(matrix);
  }

  getOutputPixels() {
    const averagedPalette = this._getAveragedPalette();
    const out = new Uint8Array(this.ow * this.oh * 3);

    for (let y = 0; y < this.oh; y += 1) {
      for (let x = 0; x < this.ow; x += 1) {
        const si = this.si(x, y);
        const lab = averagedPalette[this.paletteAssign[si]];
        const rgb = labToRgb(lab[0], lab[1] * this.saturation, lab[2] * this.saturation);
        const pi = (y * this.ow + x) * 3;
        out[pi] = Math.round(Math.max(0, Math.min(1, rgb[0])) * 255);
        out[pi + 1] = Math.round(Math.max(0, Math.min(1, rgb[1])) * 255);
        out[pi + 2] = Math.round(Math.max(0, Math.min(1, rgb[2])) * 255);
      }
    }

    return out;
  }
}

function parseHexColor(hex) {
  const normalized = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Invalid hex color: "${hex}". Use format #rrggbb or rrggbb`);
  }
  return [
    parseInt(normalized.slice(0, 2), 16) / 255,
    parseInt(normalized.slice(2, 4), 16) / 255,
    parseInt(normalized.slice(4, 6), 16) / 255,
  ];
}

async function writeImageFile(image, outputPath) {
  if (typeof image.writeAsync === "function") {
    await image.writeAsync(outputPath);
    return;
  }

  await new Promise((resolve, reject) => {
    image.write(outputPath, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function pixelateImage(options) {
  const inputPath = options.inputPath;
  const outputPath = options.outputPath;
  const outputWidth = options.outputWidth;
  const outputHeight = options.outputHeight;
  const paletteSize = options.paletteSize;
  const maxIterations = options.maxIterations;
  const scale = options.scale;
  const backgroundHex = options.backgroundHex;
  const keepAlpha = Boolean(options.keepAlpha);
  const forceIterations = Boolean(options.forceIterations);
  const tolerance = options.tolerance;

  const background = parseHexColor(backgroundHex);
  const image = await Jimp.read(inputPath);

  const inputWidth = image.bitmap.width;
  const inputHeight = image.bitmap.height;
  const extracted = extractAndComposite(
    image,
    inputWidth,
    inputHeight,
    outputWidth,
    outputHeight,
    background[0],
    background[1],
    background[2]
  );

  const pix = new Pix(extracted.rgbF, inputWidth, inputHeight, outputWidth, outputHeight, paletteSize);
  pix.splitTolerance = tolerance;
  pix.initialize();

  let completedIterations = 0;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    pix.iterate();
    completedIterations = iteration + 1;
    if (!forceIterations && pix.converged) {
      break;
    }
  }

  const effectiveColors = pix.palMaxed ? pix.palette.length : pix.subPairs.length;
  const pixels = pix.getOutputPixels();

  const scaledWidth = outputWidth * scale;
  const scaledHeight = outputHeight * scale;
  const outputImage = new Jimp({ width: scaledWidth, height: scaledHeight });

  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const pi = (y * outputWidth + x) * 3;
      const alpha = keepAlpha ? extracted.alphaOut[y * outputWidth + x] : 255;
      const color = rgbaToInt(pixels[pi], pixels[pi + 1], pixels[pi + 2], alpha);

      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          outputImage.setPixelColor(color, x * scale + sx, y * scale + sy);
        }
      }
    }
  }

  await writeImageFile(outputImage, outputPath);

  return {
    inputWidth,
    inputHeight,
    outputWidth: scaledWidth,
    outputHeight: scaledHeight,
    effectiveColors,
    internalPaletteEntries: pix.palette.length,
    iterations: completedIterations,
    converged: pix.converged,
    outputPath,
  };
}

module.exports = {
  pixelateImage,
};
