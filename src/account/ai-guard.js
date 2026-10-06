"use strict";

// Keeps AI coding tools from reading or editing sof's own folder (~/.sof), which holds your sign-ins
// (account.json, auth.json) and the list of add-ons allowed to use them (account-grants.json).
//
// It adds deny rules to the user-level settings of the tools below, only where the tool is already
// installed, and only ever adds its own entries: everything else in those files is left as it was.
// Run by `sof run self update`, the install scripts and `sof run account login`, or by hand with
// `sof run account guard`. `guard --off` removes the rules and stops sof from adding them again.
//
// What this does and does not do: it makes the tool refuse its file-reading and file-editing tools
// for that folder. It is not a sandbox: a tool that is allowed to run arbitrary shell commands as
// you can still read the folder through the shell. Add-ons are isolated separately (src/addons).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { sofHome } = require("../addons/store");

function homeFolder() {
  return process.env.SOF_AI_HOME ? path.resolve(process.env.SOF_AI_HOME) : os.homedir();
}

function stateFile() {
  return path.join(sofHome(), "ai-guard.json");
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) || {};
  } catch (_err) {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(sofHome(), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
}

function forwardSlashes(target) {
  return target.split(path.sep).join("/");
}

// Each target: the tool's user-level settings file, where its deny list lives, and the rules to add.
// Claude Code reads "~/" in rules; Cursor's CLI gets an absolute path (forward slashes) to be safe.
const TARGETS = [
  {
    name: "Claude Code",
    folder: (home) => path.join(home, ".claude"),
    file: (home) => path.join(home, ".claude", "settings.json"),
    createIfMissing: true,
    rules: ({ home, folder }) => {
      const relative = path.relative(home, folder);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return null; // sof's folder is outside the home folder; a "~/" rule would not cover it
      }
      const glob = `~/${forwardSlashes(relative)}/**`;
      return [`Read(${glob})`, `Edit(${glob})`];
    },
  },
  {
    name: "Cursor CLI",
    folder: (home) => path.join(home, ".cursor"),
    file: (home) => path.join(home, ".cursor", "cli-config.json"),
    createIfMissing: false, // Cursor writes this file itself; never invent it
    rules: ({ folder }) => {
      const glob = `${forwardSlashes(folder)}/**`;
      return [`Read(${glob})`, `Write(${glob})`];
    },
  },
];

function detectIndent(text) {
  const match = text.match(/^([ \t]+)\S/m);
  return match ? match[1] : 2;
}

function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.sof-tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

// -> [{ tool, file, status, added|removed }], status is one of: added, already, removed, absent,
// skipped (with reason). Never throws for a tool's own file problems.
function applyTarget(target, ctx, { remove = false } = {}) {
  const home = ctx.home;
  const file = target.file(home);
  const result = { tool: target.name, file, status: "absent" };

  if (!fs.existsSync(target.folder(home))) {
    return result; // the tool is not installed
  }
  const rules = target.rules(ctx);
  if (!rules) {
    return { ...result, status: "skipped", reason: "sof's folder is outside your home folder" };
  }

  let text = "";
  let settings = {};
  if (fs.existsSync(file)) {
    text = fs.readFileSync(file, "utf8");
    try {
      settings = text.trim() === "" ? {} : JSON.parse(text);
    } catch (_err) {
      return { ...result, status: "skipped", reason: "the file is not plain JSON; left untouched" };
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return { ...result, status: "skipped", reason: "unexpected file contents; left untouched" };
    }
  } else if (remove || !target.createIfMissing) {
    return result;
  }

  const permissions = settings.permissions;
  if (permissions !== undefined && (permissions === null || typeof permissions !== "object" || Array.isArray(permissions))) {
    return { ...result, status: "skipped", reason: '"permissions" has an unexpected shape; left untouched' };
  }
  const deny = permissions && permissions.deny;
  if (deny !== undefined && !Array.isArray(deny)) {
    return { ...result, status: "skipped", reason: '"permissions.deny" is not a list; left untouched' };
  }

  const current = deny || [];
  if (remove) {
    const kept = current.filter((rule) => !rules.includes(rule));
    if (kept.length === current.length) {
      return { ...result, status: "absent" };
    }
    settings.permissions = { ...permissions, deny: kept };
    writeAtomic(file, `${JSON.stringify(settings, null, detectIndent(text))}\n`);
    return { ...result, status: "removed", rules: current.filter((rule) => rules.includes(rule)) };
  }

  const missing = rules.filter((rule) => !current.includes(rule));
  if (missing.length === 0) {
    return { ...result, status: "already" };
  }
  settings.permissions = { ...(permissions || {}), deny: [...current, ...missing] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(settings, null, detectIndent(text))}\n`);
  return { ...result, status: "added", rules: missing };
}

function context() {
  const home = homeFolder();
  return { home, folder: path.resolve(sofHome()) };
}

function enabled() {
  if ((process.env.SOF_AI_GUARD || "").trim().toLowerCase() === "off") {
    return false;
  }
  return readState().enabled !== false;
}

// Adds the rules (unless the user turned this off). Returns the per-tool results, or null when off.
function applyGuard() {
  if (!enabled()) {
    return null;
  }
  const ctx = context();
  return TARGETS.map((target) => applyTarget(target, ctx));
}

function removeGuard() {
  const ctx = context();
  return TARGETS.map((target) => applyTarget(target, ctx, { remove: true }));
}

function setEnabled(value) {
  writeState({ ...readState(), enabled: value });
}

function statusGuard() {
  const ctx = context();
  return TARGETS.map((target) => {
    const file = target.file(ctx.home);
    const rules = target.rules(ctx);
    if (!fs.existsSync(target.folder(ctx.home))) {
      return { tool: target.name, file, status: "absent" };
    }
    let deny = [];
    try {
      deny = JSON.parse(fs.readFileSync(file, "utf8")).permissions.deny || [];
    } catch (_err) {
      deny = [];
    }
    return { tool: target.name, file, status: rules && rules.every((rule) => deny.includes(rule)) ? "already" : "missing" };
  });
}

function describe(results) {
  const lines = [];
  for (const r of results) {
    if (r.status === "added") {
      lines.push(`  + ${r.tool}: blocked from reading or editing ${path.resolve(sofHome())} (${r.file})`);
    } else if (r.status === "already") {
      lines.push(`  = ${r.tool}: already blocked`);
    } else if (r.status === "removed") {
      lines.push(`  - ${r.tool}: rules removed (${r.file})`);
    } else if (r.status === "skipped") {
      lines.push(`  ! ${r.tool}: ${r.reason} (${r.file})`);
    } else if (r.status === "missing") {
      lines.push(`  ! ${r.tool}: not blocked yet; run: sof run account guard`);
    }
  }
  return lines;
}

module.exports = { TARGETS, applyGuard, applyTarget, context, describe, enabled, removeGuard, setEnabled, statusGuard };
