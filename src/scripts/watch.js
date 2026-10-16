"use strict";

// `sof run script --watch`: notices when files matching a script's watch globs change, by looking
// at their sizes and modification times now and then. Polling is dull, but it behaves the same on
// every platform and needs no native watcher.

const fs = require("fs");
const path = require("path");

const IGNORED = ["**/node_modules/**", "**/.git/**"];
const MAX_FILES = 20000;

function snapshot(globs, directory) {
  const glob = require("fast-glob");
  const files = glob.sync(globs, { cwd: directory, ignore: IGNORED, onlyFiles: true, dot: false, unique: true }).slice(0, MAX_FILES);
  const state = new Map();
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(directory, file));
      state.set(file, `${stat.mtimeMs}:${stat.size}`);
    } catch (_gone) {
      // Deleted between the listing and the stat: it shows up as removed next time.
    }
  }
  return state;
}

function changesBetween(before, after) {
  const changed = [];
  for (const [file, stamp] of after) {
    if (before.get(file) !== stamp) {
      changed.push(file);
    }
  }
  for (const file of before.keys()) {
    if (!after.has(file)) {
      changed.push(file);
    }
  }
  return changed.sort();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves to the files that changed (after they stop changing for `settleMs`), or null once
// shouldStop() says so. `before` is the snapshot taken when the last run started.
async function waitForChange(globs, directory, before, { intervalMs = 400, settleMs = 150, shouldStop = () => false } = {}) {
  let last = before;
  while (!shouldStop()) {
    await sleep(intervalMs);
    const now = snapshot(globs, directory);
    if (changesBetween(last, now).length === 0) {
      continue;
    }

    // Wait for the writes to settle so one save (or a git checkout) is one run.
    let current = now;
    for (;;) {
      await sleep(settleMs);
      const next = snapshot(globs, directory);
      if (changesBetween(current, next).length === 0) {
        break;
      }
      current = next;
    }
    return { files: changesBetween(before, current), snapshot: current };
  }
  return null;
}

module.exports = { changesBetween, snapshot, waitForChange };
