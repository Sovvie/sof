"use strict";

// What an add-on says it needs, in sof-addon.json:
//
//   "requires": {
//     "sof": ">=2.8.0",                  the sof version
//     "addons": { "docs": "^1.0.0" },    other add-ons: installed with it, and the only ones it may call
//     "tools": ["ffmpeg"]                aliases that must be pinned in [tools] of the project it runs in
//   }

const semver = require("semver");

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function readRequires(descriptor) {
  const raw = descriptor.requires;
  if (raw === undefined) {
    return { sof: null, addons: {}, tools: [] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('"requires" must be an object.');
  }

  for (const key of Object.keys(raw)) {
    if (!["sof", "addons", "tools"].includes(key)) {
      throw new Error(`"requires" has an unknown key "${key}" (allowed: sof, addons, tools).`);
    }
  }

  if (raw.sof !== undefined && (typeof raw.sof !== "string" || !semver.validRange(raw.sof))) {
    throw new Error('"requires.sof" must be a semver range such as ">=2.8.0".');
  }

  const addons = raw.addons === undefined ? {} : raw.addons;
  if (!addons || typeof addons !== "object" || Array.isArray(addons)) {
    throw new Error('"requires.addons" must be an object of add-on name to version range.');
  }
  for (const [name, range] of Object.entries(addons)) {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`"requires.addons" has an invalid add-on name: ${JSON.stringify(name)}.`);
    }
    if (typeof range !== "string" || !semver.validRange(range)) {
      throw new Error(`"requires.addons.${name}" must be a semver range such as "^1.0.0".`);
    }
  }

  const tools = raw.tools === undefined ? [] : raw.tools;
  if (!Array.isArray(tools) || tools.some((alias) => typeof alias !== "string" || !ALIAS_PATTERN.test(alias))) {
    throw new Error('"requires.tools" must be a list of tool aliases.');
  }

  return { sof: raw.sof || null, addons: { ...addons }, tools: [...tools] };
}

// Problems with what an add-on needs, as { kind, message, fix } entries; empty when all is well.
// manifest: the installed add-ons ({ addons: { name: { version } } }). findTool(alias) returns the
// pinned tool or null (injected, so this file stays free of the tools code).
function checkRequires(descriptor, { manifest, sofVersion, findTool = () => null, checkTools = true }) {
  const needs = readRequires(descriptor);
  const problems = [];

  if (needs.sof && !semver.satisfies(sofVersion, needs.sof, { includePrerelease: true })) {
    problems.push({
      kind: "sof",
      message: `needs sof ${needs.sof} (this is ${sofVersion})`,
      fix: "sof run self update",
    });
  }

  for (const [name, range] of Object.entries(needs.addons)) {
    const installed = manifest.addons[name];
    if (!installed) {
      problems.push({ kind: "addon", name, range, message: `needs the add-on ${name} ${range}, which isn't installed`, fix: `sof run addon add ${name}@${range}` });
    } else if (!semver.satisfies(installed.version, range, { includePrerelease: true })) {
      problems.push({
        kind: "addon",
        name,
        range,
        message: `needs the add-on ${name} ${range} (installed: ${installed.version})`,
        fix: `sof run addon update ${name}`,
      });
    }
  }

  if (checkTools) {
    for (const alias of needs.tools) {
      if (!findTool(alias)) {
        problems.push({ kind: "tool", name: alias, message: `needs the tool "${alias}" in [tools]`, fix: "sof run tools add owner/repo" });
      }
    }
  }

  return problems;
}

module.exports = { checkRequires, readRequires };
