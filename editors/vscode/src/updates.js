"use strict";

// Turns "this dependency is outdated" into a concrete text edit: which characters to replace
// and with what. Used by the quick fixes, the hover link and the update commands.

const { bumpRange } = require("./spec");

/**
 * @typedef {import("./toml-scan").Span} Span
 * @typedef {import("./model").Analyzed} Analyzed
 *
 * @typedef {Object} PlannedUpdate
 * @property {Analyzed["dep"]} dep
 * @property {string} name
 * @property {string} from            The range as written.
 * @property {string} to              The range to write instead.
 * @property {string} version         The version the dependency moves to.
 * @property {"major" | "minor" | "patch" | "prerelease" | "fix"} kind  "fix" = it had no installable match.
 * @property {Span} span              The range text to replace.
 */

// ^1, ~1.2, 1.2.3, ^1.0.0-beta.1: ranges where raising the number is the natural edit.
const SIMPLE_RANGE = /^[\^~]?\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/;

/**
 * @param {Analyzed} analyzed
 * @returns {PlannedUpdate | null}
 */
function planUpdate(analyzed) {
  const { dep, evaluation } = analyzed;
  const { name, range } = dep.spec;
  if (!name || !range || !dep.rangeSpan || !evaluation) {
    return null;
  }

  if ((evaluation.status === "outdated" || evaluation.status === "locked-yanked") && evaluation.update) {
    const { update } = evaluation;
    // A range that already allows the newer version (">=1", "*") is not ours to narrow; only
    // the simple ^/~/exact styles get their number raised.
    if (update.inRange && !SIMPLE_RANGE.test(range)) {
      return null;
    }
    const to = bumpRange(range, update.version);
    if (to === range) {
      return null;
    }
    return { dep, name, from: range, to, version: update.version, kind: update.diff, span: dep.rangeSpan };
  }

  if ((evaluation.status === "no-match" || evaluation.status === "yanked-only") && evaluation.latest) {
    return {
      dep,
      name,
      from: range,
      to: `^${evaluation.latest}`,
      version: evaluation.latest,
      kind: "fix",
      span: dep.rangeSpan,
    };
  }

  return null;
}

/** @param {Analyzed[]} analyzed @returns {PlannedUpdate[]} */
function planUpdates(analyzed) {
  const plans = [];
  for (const entry of analyzed) {
    const plan = planUpdate(entry);
    if (plan) plans.push(plan);
  }
  return plans;
}

module.exports = { planUpdate, planUpdates };
