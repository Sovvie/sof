"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { sofHome } = require("../addons/store");
const { latestVersion } = require("../tools/github");
const {
  LOCK_FILE_NAME,
  currentPlatform,
  findLockEntry,
  lockPathFor,
  mergeLockEntries,
  readToolsLock,
  writeToolsLock,
} = require("../tools/lock");
const {
  addToolToConfig,
  readToolsFromConfig,
  removeToolFromConfig,
  updateToolsInConfig,
} = require("../tools/manifest");
const { findImportSource, readForeignTools } = require("../tools/import");
const { findToolEntry } = require("../tools/resolve");
const { ensureShims, findCsc } = require("../tools/shims");
const { formatSpecifier, normalizeAlias, parseToolId, parseToolSpecifier } = require("../tools/spec");
const {
  binDirectory,
  globalManifestPath,
  installTool,
  isToolInstalled,
  readInstallRecord,
  toolExecutablePath,
  toolsRoot,
} = require("../tools/store");
const { scaffoldToolConfigs } = require("../tools/tool-configs");

const HELP_TEXT = `
sof run tools - Install and run the tools a project uses (rojo, selene, stylua, ...)

USAGE:
  sof run tools <command> [arguments] [options]

Tools are listed under [tools] in sof.toml as "owner/repo@version" (GitHub releases). sof
downloads each version once into ~/.sof/tools, and a shim in ~/.sof/bin runs the version the
nearest sof.toml pins, so every project gets its own versions with nothing else to install.

COMMANDS:
  install [path/to/sof.toml]      Install every tool in [tools] that isn't installed yet
  add <owner/repo[@version]>      Add a tool to [tools] (the latest release unless a version is given) and install it
  remove <alias>                  Remove a tool from [tools]
  update [alias...]               Move tools to their latest release (--check only shows what would change)
  outdated                        Show tools that have a newer release
  list                            Show the tools in [tools] and whether they are installed
  import [file]                   Move the tools of a rokit.toml, aftman.toml or foreman.toml into sof.toml
  lock                            Record the checksum of each tool's release in sof.tools.lock
  x <owner/repo[@version]> [args] Run a tool once without adding it to a project
  which <alias>                   Show the program an alias runs from here
  doctor                          Check that tools are set up correctly
  setup                           Prepare ~/.sof/bin (runs automatically; the sof installer runs it too)

OPTIONS (install, add, remove, update, outdated, list, import):
  --global                        Use your global tools (~/.sof/tools.toml) instead of sof.toml
  -h, --help                      Show help for a command
`;

const INSTALL_HELP_TEXT = `
sof run tools install - Install the tools in [tools]

USAGE:
  sof run tools install [path/to/sof.toml] [--force] [--locked] [--global]

DESCRIPTION:
  Only tools that aren't installed yet (new entries or changed versions) are downloaded. If
  sof.tools.lock exists, each download must match the checksum recorded in it.

OPTIONS:
  --force                         Download every tool again
  --locked                        Fail unless sof.tools.lock has a checksum for every tool on this platform (CI)
  --global                        Install the global tools (~/.sof/tools.toml)
  -h, --help                      Show this help message
`;

const LIST_HELP_TEXT = `
sof run tools list - Show the tools in [tools]

USAGE:
  sof run tools list [path/to/sof.toml] [--global]
`;

const ADD_HELP_TEXT = `
sof run tools add - Add a tool to [tools] in sof.toml and install it

USAGE:
  sof run tools add <owner/repo[@version]> [path/to/sof.toml] [--alias <name>] [--global]

EXAMPLES:
  sof run tools add rojo-rbx/rojo
  sof run tools add Kampfkarren/selene@0.28.0 --alias selene28

OPTIONS:
  --alias <name>                  The command name (default: the repository name)
  --global                        Add it to your global tools (~/.sof/tools.toml)
  -h, --help                      Show this help message
`;

const REMOVE_HELP_TEXT = `
sof run tools remove - Remove a tool from [tools]

USAGE:
  sof run tools remove <alias> [path/to/sof.toml] [--global]

DESCRIPTION:
  Downloaded copies stay in ~/.sof/tools, so going back to that version is instant.
`;

