"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Bump when the linker's output changes, so installs made by an older sof are redone once.
const STATE_VERSION = 1;
const STATE_DIRECTORY = path.join(os.homedir(), ".sof", "state");

function hashText(text) {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/");
}

function createEntryKey(entry) {
  return `${normalizePath(entry.path)}::${entry.alias}`;
}

// The record of what sof installed lives next to the user's home, not in the project, so it
// never needs a .gitignore entry and a fresh clone simply has none (everything installs).
function stateFilePath(configDirectory) {
  const resolved = path.resolve(configDirectory);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const key = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return path.join(STATE_DIRECTORY, `${key}.json`);
}

function emptyState() {
  return { version: STATE_VERSION, configHash: "", lockHash: "", packages: {} };
}

function readInstallState(configDirectory) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(configDirectory), "utf8"));
    if (parsed && parsed.version === STATE_VERSION && parsed.packages && typeof parsed.packages === "object") {
      return { ...emptyState(), ...parsed };
    }
  } catch (_err) {
    // Missing or unreadable state just means "nothing is known to be installed".
  }
  return emptyState();
}

function writeInstallState(configDirectory, state) {
  const target = stateFilePath(configDirectory);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ ...state, version: STATE_VERSION }, null, 2)}\n`, "utf8");
}

function hashConfigGroups(groups) {
  return hashText(JSON.stringify(groups));
}

function listFiles(directory, prefix, output) {
  const children = fs.readdirSync(directory, { withFileTypes: true });
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const child of children) {
    const relative = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory()) {
      listFiles(path.join(directory, child.name), relative, output);
    } else {
      output.push(relative);
    }
  }
}

// Hash of an installed package (a single file or a folder), or null when it isn't there.
// The root init.meta.json is skipped: sof writes it itself for keep_unknown_instances.
function fingerprintInstalled(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return null;
  }

  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return hashText(fs.readFileSync(targetPath));
  }

  const files = [];
  listFiles(targetPath, "", files);
  const hash = crypto.createHash("sha256");
  for (const relative of files) {
    if (relative === "init.meta.json") {
      continue;
    }
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(targetPath, relative)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function rewritesKey(aliasRewrites) {
  return JSON.stringify(Object.entries(aliasRewrites || {}).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function findLockEntry(lockEntries, entry) {
  const key = createEntryKey(entry);
  return (lockEntries || []).find((candidate) => createEntryKey(candidate) === key) || null;
}

// Why an installed package can't be kept as it is, or null when it is already up to date.
function explainStaleEntry(entry, lockEntry, recorded, configDirectory) {
  if (!lockEntry) {
    return "new";
  }

  if (lockEntry.name !== entry.name || lockEntry.version !== entry.version || lockEntry.source !== entry.source) {
    return lockEntry.name === entry.name && lockEntry.version !== entry.version
      ? `${lockEntry.version} -> ${entry.version}`
      : "changed";
  }

  if (entry.expectedChecksum && entry.expectedChecksum !== lockEntry.checksum) {
    return "checksum changed";
  }

  if (!recorded || recorded.checksum !== lockEntry.checksum || recorded.version !== entry.version) {
    return "not recorded";
  }

  if (rewritesKey(recorded.aliasRewrites) !== rewritesKey(entry.aliasRewrites)) {
    return "requires changed";
  }

  const fingerprint = fingerprintInstalled(path.resolve(configDirectory, recorded.destination));
  if (fingerprint === null) {
    return "missing";
  }
  if (fingerprint !== recorded.fingerprint) {
    return "modified";
  }

  return null;
}

// Splits resolved entries into those already installed as expected and those that need a
// download + link, each stale one with the reason.
function classifyEntries(entries, lockEntries, state, configDirectory) {
  const current = [];
  const stale = [];

  for (const entry of entries) {
    const lockEntry = findLockEntry(lockEntries, entry);
    const recorded = state.packages[createEntryKey(entry)] || null;
    const reason = explainStaleEntry(entry, lockEntry, recorded, configDirectory);

    if (reason === null) {
      current.push({ entry, lockEntry, recorded });
    } else {
      stale.push({ entry, reason });
    }
  }

  return { current, stale };
}

function recordInstalled(entry, destinationPath, configDirectory) {
  return {
    version: entry.version,
    source: entry.source,
    checksum: entry.checksum,
    aliasRewrites: entry.aliasRewrites || {},
    destination: normalizePath(path.relative(configDirectory, destinationPath)),
    fingerprint: fingerprintInstalled(destinationPath),
  };
}

// Nothing to do when the config and lockfile are what the last successful install saw and
// every installed package still matches what was recorded.
function isInstallCurrent(state, configHash, lockfile, configDirectory) {
  if (!lockfile.exists || lockfile.entries.length === 0) {
    return false;
  }
  if (state.configHash !== configHash || state.lockHash !== lockfile.hash) {
    return false;
  }

  return lockfile.entries.every((lockEntry) => {
    const recorded = state.packages[createEntryKey(lockEntry)];
    if (!recorded || recorded.checksum !== lockEntry.checksum || recorded.version !== lockEntry.version) {
      return false;
    }
    const fingerprint = fingerprintInstalled(path.resolve(configDirectory, recorded.destination));
    return fingerprint !== null && fingerprint === recorded.fingerprint;
  });
}

module.exports = {
  classifyEntries,
  createEntryKey,
  fingerprintInstalled,
  hashConfigGroups,
  hashText,
  isInstallCurrent,
  readInstallState,
  recordInstalled,
  stateFilePath,
  writeInstallState,
};
