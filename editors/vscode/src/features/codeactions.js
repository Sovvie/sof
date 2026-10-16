"use strict";

const vscode = require("vscode");
const { planUpdates } = require("../updates");
const { rangeOf } = require("../util");

function titleFor(plan) {
  if (plan.kind === "fix") {
    return `Use ${plan.name}@${plan.to}`;
  }
  const size = plan.kind === "major" ? " (major)" : "";
  return `Update ${plan.name} to ${plan.to}${size}`;
}

/** Quick fixes: move a dependency to a newer (or installable) version. */
class CodeActionsFeature {
  /** @param {import("../service").Service} service */
  constructor(service) {
    this.service = service;
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {vscode.Range} range
   * @param {vscode.CodeActionContext} context
   */
  provideCodeActions(document, range, context) {
    if (context.only && !context.only.contains(vscode.CodeActionKind.QuickFix)) {
      return undefined;
    }

    const plans = planUpdates(this.service.analyze(document));
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);

    const actions = [];
    for (const plan of plans) {
      const { dep } = plan;
      if (end < dep.keySpan.start || start > dep.valueSpan.end) continue;

      const action = new vscode.CodeAction(titleFor(plan), vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, rangeOf(document, plan.span), plan.to);
      action.diagnostics = context.diagnostics.filter(
        (diagnostic) => diagnostic.source === "sof" && diagnostic.range.intersection(rangeOf(document, dep.valueSpan))
      );
      action.isPreferred = plan.kind === "fix";
      actions.push(action);
    }

    // Offered next to a single fix so "everything at once" is one keystroke away.
    const upgrades = plans.filter((plan) => plan.kind !== "fix");
    if (actions.length > 0 && upgrades.length >= 2) {
      const all = new vscode.CodeAction(`Update all ${upgrades.length} dependencies in this file`, vscode.CodeActionKind.QuickFix);
      all.edit = new vscode.WorkspaceEdit();
      for (const plan of upgrades) {
        all.edit.replace(document.uri, rangeOf(document, plan.span), plan.to);
      }
      actions.push(all);
    }

    return actions;
  }
}

module.exports = { CodeActionsFeature, titleFor };
