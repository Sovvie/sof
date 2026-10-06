"use strict";

// Reading and editing [tools] in sof.toml (or the global ~/.sof/tools.toml, which has the same shape).

const fs = require("fs");
const path = require("path");
const toml = require("smol-toml");

const { normalizeAlias, normalizeSpecifier } = require("./spec");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseConfigText(configText, configPath) {
  let parsed;
  try {
    parsed = toml.parse(configText);
  } catch (err) {
    throw new Error(`Failed to parse TOML config at ${configPath}: ${err.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Config at ${configPath} must be a TOML object.`);
  }
  return parsed;
}

// allowMissing: the global file may not exist yet, which just means it lists no tools.
function readToolsFromConfig(configPathArg, { allowMissing = false } = {}) {
  const configPath = path.resolve(configPathArg || "sof.toml");
  const exists = fs.existsSync(configPath);
  if (!exists && !allowMissing) {
    throw new Error(`Config file does not exist: ${configPath}`);
  }

  const configText = exists ? fs.readFileSync(configPath, "utf8") : "";
  const parsed = parseConfigText(configText, configPath);
  const toolsTable = parsed.tools;
  const tools = {};

  if (toolsTable !== undefined) {
    if (!isPlainObject(toolsTable)) {
      throw new Error(`[tools] in ${configPath} must be a TOML table.`);
    }

    for (const [aliasRaw, specifierRaw] of Object.entries(toolsTable)) {
      const alias = normalizeAlias(aliasRaw, configPath);
      tools[alias] = normalizeSpecifier(specifierRaw, configPath, alias);
    }
  }

  return { configPath, configDirectory: path.dirname(configPath), configText, tools, exists };
}

// A bare TOML key can't hold a dot (a.b is a nested table), so such names are written quoted.
function formatKey(alias) {
  return /^[A-Za-z0-9_-]+$/.test(alias) ? alias : JSON.stringify(alias);
}

function buildToolsSectionLines(tools) {
  const aliases = Object.keys(tools).sort((a, b) => a.localeCompare(b));
  return ["[tools]", ...aliases.map((alias) => `${formatKey(alias)} = ${JSON.stringify(tools[alias])}`)];
}

