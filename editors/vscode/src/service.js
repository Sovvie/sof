"use strict";

const vscode = require("vscode");
const { Registry } = require("./registry");
const { parseDependencies, analyze, isSofFileName } = require("./model");
const { parseLockfile } = require("./lockfile");

/**
 * @typedef {import("./model").Dependency} Dependency
 * @typedef {import("./model").Analyzed} Analyzed
 * @typedef {import("./lockfile").LockEntry} LockEntry
 */

const SELECTOR = {
  scheme: "file",
  pattern: "**/{sof.toml,.sof.toml,*.sof.toml}",
};

/** @param {vscode.TextDocument} document */
function isSofDocument(document) {
  if (document.uri.scheme !== "file") return false;
  const parts = document.uri.path.split("/");
  return isSofFileName(parts[parts.length - 1]);
}

// The sof.lock sitting next to a sof.toml, which is where the CLI keeps it.
class LockCache {
  constructor() {
    /** @type {Map<string, { entries: LockEntry[] | null, text: string | null }>} */
    this._byDirectory = new Map();
    this.revision = 0;
  }

  /** @param {vscode.Uri} documentUri */
  _lockUri(documentUri) {
    return vscode.Uri.joinPath(documentUri, "..", "sof.lock");
  }

  /** @param {vscode.Uri} documentUri @returns {LockEntry[] | null} */
  get(documentUri) {
    const cached = this._byDirectory.get(this._lockUri(documentUri).toString());
    return cached ? cached.entries : null;
  }

  /**
   * Reads (or re-reads) the lockfile; true when what we know changed.
   * @param {vscode.Uri} documentUri
   */
  async load(documentUri) {
    const lockUri = this._lockUri(documentUri);
    const key = lockUri.toString();

    let text = null;
    try {
      text = new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(lockUri));
    } catch (_err) {
      text = null; // no lockfile (yet), or unreadable: same as none
    }

    const before = this._byDirectory.get(key);
    if (before && before.text === text) {
      return false;
    }

    this._byDirectory.set(key, { entries: text === null ? null : parseLockfile(text), text });
    this.revision++;
    return true;
  }

  /** Forget a lockfile so the next load() re-reads it. @param {vscode.Uri} lockUri */
  forget(lockUri) {
    this._byDirectory.delete(lockUri.toString());
    this.revision++;
  }
}

// Everything the features share: registry data, lockfiles, and the parse/analysis of each open
// sof file, cached so that hover, decorations, diagnostics and code actions agree.
class Service {
  /** @param {import("./config").Config} config */
  constructor(config) {
    this.config = config;
    this.registry = new Registry({
      getSettings: () => config.registrySettings(),
      userAgent: "sof-vscode",
    });
    this.locks = new LockCache();

    /** @type {Map<string, { version: number, dependencies: Dependency[] }>} */
    this._parsed = new Map();
    /** @type {Map<string, { key: string, value: Analyzed[] }>} */
    this._analysis = new Map();
  }

  /** @param {vscode.TextDocument} document @returns {Dependency[]} */
  dependencies(document) {
    const key = document.uri.toString();
    const cached = this._parsed.get(key);
    if (cached && cached.version === document.version) {
      return cached.dependencies;
    }

    const dependencies = parseDependencies(document.getText());
    this._parsed.set(key, { version: document.version, dependencies });
    return dependencies;
  }

  /** @param {vscode.TextDocument} document @returns {Analyzed[]} */
  analyze(document) {
    const dependencies = this.dependencies(document);
    // A changed registry setting empties the registry's cache and bumps its revision; let it
    // notice that before the revision is read into the cache key.
    this.registry.refreshSettings();
    const key = [document.version, this.registry.revision, this.locks.revision, this.config.revision].join("|");

    const id = document.uri.toString();
    const cached = this._analysis.get(id);
    if (cached && cached.key === key) {
      return cached.value;
    }

    const value = analyze(dependencies, {
      getState: (name) => this.registry.getState(name),
      lockEntries: this.locks.get(document.uri),
      includePrereleases: this.config.includePrereleases,
    });
    this._analysis.set(id, { key, value });
    return value;
  }

  /**
   * Starts loading whatever this document needs; the registry's change event reports results.
   * @param {vscode.TextDocument} document
   * @param {{ force?: boolean }} [options]
   */
  async ensure(document, options = {}) {
    const names = new Set();
    for (const dependency of this.dependencies(document)) {
      if (dependency.spec.name) names.add(dependency.spec.name);
    }

    const lockLoaded = this.locks.load(document.uri);
    await Promise.all([this.registry.ensure(names, options), lockLoaded]);
  }

  /** @param {vscode.TextDocument} document */
  forget(document) {
    const key = document.uri.toString();
    this._parsed.delete(key);
    this._analysis.delete(key);
  }
}

module.exports = { Service, LockCache, isSofDocument, SELECTOR };
