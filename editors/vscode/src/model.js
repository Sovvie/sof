"use strict";

// The editor-independent core: which entries of a sof.toml are dependencies, what the registry
// says about each, and what tag they get. Nothing here touches the `vscode` module, so all of
// it is covered by plain node tests.

const semver = require("semver");
const { scan } = require("./toml-scan");
const { parseSpec } = require("./spec");
const { evaluate } = require("./versions");
const { findLockEntry } = require("./lockfile");

/**
 * @typedef {import("./toml-scan").Span} Span
 * @typedef {import("./toml-scan").Entry} Entry
 * @typedef {import("./toml-scan").ScanResult} ScanResult
 * @typedef {import("./spec").ParsedSpec} ParsedSpec
 * @typedef {import("./versions").PackageData} PackageData
 * @typedef {import("./versions").Evaluation} Evaluation
 * @typedef {import("./lockfile").LockEntry} LockEntry
 *
 * @typedef {Object} Dependency
 * @property {"install" | "publish"} kind  [[dependencies]] to install, or [package.dependencies] to publish.
 * @property {string} alias
 * @property {Span} keySpan
 * @property {Span} valueSpan              Including the quotes.
 * @property {Span} innerSpan              Excluding the quotes.
 * @property {string} raw                  Text between the quotes.
 * @property {boolean} terminated
 * @property {number} container
 * @property {string | null} groupPath     The `path = "..."` of the same [[dependencies]] table.
 * @property {ParsedSpec} spec
 * @property {Span | null} nameSpan        Absolute, when the name is well formed.
 * @property {Span | null} rangeSpan       Absolute, when the range is valid.
 *
 * @typedef {Object} RegistryState
 * @property {"loading" | "ok" | "notfound" | "error"} status
 * @property {PackageData} [data]
 * @property {string} [error]
 *
 * @typedef {Object} InstallState  How sof.lock compares with what sof.toml asks for.
 * @property {"ok" | "stale" | "missing" | "unknown" | "n/a"} state
 *   ok: locked at a version the range allows. stale: the lock pins a version the range no longer
 *   allows (the range was changed, sof install has not run since). missing: the lock has no entry
 *   for this dependency. unknown: there is no sof.lock to compare with. n/a: not an install entry.
 * @property {string | null} version  The version the lock pins, when it has an entry.
 *
 * @typedef {Object} Analyzed
 * @property {Dependency} dep
 * @property {RegistryState | null} state
 * @property {Evaluation | null} evaluation
 * @property {LockEntry | null} lock
 * @property {InstallState} install
 *
 * @typedef {Object} AnalyzeEnv
 * @property {(name: string) => RegistryState | null} getState
 * @property {LockEntry[] | null} [lockEntries]
 * @property {boolean} [includePrereleases]
 */

// Files the extension handles: sof.toml, .sof.toml and anything named *.sof.toml (the README's
// packages.sof.toml for publishing).
function isSofFileName(fileName) {
  const lower = fileName.toLowerCase();
  return lower === "sof.toml" || lower === ".sof.toml" || lower.endsWith(".sof.toml");
}

/**
 * Which kind of dependency a key path names, or null.
 * @param {string[]} path
 */
function classifyPath(path) {
  if (path.length === 2 && path[0] === "dependencies" && path[1] !== "path") {
    return "install";
  }
  if (path.length === 3 && path[0] === "package" && path[1] === "dependencies") {
    return "publish";
  }
  return null;
}

/**
 * @param {ScanResult} scanned
 * @returns {Dependency[]}
 */
function extractDependencies(scanned) {
  /** @type {Map<number, string>} */
  const groupPaths = new Map();
  for (const entry of scanned.entries) {
    if (
      entry.path.length === 2 &&
      entry.path[0] === "dependencies" &&
      entry.path[1] === "path" &&
      entry.value.kind === "string"
    ) {
      groupPaths.set(entry.container, entry.value.raw);
    }
  }

  /** @type {Dependency[]} */
  const dependencies = [];
  for (const entry of scanned.entries) {
    const kind = classifyPath(entry.path);
    if (!kind || entry.value.kind !== "string" || entry.value.multiline) {
      continue;
    }

    const value = entry.value;
    const spec = parseSpec(value.raw);
    const base = value.innerSpan.start;
    const absolute = (span) => (span ? { start: base + span.start, end: base + span.end } : null);

    dependencies.push({
      kind,
      alias: entry.key,
      keySpan: entry.keySpan,
      valueSpan: value.span,
      innerSpan: value.innerSpan,
      raw: value.raw,
      terminated: value.terminated,
      container: entry.container,
      groupPath: kind === "install" ? (groupPaths.get(entry.container) ?? null) : null,
      spec,
      nameSpan: absolute(spec.nameSpan),
      rangeSpan: absolute(spec.rangeSpan),
    });
  }

  return dependencies;
}

