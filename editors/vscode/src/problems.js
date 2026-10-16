"use strict";

// What is wrong with (or worth knowing about) each dependency, as plain data. The diagnostics
// feature turns these into squiggles; keeping them here keeps the wording testable.

const { installTagFor } = require("./model");

/**
 * @typedef {import("./toml-scan").Span} Span
 * @typedef {import("./model").Analyzed} Analyzed
 *
 * @typedef {Object} Problem
 * @property {string} code
 * @property {"error" | "warning" | "outdated"} severity  "outdated" takes the severity the user configured.
 * @property {string} message
 * @property {Span} span
 * @property {Analyzed["dep"]} dep
 */

/**
 * @param {Analyzed[]} analyzed
 * @param {{ wallyEnabled: boolean }} options
 * @returns {Problem[]}
 */
function problemsFor(analyzed, options) {
  /** @type {Problem[]} */
  const problems = [];

  for (const entry of analyzed) {
    const { dep, state, evaluation } = entry;
    const base = dep.innerSpan.start;

    if (!dep.terminated) {
      problems.push({
        code: "sof.unterminated",
        severity: "error",
        message: "Missing closing quote.",
        span: dep.valueSpan,
        dep,
      });
    }

    for (const problem of dep.spec.problems) {
      let span = { start: base + problem.span.start, end: base + problem.span.end };
      if (span.start === span.end) {
        span = dep.valueSpan; // nothing between the quotes: underline the quotes
      }
      problems.push({ code: `sof.${problem.code}`, severity: "error", message: problem.message, span, dep });
    }

    const { name, range } = dep.spec;
    if (!name) continue;

    if (state && state.status === "notfound" && dep.nameSpan) {
      problems.push({
        code: "sof.not-found",
        severity: "warning",
        message: options.wallyEnabled
          ? `"${name}" is not in the sof index or the Wally index.`
          : `"${name}" is not in the sof index.`,
        span: dep.nameSpan,
        dep,
      });
      continue;
    }

    if (!evaluation || !range || !dep.rangeSpan) continue;

    switch (evaluation.status) {
      case "no-match": {
        const latest = evaluation.latest ? ` The latest version is ${evaluation.latest}.` : "";
        problems.push({
          code: "sof.no-match",
          severity: "error",
          message: `No published version of ${name} satisfies "${range}".${latest}`,
          span: dep.rangeSpan,
          dep,
        });
        break;
      }
      case "yanked-only":
        problems.push({
          code: "sof.yanked",
          severity: "error",
          message:
            `Every version of ${name} matching "${range}" has been yanked (${evaluation.yankedMatches.join(", ")}), ` +
            "so sof will not install it.",
          span: dep.rangeSpan,
          dep,
        });
        break;
      case "locked-yanked":
        problems.push({
          code: "sof.locked-yanked",
          severity: "warning",
          message: `${name}@${evaluation.installed} (pinned in sof.lock) has been yanked.`,
          span: dep.rangeSpan,
          dep,
        });
        break;
      case "outdated": {
        const update = /** @type {NonNullable<typeof evaluation.update>} */ (evaluation.update);
        problems.push({
          code: "sof.outdated",
          severity: "outdated",
          message: `${name} ${evaluation.baseline} → ${update.version} is available (${update.diff}).`,
          span: dep.rangeSpan,
          dep,
        });
        break;
      }
      default:
        break;
    }

    if (installTagFor(entry)) {
      const { install } = entry;
      problems.push({
        code: "sof.not-installed",
        severity: "outdated",
        message:
          install.state === "stale"
            ? `${name}: sof.lock still pins ${install.version}, but sof.toml asks for "${range}". Run "sof run package install".`
            : `${name} has no entry in sof.lock. Run "sof run package install".`,
        span: dep.rangeSpan,
        dep,
      });
    }
  }

  return problems;
}

module.exports = { problemsFor };
