"use strict";

// Starts an installed add-on: checks what it requires, decides whether it runs in a sandbox, and
// hands it the host (see kit.js and docs in the README). Also how add-ons call each other.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { readAddonConfig } = require("./config");
const { createKit } = require("./kit");
const { checkRequires, readRequires } = require("./requires");
const { readAddonDescriptor, readManifest } = require("./store");

const MAX_DEPTH = 4;

function sofVersion() {
  return require("../../package.json").version;
}

function findPinnedTool(alias, cwd) {
  try {
    const { findToolEntry } = require("../tools/resolve");
    const { parseToolSpecifier } = require("../tools/spec");
    const { isToolInstalled, toolExecutablePath } = require("../tools/store");
    const entry = findToolEntry(alias, cwd);
    if (!entry) {
      return null;
    }
    const spec = parseToolSpecifier(entry.specifier, `${entry.file}: [tools].${entry.alias}`);
    return isToolInstalled(spec) ? { alias: entry.alias, path: toolExecutablePath(spec) } : null;
  } catch (_err) {
    return null;
  }
}

function problemsOf(descriptor, cwd) {
  return checkRequires(descriptor, { manifest: readManifest(), sofVersion: sofVersion(), findTool: (alias) => findPinnedTool(alias, cwd) });
}

function findInstalled(commandOrName) {
  return Object.values(readManifest().addons).find((addon) => addon.command === commandOrName || addon.name === commandOrName) || null;
}

// What `host.addons.run(command, argv)` does for an add-on: only add-ons it lists under
// requires.addons can be called, and a sandboxed add-on can only call sandboxed ones (otherwise
// the sandbox would be a way to run unsandboxed code). Resolves to the exit code.
function nestedRunner(descriptor, { depth, cwd, sandboxedCaller, fetchImpl }) {
  return async (command, argv = []) => {
    if (depth >= MAX_DEPTH) {
      throw new Error(`Add-ons are calling each other too deeply (more than ${MAX_DEPTH} levels).`);
    }
    if (typeof command !== "string" || !Array.isArray(argv) || argv.some((entry) => typeof entry !== "string")) {
      throw new Error("addons.run needs a command and a list of string arguments.");
    }

    const target = findInstalled(command);
    if (!target) {
      throw new Error(`Add-on "${command}" isn't installed.`);
    }
    if (!Object.prototype.hasOwnProperty.call(readRequires(descriptor).addons, target.name)) {
      throw new Error(`"${descriptor.name}" can only call add-ons it lists under "requires.addons" in sof-addon.json (not "${target.name}").`);
    }
    if (sandboxedCaller && readAddonDescriptor(target.directory).sandbox !== true) {
      throw new Error(`"${descriptor.name}" runs in a sandbox, so it can only call sandboxed add-ons ("${target.name}" is not one).`);
    }

    return runInstalledAddon(target, argv, { depth: depth + 1, nested: true, cwd, fetchImpl });
  };
}

function createHost(descriptor, { cwd, depth, fetchImpl }) {
  return {
    ...createKit(),
    name: descriptor.name,
    version: descriptor.version,
    sandboxed: false,
    config: async () => readAddonConfig(descriptor.name, cwd),
    tempDir: (prefix = descriptor.name) => fs.mkdtempSync(path.join(os.tmpdir(), `sof-${prefix}-`)),
    tools: { path: (alias) => (readRequires(descriptor).tools.includes(alias) ? (findPinnedTool(alias, cwd) || {}).path || null : null) },
    addons: { run: nestedRunner(descriptor, { depth, cwd, sandboxedCaller: false, fetchImpl }) },
  };
}

// Resolves to the add-on's exit code (0 unless it is a sandboxed add-on that failed). A top-level
// run sets process.exitCode; a nested one leaves that to its caller.
async function runInstalledAddon(addon, argv, { depth = 0, nested = false, cwd = process.cwd(), fetchImpl } = {}) {
  const descriptor = readAddonDescriptor(addon.directory);

  const problems = problemsOf(descriptor, cwd);
  if (problems.length > 0) {
    throw new Error(
      `Add-on "${addon.name}" can't run yet:\n${problems.map((problem) => `  - ${problem.message}  (${problem.fix})`).join("\n")}`
    );
  }

  if (process.env.SOF_REQUIRE_SANDBOX === "1" && descriptor.sandbox !== true) {
    throw new Error(`Add-on "${addon.name}" isn't sandboxed, and SOF_REQUIRE_SANDBOX=1 only lets sandboxed add-ons run.`);
  }

  if (descriptor.sandbox === true) {
    const { runSandboxed } = require("./run-sandboxed");
    const callAddon = nestedRunner(descriptor, { depth, cwd, sandboxedCaller: true, fetchImpl });
    const code = await runSandboxed(addon, argv, { cwd, fetchImpl, nested, callAddon, config: () => readAddonConfig(descriptor.name, cwd) });
    return code || 0;
  }

  const module = require(path.join(addon.directory, addon.entry));
  const run = module[addon.export || "run"];
  if (typeof run !== "function") {
    throw new Error(`Add-on "${addon.name}" doesn't export a "${addon.export || "run"}" function.`);
  }
  await run(argv, createHost(descriptor, { cwd, depth, fetchImpl }));
  return Number(process.exitCode) || 0;
}

module.exports = { MAX_DEPTH, createHost, findInstalled, problemsOf, runInstalledAddon };
