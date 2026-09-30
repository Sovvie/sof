"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_ROKIT_HOME = path.join(os.homedir(), ".rokit");
const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";

// "github:owner/repo@1.2.3" -> { owner, repo, version }
function parseToolSpecifier(specifier) {
  const raw = String(specifier).replace(/^github:/, "");
  const atIndex = raw.lastIndexOf("@");
  const [owner, repo] = raw.slice(0, atIndex).split("/");
  return { owner, repo, version: raw.slice(atIndex + 1).replace(/^v/i, "") };
}

// The tools from [tools] that Rokit doesn't have yet: its tool storage has no folder for that
// exact version, or ~/.rokit/bin has no link for the alias. Anything that can't be confirmed
// counts as missing, so the worst case is one redundant `rokit install`.
function findMissingTools(tools, rokitHome = DEFAULT_ROKIT_HOME) {
  const missing = [];

  for (const [alias, specifier] of Object.entries(tools)) {
    const { owner, repo, version } = parseToolSpecifier(specifier);
    const storage = path.join(rokitHome, "tool-storage", owner.toLowerCase(), repo.toLowerCase(), version);
    const links = [alias, alias.toLowerCase()].map((name) => path.join(rokitHome, "bin", `${name}${EXE_SUFFIX}`));

    if (!fs.existsSync(storage) || !links.some((link) => fs.existsSync(link))) {
      missing.push({ alias, specifier });
    }
  }

  return missing;
}

module.exports = {
  findMissingTools,
  parseToolSpecifier,
};
