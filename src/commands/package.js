"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const semver = require("semver");
const fg = require("fast-glob");
const tar = require("tar");
const { readPackageInstallConfig, readPackagePublishConfig } = require("../packages/config");
const {
  SOF_INDEX_BRANCH,
  SOF_INDEX_REPO,
  WALLY_INDEX_BRANCH,
  WALLY_INDEX_REPO,
} = require("../packages/constants");
const { downloadPackages, cleanupDownloadedPackages } = require("../packages/downloader");
const { linkInstalledPackages, pruneRemovedPackages, writeRojoMeta } = require("../packages/linker");
const { readLockfile, writeLockfile } = require("../packages/lockfile");
const { createRegistry } = require("../packages/registry");
const { resolveDependencyGraph } = require("../packages/resolver");
const {
  classifyEntries,
  createEntryKey,
  hashConfigGroups,
  isInstallCurrent,
  readInstallState,
  recordInstalled,
  writeInstallState,
} = require("../packages/state");

const HELP_TEXT = `
sof run package - Manage package install/publish workflow

USAGE:
  sof run package <command> [arguments] [options]

COMMANDS:
  install
    sof run package install [path/to/sof.toml]
    OPTIONS:
      --frozen                        Error when sof.lock is missing/outdated
      --force                         Reinstall every package
      -h, --help                      Show install command help

  publish
    sof run package publish [path/to/sof.toml]
    OPTIONS:
      --name <scope/name>             Publish only one package entry
      -h, --help                      Show publish command help

  check
    sof run package check [path/to/sof.toml]
    OPTIONS:
      --name <scope/name>             Validate one package entry only
      --fix                           Apply alias case fixes in source files
      -h, --help                      Show check command help

  outdated
    sof run package outdated [path/to/sof.toml]
    OPTIONS:
      --scope <scope>                 Filter output by package scope prefix
      --json                          Output JSON
      -h, --help                      Show outdated command help

  search
    sof run package search <query> [options]
    OPTIONS:
      --source <all|sof|wally>        Restrict search source (default: all)
      --limit <number>                Max results (default: 20)
      --info <scope/name>             Show detailed package info
      --json                          Output JSON
      -h, --help                      Show search command help
`;

const INSTALL_HELP_TEXT = `
sof run package install - Install packages from sof.toml

USAGE:
  sof run package install [path/to/sof.toml]

DESCRIPTION:
  Only packages that are new, changed or missing/modified on disk are downloaded and
  copied; when nothing changed since the last install, nothing is touched.

OPTIONS:
  --frozen                        Error when sof.lock is missing/outdated
  --force                         Reinstall every package, ignoring what is already installed
  -h, --help                      Show this help message
`;

const PUBLISH_HELP_TEXT = `
sof run package publish - Publish package(s) to the Sof index

USAGE:
  sof run package publish [path/to/sof.toml]

OPTIONS:
  --name <scope/name>             Publish only one package entry
  --skip-existing                 Skip packages whose version is already in the index
  -h, --help                      Show this help message
`;

const CHECK_HELP_TEXT = `
sof run package check - Validate require() alias integrity

USAGE:
  sof run package check [path/to/sof.toml]

OPTIONS:
  --name <scope/name>             Validate one package entry only
  --fix                           Apply alias case fixes in source files
  -h, --help                      Show this help message
`;

const OUTDATED_HELP_TEXT = `
sof run package outdated - Show available package updates

USAGE:
  sof run package outdated [path/to/sof.toml]

OPTIONS:
  --scope <scope>                 Filter output by package scope prefix
  --json                          Output JSON
  -h, --help                      Show this help message
`;

const SEARCH_HELP_TEXT = `
sof run package search - Search Sof/Wally package indexes

USAGE:
  sof run package search <query> [options]

OPTIONS:
  --source <all|sof|wally>        Restrict search source (default: all)
  --limit <number>                Max results (default: 20)
  --info <scope/name>             Show detailed package info
  --json                          Output JSON
  -h, --help                      Show this help message
`;

const MISSING_PUBLISH_ENTRIES_PATTERN =
  /must define at least one \[\[package\]\] entry to publish\./;

function displayPath(targetPath) {
  const relativePath = path.relative(process.cwd(), targetPath);
  return relativePath || ".";
}