function isToolsHeaderLine(line) {
  return /^\s*\[\s*tools\s*\]\s*(#.*)?$/.test(line);
}

function isAnySectionHeaderLine(line) {
  return /^\s*\[\[[^\]]+\]\]\s*(#.*)?$/.test(line) || /^\s*\[[^\[\]]+\]\s*(#.*)?$/.test(line);
}

function findToolsSection(lines) {
  const start = lines.findIndex(isToolsHeaderLine);
  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isAnySectionHeaderLine(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keyLinePattern(alias) {
  return new RegExp(`^(\\s*(["']?)${escapeRegExp(alias)}\\2\\s*=\\s*)("[^"]*"|'[^']*')(.*)$`);
}

function removeKeyLinePattern(alias) {
  return new RegExp(`^\\s*(["']?)${escapeRegExp(alias)}\\1\\s*=`);
}

// Rewrites [tools] from scratch (sorted). Used when the lines can't be edited in place.
function rebuildToolsSection(configText, tools) {
  const eol = /\r\n/.test(configText) ? "\r\n" : "\n";
  const lines = String(configText || "").split(/\r?\n/);
  const section = findToolsSection(lines);
  const sectionLines = buildToolsSectionLines(tools);

  if (!section) {
    const trimmed = String(configText || "").trimEnd();
    return `${trimmed ? `${trimmed}${eol}${eol}` : ""}${sectionLines.join(eol)}${eol}`;
  }

  const merged = [...lines.slice(0, section.start), ...sectionLines];
  const after = lines.slice(section.end);
  if (after.length > 0) {
    if (merged[merged.length - 1].trim() !== "") {
      merged.push("");
    }
    merged.push(...after);
  }

  const output = merged.join(eol);
  return output.endsWith(eol) ? output : `${output}${eol}`;
}

// Adds, changes or removes [tools] entries by editing only those lines, so comments, ordering and
// line endings stay as they were. set: { alias: specifier }, remove: [alias].
function editToolsText(configText, { set = {}, remove = [] }) {
  const text = String(configText || "");
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const additions = [];
  for (const [alias, specifier] of Object.entries(set)) {
    const section = findToolsSection(lines);
    const pattern = keyLinePattern(alias);
    const index = section
      ? lines.findIndex((line, lineIndex) => lineIndex > section.start && lineIndex < section.end && pattern.test(line))
      : -1;

    if (index === -1) {
      additions.push(`${formatKey(alias)} = ${JSON.stringify(specifier)}`);
    } else {
      lines[index] = lines[index].replace(pattern, (_all, prefix, _quote, _value, rest) => `${prefix}${JSON.stringify(specifier)}${rest}`);
    }
  }

  for (const alias of remove) {
    const section = findToolsSection(lines);
    const pattern = removeKeyLinePattern(alias);
    const index = section
      ? lines.findIndex((line, lineIndex) => lineIndex > section.start && lineIndex < section.end && pattern.test(line))
      : -1;
    if (index !== -1) {
      lines.splice(index, 1);
    }
  }

  if (additions.length > 0) {
    const section = findToolsSection(lines);
    if (!section) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
        lines.push("");
      }
      lines.push("[tools]", ...additions);
    } else {
      let insertAt = section.start + 1;
      for (let index = section.start + 1; index < section.end; index += 1) {
        if (lines[index].trim() !== "") {
          insertAt = index + 1;
        }
      }
      lines.splice(insertAt, 0, ...additions);
    }
  }

  return `${lines.join(eol)}${eol}`;
}

// Applies set/remove to the file's [tools], checks that re-reading it gives exactly the expected
// tools, and falls back to rewriting the whole section when an in-place edit didn't take.
function writeToolsEdit(config, edits) {
  const expected = { ...config.tools };
  for (const alias of edits.remove || []) {
    delete expected[alias];
  }
  Object.assign(expected, edits.set || {});

  const matches = (text) => {
    try {
      const table = parseConfigText(text, config.configPath).tools || {};
      const keys = Object.keys(table).sort();
      return JSON.stringify(keys) === JSON.stringify(Object.keys(expected).sort()) && keys.every((key) => table[key] === expected[key]);
    } catch (_err) {
      return false;
    }
  };

  let text = editToolsText(config.configText, edits);
  if (!matches(text)) {
    text = rebuildToolsSection(config.configText, expected);
  }
  if (!matches(text)) {
    throw new Error(`Couldn't edit [tools] in ${config.configPath}: please change it by hand.`);
  }

  if (text !== config.configText) {
    fs.mkdirSync(path.dirname(config.configPath), { recursive: true });
    fs.writeFileSync(config.configPath, text, "utf8");
  }
  return expected;
}

function addToolToConfig(configPathArg, aliasRaw, specifierRaw, { allowMissing = false } = {}) {
  const config = readToolsFromConfig(configPathArg, { allowMissing });
  const alias = normalizeAlias(aliasRaw, config.configPath);
  const specifier = normalizeSpecifier(specifierRaw, config.configPath, alias);

  // Names are compared without regard to case (rojo and Rojo are one tool to the resolver, which
  // takes the first it finds), so adding "Rojo" next to "rojo" changes that line instead of
  // leaving the old version in force.
  const existingKey = Object.keys(config.tools).find((name) => name.toLowerCase() === alias.toLowerCase());
  const key = existingKey || alias;
  const tools = writeToolsEdit(config, { set: { [key]: specifier } });

  return {
    configPath: config.configPath,
    configDirectory: config.configDirectory,
    alias: key,
    specifier,
    replaced: existingKey !== undefined,
    tools,
  };
}

function removeToolFromConfig(configPathArg, aliasRaw, { allowMissing = false } = {}) {
  const config = readToolsFromConfig(configPathArg, { allowMissing });
  const alias = Object.keys(config.tools).find((name) => name.toLowerCase() === String(aliasRaw).trim().toLowerCase());
  if (!alias) {
    throw new Error(`[tools] in ${config.configPath} has no tool "${aliasRaw}".`);
  }

  const specifier = config.tools[alias];
  const tools = writeToolsEdit(config, { remove: [alias] });
  return { configPath: config.configPath, alias, specifier, tools };
}

// updates: { alias: specifier }; every alias must already be in [tools].
function updateToolsInConfig(configPathArg, updates, { allowMissing = false } = {}) {
  const config = readToolsFromConfig(configPathArg, { allowMissing });
  for (const alias of Object.keys(updates)) {
    if (!Object.prototype.hasOwnProperty.call(config.tools, alias)) {
      throw new Error(`[tools] in ${config.configPath} has no tool "${alias}".`);
    }
  }

  return writeToolsEdit(config, { set: updates });
}

module.exports = {
  addToolToConfig,
  editToolsText,
  readToolsFromConfig,
  removeToolFromConfig,
  updateToolsInConfig,
};
