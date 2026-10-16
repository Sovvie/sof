"use strict";

// ~/.sof/cache: what sof downloaded, kept so that installs work offline (--offline or SOF_OFFLINE=1)
// and repeat installs don't download the same bytes again.
//
//   cache/index/<source>/<package>.json                 the registry's answer for a package
//   cache/packages/<source>/<package>/<version>.bin     the package archive (+ .json: its type and sha256)
//   cache/tools/<owner>/<repo>/<version>/<platform>.bin the release asset of a tool (+ .json: asset name, sha256)
//
// Package versions never change once published, so a cached archive is always right. Everything read
// from here is checked against the sha256 written next to it; a file that doesn't match is ignored.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { sofHome } = require("./addons/store");

function cacheRoot() {
  return path.join(sofHome(), "cache");
}

function isOffline() {
  return process.env.SOF_OFFLINE === "1";
}

function setOffline(value = true) {
  if (value) {
    process.env.SOF_OFFLINE = "1";
  } else {
    delete process.env.SOF_OFFLINE;
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// One path segment from something that came from a registry or a sof.toml.
function segment(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, "_");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new Error(`Can't cache something called ${JSON.stringify(value)}.`);
  }
  return cleaned;
}

function packageSegments(packageName) {
  return String(packageName).split("/").map(segment);
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_err) {
    return null;
  }
}

// --- registry answers ---------------------------------------------------------------------------

function indexFile(source, packageName) {
  return path.join(cacheRoot(), "index", segment(source), ...packageSegments(packageName)) + ".json";
}

function writeIndex(source, packageName, result) {
  try {
    writeAtomic(indexFile(source, packageName), JSON.stringify(result));
  } catch (_err) {
    // A cache that can't be written is only a missing speed-up.
  }
}

function readIndex(source, packageName) {
  try {
    const result = readJson(indexFile(source, packageName));
    return result && Array.isArray(result.versions) ? result : null;
  } catch (_err) {
    return null;
  }
}

// --- package archives ---------------------------------------------------------------------------

function packageBase(source, packageName, version) {
  return path.join(cacheRoot(), "packages", segment(source), ...packageSegments(packageName), segment(version));
}

function writePackage(source, packageName, version, buffer, archiveType) {
  try {
    const base = packageBase(source, packageName, version);
    writeAtomic(`${base}.bin`, buffer);
    writeAtomic(`${base}.json`, JSON.stringify({ archiveType, sha256: sha256(buffer), size: buffer.length }));
  } catch (_err) {
    // See writeIndex.
  }
}

function readPackage(source, packageName, version) {
  try {
    const base = packageBase(source, packageName, version);
    const meta = readJson(`${base}.json`);
    if (!meta || typeof meta.sha256 !== "string" || typeof meta.archiveType !== "string") {
      return null;
    }
    const buffer = fs.readFileSync(`${base}.bin`);
    return sha256(buffer) === meta.sha256 ? { buffer, archiveType: meta.archiveType } : null;
  } catch (_err) {
    return null;
  }
}

// --- tool release assets ------------------------------------------------------------------------

function toolBase(spec, platform) {
  return path.join(cacheRoot(), "tools", segment(spec.owner.toLowerCase()), segment(spec.repo.toLowerCase()), segment(spec.version), segment(platform));
}

function writeToolAsset(spec, platform, asset, buffer) {
  try {
    const base = toolBase(spec, platform);
    writeAtomic(`${base}.bin`, buffer);
    writeAtomic(`${base}.json`, JSON.stringify({ asset, sha256: sha256(buffer), size: buffer.length }));
  } catch (_err) {
    // See writeIndex.
  }
}

function readToolAsset(spec, platform) {
  try {
    const base = toolBase(spec, platform);
    const meta = readJson(`${base}.json`);
    if (!meta || typeof meta.sha256 !== "string" || typeof meta.asset !== "string") {
      return null;
    }
    const buffer = fs.readFileSync(`${base}.bin`);
    return sha256(buffer) === meta.sha256 ? { asset: meta.asset, sha256: meta.sha256, buffer } : null;
  } catch (_err) {
    return null;
  }
}

// --- looking after it ---------------------------------------------------------------------------

const CATEGORIES = ["index", "packages", "tools"];

function folderSize(directory) {
  let files = 0;
  let bytes = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch (_err) {
          // Gone while counting.
        }
      }
    }
  };
  walk(directory);
  return { files, bytes };
}

function cacheInfo() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, folderSize(path.join(cacheRoot(), category))]));
}

function clearCache(categories = CATEGORIES) {
  const removed = cacheInfo();
  for (const category of categories) {
    if (!CATEGORIES.includes(category)) {
      throw new Error(`Unknown cache folder "${category}" (one of: ${CATEGORIES.join(", ")}).`);
    }
    fs.rmSync(path.join(cacheRoot(), category), { recursive: true, force: true });
  }
  return Object.fromEntries(categories.map((category) => [category, removed[category]]));
}

module.exports = {
  CATEGORIES,
  cacheInfo,
  cacheRoot,
  clearCache,
  isOffline,
  readIndex,
  readPackage,
  readToolAsset,
  setOffline,
  writeIndex,
  writePackage,
  writeToolAsset,
};