const UPDATE_HELP_TEXT = `
sof run tools update - Move tools to their latest release

USAGE:
  sof run tools update [alias...] [path/to/sof.toml] [--check] [--global]

OPTIONS:
  --check                         Show what would change; change nothing (same as: sof run tools outdated)
  --global                        Update your global tools
  -h, --help                      Show this help message
`;

const OUTDATED_HELP_TEXT = `
sof run tools outdated - Show tools that have a newer release

USAGE:
  sof run tools outdated [alias...] [path/to/sof.toml] [--global]
`;

const IMPORT_HELP_TEXT = `
sof run tools import - Move another toolchain manager's tools into sof.toml

USAGE:
  sof run tools import [path/to/rokit.toml|aftman.toml|foreman.toml] [--global]

DESCRIPTION:
  Reads the tool list of a Rokit, Aftman or Foreman project (the file in this folder when no path
  is given), adds the tools sof.toml doesn't have yet (creating sof.toml if needed) and installs
  them. The original file is left alone. Tools from GitLab and Foreman version ranges can't be
  imported (sof pins one exact version); they are listed so you can add them by hand.

OPTIONS:
  --global                        Add to your global tools (~/.sof/tools.toml), e.g. from ~/.rokit/rokit.toml
  -h, --help                      Show this help message
`;

const LOCK_HELP_TEXT = `
sof run tools lock - Record the checksum of each tool's release

USAGE:
  sof run tools lock [path/to/sof.toml] [--refresh]

DESCRIPTION:
  Writes sof.tools.lock next to sof.toml: the sha256 of the release file each tool was
  installed from, for this platform. Commit it. From then on every install is checked against
  it, so a release that was swapped after you locked it is refused instead of run. Other
  platforms add their own lines the first time they install.

OPTIONS:
  --refresh                       Record this platform's checksums again, replacing the ones in the file
  -h, --help                      Show this help message
`;

const X_HELP_TEXT = `
sof run tools x - Run a tool once without adding it to a project

USAGE:
  sof run tools x <owner/repo[@version]> [arguments...]

EXAMPLES:
  sof run tools x JohnnyMorganz/StyLua --check src
  sof run tools x rojo-rbx/rojo@7.6.1 --version

DESCRIPTION:
  Downloads the release if needed (the latest when no version is given) and runs it with the
  arguments that follow.
`;

const WHICH_HELP_TEXT = `
sof run tools which - Show the program an alias runs from the current folder

USAGE:
  sof run tools which <alias>
`;

const DOCTOR_HELP_TEXT = `
sof run tools doctor - Check that tools are set up correctly

USAGE:
  sof run tools doctor [path/to/sof.toml]
`;

const SETUP_HELP_TEXT = `
sof run tools setup - Prepare ~/.sof/bin for tool shims

USAGE:
  sof run tools setup [--quiet]

DESCRIPTION:
  Builds the shim program (on Windows) and points every existing shim at this sof. It also
  removes the copy of Rokit that earlier versions of sof downloaded. Runs automatically during
  install; the sof installer and "sof run self update" run it too.
`;

function displayPath(targetPath) {
  const relativePath = path.relative(process.cwd(), targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    const fromHome = path.relative(os.homedir(), targetPath);
    return fromHome.startsWith("..") || path.isAbsolute(fromHome) ? targetPath : path.join("~", fromHome);
  }
  return relativePath || ".";
}

