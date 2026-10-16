"use strict";

// The hover card for a dependency, as Markdown text. Two rules:
//
//  - Everything the registry sends (descriptions, authors, dependency specifiers) is escaped: a
//    package description must never be able to smuggle in a link, an image or a command: URI.
//
//  - Colour comes from <span style="color:var(--vscode-...)"> only. That is the one form VS Code's
//    hover sanitizer lets through, and it lets the card use the same theme colours as the inline
//    tags (sof.tag.*Foreground), so a user's colour overrides apply to both.

const { sortedVersions } = require("./versions");
const { planUpdate } = require("./updates");

/**
 * @typedef {import("./model").Analyzed} Analyzed
 *
 * @typedef {Object} HoverOptions
 * @property {(name: string, source: "sof" | "wally") => string} packageUrl
 * @property {(plan: import("./updates").PlannedUpdate) => string} updateCommand  A command: URI that applies the plan.
 * @property {string} refreshCommand
 * @property {string} installCommand  A command: URI that runs the install for this file.
 * @property {boolean} wallyEnabled
 */

const MAX_VERSIONS_SHOWN = 8;
const MAX_DESCRIPTION = 400;
const MAX_DEPENDENCIES_SHOWN = 8;

/** Escapes Markdown (and HTML) control characters so registry text renders as plain text. */
function escapeMarkdown(text) {
  return String(text)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_{}[\]()#+\-.!|<>~$&"']/g, "\\$&");
}

/** Plain text in a code span: backticks cannot be escaped inside one, so they are dropped. */
function code(text) {
  return `\`${String(text).replace(/[`\r\n]/g, "")}\``;
}

function shorten(text, max) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Text in one of the tag colour families (upToDate, update, major, problem, muted, install).
 * Only ever called with text this extension wrote, never registry text.
 */
function tone(family, text) {
  return `<span style="color:var(--vscode-sof-tag-${family}Foreground);">${text}</span>`;
}

/**
 * @param {Analyzed} analyzed
 * @param {HoverOptions} options
 * @returns {string | null} Markdown, or null when there is nothing worth showing.
 */