function parseInstallArgs(argv) {
  const output = {
    configPath: null,
    frozen: false,
    force: false,
    help: false,
  };

  const positional = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--frozen") {
      output.frozen = true;
      continue;
    }

    if (arg === "--force") {
      output.force = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("package install accepts at most one positional argument (the config path).");
  }

  output.configPath = positional[0] || null;
  return output;
}

function parsePublishArgs(argv) {
  const output = {
    configPath: null,
    packageName: null,
    skipExisting: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--skip-existing") {
      output.skipExisting = true;
      continue;
    }

    if (arg === "--name") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--name requires a package value (scope/name).");
      }

      output.packageName = value.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("package publish accepts at most one positional argument (the config path).");
  }

  output.configPath = positional[0] || null;
  return output;
}

function parseCheckArgs(argv) {
  const output = {
    configPath: null,
    packageName: null,
    fix: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--name") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--name requires a package value (scope/name).");
      }
      output.packageName = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--fix") {
      output.fix = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("package check accepts at most one positional argument (the config path).");
  }

  output.configPath = positional[0] || null;
  return output;
}

function parseOutdatedArgs(argv) {
  const output = {
    configPath: null,
    scope: "",
    json: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--scope") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--scope requires a value.");
      }
      output.scope = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg === "--json") {
      output.json = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("package outdated accepts at most one positional argument (the config path).");
  }

  output.configPath = positional[0] || null;
  return output;
}

function parseSearchArgs(argv) {
  const output = {
    query: null,
    source: "all",
    limit: 20,
    infoPackage: null,
    json: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--source") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--source requires a value.");
      }
      output.source = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--limit requires a value.");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--limit must be a positive integer.");
      }
      output.limit = parsed;
      index += 1;
      continue;
    }

    if (arg === "--info") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--info requires a package value (scope/name).");
      }
      output.infoPackage = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--json") {
      output.json = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (!["all", "sof", "wally"].includes(output.source)) {
    throw new Error('--source must be one of: "all", "sof", "wally".');
  }

  if (positional.length > 1) {
    throw new Error("package search accepts one positional argument: <query>.");
  }
  output.query = positional[0] || null;

  return output;
}

function isMissingPublishEntriesError(error) {
  return (
    Boolean(error) &&
    typeof error.message === "string" &&
    MISSING_PUBLISH_ENTRIES_PATTERN.test(error.message)
  );
}

function resolvePublishConfig(configPathArg) {
  if (configPathArg) {
    return {
      config: readPackagePublishConfig(configPathArg),
      fallbackNotice: "",
    };
  }

  const defaultPath = path.resolve("sof.toml");
  const fallbackPath = path.resolve("packages.sof.toml");

  if (!fs.existsSync(defaultPath) && fs.existsSync(fallbackPath)) {
    return {
      config: readPackagePublishConfig(fallbackPath),
      fallbackNotice: `No sof.toml found; using ${displayPath(fallbackPath)} for publish.`,
    };
  }

  try {
    return {
      config: readPackagePublishConfig(defaultPath),
      fallbackNotice: "",
    };
  } catch (err) {
    if (!isMissingPublishEntriesError(err) || !fs.existsSync(fallbackPath)) {
      throw err;
    }

    return {
      config: readPackagePublishConfig(fallbackPath),
      fallbackNotice:
        `No [[package]] entries in ${displayPath(defaultPath)}; ` +
        `using ${displayPath(fallbackPath)} for publish.`,
    };
  }
}

function toLockEntries(linkedEntries) {
  return linkedEntries.map((entry) => ({
    name: entry.name,
    alias: entry.alias,
    version: entry.version,
    source: entry.source,
    path: entry.path,
    checksum: entry.checksum,
  }));
}

function ensureIncludeEntriesExist(packageEntry, configDirectory) {
  const includeEntries = [];

  for (const includeEntry of packageEntry.include) {
    const absolutePath = path.resolve(configDirectory, includeEntry);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(
        `Package "${packageEntry.name}" include path does not exist: ${includeEntry}`
      );
    }

    const relativePath = path.relative(configDirectory, absolutePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(
        `Package "${packageEntry.name}" include path must resolve inside the config directory: ${includeEntry}`
      );
    }

    includeEntries.push({
      includeEntry,
      absolutePath,
      relativePath: relativePath.split(path.sep).join("/"),
      isFile: fs.statSync(absolutePath).isFile(),
    });
  }

  return includeEntries;
}

