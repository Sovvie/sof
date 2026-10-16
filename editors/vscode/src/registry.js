"use strict";

// Talks to the sof package index the way the CLI does (src/packages/providers/sof.js):
//   GET <registry>/index/<scope>/<name>.json   every version of one package
//   GET <registry>/v1/packages?limit=&offset=  the package listing (names + latest version)
// and falls back to the Wally index for names the sof index does not hold.
//
// Results are cached. A cached answer is served immediately even when it is old; it is then
// refreshed in the background (If-None-Match, so an unchanged package costs a 304), which keeps
// tags from flickering back to "checking…" every few minutes.

const DEFAULT_REGISTRY_URL = "https://sof.sov.gg";
const WALLY_INDEX_URL = "https://raw.githubusercontent.com/UpliftGames/wally-index/main";

// What the sof registry accepts as a name segment once lowercased (providers/sof.js).
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const REQUEST_TIMEOUT_MS = 10000;
const MAX_PARALLEL = 6;
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 50;
const ERROR_RETRY_MS = 30 * 1000;
const NOTFOUND_TTL_MS = 60 * 1000;

/**
 * @typedef {import("./versions").PackageData} PackageData
 * @typedef {import("./versions").VersionInfo} VersionInfo
 * @typedef {import("./model").RegistryState} RegistryState
 *
 * @typedef {Object} Settings
 * @property {string} registryUrl   Base URL, no trailing slash.
 * @property {boolean} wallyEnabled
 * @property {number} cacheMs
 *
 * @typedef {Object} ListEntry
 * @property {string} name
 * @property {string} latest
 * @property {number} versions
 * @property {string} description
 * @property {string} [updated]
 *
 * @typedef {Object} Entry
 * @property {"loading" | "ok" | "notfound" | "error"} status
 * @property {PackageData | null} data
 * @property {string | null} error
 * @property {string | null} etag
 * @property {number} fetchedAt
 * @property {Promise<void> | null} promise
 */

/** The configured registry, else $SOF_REGISTRY_URL (as the CLI), else the public one. */
function resolveRegistryUrl(configured, env = process.env) {
  const raw = (configured && configured.trim()) || (env.SOF_REGISTRY_URL || "").trim() || DEFAULT_REGISTRY_URL;
  return raw.replace(/\/+$/, "");
}

// Reads and drops a body we have no use for, so the connection is released.
async function discard(response) {
  try {
    await response.text();
  } catch (_err) {
    // Nothing to release.
  }
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function stringMap(value) {
  /** @type {Record<string, string>} */
  const output = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") output[key] = item;
    }
  }
  return output;
}

/** @returns {PackageData | null} null when the file holds no versions. */
function parseSofIndex(name, json) {
  if (!json || typeof json !== "object" || !json.versions || typeof json.versions !== "object") {
    throw new Error('The index file has no "versions" object.');
  }

  /** @type {VersionInfo[]} */
  const versions = Object.entries(json.versions).map(([version, meta]) => {
    const m = meta && typeof meta === "object" ? meta : {};
    return {
      version,
      yanked: m.yanked === true,
      published: typeof m.published === "string" ? m.published : undefined,
      description: typeof m.description === "string" ? m.description : undefined,
      license: typeof m.license === "string" ? m.license : undefined,
      realm: typeof m.realm === "string" ? m.realm : undefined,
      authors: stringList(m.authors),
      dependencies: stringMap(m.dependencies),
    };
  });

  /** @type {PackageData} */
  const data = { source: "sof", name, versions };
  return versions.length > 0 ? data : null;
}

