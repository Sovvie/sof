"use strict";

const vscode = require("vscode");
const { planUpdates } = require("../updates");
const { isPending, installTagFor } = require("../model");
const { isSofDocument } = require("../service");

/** A summary of the active sof file in the status bar: "↑ 2 sof updates", "✓ sof"... */
class StatusBarFeature {
  /** @param {import("../service").Service} service */
  constructor(service) {
    this.service = service;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = "sof dependencies";
    this.item.command = "sof.updateDependencies";
  }

  update() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSofDocument(editor.document)) {
      this.item.hide();
      return;
    }

    const analyzed = this.service.analyze(editor.document).filter((entry) => entry.dep.kind === "install");
    if (analyzed.length === 0) {
      this.item.hide();
      return;
    }

    this.item.command = "sof.updateDependencies";
    const pending = analyzed.filter(isPending).length;
    const plans = planUpdates(analyzed);
    const upgrades = plans.filter((plan) => plan.kind !== "fix").length;
    const problems = plans.length - upgrades;
    const toInstall = analyzed.filter((entry) => installTagFor(entry) !== null).length;

    if (problems > 0) {
      this.item.text = `$(warning) sof: ${problems} unresolved`;
      this.item.tooltip = "Some dependencies cannot be installed as written. Click to fix.";
    } else if (toInstall > 0) {
      this.item.text = `$(cloud-download) sof: ${toInstall} to install`;
      this.item.tooltip = "sof.lock has not caught up with sof.toml. Click to run sof run package install.";
      this.item.command = "sof.runInstall";
    } else if (upgrades > 0) {
      this.item.text = `$(arrow-up) sof: ${upgrades} update${upgrades === 1 ? "" : "s"}`;
      this.item.tooltip = "Newer versions are available. Click to choose what to update.";
    } else if (pending > 0) {
      this.item.text = "$(sync~spin) sof";
      this.item.tooltip = "Checking the package index…";
    } else if (analyzed.some((entry) => entry.state && entry.state.status === "error")) {
      this.item.text = "$(circle-slash) sof: registry unreachable";
      this.item.tooltip = "Could not load package info. Click to retry.";
      this.item.command = "sof.refresh";
      this.item.show();
      return;
    } else {
      this.item.text = "$(check) sof";
      this.item.tooltip = "All dependencies are up to date.";
    }
    this.item.show();
  }

  dispose() {
    this.item.dispose();
  }
}

module.exports = { StatusBarFeature };