function assertStageTargetDoesNotExist(stagePath, packageName, sourcePath) {
  if (fs.existsSync(stagePath)) {
    throw new Error(
      `Package "${packageName}" include entry "${sourcePath}" collides with another staged path: ${stagePath}`
    );
  }
}

function stagePackageContents(packageEntry, includeEntries, stageDirectory) {
  for (const includeItem of includeEntries) {
    const sourcePath = includeItem.absolutePath;
    const sourceName = path.basename(sourcePath);
    const sourceStat = fs.statSync(sourcePath);

    if (sourceStat.isDirectory()) {
      const targetPath = path.join(stageDirectory, sourceName);
      assertStageTargetDoesNotExist(targetPath, packageEntry.name, includeItem.includeEntry);
      fs.cpSync(sourcePath, targetPath, { recursive: true });
      continue;
    }

    const targetFileName = sourceName;
    const targetPath = path.join(stageDirectory, targetFileName);
    assertStageTargetDoesNotExist(targetPath, packageEntry.name, includeItem.includeEntry);
    fs.copyFileSync(sourcePath, targetPath);
  }
}

async function createPackageArchive(packageEntry, configDirectory, temporaryDirectory) {
  const archiveFileName =
    `${packageEntry.name.replace("/", "--")}--` + `${packageEntry.version}.tar.gz`;
  const archivePath = path.join(temporaryDirectory, archiveFileName);

  const includeEntries = ensureIncludeEntriesExist(packageEntry, configDirectory);
  const stageDirectory = fs.mkdtempSync(path.join(temporaryDirectory, "pkg-stage-"));
  stagePackageContents(packageEntry, includeEntries, stageDirectory);

  // Glob patterns (relative to the staged archive root) left out of the archive.
  if (packageEntry.exclude && packageEntry.exclude.length > 0) {
    for (const excluded of fg.sync(packageEntry.exclude, {
      cwd: stageDirectory,
      absolute: true,
      dot: true,
      onlyFiles: false,
    })) {
      fs.rmSync(excluded, { recursive: true, force: true });
    }
  }

  const stageEntries = fs.readdirSync(stageDirectory);
  if (stageEntries.length === 0) {
    throw new Error(`Package "${packageEntry.name}" produced an empty archive.`);
  }

  await tar.c(
    {
      file: archivePath,
      gzip: true,
      cwd: stageDirectory,
      portable: true,
    },
    stageEntries
  );

  return archivePath;
}