// flags: { "--name": "key" } booleans, values: { "--name": "key" } take the next argument.
function parseOptions(argv, commandName, { flags = {}, values = {} } = {}) {
  const options = { help: false };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (Object.prototype.hasOwnProperty.call(flags, arg)) {
      options[flags[arg]] = true;
    } else if (Object.prototype.hasOwnProperty.call(values, arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a value.`);
      }
      options[values[arg]] = value.trim();
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option for tools ${commandName}: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { options, positional };
}

function resolveTarget(configPathArg, options) {
  if (options.global) {
    if (configPathArg && path.resolve(configPathArg) !== path.resolve(globalManifestPath())) {
      throw new Error("--global and a config path can't be used together.");
    }
    return { configPath: globalManifestPath(), allowMissing: true };
  }
  return { configPath: configPathArg || null, allowMissing: false };
}

function readTarget(configPathArg, options) {
  const target = resolveTarget(configPathArg, options);
  return readToolsFromConfig(target.configPath, { allowMissing: target.allowMissing });
}

function describeConfig(config, options) {
  return options.global ? `${displayPath(config.configPath)} (global tools)` : displayPath(config.configPath);
}

// Earlier versions of sof wrote rokit.toml into the project so a bundled Rokit could read it.
const GENERATED_ROKIT_MARKER = "auto-generated by Sof from [tools] in sof.toml";

function removeGeneratedRokitManifest(directory) {
  const file = path.join(directory, "rokit.toml");
  try {
    if (fs.readFileSync(file, "utf8").includes(GENERATED_ROKIT_MARKER)) {
      fs.rmSync(file, { force: true });
      console.log("Removed rokit.toml: sof doesn't need it any more (sof.toml is the only tools file).");
    }
  } catch (_err) {
    // No rokit.toml, or one somebody wrote themselves.
  }
}

// The Rokit binary that earlier versions downloaded into ~/.sof/rokit.
function removeBundledRokit() {
  try {
    fs.rmSync(path.join(sofHome(), "rokit"), { recursive: true, force: true });
  } catch (_err) {
    // In use or read-only: harmless, it's just unused.
  }
}

function normalizeDir(directory) {
  const resolved = path.resolve(directory);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function rokitBinDirectory() {
  return path.join(process.env.ROKIT_ROOT ? path.resolve(process.env.ROKIT_ROOT) : path.join(os.homedir(), ".rokit"), "bin");
}

// Another copy of a tool earlier on PATH than sof's shim (a Rokit/Aftman/Foreman link, a cargo
// install) wins, and runs a version that has nothing to do with sof.toml.
function findShadowedTools(toolAliases) {
  const directories = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const binIndex = directories.findIndex((directory) => normalizeDir(directory) === normalizeDir(binDirectory()));
  const searchUntil = binIndex === -1 ? directories.length : binIndex;
  const shadowed = [];

  for (const alias of toolAliases) {
    for (const directory of directories.slice(0, searchUntil)) {
      const candidates = process.platform === "win32" ? [`${alias}.exe`, `${alias}.cmd`, `${alias}.bat`] : [alias];
      const found = candidates.map((name) => path.join(directory, name)).find((file) => fs.existsSync(file));
      if (found) {
        shadowed.push({ alias, path: found, rokit: normalizeDir(directory) === normalizeDir(rokitBinDirectory()) });
        break;
      }
    }
  }

  return { shadowed, binOnPath: binIndex !== -1 };
}

function printPathWarnings(toolAliases) {
  const { shadowed, binOnPath } = findShadowedTools(toolAliases);

  if (!binOnPath) {
    console.warn(`  ! ${displayPath(binDirectory())} isn't on PATH in this terminal, so the tools can't be found. Open a new terminal, or add it to PATH.`);
  }

  for (const entry of shadowed) {
    console.warn(
      entry.rokit
        ? `  ! "${entry.alias}" runs Rokit's link (${entry.path}) before sof's, and Rokit no longer finds the versions in sof.toml. sof doesn't use Rokit any more: take ${displayPath(rokitBinDirectory())} off your PATH, or put ${displayPath(binDirectory())} ahead of it.`
        : `  ! "${entry.alias}" resolves to ${entry.path} before sof's. Remove that copy or move ${displayPath(binDirectory())} earlier on PATH.`
    );
  }
}

// Prepares ~/.sof/bin and gives every alias a shim.
function setUpTools(aliases) {
  removeBundledRokit();
  const result = ensureShims(aliases);
  if (result.warning) {
    console.warn(`  ! ${result.warning}`);
  }
  return result;
}

function printScaffoldSummary(scaffoldResult) {
  if (scaffoldResult.created.length > 0) {
    console.log("Created tool config file(s):");
    for (const fileName of scaffoldResult.created) {
      console.log(`  ✓ ${fileName}`);
    }
  }
}

// The line sof.tools.lock (next to the config) holds for this tool, so a version that is already
// locked is checked when it is added or updated too, not only when it is installed from sof.toml.
function lockedEntryFor(configPath, spec, options) {
  if (options.global) {
    return null;
  }

  const lock = readToolsLock(lockPathFor(path.resolve(configPath)));
  return lock.exists ? findLockEntry(lock, spec) : null;
}

