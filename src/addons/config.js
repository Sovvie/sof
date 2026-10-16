"use strict";

// An add-on's settings: the [addons.<name>] table of the nearest sof.toml (this folder, then each
// parent) that has one. Only sof core reads it; a sandboxed add-on gets the result over IPC.

const fs = require("fs");
const path = require("path");
const toml = require("smol-toml");

function readAddonConfig(name, startDirectory = process.cwd()) {
  let directory = path.resolve(startDirectory);
  for (;;) {
    const file = path.join(directory, "sof.toml");
    if (fs.existsSync(file)) {
      let parsed;
      try {
        parsed = toml.parse(fs.readFileSync(file, "utf8"));
      } catch (err) {
        throw new Error(`Failed to parse ${file}: ${err.message}`);
      }
      const table = parsed.addons && typeof parsed.addons === "object" ? parsed.addons[name] : undefined;
      if (table && typeof table === "object" && !Array.isArray(table)) {
        return JSON.parse(JSON.stringify(table));
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return {};
    }
    directory = parent;
  }
}

module.exports = { readAddonConfig };