function createChecksumForFile(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest("hex")}`;
}

// Every .luau file of a package, with how many `.Parent` hops lead from that script to the
// folder the package is installed into (1 for a single-file package or a folder's
// init.luau, 2 for a file directly inside the folder, and so on).
function collectPackageSourceFiles(packageEntry, configDirectory) {
  const files = new Map();
  for (const includeEntry of packageEntry.include) {
    const absoluteIncludePath = path.resolve(configDirectory, includeEntry);
    if (!fs.existsSync(absoluteIncludePath)) {
      continue;
    }

    const stat = fs.statSync(absoluteIncludePath);
    if (stat.isFile()) {
      if (absoluteIncludePath.toLowerCase().endsWith(".luau")) {
        files.set(path.resolve(absoluteIncludePath), 1);
      }
      continue;
    }

    for (const filePath of fg.sync("**/*.luau", {
      cwd: absoluteIncludePath,
      absolute: true,
      onlyFiles: true,
    })) {
      const segments = path.relative(absoluteIncludePath, filePath).split(path.sep);
      const isInit = /^init(\.(server|client))?\.luau$/i.test(segments[segments.length - 1]);
      files.set(path.resolve(filePath), isInit ? segments.length : segments.length + 1);
    }
  }

  return Array.from(files, ([filePath, depth]) => ({ filePath, depth })).sort((a, b) =>
    a.filePath.localeCompare(b.filePath)
  );
}

// Sibling packages a file requires: script.Parent...X / :WaitForChild("X") with exactly
// `depth` Parent hops (anything shallower is the package's own files), plus absolute
// ReplicatedStorage.Packages.X and "@game/ReplicatedStorage/Packages/X" requires.
function findScriptParentAliasReferences(source, depth = 1) {
  const references = [];

  for (const match of source.matchAll(/script((?:\.Parent)+)\.(?!Parent\b)([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (match[1].split(".Parent").length - 1 === depth) {
      references.push({ alias: match[2], kind: "dot" });
    }
  }

  for (const match of source.matchAll(
    /script((?:\.Parent)+)\s*:\s*(?:WaitForChild|FindFirstChild)\(\s*["']([^"']+)["']\s*\)/g
  )) {
    if (match[1].split(".Parent").length - 1 === depth) {
      references.push({ alias: match[2], kind: "wait" });
    }
  }

  for (const match of source.matchAll(/ReplicatedStorage\.Packages\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    references.push({ alias: match[1], kind: "absolute" });
  }

  for (const match of source.matchAll(/["']@game\/ReplicatedStorage\/Packages\/([A-Za-z_][A-Za-z0-9_]*)/g)) {
    references.push({ alias: match[1], kind: "absolute" });
  }

  return references;
}

function applyAliasCaseFixes(source, declaredAliasesByLowercase) {
  let output = source;
  let changed = false;

  output = output.replace(
    /require(\s*\(\s*script\.Parent\.)([A-Za-z_][A-Za-z0-9_]*)(\b)/g,
    (whole, before, alias, after) => {
      const canonical = declaredAliasesByLowercase.get(alias.toLowerCase());
      if (!canonical || canonical === alias) {
        return whole;
      }
      changed = true;
      return `require${before}${canonical}${after}`;
    }
  );

  output = output.replace(
    /require(\s*\(\s*script\.Parent\s*:\s*(?:WaitForChild|FindFirstChild)\(\s*["'])([^"']+)(["']\s*\))/g,
    (whole, before, alias, after) => {
      const canonical = declaredAliasesByLowercase.get(alias.toLowerCase());
      if (!canonical || canonical === alias) {
        return whole;
      }
      changed = true;
      return `require${before}${canonical}${after}`;
    }
  );

  return { output, changed };
}

function printTable(rows, columns) {
  if (rows.length === 0) {
    return "";
  }
  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => String(row[column.key]).length))
  );
  const header = columns
    .map((column, index) => column.label.padEnd(widths[index], " "))
    .join("  ");
  const separator = columns.map((_, index) => "-".repeat(widths[index])).join("  ");
  const body = rows
    .map((row) =>
      columns
        .map((column, index) => String(row[column.key]).padEnd(widths[index], " "))
        .join("  ")
    )
    .join("\n");
  return `${header}\n${separator}\n${body}`;
}

function findMatchingLockEntry(lockEntries, dependency, groupPath) {
  const normalizedPath = String(groupPath).replace(/\\/g, "/");
  return (
    lockEntries.find(
      (entry) =>
        String(entry.path).replace(/\\/g, "/") === normalizedPath &&
        entry.alias === dependency.alias &&
        entry.name === dependency.name
    ) || null
  );
}

function sortVersionsDescending(versions) {
  return versions
    .map((version) => String(version))
    .filter((version) => semver.valid(version))
    .sort((a, b) => semver.rcompare(a, b));
}

async function fetchGithubTree(repository, branch) {
  const url = `https://api.github.com/repos/${repository}/git/trees/${branch}?recursive=1`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "sof-cli",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch github tree ${repository}@${branch} (${response.status}): ${errorText}`
    );
  }

  const parsed = await response.json();
  if (!parsed || !Array.isArray(parsed.tree)) {
    throw new Error(`Unexpected github tree response for ${repository}@${branch}.`);
  }

  return parsed.tree;
}

function extractSofPackageNames(tree) {
  const names = new Set();
  for (const entry of tree) {
    if (entry.type !== "blob" || typeof entry.path !== "string") {
      continue;
    }
    const match = /^index\/([^/]+)\/([^/]+)\.json$/.exec(entry.path);
    if (!match) {
      continue;
    }
    names.add(`${match[1]}/${match[2]}`);
  }
  return Array.from(names);
}

function extractWallyPackageNames(tree) {
  const names = new Set();
  for (const entry of tree) {
    if (entry.type !== "blob" || typeof entry.path !== "string") {
      continue;
    }

    const segments = entry.path.split("/");
    if (segments.length !== 2) {
      continue;
    }

    if (!segments[0] || !segments[1]) {
      continue;
    }

    if (segments[1].includes(".")) {
      continue;
    }

    names.add(`${segments[0]}/${segments[1]}`);
  }
  return Array.from(names);
}