/** Wally index files are one JSON object per line, one line per version. */
function parseWallyIndex(name, text) {
  /** @type {VersionInfo[]} */
  const versions = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (_err) {
      throw new Error("The Wally index file is not valid.");
    }

    const meta = parsed && parsed.package;
    if (!meta || typeof meta.version !== "string") continue;
    versions.push({
      version: meta.version,
      yanked: false,
      description: typeof meta.description === "string" ? meta.description : undefined,
      license: typeof meta.license === "string" ? meta.license : undefined,
      realm: typeof meta.realm === "string" ? meta.realm : undefined,
      authors: stringList(meta.authors),
      dependencies: { ...stringMap(parsed.dependencies), ...stringMap(parsed["server-dependencies"]) },
    });
  }

  /** @type {PackageData} */
  const data = { source: "wally", name, versions };
  return versions.length > 0 ? data : null;
}

class Registry {
  /**
   * @param {{
   *   getSettings: () => Settings,
   *   fetch?: typeof fetch,
   *   now?: () => number,
   *   userAgent?: string,
   * }} options
   */
  constructor(options) {
    this._getSettings = options.getSettings;
    this._fetch = options.fetch || globalThis.fetch;
    this._now = options.now || Date.now;
    this._userAgent = options.userAgent || "sof-vscode";

    /** @type {Map<string, Entry>} */
    this._entries = new Map();
    /** @type {Set<() => void>} */
    this._listeners = new Set();
    this._settingsKey = null;

    /** @type {ListEntry[] | null} */
    this._list = null;
    this._listAt = 0;
    /** @type {Promise<void> | null} */
    this._listPromise = null;
    this._listError = null;

    this._running = 0;
    /** @type {Array<() => void>} */
    this._waiting = [];

    /** Bumped whenever something a feature might show has changed. */
    this.revision = 0;
  }

  /** @param {() => void} listener */
  onDidChange(listener) {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  }

  _changed() {
    this.revision++;
    for (const listener of [...this._listeners]) {
      try {
        listener();
      } catch (_err) {
        // A broken listener must not stop the others.
      }
    }
  }

  // A different registry or Wally switch invalidates everything cached.
  _checkSettings() {
    const settings = this._getSettings();
    const key = `${settings.registryUrl}|${settings.wallyEnabled}`;
    if (this._settingsKey !== null && this._settingsKey !== key) {
      this._entries.clear();
      this._list = null;
      this._listAt = 0;
      this._listError = null;
      this._settingsKey = key;
      this._changed();
    }
    this._settingsKey = key;
    return settings;
  }

  /** Notices a changed registry/Wally setting now (emptying the cache) rather than on next use. */
  refreshSettings() {
    this._checkSettings();
  }

  /** The registry's page for a package, for "open in browser". */
  packageUrl(name, source = "sof") {
    if (source === "wally") {
      return `https://wally.run/package/${name}`;
    }
    return `${this._getSettings().registryUrl}/p/${name.toLowerCase()}`;
  }

  /**
   * What is known about a package right now, without any network.
   * @param {string} name
   * @returns {RegistryState | null}
   */
  getState(name) {
    this._checkSettings();
    const entry = this._entries.get(name);
    if (!entry) return null;
    if (entry.data) return { status: "ok", data: entry.data };
    if (entry.status === "notfound") return { status: "notfound" };
    if (entry.status === "error") return { status: "error", error: entry.error || "unknown error" };
    return { status: "loading" };
  }

  /** Names currently cached with data (for "update everything" style commands). */
  hasData(name) {
    const entry = this._entries.get(name);
    return Boolean(entry && entry.data);
  }

  /**
   * Makes sure these packages are cached and reasonably fresh. Never rejects: a failure is
   * recorded as the package's state.
   * @param {Iterable<string>} names
   * @param {{ force?: boolean }} [options]
   */
  async ensure(names, options = {}) {
    const settings = this._checkSettings();
    const jobs = [];

    for (const name of new Set(names)) {
      const entry = this._entries.get(name);
      if (entry && entry.promise) {
        jobs.push(entry.promise);
        continue;
      }
      if (!options.force && entry && this._isFresh(entry, settings)) {
        continue;
      }
      jobs.push(this._refresh(name, entry));
    }

    await Promise.all(jobs);
  }

