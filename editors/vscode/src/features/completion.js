"use strict";

const vscode = require("vscode");
const semver = require("semver");
const { scan } = require("../toml-scan");
const { completionContext } = require("../completion-context");
const { suggestAlias } = require("../spec");
const { sortedVersions } = require("../versions");
const { rangeOf, withTimeout } = require("../util");

const LIST_WAIT_MS = 4000;
const PACKAGE_WAIT_MS = 3000;
const RANGE_OPERATOR = /^(\^|~|>=|<=|>|<|=)/;

function describe(text) {
  if (!text) return undefined;
  return new vscode.MarkdownString().appendText(text);
}

/** Package names, versions and whole dependency lines, from the registry. */
class CompletionFeature {
  /** @param {import("../service").Service} service */
  constructor(service) {
    this.service = service;
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {vscode.Position} position
   */
  async provideCompletionItems(document, position) {
    const text = document.getText();
    const context = completionContext(text, document.offsetAt(position), scan(text));
    if (!context) return undefined;

    if (context.type === "version") {
      return this.versionItems(document, context);
    }

    const list = await withTimeout(this.service.registry.getList(), LIST_WAIT_MS, null);
    if (!list) return undefined;
    return context.type === "name" ? this.nameItems(document, context, list) : this.keyItems(document, context, list);
  }

  /** @param {vscode.TextDocument} document @param {import("../completion-context").NameContext} context @param {import("../registry").ListEntry[]} list */
  nameItems(document, context, list) {
    const range = rangeOf(document, context.replace);
    const closing = context.needsClosingQuote ? '"' : "";

    return list.map((entry) => {
      const item = new vscode.CompletionItem(
        { label: entry.name, description: entry.latest || undefined },
        vscode.CompletionItemKind.Module
      );
      item.detail = entry.latest ? `latest ${entry.latest}` : undefined;
      item.documentation = describe(entry.description);
      item.range = range;
      item.filterText = entry.name;
      item.sortText = entry.name;
      if (context.hasRange) {
        item.insertText = entry.name; // the existing "@range" stays, and so does its quote
      } else if (entry.latest) {
        item.insertText = `${entry.name}@^${entry.latest}${closing}`;
      } else {
        // No version known: write "@" and let the version list open (the quote is closed then).
        item.insertText = `${entry.name}@`;
        item.command = { command: "editor.action.triggerSuggest", title: "Suggest versions" };
      }
      return item;
    });
  }

  /** @param {vscode.TextDocument} document @param {import("../completion-context").KeyContext} context @param {import("../registry").ListEntry[]} list */
  keyItems(document, context, list) {
    const range = rangeOf(document, context.replace);

    return list
      .filter((entry) => !context.usedNames.has(entry.name))
      .map((entry) => {
        const alias = suggestAlias(entry.name);
        const specifier = entry.latest ? `${entry.name}@^${entry.latest}` : `${entry.name}@`;
        const line = `${alias} = "${specifier}"`;

        const item = new vscode.CompletionItem(
          { label: entry.name, description: entry.latest || undefined },
          vscode.CompletionItemKind.Module
        );
        item.detail = line;
        item.documentation = describe(entry.description);
        item.range = range;
        item.filterText = `${entry.name} ${alias}`;
        item.sortText = entry.name;
        item.insertText = line;
        if (!entry.latest) {
          item.command = { command: "editor.action.triggerSuggest", title: "Suggest versions" };
        }
        return item;
      });
  }

  /** @param {vscode.TextDocument} document @param {import("../completion-context").VersionContext} context */
  async versionItems(document, context) {
    const { registry } = this.service;
    await withTimeout(registry.ensure([context.name]), PACKAGE_WAIT_MS, undefined);

    const state = registry.getState(context.name);
    if (!state || !state.data) return undefined;

    const versions = sortedVersions(state.data);
    if (versions.length === 0) return undefined;

    const range = rangeOf(document, context.replace);
    const closing = context.needsClosingQuote ? '"' : "";
    const stable = versions.filter((entry) => !entry.yanked && !semver.prerelease(entry.version));
    const latest = (stable[0] || versions.find((entry) => !entry.yanked) || versions[0]).version;

    // With an operator already typed, offer every version in that style; otherwise offer the
    // common styles for the latest version first, then every exact version.
    const typedOperator = RANGE_OPERATOR.exec(context.prefix.trim());
    /** @type {{ text: string, version: string, yanked: boolean, note: string }[]} */
    const candidates = [];

    if (typedOperator) {
      for (const entry of versions) {
        candidates.push({ text: `${typedOperator[1]}${entry.version}`, version: entry.version, yanked: entry.yanked, note: "" });
      }
    } else {
      candidates.push({ text: `^${latest}`, version: latest, yanked: false, note: "compatible with latest" });
      candidates.push({ text: `~${latest}`, version: latest, yanked: false, note: "patch updates only" });
      for (const entry of versions) {
        candidates.push({ text: entry.version, version: entry.version, yanked: entry.yanked, note: "exact" });
      }
    }

    return candidates.map((candidate, index) => {
      const entry = versions.find((v) => v.version === candidate.version);
      const item = new vscode.CompletionItem(candidate.text, vscode.CompletionItemKind.Value);
      item.range = range;
      item.filterText = candidate.text;
      item.sortText = String(index).padStart(4, "0");
      item.insertText = `${candidate.text}${closing}`;
      item.preselect = index === 0;

      const notes = [];
      if (candidate.note) notes.push(candidate.note);
      if (candidate.version === latest && !candidate.note) notes.push("latest");
      if (candidate.yanked) {
        notes.push("yanked");
        item.tags = [vscode.CompletionItemTag.Deprecated];
      }
      if (entry && entry.published) notes.push(entry.published.slice(0, 10));
      item.detail = notes.join(" · ") || undefined;
      return item;
    });
  }
}

module.exports = { CompletionFeature };
