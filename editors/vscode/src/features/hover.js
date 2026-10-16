"use strict";

const vscode = require("vscode");
const { buildHover } = require("../hover-content");
const { rangeOf } = require("../util");

const TRUSTED_COMMANDS = ["sof.applyEdit", "sof.refresh", "sof.runInstall"];

/**
 * The command: URI that applies one planned edit, guarded against the file having changed.
 * @param {vscode.TextDocument} document
 * @param {import("../updates").PlannedUpdate} plan
 */
function applyEditCommand(document, plan) {
  const args = [document.uri.toString(), document.version, plan.span.start, plan.span.end, plan.from, plan.to];
  return `command:sof.applyEdit?${encodeURIComponent(JSON.stringify(args))}`;
}

/**
 * @param {import("../service").Service} service
 * @param {vscode.TextDocument} document
 * @param {import("../model").Analyzed} analyzed
 * @returns {vscode.MarkdownString | null}
 */
function hoverMarkdown(service, document, analyzed) {
  const text = buildHover(analyzed, {
    packageUrl: (name, source) => service.registry.packageUrl(name, source),
    updateCommand: (plan) => applyEditCommand(document, plan),
    refreshCommand: "command:sof.refresh",
    installCommand: `command:sof.runInstall?${encodeURIComponent(JSON.stringify([document.uri.toString()]))}`,
    wallyEnabled: service.config.wallyEnabled,
  });
  if (!text) return null;

  const markdown = new vscode.MarkdownString(text);
  markdown.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
  // Only so the colour spans survive; VS Code strips every other tag and attribute, and all
  // text from the registry is escaped before it gets here (see hover-content.js).
  markdown.supportHtml = true;
  return markdown;
}

/** Hover cards on dependency names and values. */
class HoverFeature {
  /** @param {import("../service").Service} service */
  constructor(service) {
    this.service = service;
  }

  /** @param {vscode.TextDocument} document @param {vscode.Position} position */
  provideHover(document, position) {
    const offset = document.offsetAt(position);

    for (const analyzed of this.service.analyze(document)) {
      const { dep } = analyzed;
      const onKey = offset >= dep.keySpan.start && offset <= dep.keySpan.end;
      const onValue = offset >= dep.valueSpan.start && offset <= dep.valueSpan.end;
      if (!onKey && !onValue) continue;

      const markdown = hoverMarkdown(this.service, document, analyzed);
      if (!markdown) return undefined;
      return new vscode.Hover(markdown, rangeOf(document, onKey ? dep.keySpan : dep.valueSpan));
    }

    return undefined;
  }
}

module.exports = { HoverFeature, hoverMarkdown, applyEditCommand };
