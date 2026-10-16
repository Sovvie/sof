"use strict";

// Decides what a dependency's range means against what the registry holds. The rules follow
// the sof CLI (resolver.js and `sof run package outdated`):
//   - a yanked version is never picked by a fresh install, but a lockfile may keep it;
//   - a range resolves to the highest version that satisfies it (prereleases included, as the
//     resolver does);
//   - "installed" is the version sof.lock pins, as long as it still satisfies the range.

const semver = require("semver");

/**
 * @typedef {Object} VersionInfo
 * @property {string} version
 * @property {boolean} yanked
 * @property {string} [published]            ISO date.
 * @property {string} [description]
 * @property {string} [license]
 * @property {string} [realm]
 * @property {string[]} [authors]
 * @property {Record<string, string>} dependencies
 *
 * @typedef {Object} PackageData
 * @property {"sof" | "wally"} source
 * @property {string} name
 * @property {VersionInfo[]} versions
 *
 * @typedef {Object} Update
 * @property {string} version
 * @property {"major" | "minor" | "patch" | "prerelease"} diff
 * @property {boolean} inRange   True when the range already allows it.
 *
 * @typedef {Object} Evaluation
 * @property {"current" | "outdated" | "no-match" | "yanked-only" | "locked-yanked"} status
 * @property {string | null} baseline   What the dependency is "on": the lock's version, else what the range resolves to.
 * @property {string | null} resolved   What a fresh install of the range would pick.
 * @property {string | null} installed  The version sof.lock pins, if it still satisfies the range.
 * @property {string | null} lockMismatch  A lock version that no longer satisfies the range.
 * @property {string | null} latest
 * @property {Update | null} update
 * @property {string[]} yankedMatches   Yanked versions the range would have matched.
 */

const SATISFIES = { includePrerelease: true };

/** @param {string[]} versions */
function highest(versions) {
  let best = null;
  for (const version of versions) {
    if (best === null || semver.gt(version, best)) {
      best = version;
    }
  }
  return best;
}

/** @param {string} from @param {string} to @returns {Update["diff"]} */
function diffKind(from, to) {
  const kind = semver.diff(from, to);
  if (kind === "major" || kind === "premajor") return "major";
  if (kind === "minor" || kind === "preminor") return "minor";
  if (kind === "patch" || kind === "prepatch") return "patch";
  return "prerelease";
}

/**
 * @param {{ range: string, data: PackageData, installed?: string | null, includePrereleases?: boolean }} input
 * @returns {Evaluation}
 */
function evaluate({ range, data, installed = null, includePrereleases = false }) {
  const valid = data.versions.filter((entry) => semver.valid(entry.version));
  const usable = valid.filter((entry) => !entry.yanked).map((entry) => entry.version);

  const resolved = semver.maxSatisfying(usable, range, SATISFIES);
  const yankedMatches = valid
    .filter((entry) => entry.yanked && semver.satisfies(entry.version, range, SATISFIES))
    .map((entry) => entry.version);

  let lockedVersion = null;
  let lockMismatch = null;
  if (installed && semver.valid(installed)) {
    if (semver.satisfies(installed, range, SATISFIES)) {
      lockedVersion = installed;
    } else {
      lockMismatch = installed;
    }
  }

  const baseline = lockedVersion || resolved;

  const stable = usable.filter((version) => !semver.prerelease(version));
  const onPrerelease = Boolean(baseline && semver.prerelease(baseline));
  const latest =
    includePrereleases || onPrerelease ? highest(usable) : highest(stable) || highest(usable);

  /** @type {Update | null} */
  let update = null;
  if (baseline && latest && semver.gt(latest, baseline)) {
    update = {
      version: latest,
      diff: diffKind(baseline, latest),
      inRange: semver.satisfies(latest, range, SATISFIES),
    };
  }

  /** @type {Evaluation["status"]} */
  let status;
  if (!baseline) {
    status = yankedMatches.length > 0 ? "yanked-only" : "no-match";
  } else if (lockedVersion && valid.some((entry) => entry.yanked && entry.version === lockedVersion)) {
    status = "locked-yanked";
  } else if (update) {
    status = "outdated";
  } else {
    status = "current";
  }

  return { status, baseline, resolved, installed: lockedVersion, lockMismatch, latest, update, yankedMatches };
}

/** Newest first. @param {PackageData} data */
function sortedVersions(data) {
  return data.versions
    .filter((entry) => semver.valid(entry.version))
    .sort((a, b) => semver.rcompare(a.version, b.version));
}

module.exports = { evaluate, sortedVersions, highest };