async function runInstall(argv) {
  const args = parseInstallArgs(argv);
  if (args.help) {
    console.log(INSTALL_HELP_TEXT);
    process.exit(0);
  }

  const config = readPackageInstallConfig(args.configPath);
  const lockfilePath = path.join(config.configDirectory, "sof.lock");
  const lockfile = readLockfile(lockfilePath);
  const registry = createRegistry({
    token: process.env.SOF_TOKEN || "",
  });

  console.log(`Using config: ${displayPath(config.configPath)}`);
  if (args.frozen) {
    console.log("Running in frozen mode.");
  }

  const installState = readInstallState(config.configDirectory);
  const configHash = hashConfigGroups(config.groups);

  // Same config, same lockfile and every installed package untouched since the last install:
  // nothing to resolve, download or copy.
  if (!args.force && isInstallCurrent(installState, configHash, lockfile, config.configDirectory)) {
    for (const group of config.groups) {
      writeRojoMeta(config.configDirectory, group);
    }
    console.log(`Packages are up to date (${lockfile.entries.length} installed).`);
    return;
  }

  const resolved = await resolveDependencyGraph({
    groups: config.groups,
    registry,
    lockEntries: lockfile.entries,
    frozen: args.frozen,
  });

  if (resolved.entries.length === 0) {
    console.log("No dependencies were resolved from config.");
    return;
  }

  const { current, stale } = args.force
    ? {
        current: [],
        stale: resolved.entries.map((entry) => ({ entry, reason: "forced" })),
      }
    : classifyEntries(resolved.entries, lockfile.entries, installState, config.configDirectory);

  console.log(
    `Resolved ${resolved.entries.length} package(s): ${stale.length} to install, ${current.length} up to date.`
  );

  const installedByKey = new Map();
  for (const { entry, lockEntry, recorded } of current) {
    installedByKey.set(createEntryKey(entry), {
      ...entry,
      checksum: lockEntry.checksum,
      destinationPath: path.resolve(config.configDirectory, recorded.destination),
    });
  }

  const reasons = new Map(stale.map(({ entry, reason }) => [createEntryKey(entry), reason]));
  if (stale.length > 0) {
    const downloaded = await downloadPackages({
      entries: stale.map(({ entry }) => entry),
      registry,
    });

    try {
      const linked = linkInstalledPackages(downloaded.entries, config.configDirectory);
      for (const entry of linked.entries) {
        installedByKey.set(createEntryKey(entry), entry);
      }
    } finally {
      cleanupDownloadedPackages(downloaded.temporaryDirectory);
    }
  }

  const allEntries = resolved.entries.map((entry) => installedByKey.get(createEntryKey(entry)));
  const removed = pruneRemovedPackages(lockfile.entries, allEntries, config.configDirectory);

  for (const group of config.groups) {
    writeRojoMeta(config.configDirectory, group);
  }

  const written = writeLockfile(lockfilePath, toLockEntries(allEntries));

  const packageRecords = {};
  for (const entry of allEntries) {
    packageRecords[createEntryKey(entry)] = recordInstalled(entry, entry.destinationPath, config.configDirectory);
  }
  writeInstallState(config.configDirectory, {
    configHash,
    lockHash: written.hash,
    packages: packageRecords,
  });

  for (const { entry } of stale) {
    const installed = installedByKey.get(createEntryKey(entry));
    const role = installed.isDirect ? "" : " [dependency]";
    const reason = reasons.get(createEntryKey(entry));
    const rewrites = Object.entries(installed.aliasRewrites || {})
      .map(([from, to]) => `${from}->${to}`)
      .join(", ");
    console.log(
      `  ✓ ${installed.alias} -> ${displayPath(installed.destinationPath)} ` +
        `(${installed.name}@${installed.version} via ${installed.source})${role} [${reason}]` +
        (rewrites ? ` requires rewritten: ${rewrites}` : "")
    );
  }

  for (const entry of removed) {
    console.log(`  - removed ${entry.alias} (${entry.name}@${entry.version})`);
  }

  if (stale.length === 0 && removed.length === 0) {
    console.log("Packages are up to date.");
  }
}

