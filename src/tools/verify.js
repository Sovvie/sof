"use strict";

// `sof run tools verify`: are the tools on disk the ones sof.tools.lock says they should be, and
// are they still the programs sof installed? Reads files only; nothing is downloaded or run.

const crypto = require("crypto");
const fs = require("fs");

const { currentPlatform, findLockEntry } = require("./lock");
const { isToolInstalled, readInstallRecord, toolExecutablePath } = require("./store");

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

// entries: [{ alias, spec }]; lock: the result of readToolsLock (or { exists: false, entries: [] }).
// Returns { problems: [...], notes: [...], ok: [...] } of strings.
function verifyTools(entries, lock) {
  const result = { problems: [], notes: [], ok: [] };
  const platform = currentPlatform();

  for (const { alias, spec } of entries) {
    const label = `${alias} ${spec.version}`;
    if (!isToolInstalled(spec)) {
      result.problems.push(`${label} isn't installed (sof run tools install)`);
      continue;
    }

    const record = readInstallRecord(spec);
    const locked = lock.exists ? findLockEntry(lock, spec, platform) : null;
    let trouble = false;

    if (lock.exists && !locked) {
      result.notes.push(`${label} has no ${platform} line in sof.tools.lock (sof run tools lock)`);
    }

    if (!record) {
      result.notes.push(`${label} has no install record (it was copied from Rokit, or by an older sof), so it can't be checked; reinstall it with: sof run tools install --force`);
      continue;
    }

    if (locked && (record.sha256 !== locked.sha256 || record.asset !== locked.asset)) {
      result.problems.push(`${label} was installed from a different file than sof.tools.lock lists (reinstall: sof run tools install --force)`);
      trouble = true;
    }

    if (typeof record.exe === "string") {
      let current;
      try {
        current = hashFile(toolExecutablePath(spec));
      } catch (err) {
        current = null;
        result.problems.push(`${label} can't be read: ${err.message}`);
        trouble = true;
      }
      if (current && current !== record.exe) {
        result.problems.push(`${label} was changed after sof installed it (reinstall: sof run tools install --force)`);
        trouble = true;
      }
    } else {
      result.notes.push(`${label} was installed before sof recorded program checksums, so only its download is checked`);
    }

    if (!trouble) {
      result.ok.push(`${label} matches ${locked ? "sof.tools.lock" : "what was installed"}`);
    }
  }

  return result;
}

module.exports = { verifyTools };
