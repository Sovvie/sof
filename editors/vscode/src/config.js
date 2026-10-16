"use strict";

const vscode = require("vscode");
const { resolveRegistryUrl, DEFAULT_REGISTRY_URL } = require("./registry");

/** The extension's settings, read once and re-read when they change. */
class Config {
  constructor() {
    this.revision = 0;
    this.registryUrl = "";
    this.wallyEnabled = true;
    this.cacheMs = 0;
    this.inlineTags = true;
    this.showUpToDate = true;
    this.includePrereleases = false;
    this.diagnostics = true;
    this.outdatedSeverity = "off";
    this._read();
  }

  _read() {
    const cfg = vscode.workspace.getConfiguration("sof");

    let registryUrl = resolveRegistryUrl(cfg.get("registryUrl", ""));
    if (!/^https?:\/\//i.test(registryUrl)) {
      registryUrl = DEFAULT_REGISTRY_URL;
    }

    const flag = (key, fallback) => {
      const value = cfg.get(key);
      return typeof value === "boolean" ? value : fallback;
    };
    const minutes = Number(cfg.get("cacheMinutes"));

    this.registryUrl = registryUrl;
    this.wallyEnabled = flag("wally.enabled", true);
    this.cacheMs = (Number.isFinite(minutes) && minutes >= 0 ? minutes : 5) * 60 * 1000;
    this.inlineTags = flag("inlineTags.enabled", true);
    this.showUpToDate = flag("inlineTags.showUpToDate", true);
    this.includePrereleases = flag("includePrereleases", false);
    this.diagnostics = flag("diagnostics.enabled", true);
    this.outdatedSeverity = String(cfg.get("diagnostics.outdated") || "off");
  }

  /** @param {vscode.ConfigurationChangeEvent} event */
  update(event) {
    if (!event.affectsConfiguration("sof")) return false;
    this._read();
    this.revision++;
    return true;
  }

  /** What the registry client needs. */
  registrySettings() {
    return { registryUrl: this.registryUrl, wallyEnabled: this.wallyEnabled, cacheMs: this.cacheMs };
  }
}

module.exports = { Config };