function entriesOf(config) {
  return Object.entries(config.tools).map(([alias, specifier]) => ({ alias, specifier, spec: parseToolSpecifier(specifier) }));
}

// Installs everything in the config. A tool that fails doesn't stop the others; the failures are
// reported together at the end. Returns the per-tool results.
async function installConfiguredTools(config, { force = false, locked = false, global = false } = {}) {
  const entries = entriesOf(config);
  const lockPath = global ? null : lockPathFor(config.configPath);
  const lock = lockPath ? readToolsLock(lockPath) : { exists: false, entries: [] };

  if (locked) {
    const platform = currentPlatform();
    const missing = entries.filter((entry) => !findLockEntry(lock, entry.spec));
    if (!lock.exists || missing.length > 0) {
      throw new Error(
        lock.exists
          ? `${LOCK_FILE_NAME} has no ${platform} checksum for: ${missing.map((entry) => entry.alias).join(", ")}. Run: sof run tools lock`
          : `--locked needs ${LOCK_FILE_NAME}. Create it with: sof run tools lock`
      );
    }
  }

  const results = [];
  const failures = [];
  for (const entry of entries) {
    try {
      const result = await installTool(entry.spec, {
        alias: entry.alias,
        force,
        expected: findLockEntry(lock, entry.spec),
        log: (line) => console.log(line),
      });
      results.push({ ...result, alias: entry.alias });
    } catch (err) {
      failures.push(`${entry.alias}: ${err.message}`);
    }
  }

  if (lockPath && lock.exists) {
    writeToolsLock(lockPath, mergeLockEntries(lock.entries, results, entries.map((entry) => entry.spec)));
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} tool(s) couldn't be installed:\n  ${failures.join("\n  ")}`);
  }
  return results;
}

async function runToolsInstall(configPathArg, options = {}) {
  const config = readTarget(configPathArg, options);
  const toolAliases = Object.keys(config.tools);

  if (options.announce !== false) {
    console.log(`Using config: ${describeConfig(config, options)}`);
  }
  if (!options.global) {
    removeGeneratedRokitManifest(config.configDirectory);
  }

  if (toolAliases.length === 0) {
    console.log("No [tools] entries were found. Skipping tool installation.");
    return { skipped: true, configPath: config.configPath, toolAliases: [], scaffoldResult: { created: [], skippedExisting: [] } };
  }

  setUpTools(toolAliases);
  const results = await installConfiguredTools(config, options);

  const installed = results.filter((result) => !result.skipped).length;
  if (installed === 0) {
    console.log(`Tools are up to date (${toolAliases.length} installed).`);
  }

  const scaffoldResult = options.global ? { created: [], skippedExisting: [] } : scaffoldToolConfigs(config.configDirectory, toolAliases);
  printScaffoldSummary(scaffoldResult);
  printPathWarnings(toolAliases);

  return { skipped: false, configPath: config.configPath, toolAliases, scaffoldResult };
}

async function runInstall(argv) {
  const { options, positional } = parseOptions(argv, "install", {
    flags: { "--force": "force", "--locked": "locked", "--global": "global" },
  });
  if (options.help) {
    console.log(INSTALL_HELP_TEXT);
    process.exit(0);
  }
  if (positional.length > 1) {
    throw new Error("tools install accepts at most one positional argument (the config path).");
  }

  await runToolsInstall(positional[0] || null, options);
}

async function runList(argv) {
  const { options, positional } = parseOptions(argv, "list", { flags: { "--global": "global" } });
  if (options.help) {
    console.log(LIST_HELP_TEXT);
    process.exit(0);
  }
  if (positional.length > 1) {
    throw new Error("tools list accepts at most one positional argument (the config path).");
  }

  const config = readTarget(positional[0] || null, options);
  console.log(`Using config: ${describeConfig(config, options)}`);

  const entries = entriesOf(config);
  if (entries.length === 0) {
    console.log("No [tools] entries were found.");
    return;
  }

  const width = Math.max(...entries.map((entry) => entry.alias.length));
  let missing = 0;
  for (const entry of entries) {
    const installed = isToolInstalled(entry.spec);
    missing += installed ? 0 : 1;
    console.log(`  ${entry.alias.padEnd(width)}  ${formatSpecifier(entry.spec)}  ${installed ? "installed" : "not installed"}`);
  }
  if (missing > 0) {
    console.log(`Install the missing ones with: sof run tools install${options.global ? " --global" : ""}`);
  }
}

