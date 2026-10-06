"use strict";

// Reads the tool list of another toolchain manager so a project can move to sof.toml:
//   rokit.toml, aftman.toml   [tools] name = "owner/repo@version"
//   foreman.toml              [tools] name = { github = "owner/repo", version = "1.2.3" }
//                             (also { source = "owner/repo", ... }; GitLab and custom hosts aren't supported)

const fs = require("fs");
const path = require("path");
const toml = require("smol-toml");

const { formatSpecifier, normalizeAlias, parseToolSpecifier } = require("./spec");

const SOURCE_FILE_NAMES = ["rokit.toml", "aftman.toml", "foreman.toml"];

// Exactly one version: "1.2.3", "=1.2.3", "v1.2.3", "0.640". Foreman also takes ranges ("^1", "~2.1",
// ">=1"), and sof pins exact versions.
const EXACT_VERSION_PATTERN = /^=?\s*v?(\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.+-]+)?)$/;

function findImportSource(directory) {
  const found = SOURCE_FILE_NAMES.map((name) => path.join(directory, name)).find((file) => fs.existsSync(file));
  return found || null;
}

function specifierFromValue(value) {
  if (typeof value === "string") {
    return { specifier: value.trim() };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "isn't a string or a table" };
  }

  if (typeof value.gitlab === "string") {
    return { reason: "comes from GitLab, which sof doesn't install from" };
  }

  const repository = typeof value.github === "string" ? value.github : value.source;
  if (typeof repository !== "string") {
    return { reason: "has no github/source repository" };
  }

  if (typeof value.version !== "string") {
    return { reason: "has no version" };
  }

  const match = EXACT_VERSION_PATTERN.exec(value.version.trim());
  if (!match) {
    return { reason: `has the version range "${value.version}" (sof pins one exact version)` };
  }

  return { specifier: `${repository.trim()}@${match[1]}` };
}

// { tools: { alias: specifier }, skipped: [{ alias, reason }] }
function readForeignTools(file) {
  let parsed;
  try {
    parsed = toml.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${err.message}`);
  }

  const table = parsed.tools;
  if (table === undefined) {
    return { tools: {}, skipped: [] };
  }
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    throw new Error(`[tools] in ${file} must be a TOML table.`);
  }

  const tools = {};
  const skipped = [];
  for (const [aliasRaw, value] of Object.entries(table)) {
    try {
      const alias = normalizeAlias(aliasRaw, path.basename(file));
      const { specifier, reason } = specifierFromValue(value);
      if (reason) {
        skipped.push({ alias: aliasRaw, reason });
        continue;
      }

      tools[alias] = formatSpecifier(parseToolSpecifier(specifier, `${aliasRaw}`));
    } catch (err) {
      skipped.push({ alias: aliasRaw, reason: err.message.replace(/^[^:]*:\s*/, "") });
    }
  }

  return { tools, skipped };
}

module.exports = {
  SOURCE_FILE_NAMES,
  findImportSource,
  readForeignTools,
};
