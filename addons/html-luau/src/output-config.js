"use strict";

const fs = require("fs");
const path = require("path");
const toml = require("smol-toml");

function readOutputDefaults(configPathArg) {
  const configPath = path.resolve(configPathArg || "sof.toml");

  if (!fs.existsSync(configPath)) {
    return {
      configDirectory: process.cwd(),
      defaults: {},
    };
  }

  let configText;
  try {
    configText = fs.readFileSync(configPath, "utf8");
  } catch (_err) {
    return {
      configDirectory: path.dirname(configPath),
      defaults: {},
    };
  }

  let parsed;
  try {
    parsed = toml.parse(configText);
  } catch (_err) {
    return {
      configDirectory: path.dirname(configPath),
      defaults: {},
    };
  }

  const outputTable = parsed.output;
  if (
    !outputTable ||
    typeof outputTable !== "object" ||
    Array.isArray(outputTable)
  ) {
    return {
      configDirectory: path.dirname(configPath),
      defaults: {},
    };
  }

  const defaults = {};
  for (const [key, value] of Object.entries(outputTable)) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `[output] key "${key}" must be a non-empty string.`
      );
    }
    defaults[key] = value.trim();
  }

  return {
    configDirectory: path.dirname(configPath),
    defaults,
  };
}

/**
 * Returns the resolved absolute output path from the [output] table for a
 * given command name, or `null` when no default is configured.
 */
function resolveOutputDefault(configPathArg, commandName) {
  const config = readOutputDefaults(configPathArg);
  const tomlValue = config.defaults[commandName];

  if (tomlValue) {
    return path.resolve(config.configDirectory, tomlValue);
  }

  return null;
}

module.exports = {
  readOutputDefaults,
  resolveOutputDefault,
};