async function runAdd(argv) {
  const { options, positional } = parseOptions(argv, "add", {
    flags: { "--global": "global" },
    values: { "--alias": "alias" },
  });
  if (options.help) {
    console.log(ADD_HELP_TEXT);
    process.exit(0);
  }
  if (positional.length === 0) {
    throw new Error("tools add requires a tool identifier in the form owner/repo.");
  }
  if (positional.length > 2) {
    throw new Error("tools add accepts one required positional argument (<owner/repo>) and one optional config path.");
  }

  const tool = parseToolId(positional[0]);
  const target = resolveTarget(positional[1] || null, options);
  const version = !tool.version || tool.version.toLowerCase() === "latest" ? await latestVersion(tool.owner, tool.repo) : tool.version;
  const alias = normalizeAlias(options.alias || tool.repo.toLowerCase(), "tools add");
  const specifier = formatSpecifier({ owner: tool.owner, repo: tool.repo, version });

  // Installed before sof.toml is touched: a release with nothing for this platform (or a typo in
  // the name) leaves the file exactly as it was.
  await installTool(specifier, {
    alias,
    expected: lockedEntryFor(target.configPath || "sof.toml", parseToolSpecifier(specifier), options),
    log: (line) => console.log(line),
  });
  const addResult = addToolToConfig(target.configPath, alias, specifier, { allowMissing: target.allowMissing });

  console.log(`${addResult.replaced ? "Updated" : "Added"} [tools].${addResult.alias} = "${addResult.specifier}"`);

  await runToolsInstall(addResult.configPath, { global: options.global });
}

async function runRemove(argv) {
  const { options, positional } = parseOptions(argv, "remove", { flags: { "--global": "global" } });
  if (options.help) {
    console.log(REMOVE_HELP_TEXT);
    process.exit(0);
  }
  if (positional.length === 0 || positional.length > 2) {
    throw new Error("tools remove takes a tool alias and an optional config path.");
  }

  const target = resolveTarget(positional[1] || null, options);
  const result = removeToolFromConfig(target.configPath, positional[0], { allowMissing: target.allowMissing });
  console.log(`Removed [tools].${result.alias} ("${result.specifier}") from ${displayPath(result.configPath)}`);

  const lockPath = lockPathFor(result.configPath);
  const lock = options.global ? { exists: false, entries: [] } : readToolsLock(lockPath);
  if (lock.exists) {
    const specs = Object.values(result.tools).map((specifier) => parseToolSpecifier(specifier));
    writeToolsLock(lockPath, mergeLockEntries(lock.entries, [], specs));
  }
}

function isNewer(latest, current) {
  if (latest === current) {
    return false;
  }

  // Loaded here, not at the top: shims run `tools exec` for every tool start, and semver is slow to load.
  const semver = require("semver");
  const latestSemver = semver.valid(latest) ? latest : semver.coerce(latest);
  const currentSemver = semver.valid(current) ? current : semver.coerce(current);
  return latestSemver && currentSemver ? semver.gt(latestSemver, currentSemver) : true;
}

