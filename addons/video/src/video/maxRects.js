"use strict";

class MaxRects {
  constructor(width, height) {
    this.binW = width;
    this.binH = height;
    this.freeRects = [{ x: 0, y: 0, w: width, h: height }];
    this.usedRects = [];
  }

  insert(w, h) {
    let best1 = Infinity, best2 = Infinity, node = null;

    for (const fr of this.freeRects) {
      if (fr.w >= w && fr.h >= h) {
        const s1 = Math.min(fr.w - w, fr.h - h);
        const s2 = Math.max(fr.w - w, fr.h - h);
        if (s1 < best1 || (s1 === best1 && s2 < best2)) {
          best1 = s1; best2 = s2;
          node  = { x: fr.x, y: fr.y, w, h };
        }
      }
    }

    if (!node) return null;

    this._split(node);
    this._prune();
    this.usedRects.push(node);
    return node;
  }

  reset() {
    this.freeRects = [{ x: 0, y: 0, w: this.binW, h: this.binH }];
    this.usedRects = [];
  }

  _split(placed) {
    const next = [];
    for (const fr of this.freeRects) {
      if (!this._overlap(fr, placed)) { next.push(fr); continue; }

      if (placed.x < fr.x + fr.w && placed.x + placed.w > fr.x) {
        if (placed.y > fr.y)
          next.push({ x: fr.x, y: fr.y, w: fr.w, h: placed.y - fr.y });
        if (placed.y + placed.h < fr.y + fr.h)
          next.push({ x: fr.x, y: placed.y + placed.h,
                      w: fr.w, h: (fr.y + fr.h) - (placed.y + placed.h) });
      }
      if (placed.y < fr.y + fr.h && placed.y + placed.h > fr.y) {
        if (placed.x > fr.x)
          next.push({ x: fr.x, y: fr.y, w: placed.x - fr.x, h: fr.h });
        if (placed.x + placed.w < fr.x + fr.w)
          next.push({ x: placed.x + placed.w, y: fr.y,
                      w: (fr.x + fr.w) - (placed.x + placed.w), h: fr.h });
      }
    }
    this.freeRects = next;
  }

  _prune() {
    const drop = new Set();
    const fr   = this.freeRects;
    for (let i = 0; i < fr.length; i++) {
      if (drop.has(i)) continue;
      for (let j = i + 1; j < fr.length; j++) {
        if (this._contains(fr[j], fr[i])) { drop.add(i); break; }
        if (this._contains(fr[i], fr[j])) drop.add(j);
      }
    }
    this.freeRects = fr.filter((_, i) => !drop.has(i));
  }

  _overlap(a, b) {
    return a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
  }

  _contains(outer, inner) {
    return inner.x >= outer.x && inner.y >= outer.y &&
           inner.x+inner.w <= outer.x+outer.w &&
           inner.y+inner.h <= outer.y+outer.h;
  }
}

module.exports = { MaxRects };
