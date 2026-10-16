"use strict";

const vscode = require("vscode");
const { tagFor, installTagFor } = require("../model");
const { isSofDocument } = require("../service");

// Tag kind -> the colour family contributed in package.json (sof.tag.<family>Foreground/Background).
const COLOR_FAMILY = {
  current: "upToDate",
  minor: "update",
  major: "major",
  problem: "problem",
  muted: "muted",
  install: "install",
};

const FIRST_MARGIN = "0 0 0 1.5ch";
const SECOND_MARGIN = "0 0 0 0.8ch";

// VS Code only exposes a fixed set of properties for injected text; extra CSS can ride along in
// textDecoration, which is how the rounded "pill" shape is made. If a future version drops
// that, the tag still renders, just square.
const PILL_SHAPE = "none; border-radius: 4px; padding: 0 0.55ch; font-size: 0.85em; vertical-align: 5%;";

/**
 * One pill's styling and text. Styling is per instance (not per decoration type) so that two
 * pills of different colours can belong to a single decoration; see render().
 * @param {import("../model").Tag} tag
 * @param {string} margin
 */
function pill(tag, margin) {
  const family = COLOR_FAMILY[tag.kind];
  return {
    contentText: tag.text,
    color: new vscode.ThemeColor(`sof.tag.${family}Foreground`),
    backgroundColor: new vscode.ThemeColor(`sof.tag.${family}Background`),
    margin,
    textDecoration: PILL_SHAPE,
  };
}

/** The small tags after each dependency: "✓ latest", "↑ 2.0.0", "✗ no match", "⟳ not installed"... */
class DecorationsFeature {
  /** @param {import("../service").Service} service */
  constructor(service) {
    this.service = service;
    this.type = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    /** What was last drawn per document, for tests: [{ line, alias, text, kind }]. @type {Map<string, any[]>} */
    this.drawn = new Map();
  }

  /** @param {vscode.TextEditor} editor */
  render(editor) {
    const { document } = editor;
    if (!isSofDocument(document)) return;

    /** @type {vscode.DecorationOptions[]} */
    const options = [];
    const drawn = [];

    if (this.service.config.inlineTags) {
      for (const analyzed of this.service.analyze(document)) {
        const main = tagFor(analyzed, { showUpToDate: this.service.config.showUpToDate });
        const install = installTagFor(analyzed);
        if (!main && !install) continue;

        const position = document.positionAt(analyzed.dep.valueSpan.end);

        // A dependency whose lock is behind has two tags. Both hang off one decoration: the
        // install tag as its "before" part and the main tag as its "after" part, which CSS
        // always draws in that order. (Two separate decorations at one spot are drawn in an
        // order VS Code does not promise.) No hoverMessage: the hover provider covers the
        // string and its tags, and a second source made the card appear twice.
        /** @type {vscode.DecorationInstanceRenderOptions} */
        const renderOptions = {};
        if (main && install) {
          renderOptions.before = pill(install, FIRST_MARGIN);
          renderOptions.after = pill(main, SECOND_MARGIN);
        } else {
          renderOptions.after = pill(/** @type {import("../model").Tag} */ (main || install), FIRST_MARGIN);
        }
        options.push({ range: new vscode.Range(position, position), renderOptions });

        for (const tag of [install, main]) {
          if (tag) drawn.push({ line: position.line, alias: analyzed.dep.alias, text: tag.text, kind: tag.kind });
        }
      }
    }

    editor.setDecorations(this.type, options);
    this.drawn.set(document.uri.toString(), drawn);
  }

  /** @param {vscode.TextDocument} document */
  forget(document) {
    this.drawn.delete(document.uri.toString());
  }

  dispose() {
    this.type.dispose();
  }
}

module.exports = { DecorationsFeature };