async function runUpdate(argv, { check = false } = {}) {
  const commandName = check ? "outdated" : "update";
  const { options, positional } = parseOptions(argv, commandName, {
    flags: { "--global": "global", ...(check ? {} : { "--check": "check" }) },
  });
  if (options.help) {
    console.log(check ? OUTDATED_HELP_TEXT : UPDATE_HELP_TEXT);
    process.exit(0);
  }

  const configArgs = positional.filter((arg) => /\.toml$/i.test(arg));
  const aliases = positional.filter((arg) => !/\.toml$/i.test(arg));
  if (configArgs.length > 1) {
    throw new Error(`tools ${commandName} accepts at most one config path.`);
  }

  const config = readTarget(configArgs[0] || null, options);
  const selected = aliases.map((name) => {
    const alias = Object.keys(config.tools).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (!alias) {
      throw new Error(`[tools] in ${config.configPath} has no tool "${name}".`);
    }
    return alias;
  });

  const entries = entriesOf(config).filter((entry) => selected.length === 0 || selected.includes(entry.alias));
  if (entries.length === 0) {
    console.log("No [tools] entries were found.");
    return;
  }

  console.log(`Using config: ${describeConfig(config, options)}`);
  const width = Math.max(...entries.map((entry) => entry.alias.length));
  const updates = {};
  for (const entry of entries) {
    const latest = await latestVersion(entry.spec.owner, entry.spec.repo);
    if (isNewer(latest, entry.spec.version)) {
      updates[entry.alias] = formatSpecifier({ ...entry.spec, version: latest });
      console.log(`  ${entry.alias.padEnd(width)}  ${entry.spec.version} -> ${latest}`);
    } else {
      console.log(`  ${entry.alias.padEnd(width)}  ${entry.spec.version} (latest)`);
    }
  }

  const count = Object.keys(updates).length;
  if (count === 0) {
    console.log("Everything is up to date.");
    return;
  }

  if (check || options.check) {
    console.log(`${count} tool(s) can be updated: sof run tools update${options.global ? " --global" : ""}`);
    return;
  }

  // Each new version is installed before sof.toml changes: one that can't be (nothing for this
  // platform, say) keeps its old pin and the others still move.
  const failures = [];
  for (const alias of Object.keys(updates)) {
    try {
      await installTool(updates[alias], {
        alias,
        expected: lockedEntryFor(config.configPath, parseToolSpecifier(updates[alias]), options),
        log: (line) => console.log(line),
      });
    } catch (err) {
      failures.push(`${alias}: ${err.message}`);
      delete updates[alias];
    }
  }

  if (Object.keys(updates).length > 0) {
    updateToolsInConfig(config.configPath, updates, { allowMissing: options.global });
    console.log(`Updated ${Object.keys(updates).length} tool(s) in ${displayPath(config.configPath)}`);
    await runToolsInstall(config.configPath, { global: options.global, announce: false });
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} tool(s) couldn't be updated and keep their old version:\n  ${failures.join("\n  ")}`);
  }
}

