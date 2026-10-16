"use strict";

// Checks an add-on folder the way `sof run addon test` and `publish` want it: problems stop a
// release, warnings are things worth fixing.

const fs = require("fs");
const path = require("path");
const semver = require("semver");

const { readRequires } = require("./requires");

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const KNOWN_FIELDS = new Set(["name", "version", "command", "entry", "export", "usage", "description", "sandbox", "env", "account", "requires"]);

// Built-in commands an add-on can't take over.
const RESERVED_COMMANDS = new Set(["install", "package", "account", "tools", "script", "copy", "addon", "self", "doctor", "cache", "help"]);

function inspectAddon(directory) {
  const problems = [];
  const warnings = [];
  const descriptorPath = path.join(directory, "sof-addon.json");

  if (!fs.existsSync(descriptorPath)) {
    return { descriptor: null, problems: [`${directory} has no sof-addon.json.`], warnings };
  }

  let descriptor;
  try {
    descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  } catch (err) {
    return { descriptor: null, problems: [`sof-addon.json is not valid JSON: ${err.message}`], warnings };
  }

  for (const field of ["name", "version", "command", "entry"]) {
    if (typeof descriptor[field] !== "string" || descriptor[field].trim() === "") {
      problems.push(`"${field}" is required.`);
    }
  }
  if (typeof descriptor.name === "string" && !NAME_PATTERN.test(descriptor.name)) {
    problems.push(`"name" must be lowercase letters, numbers and "-", starting with a letter (got ${JSON.stringify(descriptor.name)}).`);
  }
  if (typeof descriptor.command === "string") {
    if (!COMMAND_PATTERN.test(descriptor.command)) {
      problems.push(`"command" must be lowercase letters, numbers and "-", starting with a letter.`);
    } else if (RESERVED_COMMANDS.has(descriptor.command)) {
      problems.push(`"command" ${descriptor.command} is a built-in sof command.`);
    }
  }
  if (typeof descriptor.version === "string" && !semver.valid(descriptor.version)) {
    problems.push(`"version" must be a semantic version such as 1.0.0 (got ${JSON.stringify(descriptor.version)}).`);
  }

  if (typeof descriptor.entry === "string") {
    const entry = path.resolve(directory, descriptor.entry);
    const relative = path.relative(directory, entry);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      problems.push('"entry" must be a file inside the add-on folder.');
    } else if (!fs.existsSync(entry)) {
      problems.push(`"entry" ${descriptor.entry} doesn't exist.`);
    }
  }

  if (descriptor.sandbox !== undefined && typeof descriptor.sandbox !== "boolean") {
    problems.push('"sandbox" must be true or false.');
  } else if (descriptor.sandbox === undefined) {
    warnings.push('"sandbox" is not declared. Say "sandbox": true to run without access to the sign-in or anything outside the project, or "sandbox": false if the add-on needs to start programs or load native modules.');
  }

  try {
    readRequires(descriptor);
  } catch (err) {
    problems.push(err.message);
  }

  if (typeof descriptor.description !== "string" || descriptor.description.trim() === "") {
    warnings.push('"description" is empty: it is what "sof run addon search" and "sof run --help" show.');
  }
  if (typeof descriptor.usage !== "string" || descriptor.usage.trim() === "") {
    warnings.push('"usage" is empty.');
  }
  for (const key of Object.keys(descriptor)) {
    if (!KNOWN_FIELDS.has(key)) {
      warnings.push(`unknown field "${key}" in sof-addon.json.`);
    }
  }

  const packageJson = path.join(directory, "package.json");
  if (!fs.existsSync(packageJson)) {
    warnings.push("no package.json (add one if the add-on has dependencies).");
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8"));
      if (parsed.dependencies && Object.keys(parsed.dependencies).length > 0 && !fs.existsSync(path.join(directory, "node_modules"))) {
        warnings.push("dependencies are not installed (run npm install here) so the add-on can't be loaded.");
      }
    } catch (err) {
      problems.push(`package.json is not valid JSON: ${err.message}`);
    }
  }

  return { descriptor, problems, warnings };
}

// Loads the entry and checks that it exports the function sof will call. Runs the add-on's own
// module code (its top level), so it is only for folders the developer owns.
function checkEntryLoads(directory, descriptor) {
  try {
    const mod = require(path.resolve(directory, descriptor.entry));
    const name = descriptor.export || "run";
    if (typeof mod[name] !== "function") {
      return `the entry doesn't export a "${name}" function.`;
    }
    return null;
  } catch (err) {
    return `the entry can't be loaded: ${err.message}`;
  }
}

module.exports = { RESERVED_COMMANDS, checkEntryLoads, inspectAddon };