/** @param {string} text */
function parseDependencies(text) {
  return extractDependencies(scan(text));
}

/**
 * @param {Dependency[]} dependencies
 * @param {AnalyzeEnv} env
 * @returns {Analyzed[]}
 */
function analyze(dependencies, env) {
  return dependencies.map((dep) => {
    const { name, range } = dep.spec;
    const state = name ? env.getState(name) : null;

    let lock = null;
    if (name && dep.kind === "install" && dep.groupPath !== null && env.lockEntries) {
      lock = findLockEntry(env.lockEntries, { name, alias: dep.alias, groupPath: dep.groupPath });
    }

    let evaluation = null;
    if (name && range && state && state.data) {
      evaluation = evaluate({
        range,
        data: state.data,
        installed: lock ? lock.version : null,
        includePrereleases: Boolean(env.includePrereleases),
      });
    }

    return { dep, state, evaluation, lock, install: installState(dep, lock, env.lockEntries) };
  });
}

/**
 * @param {Dependency} dep
 * @param {LockEntry | null} lock
 * @param {LockEntry[] | null | undefined} lockEntries
 * @returns {InstallState}
 */
function installState(dep, lock, lockEntries) {
  const { name, range } = dep.spec;
  if (!name || !range || dep.kind !== "install" || dep.groupPath === null) {
    return { state: "n/a", version: null };
  }
  if (!lockEntries) {
    return { state: "unknown", version: null };
  }
  if (!lock) {
    return { state: "missing", version: null };
  }
  const satisfied = !semver.valid(lock.version) || semver.satisfies(lock.version, range, { includePrerelease: true });
  return { state: satisfied ? "ok" : "stale", version: lock.version };
}

/**
 * True while a dependency with a usable name is waiting for the registry. An entry without a
 * usable name (a malformed specifier) is never looked up, so it is never pending.
 * @param {Analyzed} analyzed
 */
function isPending(analyzed) {
  return Boolean(analyzed.dep.spec.name) && (!analyzed.state || analyzed.state.status === "loading");
}

/**
 * @typedef {"current" | "minor" | "major" | "problem" | "muted" | "install"} TagKind
 * @typedef {{ kind: TagKind, text: string }} Tag
 */

/**
 * The small tag shown after a dependency, or null for nothing.
 * @param {Analyzed} analyzed
 * @param {{ showUpToDate?: boolean }} [options]
 * @returns {Tag | null}
 */
function tagFor(analyzed, options = {}) {
  const { dep, state, evaluation } = analyzed;
  if (!dep.spec.name) {
    return null; // not a usable specifier: the diagnostic says why
  }

  if (!state || state.status === "loading") {
    return { kind: "muted", text: "checking…" };
  }
  if (state.status === "notfound") {
    return { kind: "muted", text: "not in index" };
  }
  if (!evaluation) {
    return state.status === "error" ? { kind: "muted", text: "⚠ unavailable" } : null;
  }

  switch (evaluation.status) {
    case "no-match":
      return { kind: "problem", text: "✗ no match" };
    case "yanked-only":
      return { kind: "problem", text: "✗ yanked" };
    case "locked-yanked":
      return { kind: "major", text: "⚠ yanked" };
    case "outdated": {
      const update = /** @type {NonNullable<Evaluation["update"]>} */ (evaluation.update);
      return { kind: update.diff === "major" ? "major" : "minor", text: `↑ ${update.version}` };
    }
    default:
      return options.showUpToDate === false ? null : { kind: "current", text: "✓ latest" };
  }
}

/**
 * A second tag for a dependency whose sof.lock has not caught up with sof.toml: the range was
 * changed (or the dependency added) and "sof run package install" has not run since. Only
 * shown next to a verdict that is itself usable.
 * @param {Analyzed} analyzed
 * @returns {Tag | null}
 */
function installTagFor(analyzed) {
  const { install, evaluation } = analyzed;
  if (install.state !== "stale" && install.state !== "missing") {
    return null;
  }
  if (!evaluation || evaluation.status === "no-match" || evaluation.status === "yanked-only") {
    return null;
  }
  return install.state === "stale"
    ? { kind: "install", text: `⟳ installed ${install.version}` }
    : { kind: "install", text: "⟳ not installed" };
}

module.exports = {
  isSofFileName,
  classifyPath,
  extractDependencies,
  parseDependencies,
  analyze,
  isPending,
  tagFor,
  installTagFor,
};
