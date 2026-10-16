"use strict";

// One line describing what the extension found in a file, for the "sof" output channel (and
// for bug reports: it says what was analysed without anyone having to screenshot tags).

const { tagFor, installTagFor, isPending } = require("./model");
const { planUpdates } = require("./updates");

/**
 * @param {import("./model").Analyzed[]} analyzed
 * @returns {{ text: string, errors: string[], pending: number }}
 */
function summarize(analyzed) {
  const plans = planUpdates(analyzed);
  const updates = plans.filter((plan) => plan.kind !== "fix").length;
  const unresolved = plans.length - updates;
  const pending = analyzed.filter(isPending).length;
  const toInstall = analyzed.filter((entry) => installTagFor(entry) !== null).length;
  const errors = [
    ...new Set(
      analyzed.flatMap((entry) => (entry.state && entry.state.status === "error" && entry.state.error ? [entry.state.error] : []))
    ),
  ];

  if (analyzed.length === 0) {
    return { text: "no dependencies found", errors, pending };
  }

  const tags = analyzed
    .map((entry) => {
      const tag = tagFor(entry);
      return tag ? `${entry.dep.alias} ${tag.text}` : `${entry.dep.alias} (invalid)`;
    })
    .join(", ");

  const parts = [`${analyzed.length} dependenc${analyzed.length === 1 ? "y" : "ies"}`];
  if (updates > 0) parts.push(`${updates} update${updates === 1 ? "" : "s"}`);
  if (unresolved > 0) parts.push(`${unresolved} unresolved`);
  if (toInstall > 0) parts.push(`${toInstall} not installed`);
  if (pending > 0) parts.push(`${pending} checking`);
  if (errors.length > 0) parts.push("registry unreachable");

  return { text: `${parts.join(", ")}: ${tags}`, errors, pending };
}

module.exports = { summarize };
