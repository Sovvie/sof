"use strict";

// What `sof run doctor` looks at. Each check is a function that adds findings:
//   { section, status: "ok" | "info" | "warn" | "problem", message, fix? }
// A fix is { label, command } to tell the user what to run, plus apply() when sof can do it by
// itself without downloading or changing anything of the user's (see --fix).

const fs = require("fs");
const path = require("path");
const semver = require("semver");

const { isOffline, cacheInfo, cacheRoot } = require("../cache");
const { inspectAddon } = require("../addons/descriptor");
const { checkRequires } = require("../addons/requires");
const { supportsPermissionFlag } = require("../addons/run-sandboxed");
const { readManifest, sofHome } = require("../addons/store");
const { bytes } = require("../addons/kit");

function version() {
  return require("../../package.json").version;
}

function writable(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    return true;
  } catch (_err) {
    return false;
  }
}

function nearestConfig(startDirectory, explicit) {
  if (explicit) {
    const file = path.resolve(explicit);
    return fs.existsSync(file) ? file : null;
  }
  let directory = path.resolve(startDirectory);
  for (;;) {
    const file = path.join(directory, "sof.toml");
    if (fs.existsSync(file)) {
      return file;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

function checkEnvironment(add) {
  const section = "sof";
  add({ section, status: "info", message: `sof ${version()} on ${process.platform}/${process.arch}, node ${process.versions.node}` });

  const engines = require("../../package.json").engines;
  if (engines && engines.node && !semver.satisfies(process.versions.node, engines.node)) {
    add({ section, status: "problem", message: `node ${process.versions.node} is older than sof needs (${engines.node})` });
  }

  if (!supportsPermissionFlag()) {
    add({ section, status: "warn", message: `node ${process.versions.node} can't sandbox add-ons (needs 22.13 or newer), so add-ons that ask for a sandbox won't run` });
  }

  if (writable(sofHome())) {
    add({ section, status: "ok", message: `${sofHome()} is writable` });
  } else {
    add({ section, status: "problem", message: `${sofHome()} isn't writable, so nothing can be installed (SOF_HOME changes where it lives)` });
  }

  if (isOffline()) {
    add({ section, status: "info", message: "offline mode is on (SOF_OFFLINE=1 or --offline): network checks are skipped" });
  }
  if (process.env.SOF_REQUIRE_SANDBOX === "1") {
    add({ section, status: "info", message: "SOF_REQUIRE_SANDBOX=1: add-ons that aren't sandboxed won't run" });
  }
}

function checkTools(add, configFile) {
  const section = "tools";
  const { readToolsFromConfig } = require("../tools/manifest");
  const { binDirectory, isToolInstalled } = require("../tools/store");
  const { findShadowedTools, setUpTools, shimExists } = require("../commands/tools");
  const { lockPathFor, readToolsLock } = require("../tools/lock");
  const { parseToolSpecifier } = require("../tools/spec");
  const { verifyTools } = require("../tools/verify");

  let config;
  try {
    config = readToolsFromConfig(configFile);
  } catch (err) {
    add({ section, status: "problem", message: err.message });
    return;
  }

  const aliases = Object.keys(config.tools);
  if (aliases.length === 0) {
    add({ section, status: "info", message: "no [tools] in this project" });
    return;
  }

  const { shadowed, binOnPath } = findShadowedTools(aliases);
  const shimsFix = {
    label: "set up the shims",
    command: "sof run tools setup",
    apply: () => setUpTools(aliases),
  };
  add(
    binOnPath
      ? { section, status: "ok", message: `${binDirectory()} is on PATH` }
      : { section, status: "warn", message: `${binDirectory()} isn't on PATH in this terminal (open a new terminal, or add it to PATH)` }
  );

  const entries = [];
  for (const alias of aliases) {
    let spec;
    try {
      spec = parseToolSpecifier(config.tools[alias], `${configFile}: [tools].${alias}`);
    } catch (err) {
      add({ section, status: "problem", message: err.message });
      continue;
    }
    entries.push({ alias, spec });

    const label = `${alias} ${spec.version}`;
    const shadow = shadowed.find((candidate) => candidate.alias === alias);
    if (!isToolInstalled(spec)) {
      continue; // verifyTools reports it
    }
    if (shadow) {
      add({ section, status: "warn", message: `${label} is installed, but "${alias}" runs ${shadow.path} first` });
    } else if (!shimExists(alias)) {
      add({ section, status: "problem", message: `${label} is installed but has no shim in ${binDirectory()}`, fix: shimsFix });
    }
  }

  let lock;
  try {
    lock = readToolsLock(lockPathFor(configFile));
  } catch (err) {
    add({ section, status: "problem", message: err.message });
    lock = { exists: false, entries: [] };
  }

  const verified = verifyTools(entries, lock);
  for (const message of verified.ok) add({ section, status: "ok", message });
  for (const message of verified.notes) add({ section, status: "info", message });
  for (const message of verified.problems) {
    add({ section, status: "problem", message, fix: { label: "install the tools", command: /isn't installed/.test(message) ? "sof run tools install" : "sof run tools install --force" } });
  }
  if (!lock.exists) {
    add({ section, status: "info", message: "no sof.tools.lock (sof run tools lock pins the downloads, and lets CI use install --frozen)" });
  }
}

function checkPackages(add, configFile) {
  const section = "packages";
  const configDirectory = path.dirname(configFile);

  let config;
  try {
    config = require("../packages/config").readPackageInstallConfig(configFile);
  } catch (err) {
    if (/must define at least one \[\[dependencies\]\] entry/.test(err.message)) {
      add({ section, status: "info", message: "no [[dependencies]] in this project" });
    } else {
      add({ section, status: "problem", message: err.message });
    }
    return;
  }

  const { readLockfile } = require("../packages/lockfile");
  const { hashConfigGroups, isInstallCurrent, readInstallState } = require("../packages/state");
  const lockfile = readLockfile(path.join(configDirectory, "sof.lock"));
  if (!lockfile.exists) {
    add({ section, status: "warn", message: "no sof.lock yet", fix: { label: "install the packages", command: "sof run install" } });
    return;
  }

  const state = readInstallState(configDirectory);
  if (isInstallCurrent(state, hashConfigGroups(config.groups), lockfile, configDirectory)) {
    add({ section, status: "ok", message: `${lockfile.entries.length} package(s) installed and unchanged since the last install` });
  } else {
    add({
      section,
      status: "warn",
      message: "packages aren't installed, were edited, or sof.toml/sof.lock changed since the last install",
      fix: { label: "install the packages", command: "sof run install" },
    });
  }
}

function checkScripts(add, configFile) {
  const section = "scripts";
  const { readScriptsFile } = require("../scripts/parse");

  let read;
  try {
    read = readScriptsFile(configFile);
  } catch (err) {
    add({ section, status: "problem", message: err.message });
    return;
  }
  if (!read.hasTable || read.names.length === 0) {
    return;
  }

  const { safeText } = require("../safe-text");
  for (const problem of read.problems) {
    add({ section, status: "problem", message: safeText(problem.message) });
  }

  // Doctor only reads: whether each script parses and its dependencies exist. Whether it can run
  // and is trusted is `sof run script list` (nothing here goes near the script runner).
  const { buildPlan } = require("../scripts/plan");
  let fine = 0;
  for (const name of Object.keys(read.scripts)) {
    try {
      buildPlan(read, name);
      fine += 1;
    } catch (err) {
      add({ section, status: "problem", message: safeText(err.message) });
    }
  }
  if (fine > 0 && read.problems.length === 0 && fine === read.names.length) {
    add({ section, status: "ok", message: `${fine} script(s) are well formed (sof run script list shows which you have trusted)` });
  }
}

function checkAddons(add) {
  const section = "add-ons";
  let manifest;
  try {
    manifest = readManifest();
  } catch (err) {
    add({ section, status: "problem", message: err.message });
    return;
  }

  const installed = Object.values(manifest.addons);
  if (installed.length === 0) {
    add({ section, status: "info", message: "no add-ons installed" });
    return;
  }

  const { findToolEntry } = require("../tools/resolve");
  const unsandboxed = [];
  for (const addon of installed.sort((a, b) => a.name.localeCompare(b.name))) {
    const label = `${addon.name}@${addon.version}`;
    if (!fs.existsSync(addon.directory)) {
      add({
        section,
        status: "problem",
        message: `${label}: its folder is gone (${addon.directory})`,
        fix: addon.source === "path" ? { label: "reinstall it from its folder", command: `sof run addon add --path <folder>` } : { label: "download it again", command: `sof run addon update ${addon.name}`, apply: async () => (await require("../commands/addon").addFromIndex(addon.name)) },
      });
      continue;
    }

    const inspected = inspectAddon(addon.directory);
    for (const problem of inspected.problems) {
      add({ section, status: "problem", message: `${label}: ${problem}` });
    }
    if (inspected.problems.length > 0) continue;

    if (inspected.descriptor.version !== addon.version) {
      add({ section, status: "warn", message: `${label}: the folder is version ${inspected.descriptor.version}`, fix: { label: "record the folder's version", command: `sof run addon add --path ${addon.directory}` } });
    }

    const dependencies = (() => {
      try {
        return Object.keys(JSON.parse(fs.readFileSync(path.join(addon.directory, "package.json"), "utf8")).dependencies || {});
      } catch (_err) {
        return [];
      }
    })();
    if (dependencies.length > 0 && !fs.existsSync(path.join(addon.directory, "node_modules"))) {
      add({
        section,
        status: "problem",
        message: `${label}: its dependencies (${dependencies.join(", ")}) aren't installed`,
        fix: { label: "install its dependencies (npm)", command: `npm install --omit=dev (in ${addon.directory})`, apply: () => require("../commands/addon").installNodeDependencies(addon.directory) },
      });
    }

    try {
      const problems = checkRequires(inspected.descriptor, {
        manifest,
        sofVersion: version(),
        findTool: (alias) => {
          try {
            return findToolEntry(alias, process.cwd());
          } catch (_err) {
            return null;
          }
        },
      });
      for (const problem of problems) {
        add({
          section,
          status: problem.kind === "tool" ? "warn" : "problem",
          message: `${label}: ${problem.message}`,
          fix: { label: problem.fix, command: problem.fix, ...(problem.kind === "addon" && !isOffline() ? { apply: () => require("../commands/addon").addFromIndex(`${problem.name}@${problem.range}`) } : {}) },
        });
      }
    } catch (err) {
      add({ section, status: "problem", message: `${label}: ${err.message}` });
    }

    if (inspected.descriptor.sandbox === true && !supportsPermissionFlag()) {
      add({ section, status: "problem", message: `${label}: needs a sandbox, which this Node (${process.versions.node}) doesn't have` });
    }
    if (inspected.descriptor.sandbox !== true) unsandboxed.push(addon.name);
  }

  if (unsandboxed.length > 0) {
    add({ section, status: "info", message: `run with all your permissions (not sandboxed): ${unsandboxed.join(", ")}` });
  }
  add({ section, status: "ok", message: `${installed.length} add-on(s) checked` });
}

async function checkRegistry(add) {
  const section = "registry";
  const { SOF_REGISTRY_URL } = require("../packages/constants");
  if (isOffline()) {
    add({ section, status: "info", message: "skipped (offline)" });
    return;
  }
  try {
    const response = await fetch(`${SOF_REGISTRY_URL}/v1/packages?limit=1`, { signal: AbortSignal.timeout(6000) });
    add(
      response.ok
        ? { section, status: "ok", message: `${SOF_REGISTRY_URL} answers` }
        : { section, status: "warn", message: `${SOF_REGISTRY_URL} answered ${response.status}` }
    );
  } catch (err) {
    const cause = err && err.cause && err.cause.message ? `: ${err.cause.message}` : "";
    add({ section, status: "warn", message: `couldn't reach ${SOF_REGISTRY_URL} (${err.message}${cause}); install --offline works from the cache` });
  }
}

function checkAccountAndCache(add) {
  const section = "account";
  const { readAccount } = require("../account/store");
  add({ section, status: "info", message: readAccount() ? "signed in to sov.gg" : "not signed in to sov.gg (only needed for private add-ons: sof run account login)" });

  try {
    const guard = require("../account/ai-guard").statusGuard();
    const missing = guard.filter((entry) => entry.status === "missing");
    if (missing.length > 0) {
      add({ section, status: "warn", message: `${missing.map((entry) => entry.tool).join(", ")} can still read ~/.sof (your sign-in is there): sof run account guard`, fix: { label: "block AI tools from ~/.sof", command: "sof run account guard" } });
    } else if (guard.some((entry) => entry.status === "already")) {
      add({ section, status: "ok", message: "AI tools are blocked from reading ~/.sof" });
    }
  } catch (_err) {
    // Not something doctor should fail on.
  }

  const info = cacheInfo();
  const total = Object.values(info).reduce((sum, entry) => sum + entry.bytes, 0);
  add({ section: "cache", status: "info", message: `${cacheRoot()} holds ${bytes(total)} (sof run cache info)` });
}

// options: { directory, config, network }. Resolves to the findings.
async function runChecks({ directory = process.cwd(), config = null, network = true } = {}) {
  const findings = [];
  const add = (finding) => findings.push(finding);
  const guarded = async (name, run) => {
    try {
      await run();
    } catch (err) {
      add({ section: name, status: "problem", message: `the check itself failed: ${err.message}` });
    }
  };

  await guarded("sof", () => checkEnvironment(add));
  const configFile = nearestConfig(directory, config);
  if (configFile) {
    add({ section: "project", status: "info", message: `using ${configFile}` });
    await guarded("tools", () => checkTools(add, configFile));
    await guarded("packages", () => checkPackages(add, configFile));
    await guarded("scripts", () => checkScripts(add, configFile));
  } else {
    add({ section: "project", status: "info", message: "no sof.toml here or above, so only the machine-wide setup was checked" });
  }
  await guarded("add-ons", () => checkAddons(add));
  if (network) {
    await guarded("registry", () => checkRegistry(add));
  }
  await guarded("account", () => checkAccountAndCache(add));
  return findings;
}

module.exports = { runChecks };
