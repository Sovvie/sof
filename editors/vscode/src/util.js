"use strict";

const vscode = require("vscode");

/** @param {vscode.TextDocument} document @param {{ start: number, end: number }} span */
function rangeOf(document, span) {
  return new vscode.Range(document.positionAt(span.start), document.positionAt(span.end));
}

/**
 * Calls `fn` once, `delay` ms after the last call.
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} delay
 * @returns {F & { cancel(): void }}
 */
function debounce(fn, delay) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const wrapped = /** @type {any} */ (
    (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn(...args);
      }, delay);
    }
  );
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}

/** Resolves with `promise`, or with `fallback` after `ms`. */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

module.exports = { rangeOf, debounce, withTimeout };
