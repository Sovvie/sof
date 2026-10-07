"use strict";

// Which scripts you have said yes to, in ~/.sof/script-trust.json (only sof core writes it; a
// sandboxed add-on can't read ~/.sof, and the AI-tool deny rules cover it too).
//
// A yes is for one script of one project folder and for exactly what it would do: its commands and
// the version of every tool it runs. Change either (a `git pull` that edits the script, or a
// [tools] line that now points at another repository) and sof asks again.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { sofHome } = require("../addons/store");

function trustFile() {
  return path.join(sofHome(), "script-trust.json");
}

function projectKey(directory) {
  const resolved = path.resolve(directory);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function readTrust() {
  try {
    const parsed = JSON.parse(fs.readFileSync(trustFile(), "utf8"));
    return parsed && typeof parsed.projects === "object" && parsed.projects ? parsed.projects : {};
  } catch (_err) {
    return {};
  }
}

function writeTrust(projects) {
  fs.mkdirSync(sofHome(), { recursive: true });
  const temporary = `${trustFile()}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, trustFile());
}

// commands: [argv...]; tools: { alias: "owner/repo@version" } for every tool the commands run.
function definitionHash(commands, tools) {
  const sortedTools = Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b)));
  return crypto.createHash("sha256").update(JSON.stringify({ commands, tools: sortedTools })).digest("hex");
}

// "trusted", "changed" (trusted once, but the script or its tools differ now) or "untrusted".
const own = (object, key) => Boolean(object) && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, key);

function trustStatus(directory, scriptName, hash) {
  // Own properties only: a script called "constructor" must not find Object's.
  const scripts = readTrust()[projectKey(directory)];
  const recorded = own(scripts, scriptName) ? scripts[scriptName] : undefined;
  if (typeof recorded !== "string") {
    return "untrusted";
  }
  return recorded === hash ? "trusted" : "changed";
}

function trust(directory, scriptName, hash) {
  const projects = readTrust();
  const key = projectKey(directory);
  projects[key] = { ...(projects[key] || {}), [scriptName]: hash };
  writeTrust(projects);
}

// A script's name, or every script of the project when none is given. Returns how many were removed.
function untrust(directory, scriptName = null) {
  const projects = readTrust();
  const key = projectKey(directory);
  const scripts = own(projects, key) ? projects[key] : null;
  if (!scripts || typeof scripts !== "object") {
    return 0;
  }

  let removed = 0;
  for (const name of scriptName === null ? Object.keys(scripts) : [scriptName]) {
    if (own(scripts, name)) {
      delete scripts[name];
      removed += 1;
    }
  }

  if (Object.keys(scripts).length === 0) {
    delete projects[key];
  }
  if (removed > 0) {
    writeTrust(projects);
  }
  return removed;
}

module.exports = {
  definitionHash,
  trust,
  trustFile,
  trustStatus,
  untrust,
};