  /** @param {Entry} entry @param {Settings} settings */
  _isFresh(entry, settings) {
    const age = this._now() - entry.fetchedAt;
    if (entry.status === "error") return age < ERROR_RETRY_MS;
    if (entry.status === "notfound") return age < Math.min(settings.cacheMs, NOTFOUND_TTL_MS);
    return age < settings.cacheMs;
  }

  /**
   * @param {string} name
   * @param {Entry | undefined} existing
   */
  _refresh(name, existing) {
    /** @type {Entry} */
    const entry = existing || {
      status: "loading",
      data: null,
      error: null,
      etag: null,
      fetchedAt: 0,
      promise: null,
    };
    this._entries.set(name, entry);
    const settingsKey = this._settingsKey;

    entry.promise = this._schedule(() => this._load(name, entry))
      .then(
        (result) => {
          if (this._settingsKey !== settingsKey) return;
          entry.fetchedAt = this._now();
          if (result.kind === "ok") {
            entry.status = "ok";
            entry.data = result.data;
            entry.etag = result.etag;
            entry.error = null;
            this._changed();
          } else if (result.kind === "notfound") {
            const changed = entry.status !== "notfound" || entry.data !== null;
            entry.status = "notfound";
            entry.data = null;
            entry.etag = null;
            entry.error = null;
            if (changed) this._changed();
          } else if (entry.status === "loading" || entry.status === "error") {
            // 304 on something never loaded cannot happen; treat as a retry later.
            entry.status = "error";
          }
        },
        (err) => {
          if (this._settingsKey !== settingsKey) return;
          const message = err && err.message ? err.message : String(err);
          if (entry.data) {
            // Stale data beats an error: keep showing it, and look again soon.
            entry.fetchedAt = this._now() - this._getSettings().cacheMs + ERROR_RETRY_MS;
          } else {
            entry.fetchedAt = this._now();
            const changed = entry.status !== "error" || entry.error !== message;
            entry.status = "error";
            entry.error = message;
            if (changed) this._changed();
          }
        }
      )
      .finally(() => {
        entry.promise = null;
      });

    return entry.promise;
  }