async function runPublish(argv) {
  const args = parsePublishArgs(argv);
  if (args.help) {
    console.log(PUBLISH_HELP_TEXT);
    process.exit(0);
  }

  const resolvedPublishConfig = resolvePublishConfig(args.configPath);
  const config = resolvedPublishConfig.config;
  const registry = createRegistry({
    token: process.env.SOF_TOKEN || "",
  });

  if (resolvedPublishConfig.fallbackNotice) {
    console.log(resolvedPublishConfig.fallbackNotice);
  }
  console.log(`Using config: ${displayPath(config.configPath)}`);

  let packagesToPublish = config.packages;
  if (args.packageName) {
    packagesToPublish = config.packages.filter((entry) => entry.name === args.packageName);
    if (packagesToPublish.length === 0) {
      throw new Error(`No [[package]] entry matched --name ${args.packageName}.`);
    }
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sof-publish-"));
  try {
    console.log(`Publishing ${packagesToPublish.length} package(s)...`);

    for (const packageEntry of packagesToPublish) {
      if (args.skipExisting) {
        const existing = await registry.queryPackage(packageEntry.name, {
          preferredSource: "sof",
          allowFallback: false,
        });
        if (existing && existing.versions.some((entry) => entry.version === packageEntry.version)) {
          console.log(`  - ${packageEntry.name}@${packageEntry.version} already published, skipped`);
          continue;
        }
      }

      const archivePath = await createPackageArchive(
        packageEntry,
        config.configDirectory,
        temporaryDirectory
      );
      const checksum = createChecksumForFile(archivePath);

      const result = await registry.publishPackage(packageEntry, archivePath, checksum);
      console.log(`  ✓ ${result.packageName}@${result.version}`);
      console.log(`    - index: ${result.indexPath}`);
      console.log(`    - artifact: ${result.artifactPath}`);
    }
  } finally {
    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}

async function runCheck(argv) {
  const args = parseCheckArgs(argv);
  if (args.help) {
    console.log(CHECK_HELP_TEXT);
    process.exit(0);
  }

  const resolvedPublishConfig = resolvePublishConfig(args.configPath);
  const config = resolvedPublishConfig.config;
  let packagesToCheck = config.packages;
  if (args.packageName) {
    packagesToCheck = config.packages.filter((entry) => entry.name === args.packageName);
    if (packagesToCheck.length === 0) {
      throw new Error(`No [[package]] entry matched --name ${args.packageName}.`);
    }
  }

  if (resolvedPublishConfig.fallbackNotice) {
    console.log(resolvedPublishConfig.fallbackNotice);
  }
  console.log(`Using config: ${displayPath(config.configPath)}`);
  console.log(`Validating ${packagesToCheck.length} package(s)...`);

  const packageIssues = [];
  let totalFixes = 0;

  for (const packageEntry of packagesToCheck) {
    const files = collectPackageSourceFiles(packageEntry, config.configDirectory);
    const declaredAliases = new Set(packageEntry.dependencies.map((dependency) => dependency.alias));
    const declaredAliasesByLowercase = new Map(
      packageEntry.dependencies.map((dependency) => [dependency.alias.toLowerCase(), dependency.alias])
    );

    const requiredAliases = new Set();
    const mismatches = [];
    const sourceFilesWithFixes = [];

    for (const { filePath, depth } of files) {
      const source = fs.readFileSync(filePath, "utf8");
      const references = findScriptParentAliasReferences(source, depth);
      for (const reference of references) {
        requiredAliases.add(reference.alias);
        if (
          !declaredAliases.has(reference.alias) &&
          declaredAliasesByLowercase.has(reference.alias.toLowerCase())
        ) {
          mismatches.push({
            filePath,
            found: reference.alias,
            expected: declaredAliasesByLowercase.get(reference.alias.toLowerCase()),
          });
        }
      }

      if (args.fix) {
        const fixed = applyAliasCaseFixes(source, declaredAliasesByLowercase);
        if (fixed.changed) {
          fs.writeFileSync(filePath, fixed.output, "utf8");
          sourceFilesWithFixes.push(filePath);
          totalFixes += 1;
        }
      }
    }

    const ownAliases = new Set(
      [packageEntry.name.split("/")[1], ...packageEntry.include.map((entry) => path.basename(entry, ".luau"))].map(
        (alias) => alias.toLowerCase()
      )
    );
    const undeclared = Array.from(requiredAliases).filter(
      (alias) => !declaredAliases.has(alias) && !ownAliases.has(alias.toLowerCase())
    );
    const unused = Array.from(declaredAliases).filter((alias) => !requiredAliases.has(alias));

    if (undeclared.length === 0 && unused.length === 0 && mismatches.length === 0) {
      console.log(`  ✓ ${packageEntry.name}`);
      continue;
    }

    const issue = {
      packageName: packageEntry.name,
      undeclared: undeclared.sort((a, b) => a.localeCompare(b)),
      unused: unused.sort((a, b) => a.localeCompare(b)),
      mismatches,
      fixedFiles: sourceFilesWithFixes,
    };
    packageIssues.push(issue);

    console.log(`  ✗ ${packageEntry.name}`);
    if (issue.undeclared.length > 0) {
      console.log(`    - Undeclared dependencies: ${issue.undeclared.join(", ")}`);
    }
    if (issue.unused.length > 0) {
      console.log(`    - Unused declared dependencies: ${issue.unused.join(", ")}`);
    }
    if (issue.mismatches.length > 0) {
      console.log("    - Alias case mismatches:");
      for (const mismatch of issue.mismatches) {
        console.log(
          `      ${displayPath(mismatch.filePath)}: "${mismatch.found}" -> "${mismatch.expected}"`
        );
      }
    }
    if (issue.fixedFiles.length > 0) {
      console.log(`    - Applied --fix to ${issue.fixedFiles.length} file(s).`);
    }
  }

  if (args.fix && totalFixes > 0) {
    console.log(`Applied alias-case fixes in ${totalFixes} file(s).`);
  }

  if (packageIssues.length > 0) {
    throw new Error(`package check found issues in ${packageIssues.length} package(s).`);
  }
}

async function runOutdated(argv) {
  const args = parseOutdatedArgs(argv);
  if (args.help) {
    console.log(OUTDATED_HELP_TEXT);
    process.exit(0);
  }

  const config = readPackageInstallConfig(args.configPath);
  const lockfilePath = path.join(config.configDirectory, "sof.lock");
  const lockfile = readLockfile(lockfilePath);
  const registry = createRegistry({
    token: process.env.SOF_TOKEN || "",
  });

  console.log(`Using config: ${displayPath(config.configPath)}`);
  console.log(`Using lockfile: ${displayPath(lockfilePath)}${lockfile.exists ? "" : " (missing)"}`);

  const rows = [];
  for (const group of config.groups) {
    for (const dependency of group.dependencies) {
      if (args.scope && !dependency.name.toLowerCase().startsWith(`${args.scope}/`)) {
        continue;
      }

      const lockEntry = findMatchingLockEntry(lockfile.entries, dependency, group.path);
      let packageEntry = null;
      try {
        packageEntry = await registry.queryPackage(dependency.name, {
          preferredSource: lockEntry ? lockEntry.source : null,
          allowFallback: true,
        });
      } catch (err) {
        rows.push({
          package: dependency.name,
          alias: dependency.alias,
          current: lockEntry ? lockEntry.version : "-",
          wanted: "-",
          latest: "-",
          source: lockEntry ? lockEntry.source : "-",
          status: `error: ${err.message}`,
        });
        continue;
      }

      if (!packageEntry) {
        rows.push({
          package: dependency.name,
          alias: dependency.alias,
          current: lockEntry ? lockEntry.version : "-",
          wanted: "-",
          latest: "-",
          source: lockEntry ? lockEntry.source : "-",
          status: "not found",
        });
        continue;
      }

      const versions = sortVersionsDescending(packageEntry.versions.map((entry) => entry.version));
      const latest = versions[0] || "-";
      const wanted = semver.maxSatisfying(versions, dependency.range, {
        includePrerelease: true,
      }) || "-";
      const current = lockEntry ? lockEntry.version : "-";

      let status = "up-to-date";
      if (current === "-") {
        status = "not installed";
      } else if (wanted !== "-" && semver.valid(current) && semver.lt(current, wanted)) {
        status = "update available";
      } else if (latest !== "-" && semver.valid(current) && semver.lt(current, latest)) {
        status = "newer outside range";
      }

      rows.push({
        package: dependency.name,
        alias: dependency.alias,
        current,
        wanted,
        latest,
        source: packageEntry.source,
        status,
      });
    }
  }

  rows.sort((a, b) => a.package.localeCompare(b.package) || a.alias.localeCompare(b.alias));

  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No dependencies matched the requested scope.");
    return;
  }

  const table = printTable(rows, [
    { key: "package", label: "Package" },
    { key: "alias", label: "Alias" },
    { key: "current", label: "Current" },
    { key: "wanted", label: "Wanted" },
    { key: "latest", label: "Latest" },
    { key: "source", label: "Source" },
    { key: "status", label: "Status" },
  ]);
  console.log(table);
}

async function runSearch(argv) {
  const args = parseSearchArgs(argv);
  if (args.help || (!args.query && !args.infoPackage)) {
    console.log(SEARCH_HELP_TEXT);
    process.exit(args.help ? 0 : 1);
  }

  const registry = createRegistry({
    token: process.env.SOF_TOKEN || "",
  });

  if (args.infoPackage) {
    const result = await registry.queryPackage(args.infoPackage, {
      preferredSource: args.source === "all" ? null : args.source,
      allowFallback: args.source === "all",
    });

    if (!result) {
      throw new Error(`Package "${args.infoPackage}" was not found.`);
    }

    const versions = sortVersionsDescending(result.versions.map((entry) => entry.version));
    const latestVersion = versions[0] || "-";
    const latestMetadata = result.versions.find((entry) => entry.version === latestVersion) || {};
    const payload = {
      package: args.infoPackage,
      source: result.source,
      versions,
      latestVersion,
      latestMetadata: latestMetadata.metadata || {},
      dependencies: latestMetadata.dependencies || {},
    };

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Package: ${payload.package}`);
    console.log(`Source: ${payload.source}`);
    console.log(`Latest: ${payload.latestVersion}`);
    console.log(`Versions: ${payload.versions.join(", ")}`);
    const dependencies = Object.entries(payload.dependencies);
    if (dependencies.length === 0) {
      console.log("Dependencies: (none)");
    } else {
      console.log("Dependencies:");
      for (const [alias, specifier] of dependencies) {
        console.log(`  - ${alias}: ${specifier}`);
      }
    }
    return;
  }

  const queryLower = args.query.toLowerCase();
  const searchSources = args.source === "all" ? ["sof", "wally"] : [args.source];
  const results = [];

  if (searchSources.includes("sof")) {
    const tree = await fetchGithubTree(SOF_INDEX_REPO, SOF_INDEX_BRANCH);
    for (const packageName of extractSofPackageNames(tree)) {
      if (packageName.toLowerCase().includes(queryLower)) {
        results.push({
          package: packageName,
          source: "sof",
        });
      }
    }
  }

  if (searchSources.includes("wally")) {
    const tree = await fetchGithubTree(WALLY_INDEX_REPO, WALLY_INDEX_BRANCH);
    for (const packageName of extractWallyPackageNames(tree)) {
      if (packageName.toLowerCase().includes(queryLower)) {
        results.push({
          package: packageName,
          source: "wally",
        });
      }
    }
  }

  const deduped = Array.from(
    new Map(results.map((entry) => [`${entry.source}:${entry.package}`, entry])).values()
  )
    .sort((a, b) => a.package.localeCompare(b.package))
    .slice(0, args.limit);

  const enriched = [];
  for (const entry of deduped) {
    let latest = "-";
    let description = "";
    try {
      const details = await registry.queryPackage(entry.package, {
        preferredSource: entry.source,
        allowFallback: false,
        throwOnProviderFailure: false,
      });
      if (details && Array.isArray(details.versions) && details.versions.length > 0) {
        const versions = sortVersionsDescending(details.versions.map((versionEntry) => versionEntry.version));
        latest = versions[0] || "-";
        const latestEntry = details.versions.find((versionEntry) => versionEntry.version === latest);
        description =
          latestEntry && latestEntry.metadata && typeof latestEntry.metadata.description === "string"
            ? latestEntry.metadata.description
            : "";
      }
    } catch (_err) {
      // Ignore per-entry enrichment failures.
    }

    enriched.push({
      package: entry.package,
      source: entry.source,
      latest,
      description,
    });
  }

  if (args.json) {
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }

  if (enriched.length === 0) {
    console.log("No packages matched the query.");
    return;
  }

  const table = printTable(enriched, [
    { key: "package", label: "Package" },
    { key: "source", label: "Source" },
    { key: "latest", label: "Latest" },
    { key: "description", label: "Description" },
  ]);
  console.log(table);
}

async function runPackage(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "-h" || command === "--help") {
    console.log(HELP_TEXT);
    process.exit(command ? 0 : 1);
  }

  if (command === "install") {
    await runInstall(rest);
    return;
  }

  if (command === "publish") {
    await runPublish(rest);
    return;
  }

  if (command === "check") {
    await runCheck(rest);
    return;
  }

  if (command === "outdated") {
    await runOutdated(rest);
    return;
  }

  if (command === "search") {
    await runSearch(rest);
    return;
  }

  throw new Error(`Unknown package command: ${command}`);
}

module.exports = {
  runPackage,
  runPackageInstall: runInstall,
};
