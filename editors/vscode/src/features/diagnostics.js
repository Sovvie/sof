"use strict";

const vscode = require("vscode");
const { problemsFor } = require("../problems");
const { rangeOf } = require("../util");
const { isSofDocument } = require("../service");

const OUTDATED_SEVERITY = {
  hint: vscode.DiagnosticSeverity.Hint,
  information: vscode.DiagnosticSeverity.Information,
  warning: vscode.DiagnosticSeverity.Warning,
};

/** Squiggles for invalid specifiers, unknown packages, unsatisfiable ranges and yanked versions. */
class DiagnosticsFeature {
  /** @param {import("../service").Service} service */
  constructor(service) {
    this.service = service;
    this.collection = vscode.languages.createDiagnosticCollection("sof");
  }

  /** @param {vscode.TextDocument} document */
  update(document) {
    if (!isSofDocument(document)) return;

    const { config } = this.service;
    if (!config.diagnostics) {
      this.collection.delete(document.uri);
      return;
    }

    const diagnostics = [];
    for (const problem of problemsFor(this.service.analyze(document), { wallyEnabled: config.wallyEnabled })) {
      let severity;
      if (problem.severity === "error") severity = vscode.DiagnosticSeverity.Error;
      else if (problem.severity === "warning") severity = vscode.DiagnosticSeverity.Warning;
      else severity = OUTDATED_SEVERITY[config.outdatedSeverity];
      if (severity === undefined) continue; // outdated reporting is off

      const diagnostic = new vscode.Diagnostic(rangeOf(document, problem.span), problem.message, severity);
      diagnostic.source = "sof";
      diagnostic.code = problem.code;
      diagnostics.push(diagnostic);
    }

    this.collection.set(document.uri, diagnostics);
  }

  /** @param {vscode.Uri} uri */
  clear(uri) {
    this.collection.delete(uri);
  }

  dispose() {
    this.collection.dispose();
  }
}

module.exports = { DiagnosticsFeature };