async function runLock(argv) {
  const { options, positional } = parseOptions(argv, "lock", { flags: { "--refresh": "refresh" } });
  if (options.help) {
    console.log(LOCK_HELP_TEXT);
    process.exit(0);
  }
  if (positional.length > 1) {
    throw new Error("tools lock accepts at most one positional argument (the config path).");
  }

  const config = readToolsFromConfig(positional[0] || null);
  const entries = entriesOf(config);
  if (entries.length === 0) {
    console.log("No [tools] entries were found. Nothing to lock.");
    return;
  }

  const lockPath = lockPathFor(config.configPath);
  const existing = readToolsLock(lockPath);
  // --refresh forgets this platform's lines, so what is installed gets recorded as it is.
  const lock = options.refresh
    ? { exists: true, entries: existing.entries.filter((entry) => entry.platform !== currentPlatform()) }
    : existing;

  setUpTools(entries.map((entry) => entry.alias));
  const results = [];
  const failures = [];
  for (const entry of entries) {
    // Locking needs the checksum of the file a tool came from: a tool that was installed without
    // one (copied from Rokit, or installed before sof kept checksums) is downloaded again.
    const needsRecord = isToolInstalled(entry.spec) && !readInstallRecord(entry.spec);
    try {
      const result = await installTool(entry.spec, {
        alias: entry.alias,
        force: needsRecord,
        expected: findLockEntry(lock, entry.spec),
        log: (line) => console.log(line),
      });
      results.push({ ...result, alias: entry.alias });
    } catch (err) {
      failures.push(`${entry.alias}: ${err.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Nothing was locked. ${failures.length} tool(s) failed:\n  ${failures.join("\n  ")}`);
  }

  writeToolsLock(lockPath, mergeLockEntries(lock.entries, results, entries.map((entry) => entry.spec)));
  console.log(`Locked ${entries.length} tool(s) for ${currentPlatform()} in ${displayPath(lockPath)}. Commit it.`);
}

async function runImport(argv) {
  const { options, positional } = parseOptions(argv, "import", { flags: { "--global": "global" } });
  if (options.help) {
    console.log(IMPORT_HELP_TEXT);
    process.exit(0);
  }
  if (positional.length > 1) {
    throw new Error("tools import accepts at most one positional argument (the file to import).");
  }

  const source = positional[0] ? path.resolve(positional[0]) : findImportSource(process.cwd());
  if (!source || !fs.existsSync(source)) {
    throw new Error(
      positional[0]
        ? `${positional[0]} doesn't exist.`
        : "There is no rokit.toml, aftman.toml or foreman.toml in this folder. Pass the file: sof run tools import <file>"
    );
  }

  const target = resolveTarget(null, options);
  const { tools, skipped } = readForeignTools(source);
  const existing = readToolsFromConfig(target.configPath, { allowMissing: true }).tools;
  const configName = options.global ? "your global tools" : "sof.toml";

  console.log(`Importing tools from ${displayPath(source)}`);
  let added = 0;
  let configPath = null;
  for (const [alias, specifier] of Object.entries(tools)) {
    const present = Object.keys(existing).find((name) => name.toLowerCase() === alias.toLowerCase());
    if (!present) {
      configPath = addToolToConfig(target.configPath, alias, specifier, { allowMissing: true }).configPath;
      added += 1;
      console.log(`  + ${alias} = "${specifier}"`);
    } else if (existing[present] === specifier) {
      console.log(`  = ${alias} (already in ${configName})`);
    } else {
      console.log(`  ! ${alias}: ${configName} has ${existing[present]} and ${path.basename(source)} has ${specifier}; kept ${configName}'s`);
    }
  }

  for (const entry of skipped) {
    console.warn(`  ! ${entry.alias} skipped: it ${entry.reason}. Add it by hand: sof run tools add owner/repo@version --alias ${entry.alias}`);
  }

  if (added === 0) {
    console.log("Nothing new to import.");
    return;
  }

  console.log(`Added ${added} tool(s) to ${displayPath(configPath)}. ${path.basename(source)} is no longer needed by sof; it was left alone.`);
  await runToolsInstall(configPath, { global: options.global, announce: false });
}

async function runWhich(argv) {
  const { options, positional } = parseOptions(argv, "which");
  if (options.help) {
    console.log(WHICH_HELP_TEXT);
    process.exit(0);
  }
  if (positional.length !== 1) {
    throw new Error("tools which takes one tool alias.");
  }

  const entry = findToolEntry(positional[0]);
  if (!entry) {
    throw new Error(`"${positional[0]}" isn't listed under [tools] in any sof.toml from here up, or in your global tools.`);
  }

  const spec = parseToolSpecifier(entry.specifier, `${entry.file}: [tools].${entry.alias}`);
  if (!isToolInstalled(spec)) {
    throw new Error(`${entry.alias} ${spec.version} isn't installed yet. Run: sof run tools install${entry.global ? " --global" : ""}`);
  }
  console.log(toolExecutablePath(spec));
}

// Runs a tool at once, from a release nobody listed anywhere. Its own messages go to stderr so a
// program that writes data to stdout stays pipeable.
async function runX(argv) {
  const [toolId, ...args] = argv;
  if (!toolId || toolId === "-h" || toolId === "--help") {
    console.log(X_HELP_TEXT);
    process.exit(toolId ? 0 : 1);
  }

  const tool = parseToolId(toolId);
  const version = !tool.version || tool.version.toLowerCase() === "latest" ? await latestVersion(tool.owner, tool.repo) : tool.version;
  const spec = parseToolSpecifier(formatSpecifier({ owner: tool.owner, repo: tool.repo, version }));

  await installTool(spec, { alias: tool.repo.toLowerCase(), log: (line) => console.error(line) });
  process.exitCode = await require("../tools/exec").spawnTool(toolExecutablePath(spec), args);
}

function shimExists(alias) {
  const names = process.platform === "win32" ? [`${alias}.exe`, `${alias}.cmd`] : [alias];
  return names.some((name) => fs.existsSync(path.join(binDirectory(), name)));
}

async function runDoctor(argv) {
  const { options, positional } = parseOptions(argv, "doctor");
  if (options.help) {
    console.log(DOCTOR_HELP_TEXT);
    process.exit(0);
  }

  let problems = 0;
  const ok = (message) => console.log(`  ✓ ${message}`);
  const problem = (message) => {
    problems += 1;
    console.log(`  ! ${message}`);
  };

  console.log(`sof ${require("../../package.json").version} on ${process.platform}/${process.arch}, node ${process.versions.node}`);
  console.log(`tools: ${displayPath(toolsRoot())}   shims: ${displayPath(binDirectory())}`);

  const shimKind = process.platform !== "win32" ? "sh scripts" : findCsc() ? "native .exe shims (built with csc)" : null;
  if (shimKind) {
    ok(`shims are ${shimKind}`);
  } else {
    problem("no C# compiler (csc.exe) was found, so shims fall back to .cmd files that editors can't start");
  }

  console.log(process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? "  ✓ GitHub token set (higher download rate limit)" : "  · no GITHUB_TOKEN set (fine; GitHub allows 60 requests an hour without one)");

  let config = null;
  try {
    config = readToolsFromConfig(positional[0] || null);
  } catch (_err) {
    console.log("  · no sof.toml here, so only the global setup was checked");
  }

  const aliases = config ? Object.keys(config.tools) : [];
  const { shadowed, binOnPath } = findShadowedTools(aliases);
  if (binOnPath) {
    ok(`${displayPath(binDirectory())} is on PATH`);
  } else {
    problem(`${displayPath(binDirectory())} isn't on PATH in this terminal`);
  }

  for (const entry of config ? entriesOf(config) : []) {
    const shadow = shadowed.find((candidate) => candidate.alias === entry.alias);
    const label = `${entry.alias} ${entry.spec.version}`;
    if (!isToolInstalled(entry.spec)) {
      problem(`${label} isn't installed (sof run tools install)`);
    } else if (shadow) {
      problem(`${label} is installed, but "${entry.alias}" runs ${shadow.path} first`);
    } else if (!shimExists(entry.alias)) {
      problem(`${label} is installed, but it has no shim in ${displayPath(binDirectory())} (sof run tools install)`);
    } else {
      ok(`${label} is installed`);
    }
  }

  console.log(problems === 0 ? "No problems found." : `${problems} problem(s) found.`);
  process.exitCode = problems === 0 ? 0 : 1;
}

async function runSetup(argv) {
  const { options } = parseOptions(argv, "setup", { flags: { "--quiet": "quiet" } });
  if (options.help) {
    console.log(SETUP_HELP_TEXT);
    process.exit(0);
  }

  const result = setUpTools([]);
  if (!options.quiet) {
    console.log(`Tools are set up: shims go in ${displayPath(binDirectory())}${result.kind === "cmd" ? " (as .cmd files)" : ""}.`);
    printPathWarnings([]);
  }
}

async function runTools(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  // What every shim runs, so it takes nothing but the alias and leaves the arguments alone.
  if (command === "exec") {
    if (!rest[0]) {
      throw new Error("tools exec takes a tool alias (it is what the shims in ~/.sof/bin run).");
    }
    process.exitCode = await require("../tools/exec").runTool(rest[0], rest.slice(1));
    return;
  }

  if (!command || command === "-h" || command === "--help") {
    console.log(HELP_TEXT);
    process.exit(command ? 0 : 1);
  }

  const commands = {
    install: runInstall,
    list: runList,
    add: runAdd,
    remove: runRemove,
    update: (args) => runUpdate(args),
    outdated: (args) => runUpdate(args, { check: true }),
    import: runImport,
    lock: runLock,
    which: runWhich,
    x: runX,
    doctor: runDoctor,
    setup: runSetup,
    "self-update": async () => {
      console.log("sof no longer bundles Rokit, so there is nothing to update here. Update sof itself with: sof run self update");
    },
    rokit: async () => {
      throw new Error("sof no longer bundles Rokit. Its commands are built in: sof run tools install | add | remove | update | list.");
    },
  };

  if (!Object.prototype.hasOwnProperty.call(commands, command)) {
    throw new Error(`Unknown tools command: ${command}`);
  }
  await commands[command](rest);
}

module.exports = {
  findShadowedTools,
  installConfiguredTools,
  runTools,
  runToolsInstall,
};
