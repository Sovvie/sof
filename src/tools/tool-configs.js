"use strict";

const fs = require("fs");
const path = require("path");

const KNOWN_TOOL_CONFIGS = {
  selene: {
    fileName: "selene.toml",
    contents: ['std = "roblox"', ""].join("\n"),
  },
  stylua: {
    fileName: ".stylua.toml",
    contents: [
      'syntax = "Luau"',
      "column_width = 120",
      'indent_type = "Tabs"',
      "indent_width = 4",
      'quote_style = "AutoPreferDouble"',
      'call_parentheses = "Always"',
      "",
    ].join("\n"),
  },
};

function normalizeAlias(alias) {
  return String(alias || "").trim().toLowerCase();
}

// Whether anything is at the path, a symbolic link included, even one that points nowhere:
// existsSync says false for that, and writing to it would create whatever it points at (on
// Windows even an exclusive create follows such a link).
function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (_err) {
    return false;
  }
}

function scaffoldToolConfigs(projectDir, toolAliases) {
  const output = {
    created: [],
    skippedExisting: [],
  };

  const normalizedAliases = new Set(
    (Array.isArray(toolAliases) ? toolAliases : []).map(normalizeAlias).filter(Boolean)
  );
  if (normalizedAliases.size === 0) {
    return output;
  }

  for (const [toolAlias, config] of Object.entries(KNOWN_TOOL_CONFIGS)) {
    if (!normalizedAliases.has(toolAlias)) {
      continue;
    }

    const targetPath = path.resolve(projectDir, config.fileName);
    if (pathExists(targetPath)) {
      output.skippedExisting.push(config.fileName);
      continue;
    }

    try {
      fs.writeFileSync(targetPath, config.contents, { encoding: "utf8", flag: "wx" });
      output.created.push(config.fileName);
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      output.skippedExisting.push(config.fileName);
    }
  }

  return output;
}

module.exports = {
  scaffoldToolConfigs,
};