  _schedule(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this._running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this._running--;
            const next = this._waiting.shift();
            if (next) next();
          });
      };
      if (this._running < MAX_PARALLEL) run();
      else this._waiting.push(run);
    });
  }

  async _request(url, etag) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      /** @type {Record<string, string>} */
      const headers = { "User-Agent": this._userAgent, Accept: "application/json, text/plain" };
      if (etag) headers["If-None-Match"] = etag;
      return await this._fetch(url, { headers, signal: controller.signal });
    } catch (thrown) {
      /** @type {any} */
      const err = thrown;
      const reason =
        err && err.name === "AbortError"
          ? "timed out"
          : [err && err.message, err && err.cause && err.cause.message].filter(Boolean).join(": ");
      throw new Error(`Could not reach ${new URL(url).origin} (${reason}).`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {string} name
   * @param {Entry} entry
   * @returns {Promise<{ kind: "ok", data: PackageData, etag: string | null } | { kind: "notmodified" } | { kind: "notfound" }>}
   */
  async _load(name, entry) {
    const settings = this._getSettings();
    const [scope, pkg] = name.split("/").map((part) => part.toLowerCase());

    if (SEGMENT_PATTERN.test(scope) && SEGMENT_PATTERN.test(pkg)) {
      const url = `${settings.registryUrl}/index/${encodeURIComponent(scope)}/${encodeURIComponent(pkg)}.json`;
      const etag = entry.data && entry.data.source === "sof" ? entry.etag : null;
      const response = await this._request(url, etag);

      if (response.status === 304) {
        return { kind: "notmodified" };
      }
      if (response.ok) {
        let data;
        try {
          data = parseSofIndex(name, await response.json());
        } catch (err) {
          throw new Error(`Unexpected answer from ${url}: ${err instanceof Error ? err.message : err}`);
        }
        if (data) {
          return { kind: "ok", data, etag: response.headers.get("etag") };
        }
      } else {
        await discard(response);
        if (response.status !== 404) {
          throw new Error(`The registry answered ${response.status} for ${name}.`);
        }
      }
    }

    if (!settings.wallyEnabled) {
      return { kind: "notfound" };
    }

    const [rawScope, rawPkg] = name.split("/");
    const url = `${WALLY_INDEX_URL}/${encodeURIComponent(rawScope)}/${encodeURIComponent(rawPkg)}`;
    const etag = entry.data && entry.data.source === "wally" ? entry.etag : null;
    const response = await this._request(url, etag);

    if (response.status === 304) {
      return { kind: "notmodified" };
    }
    if (!response.ok) {
      await discard(response);
      if (response.status === 404) {
        return { kind: "notfound" };
      }
      throw new Error(`The Wally index answered ${response.status} for ${name}.`);
    }

    const data = parseWallyIndex(name, await response.text());
    return data ? { kind: "ok", data, etag: response.headers.get("etag") } : { kind: "notfound" };
  }

  // ---- package listing -------------------------------------------------------------------

  /** The listing as last fetched, without network; null when never fetched. */
  cachedList() {
    this._checkSettings();
    return this._list;
  }

  /**
   * Every package the sof registry lists. Serves the cached listing at once and refreshes it
   * in the background when it is old; waits for the network only the first time.
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<ListEntry[]>}
   */
  async getList(options = {}) {
    const settings = this._checkSettings();
    const stale = this._now() - this._listAt >= settings.cacheMs;

    if (this._list && !options.force) {
      if (stale) void this._refreshList();
      return this._list;
    }

    await this._refreshList();
    if (!this._list) {
      throw new Error(this._listError || "The package list is not available.");
    }
    return this._list;
  }

  _refreshList() {
    if (this._listPromise) return this._listPromise;
    const settingsKey = this._settingsKey;

    this._listPromise = this._schedule(() => this._loadList())
      .then(
        (list) => {
          if (this._settingsKey !== settingsKey) return;
          this._list = list;
          this._listAt = this._now();
          this._listError = null;
          this._changed();
        },
        (err) => {
          if (this._settingsKey !== settingsKey) return;
          this._listError = err && err.message ? err.message : String(err);
          // Retry on the next request rather than hammering a registry that is down.
          this._listAt = this._now() - this._getSettings().cacheMs + ERROR_RETRY_MS;
        }
      )
      .finally(() => {
        this._listPromise = null;
      });

    return this._listPromise;
  }

  /** @returns {Promise<ListEntry[]>} */
  async _loadList() {
    const base = this._getSettings().registryUrl;
    /** @type {ListEntry[]} */
    const packages = [];

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const offset = page * LIST_PAGE_SIZE;
      const response = await this._request(`${base}/v1/packages?limit=${LIST_PAGE_SIZE}&offset=${offset}`);
      if (!response.ok) {
        await discard(response);
        throw new Error(`The registry answered ${response.status} for its package list.`);
      }

      /** @type {any} */
      const body = await response.json();
      if (!body || !Array.isArray(body.packages)) {
        throw new Error("Unexpected answer from the registry's package list.");
      }

      for (const item of body.packages) {
        if (item && typeof item.name === "string") {
          packages.push({
            name: item.name,
            latest: typeof item.latest === "string" ? item.latest : "",
            versions: Number(item.versions) || 0,
            description: typeof item.description === "string" ? item.description : "",
            updated: typeof item.updated === "string" ? item.updated : undefined,
          });
        }
      }

      const total = Number(body.total) || 0;
      if (body.packages.length === 0 || offset + LIST_PAGE_SIZE >= total) {
        break;
      }
    }

    return packages;
  }

  /** Marks everything stale so the next ensure()/getList() refetches, keeping what is shown. */
  expire() {
    for (const entry of this._entries.values()) {
      entry.fetchedAt = 0;
    }
    this._listAt = 0;
  }
}

module.exports = {
  Registry,
  resolveRegistryUrl,
  parseSofIndex,
  parseWallyIndex,
  DEFAULT_REGISTRY_URL,
};