function buildHover(analyzed, options) {
  const { dep, state, evaluation, install } = analyzed;
  const { name, range } = dep.spec;
  if (!name) return null;

  const title = `**${escapeMarkdown(name)}**`;

  if (!state || state.status === "loading") {
    return `${title}\n\n${tone("muted", "Checking the registry…")}`;
  }

  if (state.status === "notfound") {
    const where = options.wallyEnabled ? "the sof index or the Wally index" : "the sof index";
    return `${title}\n\n${tone("muted", `**not in index** · not found in ${where}`)}`;
  }

  if (!state.data) {
    return (
      `${title}\n\n${tone("muted", "**⚠ unavailable** · could not load package info")}\n\n` +
      `${escapeMarkdown(state.error || "unknown error")}\n\n[Try again](${options.refreshCommand})`
    );
  }

  const { data } = state;
  const versions = sortedVersions(data);
  const sourceLabel = data.source === "wally" ? "Wally index" : "sof index";
  const lines = [`${title} · ${sourceLabel} · [Open ↗](${options.packageUrl(name, data.source)})`];

  // Metadata of the version the dependency is on, else the newest.
  const shownVersion =
    (evaluation && evaluation.baseline && versions.find((entry) => entry.version === evaluation.baseline)) ||
    versions[0];
  if (shownVersion && shownVersion.description) {
    lines.push("", escapeMarkdown(shorten(shownVersion.description, MAX_DESCRIPTION)));
  }

  if (range && evaluation) {
    const plan = planUpdate(analyzed);

    // The verdict: one coloured line, then what to do about it.
    switch (evaluation.status) {
      case "outdated": {
        const update = /** @type {NonNullable<typeof evaluation.update>} */ (evaluation.update);
        const scope = update.inRange ? "within your range" : `${update.diff} update, outside ${code(range)}`;
        lines.push("", `${tone(update.diff === "major" ? "major" : "update", `**↑ ${update.version} available**`)} · ${scope}`);
        if (plan) lines.push("", `[Update to ${code(plan.to)}](${options.updateCommand(plan)})`);
        break;
      }
      case "locked-yanked":
        lines.push("", `${tone("major", `**⚠ ${evaluation.installed} was yanked**`)} · it is still pinned in sof.lock`);
        if (plan) lines.push("", `[Update to ${code(plan.to)}](${options.updateCommand(plan)})`);
        break;
      case "yanked-only":
        lines.push("", `${tone("problem", "**✗ yanked**")} · every match is yanked (${evaluation.yankedMatches.map(code).join(", ")}), so a fresh install fails`);
        if (plan) lines.push("", `[Use ${code(plan.to)}](${options.updateCommand(plan)})`);
        break;
      case "no-match":
        lines.push("", `${tone("problem", "**✗ no match**")} · no published version satisfies ${code(range)}`);
        if (plan) lines.push("", `[Use ${code(plan.to)}](${options.updateCommand(plan)})`);
        break;
      default:
        lines.push("", tone("upToDate", "**✓ Up to date**"));
    }

    // What the range means, in one line. Nothing is repeated that the verdict already said.
    const meaning = [];
    if (evaluation.resolved && evaluation.resolved !== range) {
      meaning.push(`${code(range)} → ${code(evaluation.resolved)}`);
    }
    if (evaluation.installed) {
      meaning.push(`installed ${code(evaluation.installed)}`);
    }
    if (meaning.length > 0) lines.push("", meaning.join(" · "));
  }

  // sof.lock against sof.toml: has the last install caught up with the file?
  if (install.state === "stale") {
    lines.push(
      "",
      `${tone("install", `**⟳ Not installed at ${evaluation && evaluation.resolved ? evaluation.resolved : "the new range"}**`)} · ` +
        `sof.lock still pins ${code(String(install.version))}, which ${code(String(range))} does not allow`,
      "",
      `[Run sof run package install](${options.installCommand})`
    );
  } else if (install.state === "missing") {
    lines.push(
      "",
      `${tone("install", "**⟳ Not installed**")} · sof.lock has no entry for this dependency`,
      "",
      `[Run sof run package install](${options.installCommand})`
    );
  } else if (install.state === "unknown") {
    lines.push("", tone("muted", "No sof.lock next to this file yet, so installs cannot be compared."));
  }

  if (versions.length > 0) {
    const shown = versions.slice(0, MAX_VERSIONS_SHOWN).map((entry) => {
      const label = code(entry.version);
      return entry.yanked ? `~~${label}~~ (yanked)` : label;
    });
    const more = versions.length - shown.length;
    lines.push("", `Versions: ${shown.join(" · ")}${more > 0 ? ` · +${more} more` : ""}`);
  }

  if (shownVersion) {
    const facts = [];
    if (shownVersion.published) facts.push(`published ${shownVersion.published.slice(0, 10)}`);
    if (shownVersion.license) facts.push(escapeMarkdown(shownVersion.license));
    if (shownVersion.realm) facts.push(`${escapeMarkdown(shownVersion.realm)} realm`);
    if (shownVersion.authors && shownVersion.authors.length > 0) {
      facts.push(`by ${shownVersion.authors.map(escapeMarkdown).join(", ")}`);
    }
    if (facts.length > 0) lines.push("", facts.join(" · "));

    const dependencies = Object.entries(shownVersion.dependencies || {});
    if (dependencies.length > 0) {
      const listed = dependencies
        .slice(0, MAX_DEPENDENCIES_SHOWN)
        .map(([alias, specifier]) => `${escapeMarkdown(alias)} ${code(specifier)}`);
      const rest = dependencies.length - listed.length;
      lines.push("", `Depends on: ${listed.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`);
    }
  }

  return lines.join("\n");
}

module.exports = { buildHover, escapeMarkdown };
